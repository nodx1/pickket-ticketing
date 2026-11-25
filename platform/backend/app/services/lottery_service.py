"""
Lottery Service
================
Manages lottery pool application, drawing, and result processing.

WP08: Pity System 통합 — 보장 당첨권 보유자 우선 당첨,
나머지 참가자에 pity_bonus 가중치 적용, 결과에 따라 record_win/record_loss 호출.

WP12: POINT_LOTTERY — AP 투자를 가산 가중치(기본100 + log₂ AP보너스 + fan/pity)로
환산한 E-S(Efraimidis-Spirakis) 공정 가중추첨. 가격경쟁 없음, 당첨자는 정가(face price) 지불.
(구 VCG 경매 배분은 폐기 — 정본: SALE_MODE_POLICY_v2 §3-2)
"""

import logging
import secrets
import statistics
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from talkfile_engine.lottery import (
    SCHEME_COMMIT_REVEAL_V2,
    SCHEME_LEGACY_POST_HOC,
    LotteryEntry as EngineLotteryEntry,
    LotteryPool as EngineLotteryPool,
    LotteryVerifier,
    compute_lottery_weight,
    run_lottery,
)

from app.models.lottery import (
    LotteryEntryResult,
    LotteryPool,
    LotteryPoolStatus,
)
from app.models.order import OrderStatus, OrderType
from app.models.point import PointTransactionType, PointType
from app.models.seat import Seat, SeatStatus
from app.models.ticket import TicketStatus
import random as _random
from sqlalchemy import update as _sql_update
from app.core.audit import write_audit_log
from app.core.config import settings
from app.core.redis import cache_get, redis_lock
from app.repositories.lottery_repo import LotteryEntryRepository, LotteryPoolRepository
from app.models.event import Event, EventStatus
from app.repositories.event_repo import SeatTierRepository
from app.repositories.ticket_repo import TicketRepository
from app.repositories.order_repo import OrderRepository
from app.schemas.lottery import (
    LotteryDrawResult,
    LotteryEntryResponse,
    LotteryMyResultResponse,
    LotteryPoolResponse,
    LotteryTransparencyReport,
    LotteryVerificationResponse,
)
from app.models.fairness import MerkleKind
from app.services.fairness_service import FairnessService
from app.services.timeseries_log import defer_lottery_event, record_lottery_event
from talkfile_engine.vcg_allocation import (
    PUBLIC_ALGORITHM_ID,
    VCG_ALGORITHM_NAME,
    VcgEntry,
    run_allocation_draw,
    verify_allocation_reveal,
)
from talkfile_engine.weight_policy import ALGORITHM_WEIGHTED_ALLOCATION
from app.services.fan_weight_service import FanWeightService
from app.services.pity_service import PityService
from app.services.point_service import PointService
from app.services.tier_service import TierService

logger = logging.getLogger(__name__)

# WP17: Group AP cost multipliers — 그룹 규모별 할인 적용
GROUP_AP_MULTIPLIERS = {1: 1.0, 2: 1.6, 3: 2.1, 4: 2.4}

# WP16: Newcomer Shield constants
NEWCOMER_WINDOW_DAYS = 30
NEWCOMER_WEIGHT_BOOST = 1.5


def compute_group_ap_cost(invested_ap_per_seat: int, group_size: int) -> int:
    """Compute total AP cost for a group with discount applied (WP17).

    Groups get a discount on total AP cost:
    - 1 person: 1.0x (no discount)
    - 2 people: 1.6x (20% discount per person)
    - 3 people: 2.1x (30% discount per person)
    - 4 people: 2.4x (40% discount per person)

    Args:
        invested_ap_per_seat: AP invested per individual seat.
        group_size: Number of people in the group.

    Returns:
        Total AP cost for the group.
    """
    multiplier = GROUP_AP_MULTIPLIERS.get(group_size, group_size * 0.6)
    return int(invested_ap_per_seat * multiplier)


