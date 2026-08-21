"""판매 단계(sale plan) 서비스 — go `lib/sale-plan/service.ts` 의 v2 정본 이식.

레벨2 컷오버 T2-PHASE. 이전에는 주최자의 판매계획이 go `sale_phases` 에 저장되고
v2 `phase_configs` 에는 **"심사 요청" 웹훅이 딱 한 번** 손실 투영을 밀어넣었다.
그래서 승인 이후 주최자가 판매계획을 바꿔도 v2 의 자동 추첨/FCFS 전환은 옛 시각으로
돌았다(현존 P0 #1). 이 모듈이 판매계획 write 의 정본 경로가 되어 그 결함을 닫는다.

시간 정책(정본 docs §5-3, go service.ts 와 1:1):
  - 단계 간 기본 최소 간격      24h  (PHASE_GAP_HOURS)
  - 주 단계 결제창              72h  (PRIMARY_PAYMENT_WINDOW_HOURS)
  - 주 단계 사이 최소 간격      결제창 + 기본 간격 (기본 96h)
  - 대기자 승격 단계 길이      168h  (WAITLIST_DURATION_HOURS)
  - 승격된 대기자 결제창        24h  (WAITLIST_PAYMENT_WINDOW_HOURS)
"""

from __future__ import annotations

import logging
import os
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete as sql_delete
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.event import Event
from app.models.phase_config import (
    LOCKED_PHASE_STATUSES,
    MAIN_SALE_PHASE_MODES,
    PhaseConfig,
)
from app.models.seat import Seat

logger = logging.getLogger(__name__)

MAX_MAIN_PHASES = 3


class SalePlanError(Exception):
    """주최자에게 그대로 노출되는 검증 실패(한국어 메시지)."""

    def __init__(self, message: str, code: str = "VALIDATION_ERROR"):
        super().__init__(message)
        self.message = message
        self.code = code


# ── 시간 상수 ────────────────────────────────────────────────────────────


def _env_hours(name: str, default_hours: float) -> float:
    """env 오버라이드(E2E 단축용). 값이 비정상이면 기본값."""
    raw = os.getenv(name)
    if not raw:
        return default_hours
    try:
        value = float(raw)
    except (TypeError, ValueError):
        return default_hours
    return value if value > 0 else default_hours


@dataclass(frozen=True)
class PhaseTimingPolicy:
    gap_hours: float
    primary_payment_window_hours: float
    waitlist_duration_hours: float
    waitlist_payment_window_hours: float

    @property
    def min_between_main_phases_hours(self) -> float:
        return self.primary_payment_window_hours + self.gap_hours


def resolve_timing_policy() -> PhaseTimingPolicy:
    """운영 시간 정책. env 로 단축 가능하되 production 에서는 하한(1h) 강제.

    go service.ts 의 production 도메인 가드 이식 — 테스트용 짧은 env 가 운영에
    유출되면 결제창이 몇 분으로 줄어 실제 구매자가 티켓을 잃는다.
    """
    policy = PhaseTimingPolicy(
        gap_hours=_env_hours("PHASE_GAP_HOURS", 24),
        primary_payment_window_hours=_env_hours("PRIMARY_PAYMENT_WINDOW_HOURS", 72),
        waitlist_duration_hours=_env_hours("WAITLIST_DURATION_HOURS", 168),
        waitlist_payment_window_hours=_env_hours("WAITLIST_PAYMENT_WINDOW_HOURS", 24),
    )
    if settings.ENVIRONMENT == "production":
        violations = [
            f"{name}={value}h (최소 1h)"
            for name, value in (
                ("PHASE_GAP_HOURS", policy.gap_hours),
                ("PRIMARY_PAYMENT_WINDOW_HOURS", policy.primary_payment_window_hours),
                ("WAITLIST_DURATION_HOURS", policy.waitlist_duration_hours),
                ("WAITLIST_PAYMENT_WINDOW_HOURS", policy.waitlist_payment_window_hours),
            )
            if value < 1
        ]
        if violations:
            raise SalePlanError(
                "production 환경에서 비정상적으로 짧은 판매단계 시간 상수가 감지되었습니다 — "
                + ", ".join(violations)
                + ". 해당 환경변수를 제거하거나 정상값(24/72/168/24)으로 설정해주세요.",
                code="PHASE_TIMING_MISCONFIGURED",
            )
    return policy


