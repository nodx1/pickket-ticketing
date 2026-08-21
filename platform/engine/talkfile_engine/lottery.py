"""
Pickket 공정 추첨 엔진
========================
Efraimidis-Spirakis 가중 추첨 + commit-reveal 검증.

정본: docs/architecture/SALE_MODE_POLICY_v2_2026-04-10.md §3

가중치 공식 (가산 방식):
  당첨가중치 = 기본값(100) + AP보너스 + 보정값
  AP보너스   = log₂(min(투입AP, 3000) + 1) × 15
  보정값     = fan_adjustment + pity_adjustment

Features:
  - 가산 가중치: 0 AP = 100, 2000 AP = 264 (1.5배). 독식 불가.
  - Weighted lottery: E-S algorithm (weighted sampling w/o replacement)
  - Group support: atomic all-or-nothing for groups
  - Seed-based reproducibility for audit
  - Commit-reveal fairness verification
  - Auto-waitlist for losers
"""

import hashlib
import json
import math
import random
import secrets
from dataclasses import dataclass, field
from datetime import datetime, timezone


# ─── AP & Weight Helpers ───
# 정본: docs/architecture/SALE_MODE_POLICY_v2_2026-04-10.md §3-2 ~ §3-6
#
# 당첨가중치 = 기본값(100) + AP보너스 + 보정값
#   AP보너스  = log₂(min(투입AP, 3000) + 1) × 15
#   보정값    = 연속낙첨 보너스 + 신규부스트 - 쿨다운
#
# 핵심: 0 AP vs 2000 AP = 1.5배 차이. "활동 보상은 있되 독식 불가."

AP_CAP = 3000  # 투입 상한 — 이 이상 넣어도 효과 미미
BASE_WEIGHT = 100  # 모든 유저 동일 기본값
AP_SCALE = 15  # log₂ 스케일 팩터


def compute_ap_bonus(invested_ap: int) -> float:
    """AP 투자량 → AP 보너스 (로그 스케일).

    공식: log₂(min(invested_ap, 3000) + 1) × 15
    0 AP → 0, 300 AP → ~124, 2000 AP → ~164, 3000+ AP → ~173 (상한)

    Args:
        invested_ap: 투자한 AP 양 (0 이상).

    Returns:
        AP 보너스 값.
    """
    if invested_ap <= 0:
        return 0.0
    capped = min(invested_ap, AP_CAP)
    return math.log2(capped + 1) * AP_SCALE


def compute_effective_ap(invested_ap: int) -> float:
    """하위 호환용 wrapper. compute_ap_bonus 사용 권장."""
    return compute_ap_bonus(invested_ap)


def compute_lottery_weight(
    invested_ap: int,
    fan_weight: float,
    tier_multiplier: float = 1.0,
    pity_bonus: float = 1.0,
) -> float:
    """공정 추첨 가중치 계산 (가산 방식).

    정본: SALE_MODE_POLICY_v2 §3-2
      당첨가중치 = 기본값(100) + AP보너스 + 보정값(pity 등)

    fan_weight, tier_multiplier, pity_bonus는 보정값으로 변환:
      보정값 = (fan_weight - 1.0) × 50 + (pity_bonus - 1.0) × 150

    Args:
        invested_ap: 투자한 AP 양.
        fan_weight: 팬 가중치 [0.57~1.93]. 기본 1.0.
        tier_multiplier: 멤버십 티어 배율 (1.00~1.20). 현재 미사용 예약.
        pity_bonus: 연속 낙첨 보정 배율 (기본 1.0).

    Returns:
        최종 가중치 (항상 >= 1).
    """
    ap_bonus = compute_ap_bonus(invested_ap)

    # fan_weight [0.57~1.93] → 보정값 [-21.5 ~ +46.5]
    fan_adjustment = (fan_weight - 1.0) * 50

    # pity_bonus [1.0~1.6+] → 연속낙첨 보정 [0 ~ +90+]
    # docs: 2연속 +30, 3연속 +70, 4연속 +100, 5연속+ +150
    pity_adjustment = (pity_bonus - 1.0) * 150

    weight = BASE_WEIGHT + ap_bonus + fan_adjustment + pity_adjustment
    return max(weight, 1.0)