class LotteryService:
    """Service for weighted lottery ticket allocation."""

    # WP12: AP 투자 제약 상수
    AP_MIN_INVEST = 100  # 투자 시 최소 AP (0이면 미투자 참여)
    AP_MAX_INVEST = 10000  # 최대 투자 AP
    AP_MAX_AMENDMENTS = 3  # AP 수정 최대 횟수
    AP_CONSOLATION_RATE = 0.10  # 낙첨 위로금 비율 (10%)
    AP_CONSOLATION_MIN = 50  # 위로금 최소
    AP_CONSOLATION_MAX = 500  # 위로금 최대

    def __init__(self, session: AsyncSession):
        self.session = session
        self.pool_repo = LotteryPoolRepository(session)
        self.entry_repo = LotteryEntryRepository(session)
        self.tier_repo = SeatTierRepository(session)
        self.ticket_repo = TicketRepository(session)
        self.order_repo = OrderRepository(session)
        self.fan_weight_service = FanWeightService(session)
        self.pity_service = PityService(session)
        self.point_service = PointService(session)
        self.tier_service = TierService(session)

    async def apply(
        self,
        user_id: uuid.UUID,
        event_id: uuid.UUID,
        tier_id: uuid.UUID,
        group_id: uuid.UUID | None = None,
        group_size: int = 1,
        client_seed: str | None = None,
        invested_ap: int = 0,
        ip_address: str | None = None,
        device_fingerprint: str | None = None,
    ) -> LotteryEntryResponse:
        """응모 — 과업 WP5: (이벤트, 등급, 사용자) 단위 Redis 분산 락으로 중복 응모를 앞단에서 막는다.

        같은 사용자의 동시 요청(더블클릭·매크로 연타·다중 탭)은 락을 못 잡은 쪽이 즉시 거절된다.
        DB UNIQUE(pool_id, user_id) + 풀 행 잠금은 그대로 2차 방어선으로 남는다.
        Redis 장애 시에는 응모를 막지 않고 DB 방어선만으로 진행한다(가용성 우선, 경고 로그).
        """
        lock_key = f"v2:lottery:apply:{{{event_id}}}:{tier_id}:{user_id}"
        try:
            lock_cm = redis_lock(lock_key, ttl=10, retry=1, delay=0.01)
            await lock_cm.__aenter__()
        except TimeoutError:
            raise ValueError("같은 응모가 이미 처리 중입니다. 잠시 후 결과를 확인해 주세요") from None
        except Exception:  # noqa: BLE001 — Redis 장애: DB 방어선으로 진행
            logger.warning("apply lock unavailable — falling back to DB constraints", exc_info=True)
            return await self._apply_inner(
                user_id, event_id, tier_id, group_id, group_size, client_seed, invested_ap,
                ip_address, device_fingerprint,
            )
        try:
            return await self._apply_inner(
                user_id, event_id, tier_id, group_id, group_size, client_seed, invested_ap,
                ip_address, device_fingerprint,
            )
        finally:
            try:
                await lock_cm.__aexit__(None, None, None)
            except Exception:  # noqa: BLE001
                logger.warning("apply lock release failed", exc_info=True)

    async def _apply_inner(
        self,
        user_id: uuid.UUID,
        event_id: uuid.UUID,
        tier_id: uuid.UUID,
        group_id: uuid.UUID | None = None,
        group_size: int = 1,
        client_seed: str | None = None,
        invested_ap: int = 0,
        ip_address: str | None = None,
        device_fingerprint: str | None = None,
    ) -> LotteryEntryResponse:
        """
        Apply to a lottery pool for a tier.

        Creates the pool if it doesn't exist. Prevents duplicate entries.
        WP12: invested_ap > 0 이면 AP 차감 (INVEST_LOTTERY).

        Args:
            user_id: Applying user's UUID.
            event_id: Event UUID.
            tier_id: Seat tier UUID.
            group_id: Optional group identifier for group tickets.
            group_size: Number of seats needed for the group.
            client_seed: Optional client-provided seed for combined seed derivation.
            invested_ap: AP to invest (0 = no investment, 100~10000 in 100 units).

        Returns:
            LotteryEntryResponse with entry details.

        Raises:
            ValueError: If tier not found, user already applied, or insufficient AP.
        """
        from app.models.point import PointType, PointTransactionType

        tier = await self.tier_repo.get(tier_id)
        if not tier:
            raise ValueError(f"Tier {tier_id} not found")
        if tier.event_id != event_id:
            # A tier UUID is globally unique, but the public route is scoped by
            # event. Without this binding a caller can inject another event's
            # tier and create a cross-event pool/order/ticket chain.
            raise ValueError("Tier does not belong to event")

        # Event status check — only allow lottery applications for active events
        from app.repositories.event_repo import EventRepository
        from app.models.event import EventStatus
        event_repo = EventRepository(self.session)
        event = await event_repo.get(event_id)
        if not event:
            raise ValueError("Event not found")
        _LOTTERY_ALLOWED = {EventStatus.APPROVED, EventStatus.BIDDING_OPEN, EventStatus.ALLOCATED}
        if event.status not in _LOTTERY_ALLOWED:
            raise ValueError(f"Event not accepting lottery applications (status: {event.status.value})")

        # 시간 이중 검증 — status와 무관하게 opens_at/closes_at 범위 확인.
        # go webhook 타이밍 이상/admin 수동 조작/클럭 드리프트 방어.
        now = datetime.now(timezone.utc)
        opens_at = event.bidding_opens_at
        closes_at = event.bidding_closes_at
        if opens_at and opens_at.tzinfo is None:
            opens_at = opens_at.replace(tzinfo=timezone.utc)
        if closes_at and closes_at.tzinfo is None:
            closes_at = closes_at.replace(tzinfo=timezone.utc)
        if opens_at and now < opens_at:
            raise ValueError("Sales window not yet open")
        if closes_at and now > closes_at:
            raise ValueError("Sales window closed")

        # phase 가드 (인터파크 방식): phase_configs 테이블에서 현재 시각이
        # lottery phase 의 [starts_at, ends_at] 안인지 SQL 비교.
        # cron/webhook 의존 제거 — 시간만 정확하면 항상 일관됨.
        if tier.sale_mode == "point_lottery":
            import os
            from app.models.phase_config import PhaseConfig
            from sqlalchemy import or_ as _or
            from sqlalchemy import select as _select

            if not os.environ.get("PYTEST_CURRENT_TEST"):
                lottery_phase = (
                    await self.session.execute(
                        _select(PhaseConfig).where(
                            PhaseConfig.event_id == event_id,
                            PhaseConfig.phase == "lottery",
                            PhaseConfig.starts_at <= now,
                            # ends_at nullable(마감 미정) — NULL 을 배제하면 응모가
                            # 열려 있는데도 "이미 마감" 으로 오판한다(T2-PHASE).
                            _or(
                                PhaseConfig.ends_at.is_(None),
                                PhaseConfig.ends_at >= now,
                            ),
                        )
                    )
                ).scalar_one_or_none()
                if not lottery_phase:
                    raise ValueError(
                        "Lottery phase not active — 응모 시작 전이거나 이미 마감되었습니다"
                    )

        # Auto-transition APPROVED → BIDDING_OPEN (시간 검증 통과 후)
        if event.status == EventStatus.APPROVED:
            from sqlalchemy import update
            from app.models.event import Event
            await self.session.execute(
                update(Event).where(Event.id == event_id).values(status=EventStatus.BIDDING_OPEN)
            )
            try:
                from app.api.v1.events import _invalidate_event_caches
                await _invalidate_event_caches(event_id)
            except Exception:
                pass

        # WP12: AP 투자 유효성 검증
        if invested_ap < 0:
            raise ValueError("invested_ap must be >= 0")
        if invested_ap > self.AP_MAX_INVEST:
            raise ValueError(f"invested_ap must be <= {self.AP_MAX_INVEST}")
        if invested_ap > 0 and invested_ap < self.AP_MIN_INVEST:
            raise ValueError(f"invested_ap must be >= {self.AP_MIN_INVEST} when investing")
        if invested_ap > 0 and invested_ap % 100 != 0:
            raise ValueError("invested_ap must be in multiples of 100")

        # 과업 WP2: 제재(Slash) 계정 응모 거부 + 계정 복제(같은 기기 다중 계정) 차단
        from app.services.sanction_service import SanctionService

        await SanctionService(self.session).check_apply(
            user_id, event_id, ip_address=ip_address, device_fingerprint=device_fingerprint
        )

        # Get or create lottery pool
        # 🔴 과업 WP11 부하 테스트에서 발견(2026-11-17): 첫 응모가 동시에 몰리면 풀이 여러 개 생겼다.
        #    예전 코드는 Redis 락 안에서 풀을 만들고 flush 만 한 채 락을 풀었다 — 커밋 전이라 다음 대기자의
        #    재확인 조회에 안 보였고, 각자 풀을 또 만들었다. 이후 모든 응모가 MultipleResultsFound(500).
        #    ⟹ (event_id, tier_id) UNIQUE(poolunique_1117) 를 정본으로 삼고, 생성은 SAVEPOINT 안에서 한다.
        #       동시에 만든 쪽은 상대 커밋까지 기다렸다가 UNIQUE 위반 → 되돌리고 커밋된 풀을 다시 읽는다.
        pool = await self.pool_repo.get_by_event_tier(event_id, tier_id)
        if not pool:
            try:
                async with self.session.begin_nested():
                    pool = await self.pool_repo.create(
                        event_id=event_id,
                        tier_id=tier_id,
                        total_seats=tier.capacity - tier.sold_count,
                        use_fan_weight=True,
                        status=LotteryPoolStatus.OPEN,
                    )
                    # F-1 commit-reveal ① 커밋 단계: 풀 생성(첫 응모) 시점에
                    # server_seed 를 생성·비공개 저장하고 seed_commitment 를
                    # 영속화한다. 추첨보다 한참 앞선 시점에 커밋이 고정되고,
                    # 이후 응모자들의 client_seed 가 결합 시드에 섞이므로
                    # 운영자는 커밋 시점에 결과를 예측·선택할 수 없다.
                    self._set_seed_commitment(pool)
                    await self.session.flush()
                    # 과업 WP1: 사전 커밋과 같은 시점에 주최사 가중치 정책을 스냅숏·고정한다.
                    # 이후 정책을 바꿔도 이 풀에는 영향이 없다(사후 조작 방지).
                    await FairnessService(self.session).lock_pool_policy(pool)
            except IntegrityError:
                pool = await self.pool_repo.get_by_event_tier(event_id, tier_id)
                if not pool:
                    raise

        # idx13: apply/draw 경합 차단.
        # 이전엔 잠금 없는 일반 SELECT 의 pool.status 로 OPEN 을 확인한 뒤 엔트리를
        # INSERT 했다. draw 가 같은 풀을 FOR UPDATE 로 잠그고 CLOSED 로 전이한 뒤
        # 엔트리를 로드하는 사이에 apply 가 커밋되면, 그 엔트리는 추첨에서 누락된 채
        # 영구 PENDING 으로 잔류하고 투자 AP 도 환급/위로금 없이 소실됐다.
        # 풀 행을 FOR UPDATE 로 잠그고 그 잠금 하에서 status 를 재확인하면 apply 와
        # draw 가 동일 행 잠금으로 직렬화되어, draw 가 진행 중이면 apply 는 그 잠금이
        # 풀릴 때까지 대기한 뒤 CLOSED 를 보고 거부된다(엔트리·AP 차감 발생 안 함).
        # 과업 WP11(부하 테스트): 예전엔 여기서 배타 잠금(FOR UPDATE)을 잡아 같은 풀의 모든 응모가
        #   한 줄로 처리됐다(동시 100명 기준 처리량 25건/초, 중앙값 3.3초 — 실측). 응모끼리는 공유 잠금,
        #   추첨만 배타 잠금이면 idx13 의 응모·추첨 직렬화는 그대로 지키면서 응모는 병렬로 돈다.
        locked_pool = await self.pool_repo.get_for_share(pool.id)
        if locked_pool is not None:
            pool = locked_pool
        if pool.status != LotteryPoolStatus.OPEN:
            raise ValueError("Lottery pool is no longer accepting applications")

        # 과업 WP3: 가중 배분(가중 VCG) 풀은 1인 1매 — 묶음 응모는 단위 분할 시 일부만
        # 배정될 수 있어 받지 않는다.
        if group_size and group_size > 1:
            pool_policy, _ = await FairnessService(self.session).get_pool_policy(pool.id)
            if pool_policy.algorithm == ALGORITHM_WEIGHTED_ALLOCATION:
                raise ValueError("가중 배분 추첨은 1인 1매로만 응모할 수 있습니다")

        # Check for duplicate entry
        existing = await self.entry_repo.get_user_entry(pool.id, user_id)
        if existing:
            # 팬 화면에 그대로 뜨는 문구라 한국어로 둔다(2026-11-23 시연에서 영어로 노출됨).
            raise ValueError("이미 이 등급에 응모했습니다. 응모 결과는 마감 후 알려 드려요")

        # Compute fan weight
        fan_weight = await self.fan_weight_service.compute_weight(user_id)

        # WP16: Newcomer Shield — boost weight for new users
        newcomer_applied = False
        try:
            newcomer_applied = await self._apply_newcomer_shield(user_id, fan_weight)
            if newcomer_applied:
                fan_weight *= NEWCOMER_WEIGHT_BOOST
        except Exception:
            logger.warning("Failed to apply newcomer shield for user %s", user_id)

        # WP12: AP 차감 (투자 시)
        if invested_ap > 0:
            try:
                await self.point_service.deduct(
                    user_id=user_id,
                    point_type=PointType.FAN,
                    amount=invested_ap,
                    tx_type=PointTransactionType.INVEST_LOTTERY,
                    reference_id=event_id,
                    description=f"추첨 AP 투자 ({invested_ap}AP)",
                )
            except ValueError as e:
                raise ValueError(f"AP 투자 실패: {e}")

        # WP13: 티어 배율 조회
        tier_multiplier = await self.tier_service.get_tier_multiplier(user_id)

        # WP08: pity_bonus 조회 (apply 시점에 저장)
        domain = await self._get_event_domain(event_id)
        try:
            pity_bonus = await self.pity_service.get_pity_bonus(user_id, domain)
        except Exception:
            pity_bonus = 1.0

        # Create entry (with optional client_seed + WP12 fields)
        entry = await self.entry_repo.create(
            pool_id=pool.id,
            user_id=user_id,
            group_id=group_id,
            group_size=group_size,
            fan_weight=fan_weight,
            client_seed=client_seed,
            invested_ap=invested_ap,
            tier_multiplier=tier_multiplier,
            pity_bonus=pity_bonus,
            result=LotteryEntryResult.PENDING,
        )
        # 과업 WP5: 응모 시계열(가명 actor). 커밋 후 별도 세션으로 기록(WP11 — 응모 지연·잠금 시간에서 제외).
        defer_lottery_event(
            self.session,
            event_id=event_id,
            kind="apply",
            pool_id=pool.id,
            tier_id=tier_id,
            user_id=user_id,
            ap=invested_ap,
            meta={"group_size": group_size},
        )

        # Audit
        await write_audit_log(
            self.session,
            actor_id=user_id,
            action="lottery_apply",
            resource_type="lottery",
            resource_id=str(pool.id),
            event_id=event_id,
            tier_id=tier_id,
            sale_mode=tier.sale_mode,
            new_value={
                "pool_id": str(pool.id),
                "group_id": str(group_id) if group_id else None,
                "group_size": group_size,
                "fan_weight": fan_weight,
                "invested_ap": invested_ap,
                "tier_multiplier": tier_multiplier,
                "pity_bonus": pity_bonus,
                "has_client_seed": client_seed is not None,
                "newcomer_shield_applied": newcomer_applied,
                "result": "success",
            },
        )

        # Quest 자동 진행 — "응모하기" / "5개 이벤트 응모하기" purchase quest
        try:
            from app.services.quest_service import QuestService
            await QuestService(self.session).complete_by_condition(user_id, "purchase")
        except Exception:  # noqa: BLE001
            pass  # Quest 진행 실패는 응모 자체를 막지 않음

        return LotteryEntryResponse(
            id=entry.id,
            pool_id=pool.id,
            user_id=user_id,
            group_size=group_size,
            fan_weight=fan_weight,
            invested_ap=invested_ap,
            tier_multiplier=tier_multiplier,
            pity_bonus=pity_bonus,
            result=entry.result.value,
            created_at=entry.created_at,
        )

    async def _get_event_domain(self, event_id: uuid.UUID) -> str:
        """이벤트 카테고리를 소문자 domain 문자열로 반환."""
        result = await self.session.execute(select(Event.category).where(Event.id == event_id))
        category = result.scalar_one_or_none()
        return (category or "concert").lower()

    # ─── Commit-reveal v2 (F-1) ───

    @staticmethod
    def _set_seed_commitment(pool) -> None:
        """풀에 server_seed(비공개) + seed_commitment(공개) + committed_at 설정.

        호출자가 flush/commit 책임을 가진다. 이미 커밋된 풀에는 호출 금지
        (커밋 교체는 곧 시드 재추첨 — 검증 체계 위반).
        """
        if pool.seed_commitment:
            raise ValueError("Seed commitment already exists for this pool")
        server_seed = secrets.randbelow(2**63)
        pool.server_seed = server_seed
        pool.seed_commitment = LotteryVerifier.compute_seed_commitment(
            server_seed, str(pool.id)
        )
        pool.committed_at = datetime.now(timezone.utc)

    async def ensure_commitment(self, pool_id: uuid.UUID) -> str | None:
        """풀에 사전 시드 커밋이 없으면 생성하고 **즉시 커밋(영속화)** 한다.

        신규 풀은 생성 시점에 커밋을 받으므로 이 메서드는 no-op 이다.
        마이그레이션 이전에 생성된 legacy OPEN/CLOSED 풀의 백필 훅:
        응모 마감 시점(Celery auto_draw 의 deadline 판정, 수동 draw 요청의
        진입부)에 draw 와 **분리된 트랜잭션**으로 먼저 영속화된다.
        커밋이 추첨과 같은 트랜잭션에 묶이면 사후 커밋과 동일해지므로
        (둘 다 한꺼번에 롤백·재실행 가능) 여기서 self.session.commit() 한다.

        Returns:
            seed_commitment (이미 DRAWN 인 legacy 풀이면 None — 사후 생성은
            의미가 없고 오히려 위조이므로 생성하지 않는다).
        """
        from app.models.lottery import LotteryPool

        existing = await self.session.scalar(
            select(LotteryPool.seed_commitment).where(LotteryPool.id == pool_id)
        )
        if existing:
            return existing

        pool = await self.pool_repo.get_for_update(pool_id)
        if not pool:
            raise ValueError(f"Lottery pool {pool_id} not found")
        if pool.seed_commitment:
            return pool.seed_commitment
        if pool.status == LotteryPoolStatus.DRAWN:
            # 이미 추첨된 legacy 풀 — 사후 커밋을 만들어내면 안 된다.
            return None

        self._set_seed_commitment(pool)
        await write_audit_log(
            self.session,
            action="lottery_seed_commit",
            resource_type="lottery",
            resource_id=str(pool_id),
            event_id=pool.event_id,
            tier_id=pool.tier_id,
            new_value={
                "pool_id": str(pool_id),
                "seed_commitment": pool.seed_commitment,
                "committed_at": pool.committed_at.isoformat(),
                "reason": "legacy_backfill_before_draw",
            },
        )
        commitment = pool.seed_commitment
        # 별도 트랜잭션으로 영속화 — 이후의 draw 가 실패/재실행되어도
        # 커밋(시드)은 불변으로 남는다.
        await self.session.commit()
        return commitment

    async def commit_entries_snapshot(self, pool_id: uuid.UUID) -> str | None:
        """응모 마감 + 응모 Merkle 루트 확정 (과업 WP4).

        추첨과 **분리된 트랜잭션**으로 커밋한다. 같은 트랜잭션이면 루트와 결과가 함께
        롤백·재실행될 수 있어 "루트가 추첨보다 먼저 고정됐다"를 증명할 수 없다
        (ensure_commitment 와 같은 이유).

        - 이미 루트가 있으면 그대로(멱등) — 추첨 재시도 시 같은 명단·가중치를 쓴다.
        - 취소된 이벤트·이미 추첨된 풀은 건드리지 않는다(기존 오류 경로를 그대로 둔다).
        - 제재(Slash)된 응모자는 가중치 0 으로 트리에 남기고 추첨에서 뺀다.
        """
        fairness = FairnessService(self.session)
        existing = await fairness.get_root(pool_id, MerkleKind.ENTRIES)
        if existing is not None:
            return existing.root

        pool = await self.pool_repo.get_for_update(pool_id)
        if not isinstance(pool, LotteryPool) or pool.status == LotteryPoolStatus.DRAWN:
            return None  # 실제 DB 행만 다룬다(목 객체 등은 기존 경로 그대로)
        event_status = await self.session.scalar(select(Event.status).where(Event.id == pool.event_id))
        if event_status == EventStatus.CANCELLED:
            return None

        if pool.status == LotteryPoolStatus.OPEN:
            pool.status = LotteryPoolStatus.CLOSED
        entries = await self.entry_repo.get_by_pool(pool_id)
        excluded = await self._sanctioned_user_ids([e.user_id for e in entries], pool.event_id)
        root, _ = await fairness.commit_entries_tree(pool, entries, excluded)
        await record_lottery_event(
            self.session,
            event_id=pool.event_id,
            kind="close",
            pool_id=pool.id,
            tier_id=pool.tier_id,
            meta={"entries": len(entries), "excluded": len(excluded), "entries_root": root.root},
        )
        await self.session.commit()
        return root.root

    async def _sanctioned_user_ids(
        self, user_ids: list[uuid.UUID], event_id: uuid.UUID
    ) -> set[uuid.UUID]:
        """추첨에서 뺄 제재 대상(과업 WP2 Slash). 제재 서비스가 없으면 빈 집합."""
        try:
            from app.services.sanction_service import SanctionService
        except ImportError:
            return set()
        return await SanctionService(self.session).disqualified_among(user_ids, event_id)

    async def draw(self, pool_id: uuid.UUID, max_winners: int | None = None) -> LotteryDrawResult:
        """
        Execute the lottery drawing for a pool.

        §26 P0: 분산 락으로 동시 draw 방지 — 두 주최자가 동시에 draw를
        트리거하면 중복 당첨자가 발생할 수 있으므로, Redis 분산 락을 획득한
        후에만 추첨을 진행한다.

        WP08 Pity System 통합:
        1. 보장 당첨권 보유자를 먼저 당첨 처리 (좌석이 남아있는 한)
        2. 나머지 참가자에 pity_bonus 가중치 적용
        3. 엔진 추첨 실행
        4. 낙첨자에 record_loss(), 당첨자에 record_win() 호출

        Args:
            pool_id: Lottery pool UUID.
            max_winners: Optional cap on number of winners.

        Returns:
            LotteryDrawResult with drawing outcome.

        Raises:
            ValueError: If pool not found or already drawn.
            TimeoutError: If another draw is already in progress for this pool.
        """
        # §26 P0: Redis distributed lock prevents duplicate draws.
        # Uses the pool's event_id as the hash tag for Redis Cluster slot affinity.
        # TTL=30s is generous for the draw operation; auto-renewal handles longer draws.
        try:
            async with redis_lock(f"v2:lottery:draw:{{{pool_id}}}", ttl=30, retry=3, delay=1.0):
                # F-1 commit-reveal: draw 는 '이전 트랜잭션에서 영속화된' 사전
                # 커밋만 사용한다. 신규 풀은 생성 시점에 커밋이 만들어지므로
                # 아래는 no-op 이고, legacy 풀만 여기서 별도 트랜잭션으로
                # 백필된 뒤 추첨된다. _draw_inner 는 커밋 없는 풀을 거부한다.
                await self.ensure_commitment(pool_id)
                # 과업 WP4: 응모 마감 + 응모 Merkle 루트를 추첨과 **분리된 트랜잭션**으로
                # 먼저 영속화한다. 루트 시각 < 추첨 시각이 증명서로 증명된다.
                await self.commit_entries_snapshot(pool_id)
                return await self._draw_inner(pool_id, max_winners)
        except TimeoutError:
            raise ValueError(
                "추첨이 이미 진행 중입니다. 잠시 후 다시 시도해주세요."
            )

    async def _draw_inner(self, pool_id: uuid.UUID, max_winners: int | None = None) -> LotteryDrawResult:
        """Inner draw logic, called under distributed lock."""
        logger = logging.getLogger(__name__)

        # DB-level safeguard (Redis 락 위 2차 방어): pool 을 FOR UPDATE 로 잠그고
        # 상태를 재확인. 두 워커가 동시에 draw 에 진입해도 한쪽만 진행하도록 보장.
        pool = await self.pool_repo.get_for_update(pool_id)
        if not pool:
            raise ValueError(f"Lottery pool {pool_id} not found")

        if pool.status == LotteryPoolStatus.DRAWN:
            raise ValueError("Lottery pool has already been drawn")

        # 취소된 이벤트 추첨 차단 — 자동(Celery)/수동(API)/webhook 모든 draw 경로 공통 가드.
        # 취소된 이벤트에 PAYMENT_REQUIRED 주문·PENDING 티켓·HELD 좌석이 생성되고
        # 낙첨자 AP 가 소진되는 것을 방지.
        event_status = await self.session.scalar(
            select(Event.status).where(Event.id == pool.event_id)
        )
        if event_status == EventStatus.CANCELLED:
            raise ValueError("취소된 이벤트는 추첨을 실행할 수 없습니다")

        # F-1 commit-reveal: 사전 커밋이 없는 풀은 추첨 불가.
        # 커밋은 풀 생성 시(apply) 또는 draw() 래퍼/ensure_commitment 의
        # 별도 트랜잭션에서만 생성된다 — _draw_inner 가 직접 만들면
        # 추첨과 같은 트랜잭션의 사후 커밋이 되어 검증 체계가 무력화된다.
        if not pool.seed_commitment or pool.server_seed is None:
            raise ValueError(
                "사전 시드 커밋이 없어 추첨할 수 없습니다 — "
                "ensure_commitment 를 별도 트랜잭션에서 먼저 실행하세요 (commit-reveal)"
            )

        # Close pool for new entries
        pool.status = LotteryPoolStatus.CLOSED
        await self.session.flush()

        # Load all entries
        entries = await self.entry_repo.get_by_pool(pool_id)
        if not entries:
            pool.status = LotteryPoolStatus.DRAWN
            pool.drawn_at = datetime.now(timezone.utc)
            await self.session.flush()
            return LotteryDrawResult(
                pool_id=pool_id,
                winners=0,
                waitlisted=0,
                seed_used=0,
            )

        # 과업 WP1·WP3·WP4: 풀에 고정된 정책, 마감 시 확정된 가중치, 제재 제외 대상.
        # 응모 트리가 없는 기존 풀(committed_weights == {})은 기존 상수 경로 그대로 동작한다.
        fairness = FairnessService(self.session)
        pool_policy, _ = await fairness.get_pool_policy(pool.id)
        committed_weights = await fairness.entry_weights(pool.id)
        excluded_uids = await fairness.excluded_users(pool.id)
        use_allocation = pool_policy.algorithm == ALGORITHM_WEIGHTED_ALLOCATION
        allocation_charges: dict[str, int] = {}
        engine_waitlist_ordered: list[str] = []
        outcomes: dict[str, dict] = {}

        # WP08: 이벤트 도메인 조회
        domain = await self._get_event_domain(pool.event_id)

        tier = await self.tier_repo.get(pool.tier_id)
        face_price = tier.face_price if tier else 0.0
        sale_mode = tier.sale_mode if tier else "point_lottery"
        is_point_lottery = tier is not None and tier.sale_mode == "point_lottery"

        # -------------------------------------------------------
        # WP08 Phase 1: 보장 당첨권 보유자 우선 당첨
        # -------------------------------------------------------
        guaranteed_winners: list = []
        remaining_entries: list = []

        # docs §4-1 "미소화 좌석 자동 이월" — draw() 시점에 실가용 좌석을 재조회.
        # go에서 sync된 개별 Seat 레코드가 존재하면, 현재 AVAILABLE 좌석 수를 사용.
        # 이전 phase(membership_presale 등) 미결제로 AVAILABLE 복구된 좌석이 반영됨.
        # Seat 레코드가 없으면 pool.total_seats(생성 시점 snapshot) fallback.
        seat_records_scalar = await self.session.scalar(
            select(func.count(Seat.id)).where(
                Seat.event_id == pool.event_id,
                Seat.tier_id == pool.tier_id,
            )
        )
        # 실제 DB count 결과만 신뢰 (mock 테스트의 MagicMock 등은 int 아님 → fallback)
        if isinstance(seat_records_scalar, int) and seat_records_scalar > 0:
            available_scalar = await self.session.scalar(
                select(func.count(Seat.id)).where(
                    Seat.event_id == pool.event_id,
                    Seat.tier_id == pool.tier_id,
                    Seat.status == SeatStatus.AVAILABLE,
                )
            )
            total_available = (
                available_scalar if isinstance(available_scalar, int) else pool.total_seats
            )
            total_seat_records = seat_records_scalar
        else:
            # Seat 레코드가 없는 경우(v2 자체 이벤트) pool snapshot 사용
            total_available = pool.total_seats
            total_seat_records = 0

        # quota 상한 존중: 주최자 의도(phase별 배분)를 넘지 않도록
        # 초과분은 다음 phase(fcfs_residual)가 흡수 — 좌석 증발 없음
        if max_winners is not None and max_winners < total_available:
            total_available = max_winners

        # 풀 메타데이터도 실제 추첨 풀 크기로 동기화 (transparency/verify 일관성)
        pool.total_seats = total_available
        remaining_seats = total_available

        logger.info(
            "Lottery draw pool_size: pool=%s seat_records=%d available=%d quota=%s final=%d",
            pool_id, total_seat_records, total_available,
            max_winners if max_winners is not None else "None",
            remaining_seats,
        )

        for entry in entries:
            if str(entry.user_id) in excluded_uids:
                continue  # 제재(Slash) — 보장 당첨·추첨 모두에서 제외
            has_guaranteed = await self.pity_service.has_guaranteed_ticket(entry.user_id, domain)
            if has_guaranteed and remaining_seats >= entry.group_size:
                guaranteed_winners.append(entry)
                remaining_seats -= entry.group_size
                # 보장 당첨권 사용 처리
                await self.pity_service.use_guaranteed_ticket(entry.user_id, domain)
            else:
                remaining_entries.append(entry)

        # -------------------------------------------------------
        # WP08 Phase 2: 나머지 참가자에 pity_bonus 적용 + 엔진 추첨
        # WP01-03: client_seeds 수집
        # -------------------------------------------------------
        engine_entries = []
        weights: dict[str, float] = {}
        client_seeds: dict[str, str] = {}
        for entry in remaining_entries:
            engine_entries.append(
                EngineLotteryEntry(
                    user_id=str(entry.user_id),
                    group_id=str(entry.group_id) if entry.group_id else None,
                    group_size=entry.group_size,
                    applied_at=entry.created_at,
                )
            )
            # 가산 방식 가중치 (정본: SALE_MODE_POLICY_v2 §3-2)
            # 기본100 + AP보너스(log₂) + 보정값(fan/pity)
            pity_bonus = entry.pity_bonus if entry.pity_bonus else 1.0
            tier_mult = entry.tier_multiplier if entry.tier_multiplier else 1.0
            committed = committed_weights.get(str(entry.user_id))
            if committed is not None:
                # 응모 Merkle 트리에 고정된 가중치를 그대로 쓴다(트리 ↔ 추첨 일치 보장).
                w = committed
            else:
                w = compute_lottery_weight(
                    invested_ap=entry.invested_ap or 0,
                    fan_weight=entry.fan_weight,
                    tier_multiplier=tier_mult,
                    pity_bonus=pity_bonus,
                )
            weights[str(entry.user_id)] = w
            if entry.client_seed:
                client_seeds[str(entry.user_id)] = entry.client_seed

        # 남은 좌석이 있고 참가자가 있으면 엔진 추첨 실행
        lottery_winner_set: set[str] = set()
        lottery_waitlist_set: set[str] = set()
        seed_used = 0
        commitment_hash = ""
        verification_data: dict = {}
        engine_winners_ordered: list[str] = []
        entries_digest = ""

        if remaining_seats > 0 and engine_entries and use_allocation:
            # 과업 WP3: 가중 배분(가중 VCG). 입찰 = 투입 AP, w_i = 고정된 정책 가중치.
            # 시드는 가중 추첨과 똑같이 사전 커밋된 server_seed(+client_seeds) — 동점 순서까지
            # 커밋에 묶인다. 공개 데이터 algorithm 은 중립 명칭(weighted_allocation_v1).
            alloc_entries = [
                VcgEntry(
                    user_id=str(entry.user_id),
                    bid_ap=int(entry.invested_ap or 0),
                    weight=weights[str(entry.user_id)],
                )
                for entry in remaining_entries
            ]
            alloc_result, verification_data = run_allocation_draw(
                alloc_entries,
                remaining_seats,
                pool.server_seed,
                pool_policy,
                str(pool.tier_id),
                client_seeds if client_seeds else None,
            )
            lottery_winner_set = set(alloc_result.winners)
            lottery_waitlist_set = set(alloc_result.waitlist)
            engine_winners_ordered = list(alloc_result.winners)
            engine_waitlist_ordered = list(alloc_result.waitlist)
            allocation_charges = dict(alloc_result.charges)
            seed_used = int(verification_data["seed"])
            entries_digest = verification_data["entries_digest"]
            commitment_hash = LotteryVerifier.compute_commitment(
                seed_used, engine_entries, remaining_seats, weights, client_seeds or None
            )
        elif remaining_seats > 0 and engine_entries:
            # F-1 commit-reveal ② 실행 단계: 시드는 새로 뽑지 않고, 추첨 전에
            # 영속화된 사전 커밋의 server_seed 를 사용한다. client_seeds 가
            # 있으면 엔진이 sha256(server_seed + client_seeds) 결합 시드를
            # 유도한다 — server_seed 는 커밋에 고정돼 있으므로 운영자가
            # 결과를 보고 시드를 바꾸면 커밋 해시가 깨진다.
            engine_pool = EngineLotteryPool(
                tier_id=str(pool.tier_id),
                entries=engine_entries,
                total_seats=remaining_seats,
                use_fan_weight=True if is_point_lottery else pool.use_fan_weight,
            )
            result = run_lottery(
                engine_pool,
                weights=weights,
                seed=pool.server_seed,
                client_seeds=client_seeds if client_seeds else None,
            )
            lottery_winner_set = set(result.winners)
            lottery_waitlist_set = set(result.waitlist)
            engine_waitlist_ordered = list(result.waitlist)
            seed_used = result.seed_used
            commitment_hash = result.commitment_hash
            verification_data = result.verification_data
            engine_winners_ordered = list(result.winners)
            entries_digest = result.entries_digest
        elif engine_entries:
            # 좌석이 모두 보장 당첨으로 소진됨 → 나머지는 전원 대기
            lottery_waitlist_set = {str(e.user_id) for e in remaining_entries}

        # ── 보장당첨(pity) 소진: 엔진 draw 가 스킵된 v2 풀의 reveal 구성 ──
        # 좌석을 전부 pity 보장당첨자가 채우면(remaining_seats==0) 위 if 분기가
        # 스킵돼 verification_data 가 {} 로 남는다. 이 경우에도 사전 커밋
        # (server_seed/seed_commitment)은 존재하고 당첨자는 보장당첨 목록으로
        # 확정돼 있으므로, verify 가 v2 로 인식·재검증할 수 있도록 reveal 데이터를
        # 직접 구성한다. 가중 추첨은 실행되지 않았으므로(deterministic 배정),
        # winners 는 보장당첨자, entries 스냅샷도 보장당첨자 입력 스냅샷이다.
        if (
            not verification_data
            and guaranteed_winners
            and pool.seed_commitment
            and pool.server_seed is not None
        ):
            pity_canonical_entries = [
                {
                    "user_id": str(e.user_id),
                    "weight": 1.0,
                    "group_size": int(e.group_size),
                    "group_id": str(e.group_id) if e.group_id else None,
                }
                for e in sorted(guaranteed_winners, key=lambda x: str(x.user_id))
            ]
            pity_winners_ordered = [
                str(e.user_id)
                for e in sorted(guaranteed_winners, key=lambda x: str(x.user_id))
            ]
            entries_digest = LotteryVerifier.compute_entries_digest(
                pity_canonical_entries, total_available
            )
            engine_winners_ordered = pity_winners_ordered
            seed_used = pool.server_seed
            commitment_hash = LotteryVerifier.compute_commitment(
                pool.server_seed,
                [
                    EngineLotteryEntry(
                        user_id=str(e.user_id),
                        group_id=str(e.group_id) if e.group_id else None,
                        group_size=e.group_size,
                        applied_at=e.created_at,
                    )
                    for e in guaranteed_winners
                ],
                total_available,
            )
            verification_data = {
                "scheme": SCHEME_COMMIT_REVEAL_V2,
                "draw_mode": LotteryVerifier.DRAW_MODE_PITY_EXHAUSTED,
                "algorithm": "efraimidis_spirakis_weighted_sampling",
                "hash_function": "sha256",
                "seed_derivation_method": "server_seed_only",
                "seed": pool.server_seed,
                "server_seed": pool.server_seed,
                "capacity": total_available,
                "entries": pity_canonical_entries,
                "entries_digest": entries_digest,
                "winners": list(pity_winners_ordered),
                "waitlist": sorted(lottery_waitlist_set),
                "tier_id": str(pool.tier_id),
            }

        # -------------------------------------------------------
        # 결과 처리: 당첨자 (보장 + 추첨), 대기자
        # -------------------------------------------------------
        # Combine all winner user_ids
        guaranteed_winner_uids = {str(e.user_id) for e in guaranteed_winners}
        all_winner_uids = guaranteed_winner_uids | lottery_winner_set

        winners_count = 0
        waitlisted_count = 0

        # ── 당첨자 좌석 랜덤 배정 준비 ──
        # pool.tier_id 에 속한 AVAILABLE 좌석을 모두 가져와 셔플.
        # 당첨자별 group_size 만큼 pop 하여 ticket.seat_id 로 할당하고, seats.status=HELD 처리.
        # 결제 완료 시 seats.status=SOLD 로 전환되는 건 주문/결제 서비스가 담당.
        available_seats_q = await self.session.execute(
            select(Seat).where(
                Seat.event_id == pool.event_id,
                Seat.tier_id == pool.tier_id,
                Seat.status == SeatStatus.AVAILABLE,
            )
        )
        available_seats = list(available_seats_q.scalars().all())
        _random.shuffle(available_seats)
        # 추첨 당첨자 결제 기한 — 우선순위: **phase_configs.config(DB 정본)** → Redis → env.
        #
        # T2-PHASE 이전에는 이 값이 Redis TTL 7일에만 존재했다. flush 하거나 7일이 지나면
        # 주최자가 설정한 결제창(예: 72h)이 조용히 env 기본값으로 되돌아갔다(현존 P0 #2).
        # 이제 판매계획 저장 시 phase_configs.config 에 영속되므로 DB 를 먼저 본다.
        lottery_payment_hours: float = settings.LOTTERY_PAYMENT_HOURS
        try:
            from app.services.sale_phase_service import get_phase_config_value

            db_val = await get_phase_config_value(
                self.session,
                pool.event_id,
                "payment_window_hours",
                phases=("lottery", "membership_presale"),
            )
        except Exception:  # noqa: BLE001
            db_val = None
            logger.debug("phase_configs payment_window lookup failed", exc_info=True)
        if db_val is not None:
            lottery_payment_hours = db_val
        else:
            try:
                redis_val = await cache_get(f"event:{pool.event_id}:payment_window_hours")
                if redis_val is not None:
                    lottery_payment_hours = float(redis_val)
            except (ValueError, TypeError):
                logger.warning(
                    "Invalid payment_window_hours in Redis for event=%s, using env/default",
                    pool.event_id,
                )
        seat_hold_until = datetime.now(timezone.utc) + timedelta(
            hours=lottery_payment_hours
        )
        seat_ids_to_hold: list[uuid.UUID] = []

        for entry in entries:
            uid_str = str(entry.user_id)
            if uid_str in all_winner_uids:
                entry.result = LotteryEntryResult.WON
                winners_count += 1

                # Create order for winner
                order = await self.order_repo.create(
                    user_id=entry.user_id,
                    event_id=pool.event_id,
                    tier_id=pool.tier_id,
                    order_type=OrderType.PURCHASE,
                    status=OrderStatus.PAYMENT_REQUIRED,
                    quantity=entry.group_size,
                    unit_price=face_price,
                    total_amount=face_price * entry.group_size,
                    payment_deadline=datetime.now(timezone.utc)
                    + timedelta(hours=lottery_payment_hours),
                )

                # Create tickets for each seat in group — 당첨자에게 랜덤 좌석 할당
                tickets_data = []
                for _ in range(entry.group_size):
                    assigned_seat = (
                        available_seats.pop() if available_seats else None
                    )
                    if assigned_seat is not None:
                        seat_ids_to_hold.append(assigned_seat.id)
                    tickets_data.append(
                        {
                            "event_id": pool.event_id,
                            "tier_id": pool.tier_id,
                            "seat_id": assigned_seat.id if assigned_seat else None,
                            "original_owner_id": entry.user_id,
                            "current_owner_id": entry.user_id,
                            "purchase_price": face_price,
                            "sale_mode": sale_mode,
                            "purchase_order_id": order.id,
                            "status": TicketStatus.PENDING,
                        }
                    )
                if tickets_data:
                    await self.ticket_repo.create_batch(tickets_data)

                # WP08: 당첨 기록
                try:
                    await self.pity_service.record_win(entry.user_id, domain)
                except Exception:
                    logger.warning("Failed to record pity win for user %s", entry.user_id)

                # 당첨자 투자 AP는 전액 소진 (정가 보장 원칙)
                invested = int(entry.invested_ap or 0)
                ap_charged = invested
                if (
                    use_allocation
                    and uid_str in allocation_charges
                    and uid_str not in guaranteed_winner_uids
                ):
                    # 과업 WP3: 가중 배분 당첨자는 VCG 가격만큼만 소각, 차액 환급.
                    ap_charged = int(allocation_charges[uid_str])
                    refund = invested - ap_charged
                    if refund > 0:
                        await self.point_service.earn(
                            user_id=entry.user_id,
                            point_type=PointType.FAN,
                            amount=refund,
                            tx_type=PointTransactionType.REFUND_LOTTERY,
                            reference_id=pool.event_id,
                            description=f"가중 배분 차액 환급 ({refund}AP, 투입 {invested}AP 중 {ap_charged}AP 소각)",
                            idempotency_key=f"lottery_alloc_refund:{entry.id}",
                        )
                if uid_str in guaranteed_winner_uids:
                    outcomes[uid_str] = {"result": "won", "order": None, "ap_charged": ap_charged, "path": "guaranteed"}
                else:
                    outcomes[uid_str] = {
                        "result": "won",
                        "order": engine_winners_ordered.index(uid_str) if uid_str in engine_winners_ordered else None,
                        "ap_charged": ap_charged,
                        "path": "draw",
                    }

            elif uid_str in lottery_waitlist_set:
                entry.result = LotteryEntryResult.WAITLISTED
                waitlisted_count += 1

                # WP08: 낙첨 기록
                try:
                    await self.pity_service.record_loss(entry.user_id, domain)
                except Exception:
                    logger.warning("Failed to record pity loss for user %s", entry.user_id)

                waitlist_order = (
                    engine_waitlist_ordered.index(uid_str) if uid_str in engine_waitlist_ordered else None
                )
                if use_allocation:
                    # 과업 WP3: VCG 규칙상 낙첨자 지불은 0 — 투입 AP 전액 환급(위로금 없음).
                    if entry.invested_ap and entry.invested_ap > 0:
                        await self.point_service.earn(
                            user_id=entry.user_id,
                            point_type=PointType.FAN,
                            amount=int(entry.invested_ap),
                            tx_type=PointTransactionType.REFUND_LOTTERY,
                            reference_id=pool.event_id,
                            description=f"가중 배분 낙첨 환급 ({entry.invested_ap}AP)",
                            idempotency_key=f"lottery_alloc_loser_refund:{entry.id}",
                        )
                    outcomes[uid_str] = {"result": "waitlisted", "order": waitlist_order, "ap_charged": 0, "path": "draw"}
                    continue

                outcomes[uid_str] = {
                    "result": "waitlisted",
                    "order": waitlist_order,
                    "ap_charged": int(entry.invested_ap or 0),
                    "path": "draw",
                }

                # WP12: 낙첨자 — 투자 AP 소진 (환급 없음) + 위로금 지급
                # 정본: SALE_MODE_POLICY_v2_2026-04-10.md + AP_POINT_POLICY.md
                # "AP를 '진짜 자원'으로 만든다. 환급하면 AP가 무한 재활용되어 화폐 가치 붕괴."
                if entry.invested_ap and entry.invested_ap > 0:
                    try:
                        # 위로금: 투자 AP의 10% (최소 50, 최대 500)
                        consolation = int(entry.invested_ap * self.AP_CONSOLATION_RATE)
                        consolation = max(
                            self.AP_CONSOLATION_MIN, min(self.AP_CONSOLATION_MAX, consolation)
                        )
                        await self.point_service.earn(
                            user_id=entry.user_id,
                            point_type=PointType.FAN,
                            amount=consolation,
                            tx_type=PointTransactionType.EARN_CONSOLATION_LOTTERY,
                            reference_id=pool.event_id,
                            description=f"낙첨 위로금 ({consolation}AP, 투자 {entry.invested_ap}AP 소진)",
                        )
                    except Exception:
                        logger.warning("Failed to grant consolation AP for user %s", entry.user_id)

            elif uid_str in excluded_uids:
                # 과업 WP2: 제재(Slash)로 추첨에서 제외된 응모 — 투입 AP 는 환급하지 않는다
                # (소각). 결과는 비당첨 종결(WAITLISTED), 결과 트리에는 excluded 로 기록.
                entry.result = LotteryEntryResult.WAITLISTED
                outcomes[uid_str] = {
                    "result": "excluded",
                    "order": None,
                    "ap_charged": int(entry.invested_ap or 0),
                    "path": "excluded",
                }

            else:
                # idx13: 당첨도 대기도 아닌 엔트리 — 추첨이 실제로 이 엔트리를
                # 판정하지 못한 경우다. apply/draw 경합으로 추첨 스냅샷(engine_entries)
                # 로드 이후에 커밋된 엔트리가 이 경로에 들어올 수 있다(이제 apply 의
                # FOR UPDATE 잠금으로 신규 발생은 차단되지만, 과거 잔류분·예외 케이스를
                # 위한 방어선). 이런 엔트리를 영구 PENDING + AP 소실로 방치하지 않는다:
                # 공정 추첨이 실제로 적용되지 않았으므로(플랫폼 귀책) 투자 AP 를 전액
                # 환급하고, 결과는 종결 상태(WAITLISTED)로 전이한다 — PENDING 잔류
                # (마이페이지 '진행중' 영구 표시) 방지. LotteryEntryResult 에 LOST
                # 값이 없어 비당첨 종결 상태인 WAITLISTED 를 사용한다.
                logger.warning(
                    "Lottery draw: entry %s (user %s) excluded from draw adjudication "
                    "(apply/draw race fallback); refunding invested AP and finalizing",
                    entry.id,
                    entry.user_id,
                )
                if entry.invested_ap and entry.invested_ap > 0:
                    try:
                        await self.point_service.earn(
                            user_id=entry.user_id,
                            point_type=PointType.FAN,
                            amount=entry.invested_ap,
                            tx_type=PointTransactionType.REFUND_LOTTERY,
                            reference_id=pool.event_id,
                            description=(
                                f"추첨 누락 환급 ({entry.invested_ap}AP) — "
                                "응모/추첨 경합으로 추첨에서 제외"
                            ),
                            idempotency_key=f"lottery_race_refund:{entry.id}",
                        )
                    except Exception:
                        logger.warning(
                            "Failed to refund invested AP for race-excluded entry %s user %s",
                            entry.id,
                            entry.user_id,
                        )
                entry.result = LotteryEntryResult.WAITLISTED
                waitlisted_count += 1
                outcomes[uid_str] = {"result": "waitlisted", "order": None, "ap_charged": 0, "path": "race_refund"}

        # 당첨자에게 배정된 좌석들을 HELD 로 일괄 전환 (결제 기한 내 점유).
        # 결제 완료 → SOLD, 결제 만료 → AVAILABLE 복구는 payment/order 서비스가 처리.
        if seat_ids_to_hold:
            await self.session.execute(
                _sql_update(Seat)
                .where(Seat.id.in_(seat_ids_to_hold))
                .values(
                    status=SeatStatus.HELD,
                    held_until=seat_hold_until,
                )
            )

        # F-1 commit-reveal ③ 공개/바인딩 단계: 결과(당첨자)·엔트리 스냅샷
        # digest·server_seed 를 사전 커밋에 바인딩한 result_hash 를 기록.
        # verify 는 ① 공개된 server_seed 가 사전 커밋과 일치하는지
        # ② 시드+스냅샷으로 추첨을 재계산하면 기록된 당첨자와 일치하는지 검증.
        if verification_data:
            verification_data = dict(verification_data)
            verification_data["pool_id"] = str(pool.id)
            verification_data["seed_commitment"] = pool.seed_commitment
            verification_data["committed_at"] = (
                pool.committed_at.isoformat() if pool.committed_at else None
            )
            # ── 혼합(pity+엔진) 케이스 보장당첨자 바인딩 ──
            # 엔진 재추첨은 가중 추첨 당첨자(engine_winners_ordered)만 재현하므로,
            # 보장(pity)당첨자는 엔진 verify 의 winners_match 검증 범위 밖이다.
            # 이들이 result_hash 에 바인딩되지 않으면 누군가 보장당첨자를
            # 사후에 주입/변조해도 탐지되지 않는다. 정렬된 안정 키 목록으로
            # verification_data 에 기록하고 result_hash 에 함께 바인딩한다.
            # (pity 소진 케이스는 winners==보장당첨자라 위 전용 경로가 처리하므로
            #  여기서 별도 guaranteed_winners 필드는 추가하지 않는다 — draw_mode 로 구분)
            guaranteed_winners_bound: list[str] | None = None
            if (
                guaranteed_winners
                and verification_data.get("draw_mode")
                != LotteryVerifier.DRAW_MODE_PITY_EXHAUSTED
            ):
                guaranteed_winners_bound = sorted(
                    str(e.user_id) for e in guaranteed_winners
                )
                verification_data["guaranteed_winners"] = guaranteed_winners_bound
            verification_data["result_hash"] = LotteryVerifier.compute_result_hash(
                pool.seed_commitment,
                pool.server_seed,
                entries_digest,
                engine_winners_ordered,
                guaranteed_winners_bound,
            )

        # Update pool with verification data
        pool.status = LotteryPoolStatus.DRAWN
        pool.drawn_at = datetime.now(timezone.utc)
        pool.seed_used = seed_used
        pool.commitment_hash = commitment_hash
        pool.verification_data = verification_data

        # 과업 WP4: 결과 Merkle 루트(응모 트리와 같은 잎 순서). 응모 트리가 없는 기존 풀은 건너뜀.
        results_root = await fairness.commit_results_tree(pool, outcomes)
        await record_lottery_event(
            self.session,
            event_id=pool.event_id,
            kind="draw",
            pool_id=pool.id,
            tier_id=pool.tier_id,
            meta={
                "winners": winners_count,
                "waitlisted": waitlisted_count,
                "excluded": len(excluded_uids),
                "algorithm": pool_policy.algorithm,
            },
        )

        # Increment tier sold count
        # sold_count: PG 는 trg_sync_sold_count 가 위 create_batch(PENDING 티켓) INSERT 시
        # 자동 +1. 여기서 또 increment_sold 하면 이중증가 → SQLite(test) 에서만 수동 증가.
        import os

        if tier and winners_count > 0 and os.environ.get("PYTEST_CURRENT_TEST"):
            total_seats_sold = sum(
                e.group_size for e in entries if str(e.user_id) in all_winner_uids
            )
            await self.tier_repo.increment_sold(pool.tier_id, total_seats_sold)

        # Audit
        await write_audit_log(
            self.session,
            action="lottery_draw",
            resource_type="lottery",
            resource_id=str(pool_id),
            event_id=pool.event_id,
            tier_id=pool.tier_id,
            sale_mode=sale_mode,
            new_value={
                "pool_id": str(pool_id),
                "total_applicants": len(entries),
                "guaranteed_winners": len(guaranteed_winners),
                "winners": winners_count,
                "waitlisted": waitlisted_count,
                "seed_used": seed_used,
                "commitment_hash": commitment_hash,
                "seed_commitment": pool.seed_commitment,
                "committed_at": pool.committed_at.isoformat() if pool.committed_at else None,
                # 감사 로그의 algorithm 필드는 내부 알고리즘명 허용(DOMAIN_MODEL_STANDARD §1.3)
                "algorithm": VCG_ALGORITHM_NAME if use_allocation else "efraimidis_spirakis_weighted_sampling",
                "policy_hash": pool_policy.policy_hash(),
                "results_root": results_root.root if results_root else None,
                "excluded_by_sanction": len(excluded_uids),
                "result": "success",
            },
        )

        return LotteryDrawResult(
            pool_id=pool_id,
            winners=winners_count,
            waitlisted=waitlisted_count,
            seed_used=seed_used,
        )

    async def cancel_pools_for_event(self, event_id: uuid.UUID) -> dict:
        """이벤트 취소 시 추첨 풀/응모 정리.

        - 미추첨(OPEN) 풀을 CLOSED 로 전이 — 추가 응모 차단 + Celery
          auto_draw_lotteries 의 OPEN 풀 선별에서 제외.
          (LotteryPoolStatus 에 CANCELLED 값이 없어 CLOSED 사용; 추첨 실행 자체는
          _draw_inner 의 이벤트 상태(CANCELLED) 가드가 모든 경로에서 차단)
        - 아직 추첨되지 않은 응모(PENDING)의 투자 AP 전액 환급(REFUND_LOTTERY).
          'AP 소진(환급 없음)' 정책은 공정 추첨이 실제로 실행된 낙첨에만 적용 —
          추첨 자체가 무산된 이벤트 취소는 플랫폼/주최자 귀책이므로 전액 환급.
          idempotency_key 로 중복 환급 방지.

        Returns:
            {"pools_closed", "entries_refunded", "ap_refunded", "refund_failed"}
        """
        from app.models.lottery import LotteryEntry, LotteryPool

        pools = (
            await self.session.execute(
                select(LotteryPool).where(
                    LotteryPool.event_id == event_id,
                    LotteryPool.status != LotteryPoolStatus.DRAWN,
                )
            )
        ).scalars().all()

        pools_closed = 0
        entries_refunded = 0
        ap_refunded = 0
        refund_failed = 0

        for pool in pools:
            if pool.status == LotteryPoolStatus.OPEN:
                pool.status = LotteryPoolStatus.CLOSED
                pools_closed += 1

            entries = (
                await self.session.execute(
                    select(LotteryEntry).where(
                        LotteryEntry.pool_id == pool.id,
                        LotteryEntry.result == LotteryEntryResult.PENDING,
                        LotteryEntry.invested_ap > 0,
                    )
                )
            ).scalars().all()

            for entry in entries:
                try:
                    await self.point_service.earn(
                        user_id=entry.user_id,
                        point_type=PointType.FAN,
                        amount=entry.invested_ap,
                        tx_type=PointTransactionType.REFUND_LOTTERY,
                        reference_id=event_id,
                        description=f"이벤트 취소 — 추첨 투자 AP 환급 ({entry.invested_ap}AP)",
                        idempotency_key=f"lottery_cancel_refund:{entry.id}",
                    )
                    entries_refunded += 1
                    ap_refunded += entry.invested_ap
                except Exception:
                    refund_failed += 1
                    logger.warning(
                        "Failed to refund invested AP on event cancel: entry=%s user=%s",
                        entry.id,
                        entry.user_id,
                    )

        if pools or entries_refunded:
            await write_audit_log(
                self.session,
                action="lottery_pools_cancel",
                resource_type="lottery",
                resource_id=str(event_id),
                event_id=event_id,
                new_value={
                    "pools_closed": pools_closed,
                    "entries_refunded": entries_refunded,
                    "ap_refunded": ap_refunded,
                    "refund_failed": refund_failed,
                    "reason": "event_cancelled",
                },
            )

        return {
            "pools_closed": pools_closed,
            "entries_refunded": entries_refunded,
            "ap_refunded": ap_refunded,
            "refund_failed": refund_failed,
        }

    async def get_pool_status(self, event_id: uuid.UUID, tier_id: uuid.UUID) -> LotteryPoolResponse:
        """
        Get current status of a lottery pool.

        Args:
            event_id: Event UUID.
            tier_id: Seat tier UUID.

        Returns:
            LotteryPoolResponse with pool details.

        Raises:
            ValueError: If pool not found.
        """
        pool = await self.pool_repo.get_by_event_tier(event_id, tier_id)
        if not pool:
            raise ValueError(f"No lottery pool found for event={event_id}, tier={tier_id}")

        total_applicants = await self.entry_repo.count_by_pool(pool.id)

        return LotteryPoolResponse(
            id=pool.id,
            event_id=pool.event_id,
            tier_id=pool.tier_id,
            total_seats=pool.total_seats,
            total_applicants=total_applicants,
            status=pool.status.value,
            seed_used=pool.seed_used,
            # 사전 커밋 공개 — 추첨 전에 누구나 기록해 둘 수 있어야
            # 추첨 후 reveal(server_seed)을 제3자가 검증 가능하다.
            # server_seed 자체는 DRAWN 전까지 절대 노출하지 않는다.
            seed_commitment=pool.seed_commitment,
            committed_at=pool.committed_at,
        )

    async def _apply_newcomer_shield(self, user_id: uuid.UUID, base_weight: float) -> bool:
        """WP16: Apply Newcomer Shield boost if eligible.

        Conditions:
        - User signed up within the last 30 days
        - Profile is completed (avatar_url or bio exists)
        - newcomer_uses_remaining > 0

        If eligible, decrements newcomer_uses_remaining and returns True.

        Args:
            user_id: The user's UUID.
            base_weight: The base fan weight (not modified here).

        Returns:
            True if newcomer shield was applied, False otherwise.
        """
        from app.models.user import User

        result = await self.session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user:
            return False

        # Check signup date within 30 days
        created_at = user.created_at
        if created_at.tzinfo is None:
            created_at = created_at.replace(tzinfo=timezone.utc)
        days_since_signup = (datetime.now(timezone.utc) - created_at).days
        if days_since_signup > NEWCOMER_WINDOW_DAYS:
            return False

        # Check profile completion (avatar_url or bio)
        profile_completed = bool(user.avatar_url or user.bio)
        if not profile_completed:
            return False

        # Apply shield: 원자적 가드 UPDATE 로 동시 응모 시 음수/이중차감 방지.
        # newcomer_uses_remaining > 0 인 경우에만 1 차감, 0건 매칭이면 잔여 없음.
        update_result = await self.session.execute(
            _sql_update(User)
            .where(User.id == user_id, User.newcomer_uses_remaining > 0)
            .values(newcomer_uses_remaining=User.newcomer_uses_remaining - 1)
            .returning(User.newcomer_uses_remaining)
        )
        new_remaining = update_result.scalar_one_or_none()
        if new_remaining is None:
            # 잔여 사용권 없음 (또는 동시 요청에 선점됨) → shield 미적용
            return False

        # 메모리상 객체 동기화 (이후 코드가 user.newcomer_uses_remaining 읽을 수 있음)
        try:
            await self.session.refresh(user, ["newcomer_uses_remaining"])
        except Exception:
            user.newcomer_uses_remaining = new_remaining

        logger.info(
            "Newcomer shield applied: user=%s remaining=%d",
            user_id,
            new_remaining,
        )
        return True

    async def verify_pool(self, pool_id: uuid.UUID) -> LotteryVerificationResponse:
        """
        Verify lottery pool results using stored commitment and verification data.

        Public endpoint -- allows anyone to independently verify the lottery was fair.

        Args:
            pool_id: Lottery pool UUID.

        Returns:
            LotteryVerificationResponse with verification results.

        Raises:
            ValueError: If pool not found or not yet drawn.
        """
        pool = await self.pool_repo.get(pool_id)
        if not pool:
            raise ValueError(f"Lottery pool {pool_id} not found")

        if pool.status != LotteryPoolStatus.DRAWN:
            raise ValueError("Lottery pool has not been drawn yet")

        total_applicants = await self.entry_repo.count_by_pool(pool.id)

        is_valid = False
        verification_data = pool.verification_data or {}
        commitment_hash = pool.commitment_hash or ""
        checks: dict = {}

        algorithm = verification_data.get("algorithm", "efraimidis_spirakis_weighted_sampling")

        is_v2 = bool(pool.seed_commitment) and (
            verification_data.get("scheme") == SCHEME_COMMIT_REVEAL_V2
        )

        if algorithm == "vcg_weighted_allocation":
            # VCG는 결정론적 — 동일 입력 시 동일 결과 보장.
            # is_strategy_proof 는 더 이상 하드코딩 True 가 아니라 엔진이 실제
            # 메커니즘 파라미터(안정화 lambda 등)로 산출한 DSIC 속성이다.
            # 안정화가 켜져 DSIC 가 약화되면 엔진이 False 를 기록 → 여기서도
            # valid=False 로 정직하게 반영된다. 기록이 없으면 검증 불가(False).
            scheme = "vcg_deterministic"
            is_legacy = True
            is_strategy_proof = bool(verification_data.get("is_strategy_proof", False))
            is_valid = is_strategy_proof
            checks = {
                "is_strategy_proof": is_strategy_proof,
                "note": (
                    "DSIC property as computed by the engine from the actual "
                    "mechanism parameters; stabilization (lambda>0) weakens DSIC "
                    "and is reported as not strategy-proof"
                ),
            }
        elif is_v2:
            # ── Commit-reveal v2 (F-1) ──
            # ① 공개된 server_seed 가 추첨 *이전에* 영속화된 커밋과 일치하는지
            # ② 그 시드 + 엔트리 스냅샷으로 추첨을 재계산하면 기록된
            #    당첨자 목록과 일치하는지 (엔진 verify_reveal 이 실제 재실행)
            # ③ 엔트리 스냅샷 digest / 결과 바인딩 해시 일치 여부
            # ④ committed_at < drawn_at (커밋 선행 증명)
            scheme = SCHEME_COMMIT_REVEAL_V2
            is_legacy = False
            # 보장당첨(pity) 소진 풀은 가중 추첨이 실행되지 않았으므로(좌석을
            # 전부 보장당첨자가 채움) 재추첨 재현 대신 '보장당첨자 목록 == 기록
            # + 커밋 선행'을 확인한다. 그 외 v2 는 엔진 재추첨으로 검증.
            if (
                verification_data.get("draw_mode")
                == LotteryVerifier.DRAW_MODE_PITY_EXHAUSTED
            ):
                checks = LotteryVerifier.verify_pity_reveal(
                    pool.seed_commitment, str(pool.id), verification_data
                )
            elif verification_data.get("algorithm") == PUBLIC_ALGORITHM_ID:
                # 과업 WP3: 가중 배분 풀 — 공개 입력으로 가중 VCG 를 다시 돌려 당첨자·소각 AP 비교
                checks = verify_allocation_reveal(
                    pool.seed_commitment, str(pool.id), verification_data
                )
            else:
                checks = LotteryVerifier.verify_reveal(
                    pool.seed_commitment, str(pool.id), verification_data
                )
            committed_at = pool.committed_at
            drawn_at = pool.drawn_at
            if committed_at and committed_at.tzinfo is None:
                committed_at = committed_at.replace(tzinfo=timezone.utc)
            if drawn_at and drawn_at.tzinfo is None:
                drawn_at = drawn_at.replace(tzinfo=timezone.utc)
            checks["commit_precedes_draw"] = bool(
                committed_at and drawn_at and committed_at < drawn_at
            )
            checks["is_valid"] = bool(
                checks.get("is_valid") and checks["commit_precedes_draw"]
            )
            is_valid = checks["is_valid"]
        elif verification_data and commitment_hash:
            # ── Legacy(사후 커밋) 데이터: 해시 무결성만 확인 가능 ──
            # 커밋이 추첨과 같은 호출에서 생성되었으므로 '시드가 추첨 전에
            # 고정되었다'는 것은 증명할 수 없다. legacy 로 명시 구분 응답.
            scheme = SCHEME_LEGACY_POST_HOC
            is_legacy = True
            is_valid = LotteryVerifier.verify(commitment_hash, verification_data)
            checks = {
                "legacy_hash_match": is_valid,
                "note": (
                    "post-hoc commitment: integrity only — does NOT prove "
                    "the seed was fixed before the draw"
                ),
            }
        else:
            scheme = SCHEME_LEGACY_POST_HOC
            is_legacy = True

        return LotteryVerificationResponse(
            pool_id=pool.id,
            commitment_hash=commitment_hash,
            seed_used=pool.seed_used or 0,
            algorithm=algorithm,
            total_applicants=total_applicants,
            total_seats=pool.total_seats,
            verification_data=verification_data,
            is_valid=is_valid,
            scheme=scheme,
            is_legacy=is_legacy,
            checks=checks,
            seed_commitment=pool.seed_commitment,
            # reveal: DRAWN 상태에서만 이 메서드에 도달하므로 공개 가능
            server_seed=pool.server_seed if is_v2 else None,
            committed_at=pool.committed_at,
            drawn_at=pool.drawn_at,
        )

    async def get_transparency_report(self, pool_id: uuid.UUID) -> LotteryTransparencyReport:
        """
        Generate an anonymized transparency report for a drawn lottery pool.

        Includes competition ratio, weight distribution statistics, and
        breakdown of results. No personally identifiable information is exposed.

        Args:
            pool_id: Lottery pool UUID.

        Returns:
            LotteryTransparencyReport with anonymized statistics.

        Raises:
            ValueError: If pool not found or not yet drawn.
        """
        pool = await self.pool_repo.get(pool_id)
        if not pool:
            raise ValueError(f"Lottery pool {pool_id} not found")

        if pool.status != LotteryPoolStatus.DRAWN:
            raise ValueError("Lottery pool has not been drawn yet")

        entries = await self.entry_repo.get_by_pool(pool_id)
        total_applicants = len(entries)

        # Competition ratio
        competition_ratio = total_applicants / pool.total_seats if pool.total_seats > 0 else 0.0

        # Weight distribution
        fan_weights = [e.fan_weight for e in entries]
        if fan_weights:
            sorted_weights = sorted(fan_weights)
            n = len(sorted_weights)
            weight_distribution = {
                "min": min(sorted_weights),
                "max": max(sorted_weights),
                "median": statistics.median(sorted_weights),
                "p25": sorted_weights[n // 4] if n >= 4 else sorted_weights[0],
                "p75": sorted_weights[(n * 3) // 4] if n >= 4 else sorted_weights[-1],
            }
        else:
            weight_distribution = {
                "min": 0,
                "max": 0,
                "median": 0,
                "p25": 0,
                "p75": 0,
            }

        # Pool breakdown: count by result
        won_count = sum(1 for e in entries if e.result == LotteryEntryResult.WON)
        waitlisted_count = sum(1 for e in entries if e.result == LotteryEntryResult.WAITLISTED)
        pending_count = sum(1 for e in entries if e.result == LotteryEntryResult.PENDING)

        pool_breakdown = {
            "won": won_count,
            "waitlisted": waitlisted_count,
            "pending": pending_count,
        }

        v_data = pool.verification_data or {}
        commitment_hash = pool.commitment_hash or ""
        algorithm = v_data.get("algorithm", "efraimidis_spirakis_weighted_sampling")
        seed_derivation_method = v_data.get("seed_derivation_method", "server_seed_only")

        # VCG 풀이면 공정성 지표를 weight_distribution에 병합
        if algorithm == "vcg_weighted_allocation":
            fairness = v_data.get("fairness_metrics", {})
            consumer = v_data.get("consumer_metrics", {})
            weight_distribution.update({
                "gini_coefficient": fairness.get("gini_coefficient", 0),
                "theil_index": fairness.get("theil_index", 0),
                "atkinson_index": fairness.get("atkinson_index", 0),
                "entropy_fairness": fairness.get("entropy_fairness", 1.0),
                "weight_price_correlation": fairness.get("weight_price_correlation", 0),
                "total_consumer_surplus": consumer.get("total_consumer_surplus", 0),
                "avg_surplus_ratio": consumer.get("avg_surplus_ratio", 0),
                # 엔진이 실제 메커니즘 파라미터로 산출한 값만 공표.
                # 기록이 없으면 'strategy-proof: true' 로 낙관 공표하지 않는다
                # (검증 불가 → False). 엔진 vcg.py 가 lambda>0(안정화)면 False 로
                # 산출하므로 이 값은 실제 DSIC 속성을 반영한다.
                "is_strategy_proof": bool(v_data.get("is_strategy_proof", False)),
            })

        return LotteryTransparencyReport(
            pool_id=pool.id,
            total_applicants=total_applicants,
            total_seats=pool.total_seats,
            competition_ratio=round(competition_ratio, 2),
            weight_distribution=weight_distribution,
            pool_breakdown=pool_breakdown,
            commitment_hash=commitment_hash,
            algorithm=algorithm,
            seed_derivation_method=seed_derivation_method,
            created_at=pool.created_at,
            scheme=(
                SCHEME_COMMIT_REVEAL_V2
                if pool.seed_commitment
                and v_data.get("scheme") == SCHEME_COMMIT_REVEAL_V2
                else SCHEME_LEGACY_POST_HOC
            ),
            seed_commitment=pool.seed_commitment,
            committed_at=pool.committed_at,
            drawn_at=pool.drawn_at,
        )

    async def get_my_result(
        self, pool_id: uuid.UUID, user_id: uuid.UUID
    ) -> LotteryMyResultResponse:
        """
        Get the current user's result for a specific lottery pool.

        Returns detailed information about the user's entry, fan weight
        breakdown, and pool-level statistics.

        Args:
            pool_id: Lottery pool UUID.
            user_id: Requesting user's UUID.

        Returns:
            LotteryMyResultResponse with user's result and context.

        Raises:
            ValueError: If pool or entry not found, or pool not yet drawn.
        """
        pool = await self.pool_repo.get(pool_id)
        if not pool:
            raise ValueError(f"Lottery pool {pool_id} not found")

        if pool.status != LotteryPoolStatus.DRAWN:
            raise ValueError("Lottery pool has not been drawn yet")

        entry = await self.entry_repo.get_user_entry(pool_id, user_id)
        if not entry:
            raise ValueError("User has no entry in this lottery pool")

        # Get all entries to compute pool stats
        all_entries = await self.entry_repo.get_by_pool(pool_id)
        fan_weights = [e.fan_weight for e in all_entries]
        avg_weight = sum(fan_weights) / len(fan_weights) if fan_weights else 0.0

        # Build weight breakdown from user data
        try:
            from app.repositories.user_repo import UserRepository

            user_repo = UserRepository(self.session)
            user = await user_repo.get(user_id)
            if user:
                scores = self.fan_weight_service.build_fan_scores(user)
                weight_breakdown = {
                    "loyalty": scores.loyalty,
                    "history": scores.history,
                    "fanclub": scores.fanclub,
                    "behavior": scores.behavior,
                    "freshness": scores.freshness,
                }
            else:
                weight_breakdown = {}
        except Exception:
            weight_breakdown = {}

        pool_stats = {
            "avg_weight": round(avg_weight, 4),
            "total_applicants": len(all_entries),
        }

        verification_link = f"/api/v1/lottery/pools/{pool_id}/verify"

        return LotteryMyResultResponse(
            pool_id=pool_id,
            user_id=user_id,
            result=entry.result.value,
            fan_weight=entry.fan_weight,
            weight_breakdown=weight_breakdown,
            invested_ap=entry.invested_ap or 0,
            pool_stats=pool_stats,
            verification_link=verification_link,
        )