# ── 입력 스펙 ────────────────────────────────────────────────────────────


@dataclass
class PhaseSpec:
    """주최자가 판매 방식 카드에서 저장하는 단일 주 단계."""

    mode: str
    ratio_pct: float
    opens_at: datetime
    closes_at: datetime
    fanclub_id: str | None = None


@dataclass
class PhaseRow:
    """DB 에 기록될 단계 1행 (검증 통과 후 산출물)."""

    phase: str
    sort_order: int
    starts_at: datetime
    ends_at: datetime | None
    target_quantity: int | None
    config: dict = field(default_factory=dict)
    status: str = "scheduled"


# ── 검증 (go validatePhaseInputs 이식) ───────────────────────────────────


def validate_phase_specs(
    phases: list[PhaseSpec],
    fcfs_opens_at: datetime | None,
    policy: PhaseTimingPolicy | None = None,
) -> None:
    policy = policy or resolve_timing_policy()

    if not phases:
        if fcfs_opens_at is None:
            raise SalePlanError(
                "최소 하나의 판매 단계를 선택하거나 선착순 시작 시각을 입력해주세요"
            )
        return

    if len(phases) > MAX_MAIN_PHASES:
        raise SalePlanError(f"판매 단계는 최대 {MAX_MAIN_PHASES}개까지 선택할 수 있습니다")

    for i, p in enumerate(phases):
        if p.mode not in MAIN_SALE_PHASE_MODES:
            raise SalePlanError(f"{i + 1}번째 단계의 판매 방식이 올바르지 않습니다: {p.mode}")

    sum_ratio = sum(p.ratio_pct for p in phases)
    if round(sum_ratio) != 100:
        raise SalePlanError(f"판매 단계 비율 합계가 100% 여야 합니다 (현재: {sum_ratio}%)")

    if len({p.mode for p in phases}) != len(phases):
        raise SalePlanError("같은 판매 방식을 중복 선택할 수 없습니다")

    for i, p in enumerate(phases):
        if p.ratio_pct <= 0:
            raise SalePlanError(f"{i + 1}번째 단계의 비율은 0보다 커야 합니다")
        if p.closes_at <= p.opens_at:
            raise SalePlanError(f"{i + 1}번째 단계의 마감 시각은 시작보다 이후여야 합니다")
        if p.mode == "membership_presale" and not p.fanclub_id:
            raise SalePlanError("멤버십 선예매 단계는 연결할 팬클럽을 선택해주세요")
        if i > 0:
            prev = phases[i - 1]
            gap_hours = (p.opens_at - prev.closes_at).total_seconds() / 3600
            if gap_hours < policy.min_between_main_phases_hours:
                raise SalePlanError(
                    f"{i + 1}번째 단계는 이전 단계 마감 후 최소 "
                    f"{policy.min_between_main_phases_hours}시간 뒤에 시작해야 합니다 "
                    f"(결제창 {policy.primary_payment_window_hours}h + "
                    f"간격 {policy.gap_hours}h, docs §5-3). "
                    "이 시간 동안 이전 단계의 결제 마감과 미결제 이월이 처리됩니다."
                )