@dataclass
class LotteryEntry:
    """Single lottery application."""
    user_id: str
    group_id: str | None = None
    group_size: int = 1
    applied_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))


@dataclass
class LotteryPool:
    """Lottery pool for a single tier."""
    tier_id: str
    entries: list[LotteryEntry] = field(default_factory=list)
    total_seats: int = 0
    use_fan_weight: bool = True


@dataclass
class LotteryResult:
    """Result of lottery drawing."""
    winners: list[str] = field(default_factory=list)
    waitlist: list[str] = field(default_factory=list)
    seed_used: int = 0
    total_applicants: int = 0
    total_seats: int = 0
    commitment_hash: str = ""
    verification_data: dict = field(default_factory=dict)
    client_seeds_hash: str = ""
    # Commit-reveal v2: the raw server seed (before combining with client
    # seeds). This is what the pre-draw commitment binds; it must be revealed
    # after the draw so anyone can check H(server_seed‖pool_id) == commitment
    # and re-derive seed_used = sha256(server_seed + client_seeds).
    server_seed: int = 0
    # SHA-256 digest of the canonical entry snapshot (user_id, weight,
    # group) actually consumed by this draw — binds the applicant list to
    # the result so post-hoc entry tampering is detectable.
    entries_digest: str = ""


# ─── Commit-reveal v2 constants ───
# Domain-separation tag for the pre-draw seed commitment.
COMMITMENT_DOMAIN_V2 = "pickket-lottery-commit-v2"
SCHEME_COMMIT_REVEAL_V2 = "commit_reveal_v2"
SCHEME_LEGACY_POST_HOC = "legacy_post_hoc_commit"


