"""
Weighted VCG Allocation — 가중 VCG 배분 모드 (정책 algorithm = "weighted_allocation")
==============================================================================

추첨 풀을 가중 VCG(Vickrey–Clarke–Groves) 메커니즘으로 배분한다. 화면 명칭은 "가중 배분"
(도메인 표준의 대외 금지어 규칙), 코드·기술 명세서 명칭은 가중 VCG 다.

    입찰 b_i  = 응모자가 투입한 AP
    가중치 w_i = 주최사 정책의 가중치(기본·팬 활동·연속 낙첨·누적 시간)
    배분      = argmax Σ w_i·b_i·x_i  s.t. Σ x_i ≤ K     (가중 사회후생 극대화)
    지불      = m_i = w_{K+1}·b_{K+1} / w_i               (가중 2위 가격, AP 단위)

- 당첨자는 투입 AP 전부가 아니라 **VCG 가격만큼만 소각**하고 차액은 돌려받는다.
  낙첨자는 전액 환불(기존 AP 정책과 같음). 그래서 "많이 넣을수록 손해" 가 없고,
  자기 가치대로 투입하는 것이 최선(전략적 정직성, λ=0 일 때 DSIC)이다.
- 동점 처리: 엔진은 (가중 가치 내림차순, bid_id) 로 정렬한다. bid_id 를
  SHA-256(domain|seed|user_id) 로 만들어, 사전 커밋된 시드로 정해지는 무작위 순서가
  동점을 가른다. 운영자는 커밋 후 시드를 바꿀 수 없으므로 동점 순서도 조작할 수 없다.
- 1인 1매 전용: 묶음(그룹) 응모는 단위 분할 시 일부만 배정될 수 있어 지원하지 않는다.
  서비스 계층이 응모 단계에서 그룹 응모를 거부한다.
"""

from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field

from talkfile_engine.vcg import AllocationInput, BidInput, VCGEngine
from talkfile_engine.weight_policy import WeightPolicy

TIEBREAK_DOMAIN = "pickket-vcg-tiebreak-v1"
VCG_ALGORITHM_NAME = "weighted_vcg_second_price"


@dataclass(frozen=True)
class VcgEntry:
    user_id: str
    bid_ap: int
    weight: float


@dataclass
class VcgDrawResult:
    winners: list[str] = field(default_factory=list)  # 순위 순
    waitlist: list[str] = field(default_factory=list)  # 순위 순
    charges: dict[str, int] = field(default_factory=dict)  # 당첨자별 소각 AP
    prices: dict[str, float] = field(default_factory=dict)  # 당첨자별 VCG 가격(실수)
    seed_used: int = 0
    is_strategy_proof: bool = False
    total_social_welfare: float = 0.0
    cutoff_weighted_value: float = 0.0


def tiebreak_key(seed: int, user_id: str) -> str:
    return hashlib.sha256(f"{TIEBREAK_DOMAIN}|{seed}|{user_id}".encode()).hexdigest()


def _rank_key(entry: VcgEntry, seed: int) -> tuple:
    return (-(entry.bid_ap * entry.weight), tiebreak_key(seed, entry.user_id), entry.user_id)


def run_weighted_vcg(
    entries: list[VcgEntry],
    total_seats: int,
    seed: int,
    policy: WeightPolicy,
) -> VcgDrawResult:
    """가중 VCG 배분 실행. 같은 입력 → 같은 결과(재현 가능)."""
    result = VcgDrawResult(seed_used=seed)
    if not entries or total_seats <= 0:
        result.waitlist = [e.user_id for e in sorted(entries, key=lambda e: _rank_key(e, seed))]
        return result

    seen: set[str] = set()
    for e in entries:
        if e.user_id in seen:
            raise ValueError(f"duplicate user in VCG pool: {e.user_id}")
        seen.add(e.user_id)
        if e.bid_ap < 0:
            raise ValueError("bid_ap must be non-negative")

    bids = [
        BidInput(
            bid_id=tiebreak_key(seed, e.user_id),
            user_id=e.user_id,
            max_willingness_to_pay=float(e.bid_ap),
            effective_weight=float(e.weight),
            quantity=1,
        )
        for e in entries
    ]
    output = VCGEngine().allocate(
        AllocationInput(
            bids=bids,
            total_seats=total_seats,
            stabilization_lambda=policy.vcg_stabilization_lambda,
            seed=seed,
        )
    )

    winner_ids = {w.user_id for w in output.winners}
    by_user = {e.user_id: e for e in entries}
    ordered = sorted(entries, key=lambda e: _rank_key(e, seed))
    result.winners = [e.user_id for e in ordered if e.user_id in winner_ids]
    result.waitlist = [e.user_id for e in ordered if e.user_id not in winner_ids]

    for w in output.winners:
        bid_ap = by_user[w.user_id].bid_ap
        price = max(0.0, float(w.final_price))
        # AP 는 정수. 가격을 올림하되 개인 합리성(지불 ≤ 입찰)은 반드시 지킨다.
        charge = min(bid_ap, math.ceil(price - 1e-9))
        result.charges[w.user_id] = charge
        result.prices[w.user_id] = price

    result.is_strategy_proof = output.is_strategy_proof
    result.total_social_welfare = output.total_social_welfare
    if len(ordered) > total_seats:
        cutoff = ordered[total_seats]
        result.cutoff_weighted_value = cutoff.bid_ap * cutoff.weight
    return result