def validate_against_event(
    phases: list[PhaseSpec],
    fcfs_opens_at: datetime | None,
    event_starts_at: datetime | None,
    policy: PhaseTimingPolicy | None = None,
) -> None:
    """이벤트 시작 시각과의 정합 — 자동 부가 단계가 공연 이후에 끝나면 안 된다."""
    policy = policy or resolve_timing_policy()
    if event_starts_at is None:
        raise SalePlanError("이벤트 시작 시각이 설정되지 않았습니다")
    event_starts_at = _as_utc(event_starts_at)

    if phases:
        last_main = phases[-1]
        waitlist_opens = last_main.closes_at + timedelta(
            hours=policy.primary_payment_window_hours
        )
        waitlist_closes = waitlist_opens + timedelta(hours=policy.waitlist_duration_hours)
        if event_starts_at <= waitlist_closes:
            required = policy.primary_payment_window_hours + policy.waitlist_duration_hours
            raise SalePlanError(
                f"이벤트 시작 시각이 너무 빠릅니다. 마지막 판매 단계 마감 후 최소 {required}시간 "
                f"(결제창 {policy.primary_payment_window_hours}h + "
                f"대기자 승격 {policy.waitlist_duration_hours}h) "
                "이후로 공연 시작 시각을 잡거나, 마지막 판매 단계 마감 시각을 앞당겨주세요."
            )
    elif fcfs_opens_at is not None and event_starts_at <= _as_utc(fcfs_opens_at):
        raise SalePlanError("선착순 시작 시각이 이벤트 시작 시각보다 늦거나 같습니다")


# ── 시퀀스 구성 (go buildPhaseSequence 이식) ─────────────────────────────