class LotteryVerifier:
    """Verifiable lottery system (commit-reveal v2).

    Two-phase scheme:
    1. PRE-COMMIT (before entries close / before any draw):
       server_seed is generated and kept private; only
       ``compute_seed_commitment(server_seed, pool_id)`` is published.
       Because the commitment binds the seed *before* the draw, the operator
       cannot re-roll the seed after seeing results without breaking the
       published hash.
    2. EXECUTION: the draw consumes seed_used =
       sha256(server_seed + sorted client_seeds) (or server_seed alone).
    3. REVEAL (after the draw): server_seed, the canonical entry snapshot
       (``entries_digest``), and the winner list are published together with
       a ``result_hash`` binding all of them to the pre-draw commitment.
    4. VERIFY: ``verify_reveal`` checks (a) the revealed server_seed matches
       the pre-draw commitment, (b) re-running the lottery from the revealed
       entries + seed reproduces the recorded winners, and (c) the entry
       snapshot digest matches — any seed re-roll, winner substitution, or
       entry-list tampering after the fact is detected.

    The legacy v1 helpers (``compute_commitment`` / ``verify``) computed the
    commitment at draw time (post-hoc) and only re-hashed the published data;
    they are kept for verifying historical pools and are marked legacy.
    """

    @staticmethod
    def compute_commitment(
        seed: int,
        entries: list[LotteryEntry],
        total_seats: int,
        weights: dict[str, float] | None = None,
        client_seeds: dict[str, str] | None = None,
    ) -> str:
        """Compute SHA-256 commitment hash before lottery execution.

        Args:
            seed: Random seed for the lottery.
            entries: List of LotteryEntry objects.
            total_seats: Number of available slots.
            weights: Optional {user_id: fan_weight} mapping.
            client_seeds: Optional {user_id: client_seed} mapping.

        Returns:
            Hex-encoded SHA-256 hash of the commitment.
        """
        # Deterministic serialization of lottery parameters
        commitment_data = {
            "seed": seed,
            "capacity": total_seats,
            "entries": [
                {
                    "user_id": str(e.user_id),
                    "weight": float(weights.get(e.user_id, 1.0)) if weights else 1.0,
                    "group_size": int(e.group_size),
                    "group_id": str(e.group_id) if e.group_id else None,
                }
                for e in sorted(entries, key=lambda x: str(x.user_id))
            ],
        }
        if client_seeds:
            commitment_data["client_seeds_hash"] = LotteryVerifier.compute_client_seeds_hash(
                client_seeds
            )
        serialized = json.dumps(commitment_data, sort_keys=True, ensure_ascii=True)
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    @staticmethod
    def compute_client_seeds_hash(client_seeds: dict[str, str]) -> str:
        """Compute SHA-256 hash of sorted client seeds.

        Args:
            client_seeds: {user_id: client_seed} mapping.

        Returns:
            Hex-encoded SHA-256 hash.
        """
        sorted_values = [v for _, v in sorted(client_seeds.items())]
        combined = "|".join(sorted_values)
        return hashlib.sha256(combined.encode("utf-8")).hexdigest()

    @staticmethod
    def derive_combined_seed(
        server_seed: int,
        client_seeds: dict[str, str],
    ) -> int:
        """Derive a combined seed from server seed and client seeds.

        Uses SHA-256(server_seed + sorted(client_seeds.values())) converted to int.

        Args:
            server_seed: The server-generated random seed.
            client_seeds: {user_id: client_seed} mapping.

        Returns:
            Combined seed as integer.
        """
        sorted_values = [v for _, v in sorted(client_seeds.items())]
        seed_input = str(server_seed) + "".join(sorted_values)
        hash_hex = hashlib.sha256(seed_input.encode("utf-8")).hexdigest()
        # Use first 15 hex chars to stay within 63-bit range
        return int(hash_hex[:15], 16)

    @staticmethod
    def create_verification_data(
        seed: int,
        entries: list[LotteryEntry],
        total_seats: int,
        weights: dict[str, float] | None = None,
        client_seeds: dict[str, str] | None = None,
    ) -> dict:
        """Create full verification data for post-lottery publication.

        Returns a dict that allows any third party to independently
        reproduce the lottery results.
        """
        data = {
            "seed": seed,
            "capacity": total_seats,
            "entries": [
                {
                    "user_id": str(e.user_id),
                    "weight": float(weights.get(e.user_id, 1.0)) if weights else 1.0,
                    "group_size": int(e.group_size),
                    "group_id": str(e.group_id) if e.group_id else None,
                }
                for e in sorted(entries, key=lambda x: str(x.user_id))
            ],
            "algorithm": "efraimidis_spirakis_weighted_sampling",
            "hash_function": "sha256",
        }
        if client_seeds:
            data["client_seeds"] = {
                uid: cs for uid, cs in sorted(client_seeds.items())
            }
            data["seed_derivation_method"] = "sha256(server_seed + sorted_client_seeds)"
            data["client_seeds_hash"] = LotteryVerifier.compute_client_seeds_hash(client_seeds)
        else:
            data["seed_derivation_method"] = "server_seed_only"
        return data

    # ─── Commit-reveal v2 ───

    @staticmethod
    def compute_seed_commitment(server_seed: int, pool_id: str) -> str:
        """Compute the pre-draw seed commitment (publish BEFORE the draw).

        commitment = SHA-256(domain ‖ pool_id ‖ server_seed). Binding the
        pool_id prevents reusing one commitment across pools.

        Args:
            server_seed: Secret server-generated seed (revealed after draw).
            pool_id: Lottery pool identifier the commitment is bound to.

        Returns:
            Hex-encoded SHA-256 commitment.
        """
        payload = json.dumps(
            {
                "domain": COMMITMENT_DOMAIN_V2,
                "pool_id": str(pool_id),
                "server_seed": int(server_seed),
            },
            sort_keys=True,
            ensure_ascii=True,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    @staticmethod
    def compute_entries_digest(canonical_entries: list[dict], capacity: int) -> str:
        """SHA-256 digest of the canonical entry snapshot + capacity.

        ``canonical_entries`` is the user_id-sorted list of
        {user_id, weight, group_size, group_id} dicts as produced by
        ``create_verification_data`` — i.e. exactly what the draw consumed.

        Returns:
            Hex-encoded SHA-256 digest.
        """
        payload = json.dumps(
            {"capacity": int(capacity), "entries": canonical_entries},
            sort_keys=True,
            ensure_ascii=True,
        )
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    @staticmethod
    def compute_result_hash(
        seed_commitment: str,
        server_seed: int,
        entries_digest: str,
        winners: list[str],
        guaranteed_winners: list[str] | None = None,
    ) -> str:
        """Bind the draw outcome to the pre-draw commitment.

        result_hash = SHA-256(seed_commitment ‖ server_seed ‖
        entries_digest ‖ ordered winner list [‖ sorted guaranteed winners]).
        Changing any of the seed, the entry snapshot, or the winner list
        breaks this hash.

        ``guaranteed_winners`` (pity-guaranteed holders in a *mixed* draw) are
        NOT part of the weighted engine re-run — the engine only reproduces the
        sampled winners. Binding the guaranteed list here is what makes
        post-hoc tampering (injecting/removing a guaranteed winner) detectable:
        any change to the bound list breaks the result_hash even though the
        engine re-run still matches. It is included as a *sorted* stable list
        so binding is order-independent.

        Backward compatibility: when ``guaranteed_winners`` is None or empty the
        key is omitted entirely, so pure-engine / legacy reveals produce exactly
        the same hash as before this field existed.
        """
        payload: dict = {
            "seed_commitment": seed_commitment,
            "server_seed": int(server_seed),
            "entries_digest": entries_digest,
            "winners": [str(w) for w in winners],
        }
        if guaranteed_winners:
            payload["guaranteed_winners"] = sorted(str(w) for w in guaranteed_winners)
        serialized = json.dumps(payload, sort_keys=True, ensure_ascii=True)
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    @staticmethod
    def verify_reveal(
        seed_commitment: str,
        pool_id: str,
        verification_data: dict,
    ) -> dict:
        """Full two-phase verification of a revealed lottery (v2).

        Checks performed:
          - reveal_complete:      all reveal fields are present
          - commitment_valid:     H(server_seed ‖ pool_id) == pre-draw commitment
          - entries_digest_valid: digest(entry snapshot) == recorded digest
          - winners_match:        re-running the lottery from the revealed
                                  entries + server_seed (+ client_seeds)
                                  reproduces the recorded engine winner list
          - waitlist_match:       (if recorded) same for the waitlist order
          - result_hash_valid:    (if recorded) the outcome binding hash holds,
                                  binding the engine winners AND any recorded
                                  guaranteed (pity) winners to the commitment

        Mixed pity+engine draws: ``verification_data["winners"]`` holds only the
        engine-sampled winners (the only thing reproducible by re-running the
        weighted draw). Pity-guaranteed holders are recorded separately in
        ``verification_data["guaranteed_winners"]`` and are bound into the
        ``result_hash`` (not re-sampled, since pity allocation is
        deterministic). Injecting/removing/altering a guaranteed winner after
        the draw therefore breaks ``result_hash_valid`` and is detected.

        Args:
            seed_commitment: The commitment persisted/published before the draw.
            pool_id: The pool identifier the commitment was bound to.
            verification_data: The post-draw reveal payload (must contain
                server_seed, entries, capacity, winners; optionally
                client_seeds, waitlist, entries_digest, result_hash).

        Returns:
            Dict of individual boolean checks plus an aggregate ``is_valid``.
        """
        vd = verification_data or {}
        checks: dict[str, bool] = {}

        required = ("server_seed", "entries", "capacity", "winners")
        checks["reveal_complete"] = bool(seed_commitment) and all(
            vd.get(k) is not None for k in required
        )
        if not checks["reveal_complete"]:
            checks["is_valid"] = False
            return checks

        server_seed = int(vd["server_seed"])
        canonical_entries = vd["entries"]
        capacity = int(vd["capacity"])
        recorded_winners = [str(w) for w in vd["winners"]]

        # ① Reveal matches the pre-draw commitment
        checks["commitment_valid"] = (
            LotteryVerifier.compute_seed_commitment(server_seed, str(pool_id))
            == seed_commitment
        )

        # ② Entry snapshot integrity
        recorded_digest = vd.get("entries_digest", "")
        checks["entries_digest_valid"] = bool(recorded_digest) and (
            LotteryVerifier.compute_entries_digest(canonical_entries, capacity)
            == recorded_digest
        )

        # ③ Independent re-run: seed + snapshot → must reproduce winners
        entries = [
            LotteryEntry(
                user_id=str(item["user_id"]),
                group_id=str(item["group_id"]) if item.get("group_id") else None,
                group_size=int(item.get("group_size", 1)),
            )
            for item in canonical_entries
        ]
        weights = {
            str(item["user_id"]): float(item.get("weight", 1.0))
            for item in canonical_entries
        }
        rerun = run_lottery(
            LotteryPool(
                tier_id=str(vd.get("tier_id", "")),
                entries=entries,
                total_seats=capacity,
                use_fan_weight=True,
            ),
            weights=weights,
            seed=server_seed,
            client_seeds=vd.get("client_seeds") or None,
        )
        checks["winners_match"] = list(rerun.winners) == recorded_winners
        if vd.get("waitlist") is not None:
            checks["waitlist_match"] = list(rerun.waitlist) == [
                str(w) for w in vd["waitlist"]
            ]

        # ④ Outcome binding hash (if recorded).
        #    In a mixed pity+engine draw, the guaranteed (pity) winners are not
        #    reproduced by the engine re-run above (winners_match only covers
        #    the sampled list). They are bound into result_hash instead, so any
        #    post-hoc tampering with the guaranteed list breaks this check.
        recorded_guaranteed = vd.get("guaranteed_winners")
        if recorded_guaranteed is not None:
            recorded_guaranteed = [str(w) for w in recorded_guaranteed]
        if vd.get("result_hash"):
            checks["result_hash_valid"] = vd["result_hash"] == (
                LotteryVerifier.compute_result_hash(
                    seed_commitment,
                    server_seed,
                    recorded_digest,
                    recorded_winners,
                    recorded_guaranteed,
                )
            )

        checks["is_valid"] = all(v for k, v in checks.items() if k != "is_valid")
        return checks

    # ─── Commit-reveal v2: pity-exhausted (no engine draw) ───

    DRAW_MODE_PITY_EXHAUSTED = "pity_exhausted"

    @staticmethod
    def verify_pity_reveal(
        seed_commitment: str,
        pool_id: str,
        verification_data: dict,
    ) -> dict:
        """Verify a v2 pool whose seats were fully consumed by guaranteed
        (pity) winners, so no weighted draw was executed.

        When every available seat is taken by pity-guaranteed holders, the
        backend skips the engine draw entirely — there is no random sampling
        to reproduce. The winner set is the deterministic guaranteed list, so
        fairness here means: the recorded winners are exactly the bound list,
        and the pre-draw commitment was in place before the draw.

        Checks performed:
          - reveal_complete:      required reveal fields are present
          - commitment_valid:     H(server_seed ‖ pool_id) == pre-draw commitment
          - entries_digest_valid: digest(winner snapshot) == recorded digest
          - result_hash_valid:    outcome binding hash holds (winners bound to
                                  the commitment + seed + entry snapshot)

        Unlike ``verify_reveal`` this does NOT re-run the weighted lottery,
        because pity allocation is deterministic, not sampled. Tampering with
        the winner list, the entry snapshot, or the seed still breaks either
        the digest or the result_hash and is detected.

        Args:
            seed_commitment: The commitment persisted/published before the draw.
            pool_id: The pool identifier the commitment was bound to.
            verification_data: The reveal payload (must contain server_seed,
                entries, capacity, winners, entries_digest, result_hash;
                draw_mode == "pity_exhausted").

        Returns:
            Dict of individual boolean checks plus an aggregate ``is_valid``.
        """
        vd = verification_data or {}
        checks: dict[str, bool] = {}

        required = ("server_seed", "entries", "capacity", "winners")
        checks["reveal_complete"] = bool(seed_commitment) and all(
            vd.get(k) is not None for k in required
        )
        if not checks["reveal_complete"]:
            checks["is_valid"] = False
            return checks

        server_seed = int(vd["server_seed"])
        canonical_entries = vd["entries"]
        capacity = int(vd["capacity"])
        recorded_winners = [str(w) for w in vd["winners"]]

        # ① Reveal matches the pre-draw commitment
        checks["commitment_valid"] = (
            LotteryVerifier.compute_seed_commitment(server_seed, str(pool_id))
            == seed_commitment
        )

        # ② Winner snapshot integrity (entries snapshot == guaranteed winners)
        recorded_digest = vd.get("entries_digest", "")
        checks["entries_digest_valid"] = bool(recorded_digest) and (
            LotteryVerifier.compute_entries_digest(canonical_entries, capacity)
            == recorded_digest
        )

        # ③ The recorded winners must be exactly the bound entry snapshot —
        #    every seat went to a guaranteed holder, so the winner list and the
        #    entry snapshot must describe the same users.
        snapshot_users = sorted(str(item["user_id"]) for item in canonical_entries)
        checks["winners_match"] = snapshot_users == sorted(recorded_winners)

        # ④ Outcome binding hash
        checks["result_hash_valid"] = bool(vd.get("result_hash")) and (
            vd["result_hash"]
            == LotteryVerifier.compute_result_hash(
                seed_commitment, server_seed, recorded_digest, recorded_winners
            )
        )

        checks["is_valid"] = all(v for k, v in checks.items() if k != "is_valid")
        return checks

    # ─── Legacy (v1, post-hoc) verification — kept for historical pools ───

    @staticmethod
    def verify(commitment_hash: str, verification_data: dict) -> bool:
        """[LEGACY v1] Re-hash published data against the stored commitment.

        Both values were generated in the same draw call (post-hoc commit),
        so this only proves data integrity, NOT that the seed was fixed
        before the draw. Use ``verify_reveal`` for v2 pools.

        Args:
            commitment_hash: The hash stored alongside the draw.
            verification_data: The full data revealed after lottery.

        Returns:
            True if the commitment matches, False otherwise.
        """
        recomputed_data = {
            "seed": verification_data["seed"],
            "capacity": verification_data["capacity"],
            "entries": verification_data["entries"],
        }
        if "client_seeds_hash" in verification_data:
            recomputed_data["client_seeds_hash"] = verification_data["client_seeds_hash"]
        recomputed = json.dumps(
            recomputed_data,
            sort_keys=True,
            ensure_ascii=True,
        )
        recomputed_hash = hashlib.sha256(recomputed.encode("utf-8")).hexdigest()
        return recomputed_hash == commitment_hash


def run_lottery(
    pool: LotteryPool,
    weights: dict[str, float] | None = None,
    seed: int | None = None,
    client_seeds: dict[str, str] | None = None,
) -> LotteryResult:
    """
    Run weighted or uniform lottery.

    Args:
        pool: Lottery pool with entries and seat count
        weights: {user_id: fan_weight} for weighted lottery
        seed: Random seed for reproducibility
        client_seeds: {user_id: client_seed} for combined seed derivation

    Returns:
        LotteryResult with winners and waitlist
    """
    if not pool.entries or pool.total_seats <= 0:
        return LotteryResult(
            total_applicants=len(pool.entries),
            total_seats=pool.total_seats,
            server_seed=seed or 0,
        )

    if seed is None:
        seed = secrets.randbelow(2**63)

    # F-1: 추첨이 실제로 소비하는 가중치와 커밋/공개 데이터에 기록되는 가중치가
    # 반드시 일치해야 한다. use_fan_weight=False 풀은 모든 항목을 w=1.0으로
    # 추첨하므로, 커밋/검증 데이터에도 동일하게 1.0이 기록되도록 여기서 통일.
    # (이전에는 추첨은 1.0, 기록은 실제 가중치 → 정직한 재현조차 불일치했음)
    effective_weights = weights if (weights and pool.use_fan_weight) else None

    # Derive combined seed from server seed + client seeds
    server_seed = seed
    client_seeds_hash = ""
    if client_seeds:
        seed = LotteryVerifier.derive_combined_seed(server_seed, client_seeds)
        client_seeds_hash = LotteryVerifier.compute_client_seeds_hash(client_seeds)

    rng = random.Random(seed)

    # F-1 방어적 정렬: rng.random() 소비 순서가 엔트리 순회 순서에 의존하므로,
    # 호출자(DB 조회 등)가 어떤 순서로 엔트리를 넘기든 동일 입력 → 동일 결과가
    # 되도록 안정 키(user_id, group_id)로 결정론적 정렬을 보장한다.
    # 이 정렬이 없으면 시드를 기록해도 추첨을 재현할 수 없다 (감사 불가).
    entries = sorted(
        pool.entries,
        key=lambda e: (str(e.user_id), str(e.group_id) if e.group_id else ""),
    )

    # Separate groups and individuals
    groups: dict[str, list[LotteryEntry]] = {}
    individuals: list[LotteryEntry] = []

    for entry in entries:
        if entry.group_id:
            if entry.group_id not in groups:
                groups[entry.group_id] = []
            groups[entry.group_id].append(entry)
        else:
            individuals.append(entry)

    # Build draw list: each item is (user_ids, seats_needed, weight)
    draw_items: list[tuple[list[str], int, float]] = []

    for entry in individuals:
        w = effective_weights.get(entry.user_id, 1.0) if effective_weights else 1.0
        # F-5/오버셀 방어: group_id 없는 개인 응모도 group_size(1~4) 만큼 좌석을 차감해야 한다.
        # 소비자 앱 표준 응모는 group_id 없이 group_size 만 보내는데(메인라인), 이를 항상 1로
        # 처리하면 당첨 후 서비스가 group_size 장의 티켓·주문을 만들어 최대 4배 오버셀이 되고
        # 검증(동일 엔진 재실행)조차 통과한다. orchestrator 경로는 개인 group_size=1 이라 무회귀.
        seats_needed = entry.group_size if entry.group_size > 0 else 1
        draw_items.append(([entry.user_id], seats_needed, w))

    for group_id, members in groups.items():
        leader = members[0]
        user_ids = [m.user_id for m in members]
        group_size = leader.group_size if leader.group_size > 0 else len(members)
        # Group weight = average of member weights
        if effective_weights:
            member_weights = [effective_weights.get(uid, 1.0) for uid in user_ids]
            avg_w = sum(member_weights) / len(member_weights)
        else:
            avg_w = 1.0
        draw_items.append((user_ids, group_size, avg_w))

    # Weighted shuffle
    total_weight = sum(item[2] for item in draw_items)
    if total_weight <= 0:
        total_weight = 1.0

    # Sort by weighted random key (equivalent to weighted sampling without replacement)
    keyed = []
    for item in draw_items:
        user_ids, seats_needed, w = item
        # Weighted shuffle key: -log(uniform) / weight
        # This gives correct weighted sampling without replacement
        u = rng.random()
        while u == 0:
            u = rng.random()
        key = -math.log(u) / (w if w > 0 else 1e-9)
        keyed.append((key, user_ids, seats_needed))

    keyed.sort(key=lambda x: x[0])

    # Allocate seats in order
    remaining_seats = pool.total_seats
    winners: list[str] = []
    waitlist: list[str] = []

    for _, user_ids, seats_needed in keyed:
        if seats_needed <= remaining_seats:
            winners.extend(user_ids)
            remaining_seats -= seats_needed
        else:
            # Group can't fit — skip to waitlist
            waitlist.extend(user_ids)

    # Legacy v1 hash (kept for backward compatibility with stored pools).
    # NOTE: effective_weights (the weights actually consumed) are recorded,
    # so third-party re-runs from the published data match bit-for-bit.
    commitment_hash = LotteryVerifier.compute_commitment(
        seed, pool.entries, pool.total_seats, effective_weights, client_seeds
    )
    verification_data = LotteryVerifier.create_verification_data(
        seed, pool.entries, pool.total_seats, effective_weights, client_seeds
    )

    # ── Commit-reveal v2 bindings ──
    # server_seed: the raw seed the pre-draw commitment binds (reveal target).
    # entries_digest: snapshot of the exact entry list/weights consumed.
    # winners/waitlist: outcome bound into the reveal payload so the verify
    # step can compare an independent re-run against the recorded result.
    entries_digest = LotteryVerifier.compute_entries_digest(
        verification_data["entries"], pool.total_seats
    )
    verification_data.update(
        {
            "scheme": SCHEME_COMMIT_REVEAL_V2,
            "server_seed": server_seed,
            "entries_digest": entries_digest,
            "winners": list(winners),
            "waitlist": list(waitlist),
            "tier_id": str(pool.tier_id),
        }
    )

    return LotteryResult(
        winners=winners,
        waitlist=waitlist,
        seed_used=seed,
        total_applicants=len(pool.entries),
        total_seats=pool.total_seats,
        commitment_hash=commitment_hash,
        verification_data=verification_data,
        client_seeds_hash=client_seeds_hash,
        server_seed=server_seed,
        entries_digest=entries_digest,
    )