def verify_weighted_vcg(
    entries: list[VcgEntry],
    total_seats: int,
    seed: int,
    policy: WeightPolicy,
    claimed_winners: list[str],
    claimed_charges: dict[str, int] | None = None,
) -> bool:
    """공개된 입력으로 다시 배분해 결과가 같은지 확인한다."""
    redo = run_weighted_vcg(entries, total_seats, seed, policy)
    if redo.winners != list(claimed_winners):
        return False
    return claimed_charges is None or redo.charges == dict(claimed_charges)


# ─── Commit-reveal v2 연동 ───
# 공개 검증 데이터의 algorithm 값. 대외 표기 규칙상 중립 명칭을 쓴다.
PUBLIC_ALGORITHM_ID = "weighted_allocation_v1"


def run_allocation_draw(
    entries: list[VcgEntry],
    total_seats: int,
    server_seed: int,
    policy: WeightPolicy,
    tier_id: str,
    client_seeds: dict[str, str] | None = None,
) -> tuple[VcgDrawResult, dict]:
    """사전 커밋 시드로 가중 배분을 실행하고 commit-reveal v2 공개 데이터를 만든다.

    시드 = server_seed (응모자 client_seed 가 있으면 SHA-256 결합 — 가중 추첨과 같은 규칙).
    공개 데이터의 entries 는 user_id 정렬 스냅숏이며 투입 AP(`ap`)를 포함한다.
    """
    from talkfile_engine.lottery import SCHEME_COMMIT_REVEAL_V2, LotteryVerifier

    seed = (
        LotteryVerifier.derive_combined_seed(server_seed, client_seeds)
        if client_seeds
        else server_seed
    )
    result = run_weighted_vcg(entries, total_seats, seed, policy)
    canonical = [
        {"user_id": e.user_id, "weight": float(e.weight), "group_size": 1, "group_id": None, "ap": int(e.bid_ap)}
        for e in sorted(entries, key=lambda x: x.user_id)
    ]
    data = {
        "scheme": SCHEME_COMMIT_REVEAL_V2,
        "algorithm": PUBLIC_ALGORITHM_ID,
        "hash_function": "sha256",
        "seed": seed,
        "server_seed": server_seed,
        "seed_derivation_method": "sha256_server_plus_client" if client_seeds else "server_seed_only",
        "capacity": int(total_seats),
        "entries": canonical,
        "entries_digest": LotteryVerifier.compute_entries_digest(canonical, total_seats),
        "winners": list(result.winners),
        "waitlist": list(result.waitlist),
        "charges": dict(result.charges),
        "is_strategy_proof": bool(result.is_strategy_proof),
        "stabilization_lambda": policy.vcg_stabilization_lambda,
        "tier_id": tier_id,
    }
    if client_seeds:
        data["client_seeds"] = dict(client_seeds)
    return result, data


def verify_allocation_reveal(seed_commitment: str, pool_id: str, verification_data: dict) -> dict:
    """가중 배분 풀의 commit-reveal v2 검증. 가중 추첨의 verify_reveal 과 같은 항목을 본다."""
    from talkfile_engine.lottery import LotteryVerifier

    vd = verification_data or {}
    checks: dict[str, bool] = {}
    required = ("server_seed", "entries", "capacity", "winners", "charges")
    checks["reveal_complete"] = bool(seed_commitment) and all(vd.get(k) is not None for k in required)
    if not checks["reveal_complete"]:
        checks["is_valid"] = False
        return checks

    server_seed = int(vd["server_seed"])
    capacity = int(vd["capacity"])
    canonical = vd["entries"]
    checks["commitment_valid"] = (
        LotteryVerifier.compute_seed_commitment(server_seed, str(pool_id)) == seed_commitment
    )
    recorded_digest = vd.get("entries_digest", "")
    checks["entries_digest_valid"] = bool(recorded_digest) and (
        LotteryVerifier.compute_entries_digest(canonical, capacity) == recorded_digest
    )
    entries = [
        VcgEntry(user_id=str(e["user_id"]), bid_ap=int(e.get("ap", 0)), weight=float(e["weight"]))
        for e in canonical
    ]
    client_seeds = vd.get("client_seeds") or None
    seed = LotteryVerifier.derive_combined_seed(server_seed, client_seeds) if client_seeds else server_seed
    policy = WeightPolicy(
        algorithm="weighted_allocation",
        vcg_stabilization_lambda=float(vd.get("stabilization_lambda", 0.0)),
    )
    redo = run_weighted_vcg(entries, capacity, seed, policy)
    checks["winners_match"] = redo.winners == [str(w) for w in vd["winners"]]
    if vd.get("waitlist") is not None:
        checks["waitlist_match"] = redo.waitlist == [str(w) for w in vd["waitlist"]]
    checks["charges_match"] = redo.charges == {str(k): int(v) for k, v in vd["charges"].items()}
    if vd.get("result_hash"):
        recorded_guaranteed = vd.get("guaranteed_winners")
        checks["result_hash_valid"] = vd["result_hash"] == LotteryVerifier.compute_result_hash(
            seed_commitment,
            server_seed,
            recorded_digest,
            [str(w) for w in vd["winners"]],
            [str(w) for w in recorded_guaranteed] if recorded_guaranteed else None,
        )
    checks["is_valid"] = all(v for k, v in checks.items() if k != "is_valid")
    return checks