def build_phase_rows(
    phases: list[PhaseSpec],
    fcfs_opens_at: datetime | None,
    total_seats: int,
    event_starts_at: datetime,
    policy: PhaseTimingPolicy | None = None,
) -> list[PhaseRow]:
    policy = policy or resolve_timing_policy()
    event_starts_at = _as_utc(event_starts_at)

    if not phases:
        if fcfs_opens_at is None:
            raise SalePlanError("선착순 시작 시각이 필요합니다")
        return [
            PhaseRow(
                phase="fcfs_residual",
                sort_order=1,
                starts_at=_as_utc(fcfs_opens_at),
                ends_at=event_starts_at,
                target_quantity=None,
                config={},
            )
        ]

    rows: list[PhaseRow] = []
    for idx, p in enumerate(phases):
        config: dict = {"payment_window_hours": policy.primary_payment_window_hours}
        if p.mode == "membership_presale" and p.fanclub_id:
            config["fanclub_id"] = str(p.fanclub_id)
        quota = int(total_seats * p.ratio_pct // 100)
        rows.append(
            PhaseRow(
                phase=p.mode,
                sort_order=idx + 1,
                starts_at=_as_utc(p.opens_at),
                ends_at=_as_utc(p.closes_at),
                target_quantity=quota if quota > 0 else None,
                config=config,
            )
        )

    last = phases[-1]
    waitlist_opens = _as_utc(last.closes_at) + timedelta(
        hours=policy.primary_payment_window_hours
    )
    waitlist_closes = waitlist_opens + timedelta(hours=policy.waitlist_duration_hours)

    rows.append(
        PhaseRow(
            phase="waitlist_promotion",
            sort_order=len(phases) + 1,
            starts_at=waitlist_opens,
            ends_at=waitlist_closes,
            target_quantity=None,
            config={
                "waitlist_payment_window_hours": policy.waitlist_payment_window_hours
            },
        )
    )
    rows.append(
        PhaseRow(
            phase="fcfs_residual",
            sort_order=len(phases) + 2,
            starts_at=waitlist_closes,
            ends_at=event_starts_at,
            target_quantity=None,
            config={},
        )
    )
    return rows


# ── 저장 ────────────────────────────────────────────────────────────────


async def compute_total_capacity(db: AsyncSession, event: Event) -> int:
    """이벤트 총 정원(지정석 좌석 수 + 스탠딩 섹션 정원).

    v2 가 커머스 SoT 이므로 자기 데이터로 직접 계산한다(go 왕복 없음).
    스탠딩은 published 배치도의 figmaLayout standing 섹션 capacity 합.
    """
    seat_count = (
        await db.execute(
            select(func.count(Seat.id)).where(Seat.event_id == event.id)
        )
    ).scalar() or 0

    standing = 0
    maps = ((event.seat_map_data or {}).get("maps") or []) if isinstance(event.seat_map_data, dict) else []
    published = [m for m in maps if isinstance(m, dict) and m.get("status") == "published"]
    if published:
        canvas = published[-1].get("map_data")
        sections = []
        if isinstance(canvas, dict):
            layout = canvas.get("figmaLayout")
            if isinstance(layout, dict):
                sections = layout.get("sections") or []
        for s in sections:
            if isinstance(s, dict) and s.get("kind") == "standing":
                try:
                    standing += int(s.get("capacity") or 0)
                except (TypeError, ValueError):
                    continue
    return int(seat_count) + standing


async def list_phases(db: AsyncSession, event_id: uuid.UUID) -> list[PhaseConfig]:
    return list(
        (
            await db.execute(
                select(PhaseConfig)
                .where(PhaseConfig.event_id == event_id)
                .order_by(PhaseConfig.sort_order.asc())
            )
        )
        .scalars()
        .all()
    )


async def get_current_phase(db: AsyncSession, event_id: uuid.UUID) -> PhaseConfig | None:
    """팬에게 노출할 현재 단계. 우선순위: open > 가장 이른 scheduled.

    go `salePhaseRepo.findCurrentByEvent` 와 동일 우선순위.
    """
    rows = (
        await db.execute(
            select(PhaseConfig)
            .where(
                PhaseConfig.event_id == event_id,
                PhaseConfig.status.in_(("open", "scheduled")),
            )
            .order_by(PhaseConfig.sort_order.asc())
        )
    ).scalars().all()
    if not rows:
        return None
    for row in rows:
        if row.status == "open":
            return row
    return rows[0]


async def apply_sale_plan(
    db: AsyncSession,
    event: Event,
    phases: list[PhaseSpec],
    fcfs_opens_at: datetime | None,
) -> list[PhaseConfig]:
    """주최자 판매계획 저장 — phase_configs 를 새 시퀀스로 **원자 교체**.

    안전장치:
      1. 이미 진행/완료된 단계가 있으면 거부(무결성).
      2. 좌석 0인 이벤트에 주 단계 설정 거부.
      3. **산출 시퀀스가 비면 삭제하지 않는다** — delete-then-insert 가 빈 입력에
         phase 를 통째로 날리는 사고를 원천 차단.
    호출자가 commit 한다(같은 트랜잭션에서 event 갱신과 함께 커밋되도록).
    """
    policy = resolve_timing_policy()

    validate_phase_specs(phases, fcfs_opens_at, policy)
    validate_against_event(phases, fcfs_opens_at, event.event_date, policy)

    existing = await list_phases(db, event.id)
    locked = [p for p in existing if p.status in LOCKED_PHASE_STATUSES]
    if locked:
        raise SalePlanError(
            "이미 진행중이거나 완료된 판매 단계가 있어 변경할 수 없습니다",
            code="PHASE_LOCKED",
        )

    total_seats = await compute_total_capacity(db, event)
    if phases and total_seats == 0:
        raise SalePlanError("좌석이 하나도 없는 이벤트에는 판매 단계를 설정할 수 없습니다")

    rows = build_phase_rows(phases, fcfs_opens_at, total_seats, event.event_date, policy)

    # 🔒 빈 시퀀스 가드 — 여기 도달하면 논리 버그. 지우지 말고 실패시킨다.
    if not rows:
        raise SalePlanError(
            "판매 단계를 생성하지 못했습니다(빈 시퀀스). 기존 판매 단계는 유지됩니다.",
            code="EMPTY_PHASE_SEQUENCE",
        )

    await db.execute(sql_delete(PhaseConfig).where(PhaseConfig.event_id == event.id))
    # SQLAlchemy 는 flush 순서상 DELETE 를 INSERT 뒤로 미룰 수 있어(uq_event_phase 충돌)
    # 명시적으로 먼저 반영한다.
    await db.flush()

    created: list[PhaseConfig] = []
    for row in rows:
        pc = PhaseConfig(
            event_id=event.id,
            phase=row.phase,
            starts_at=row.starts_at,
            ends_at=row.ends_at,
            sort_order=row.sort_order,
            target_quantity=row.target_quantity,
            allocated_quantity=0,
            status=row.status,
            config=row.config,
        )
        db.add(pc)
        created.append(pc)
    await db.flush()

    # 판매창(bidding_opens_at/closes_at) 은 단계 시퀀스에서 파생 — go 가 심사요청 웹훅으로
    # 밀어주던 값을 정본 경로가 직접 갱신한다(현존 버그 #1: 승인 후 변경 미반영).
    opens = min(r.starts_at for r in rows)
    closes_candidates = [r.ends_at for r in rows if r.ends_at is not None]
    # events CHECK 제약: bidding_closes_at > bidding_opens_at. 종료 시각이 하나도 없는
    # (전부 무기한) 시퀀스면 공연 시작 시각을 판매 종료로 삼아 불변식을 유지한다.
    closes = max(closes_candidates) if closes_candidates else _as_utc(event.event_date)
    if closes <= opens:
        closes = max(_as_utc(event.event_date), opens + timedelta(hours=1))
    event.bidding_opens_at = opens
    event.bidding_closes_at = closes

    # 멤버십 단계의 팬클럽은 `config.fanclub_id` 에 영속된다(과거 Redis TTL 7일에만 존재).
    # v2 Event 에는 fanclub_id 컬럼이 없고 팬클럽 게이팅은 community_id 로 하므로
    # 이벤트-커뮤니티 연결은 건드리지 않는다(범위 밖 · 다른 트랙 소유).

    logger.info(
        "sale plan applied: event=%s phases=%s total_seats=%s",
        event.id,
        [r.phase for r in rows],
        total_seats,
    )
    return created


# ── config 조회 (현존 버그 #2: Redis TTL 의존 제거) ──────────────────────


async def get_phase_config_value(
    db: AsyncSession, event_id: uuid.UUID, key: str, phases: tuple[str, ...] | None = None
) -> float | None:
    """phase_configs.config 에서 숫자 설정값 조회(영속 SoT).

    Redis 캐시는 가속용일 뿐이며 flush/만료되면 사라진다. 이 함수가 DB 정본을 읽는다.
    """
    stmt = select(PhaseConfig).where(PhaseConfig.event_id == event_id)
    if phases:
        stmt = stmt.where(PhaseConfig.phase.in_(phases))
    rows = (await db.execute(stmt.order_by(PhaseConfig.sort_order.asc()))).scalars().all()
    for row in rows:
        cfg = row.config or {}
        if isinstance(cfg, dict) and cfg.get(key) is not None:
            try:
                return float(cfg[key])
            except (TypeError, ValueError):
                continue
    return None


def active_phase_window_filter(now: datetime):
    """`starts_at <= now AND (ends_at IS NULL OR ends_at >= now)` 조건.

    ends_at 이 nullable 로 완화되면서 `ends_at >= now` 단독 비교는 무기한 단계를
    **조용히 탈락**시킨다. 시간창 비교는 반드시 이 헬퍼를 쓸 것.
    """
    return (
        PhaseConfig.starts_at <= now,
        or_(PhaseConfig.ends_at.is_(None), PhaseConfig.ends_at >= now),
    )


def phase_to_dict(pc: PhaseConfig) -> dict:
    """go `SalePhase` DTO 호환 직렬화 (주최자 UI·소비자 훅이 그대로 읽는 키 이름)."""
    return {
        "id": str(pc.id),
        "eventId": str(pc.event_id),
        "phaseOrder": pc.sort_order,
        "mode": pc.phase,
        "opensAt": pc.starts_at.isoformat() if pc.starts_at else None,
        "closesAt": pc.ends_at.isoformat() if pc.ends_at else None,
        "targetQuantity": pc.target_quantity,
        "allocatedQuantity": pc.allocated_quantity or 0,
        "status": pc.status,
        "config": pc.config or {},
    }


def _as_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=timezone.utc)
    return value.astimezone(timezone.utc)
