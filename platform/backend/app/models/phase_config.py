import uuid
from datetime import datetime

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# PostgreSQL 은 JSONB, SQLite 테스트는 JSON 으로 컴파일 (event.py 와 동일 규약).
_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")

#: 판매 단계 모드 — docs SALE_MODE_POLICY_v2 canonical.
SALE_PHASE_MODES = (
    "membership_presale",
    "lottery",
    "waitlist_promotion",
    "queue_sale",
    "fcfs_residual",
)

#: 주최자가 직접 고르는 주 판매 모드 (waitlist_promotion/fcfs_residual 은 자동 부가).
MAIN_SALE_PHASE_MODES = ("membership_presale", "lottery", "queue_sale")

#: 단계 상태기계 (go sale_phases.status 와 동일 6종).
SALE_PHASE_STATUSES = (
    "scheduled",
    "open",
    "closed",
    "allocating",
    "allocated",
    "skipped",
)

#: 주최자가 판매계획을 더 바꿀 수 없는(이미 진행/완료된) 상태.
LOCKED_PHASE_STATUSES = ("open", "closed", "allocating", "allocated")


class PhaseConfig(Base):
    """이벤트 판매 단계 — **판매계획의 SSOT**.

    레벨2 컷오버 T2-PHASE 이전에는 go `sale_phases` 가 주최자 저장소, 이 테이블은
    "심사 요청 웹훅이 한 번 밀어넣는 손실 투영"이었다. 이제 주최자 판매계획 write 가
    `internal_commerce` 의 sale-plan 경로로 직접 들어와 이 테이블이 정본이 된다.

    `config` 는 과거 Redis TTL 7일에만 존재하던 값(payment_window_hours,
    waitlist_payment_window_hours, fanclub_id)의 **영속 저장소**다. Redis flush/만료
    시 결제창이 env 기본값으로 되돌아가던 결함을 이 컬럼이 닫는다.
    """

    __tablename__ = "phase_configs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    phase: Mapped[str] = mapped_column(String(50), nullable=False)
    starts_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # NULL = 종료 시각 미정(무기한). go `sale_phases.closes_at NULL` 의 표현력 보존.
    # ⚠️ 시간창 비교 쿼리는 반드시 `ends_at IS NULL OR ends_at >= now` 로 쓸 것.
    ends_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    applicable_tier_ids: Mapped[str | None] = mapped_column(
        String(2000), nullable=True
    )  # JSON string of UUID list (SQLite compatible)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    # ── T2-PHASE: go sale_phases 흡수 컬럼 ──────────────────────────────
    #: 이 단계에 배정된 좌석 수. NULL = "이월분 전부"(waitlist_promotion/fcfs_residual).
    target_quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    allocated_quantity: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default=text("0")
    )
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="scheduled", server_default=text("'scheduled'")
    )
    config: Mapped[dict] = mapped_column(
        _JSON_TYPE, nullable=False, default=dict, server_default=text("'{}'")
    )

    __table_args__ = (UniqueConstraint("event_id", "phase", name="uq_event_phase"),)
