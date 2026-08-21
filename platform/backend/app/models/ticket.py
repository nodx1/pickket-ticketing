import uuid
from datetime import date, datetime, timezone
from decimal import Decimal
from enum import Enum as PyEnum

from sqlalchemy import CheckConstraint, String, Integer, ForeignKey, Enum, DateTime, Date, Boolean, Index, JSON, LargeBinary, event, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.types import Money

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class TicketStatus(str, PyEnum):
    PENDING = "pending"
    ACTIVE = "active"
    TRANSFERRED = "transferred"
    CANCELLED = "cancelled"
    USED = "used"
    EXPIRED = "expired"


def derive_ticket_number(ticket_id: uuid.UUID | str) -> str:
    """티켓 UUID → 사람이 읽는 티켓번호(소비자 URL 키).

    **go 와 완전히 동일한 결정적 공식**을 유지한다. go `orders.ts` 앵커 write 가
    `TKT-${ticketId.replace(/-/g,"").slice(0,12).toUpperCase()}` 로 생성해 왔으므로,
    v2 가 같은 공식을 쓰면 **이미 발급된 티켓 URL·QR·지갑 패스가 그대로 유효**하다
    (go 제거 시 재발급/링크 파손 0). 결정적이라 재시도·복구 시에도 값이 흔들리지 않는다.
    """
    return "TKT-" + str(ticket_id).replace("-", "")[:12].upper()


class Ticket(Base):
    __tablename__ = "tickets"
    __table_args__ = (
        Index("idx_ticket_current_owner", "current_owner_id"),
        Index("idx_tickets_event_tier", "event_id", "tier_id"),
        # P0-11: hotpath composite indexes
        Index("idx_ticket_owner_status", "current_owner_id", "status"),
        Index("idx_ticket_event_status", "event_id", "status"),
        Index("ix_tickets_event_checked_in", "event_id", "checked_in_at"),  # H3: 체크인 집계
        Index(
            "uq_tickets_qr_code_hash",
            "qr_code_hash",
            unique=True,
            postgresql_where=text("qr_code_hash IS NOT NULL"),
        ),
        # DB reconcile: 기존 DB 인덱스 모델 선언 동기화
        Index("ix_tickets_not_deleted", "id", postgresql_where=text("deleted_at IS NULL")),
        Index("ix_tickets_owner_created", "current_owner_id", "created_at"),
        Index(
            "ix_tickets_seat_active",
            "event_id",
            "seat_id",
            unique=True,
            postgresql_where=text(
                "seat_id IS NOT NULL AND status IN ('active'::ticketstatus, 'pending'::ticketstatus)"
            ),
        ),
        CheckConstraint("transfer_count >= 0", name="ck_tickets_transfer_count_nonneg"),
        # 상세통합 S2a(§2.1): 티켓 소유는 회원(current_owner_id) XOR 게스트(guest_owner_id).
        # 둘 다 세팅 금지 — 둘 다 NULL 은 허용(미발급/무료 미배정 케이스). claim 시 rebind.
        # CASE 형식(postgres '::int' 캐스트 대신) — postgres·sqlite 양쪽 파싱 가능(테스트 DB 정합).
        CheckConstraint(
            "(CASE WHEN current_owner_id IS NOT NULL THEN 1 ELSE 0 END) "
            "+ (CASE WHEN guest_owner_id IS NOT NULL THEN 1 ELSE 0 END) <= 1",
            name="ck_tickets_owner_not_both",
        ),
        # 상세통합 S2a(§2.1): 게스트 소유 티켓 조회 인덱스(guest_owner_id 있는 행만).
        Index(
            "idx_tickets_guest_owner",
            "guest_owner_id",
            postgresql_where=text("guest_owner_id IS NOT NULL"),
        ),
        # F4 경품번호: 이벤트 스코프 유니크 (raffle_number 부여된 티켓만).
        Index(
            "uq_tickets_event_raffle_number",
            "event_id",
            "raffle_number",
            unique=True,
            postgresql_where=text("raffle_number IS NOT NULL"),
        ),
        # T2-ORD: 사람이 읽는 티켓번호 = 소비자 티켓 URL 키(go attendees.ticket_number 흡수).
        # 전역 유니크(go 동등). NULL(미부여) 다수 허용 → partial unique.
        Index(
            "uq_tickets_ticket_number",
            "ticket_number",
            unique=True,
            postgresql_where=text("ticket_number IS NOT NULL"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="RESTRICT"), nullable=False
    )
    tier_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seat_tiers.id", ondelete="RESTRICT"), nullable=False
    )
    seat_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seats.id", ondelete="SET NULL"), nullable=True
    )
    original_owner_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    current_owner_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    # 상세통합 S2a(§2.1): 게스트(비회원) 소유. 회원 소유(current_owner_id)와 XOR
    # (ck_tickets_owner_not_both). RESTRICT — 미청산 게스트 티켓 있으면 guest 삭제 차단(회계보존).
    # claim(회원 승격) 시 guest_owner_id → current_owner_id 로 rebind(§2.4).
    guest_owner_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("guests.id", ondelete="RESTRICT"), nullable=True
    )
    purchase_price: Mapped[Decimal] = mapped_column(Money, nullable=False)
    sale_mode: Mapped[str] = mapped_column(String(50), nullable=False)
    purchase_order_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orders.id", ondelete="RESTRICT"), nullable=True
    )
    # 단계3 expand: OrderItem 라인 연결(nullable). 백필은 단계6 cutover.
    order_item_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("order_items.id", ondelete="SET NULL"), nullable=True
    )
    status: Mapped[TicketStatus] = mapped_column(Enum(TicketStatus, values_callable=lambda e: [x.value for x in e]), default=TicketStatus.ACTIVE)
    # 체크인 상태(v2 ticket SoT). 집계 SoT 는 go-local 로그(현장도구) — 이 값은 상태 통지.
    # F1: 다일 입장에서 checked_in_at 은 "최초 입장 시각" 을 유지(표시/호환용). 멱등 판정은
    # event_admissions 원장이 SoT. (재스캔·다일 입장으로 이 스칼라를 덮어쓰지 않는다.)
    checked_in_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # F1: 최초 입장 시각 — 부작용(포인트·NFT·보증금) 1회 트리거 + 양도/재판매 가드.
    first_checked_in_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    # F1: daypass 지정/확정 입장일(KST 로컬 date). single/allpass 는 NULL.
    admission_day: Mapped[date | None] = mapped_column(Date, nullable=True)
    # F4: 경품 응모번호 — raffle_enabled 이벤트에서만 발권 시 부여(이벤트 스코프 유니크).
    # raffle_enabled=false 이벤트 티켓은 NULL(하위호환).
    raffle_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    # T2-ORD: go attendees.ticket_number 흡수. 소비자 티켓 URL(`/tickets/{n}`)·QR·PDF·
    # Apple/Google 지갑의 진입 키. v2 는 tickets.id(UUID) 로 키잉하므로 이 값이 없으면
    # go 제거 시 이미 발급된 티켓 URL 이 전부 깨진다. 발권 경로가 부여(없으면 NULL).
    ticket_number: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # T2-ORD: go attendees.answers 흡수 — 예매 설문(event_questions) 응답 {questionId: value}.
    answers: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    qr_code_hash: Mapped[str | None] = mapped_column(String(128), nullable=True)
    nfc_uid: Mapped[str | None] = mapped_column(String(64), nullable=True, unique=True)
    identity_verified: Mapped[bool] = mapped_column(Boolean, default=False)
    is_resalable: Mapped[bool] = mapped_column(Boolean, default=True)
    resale_max_price: Mapped[Decimal] = mapped_column(Money, default=0.0)
    transfer_count: Mapped[int] = mapped_column(Integer, default=0)
    totp_seed: Mapped[bytes | None] = mapped_column(
        LargeBinary, nullable=True, comment="TOTP seed for rotating QR (32 bytes, encrypted)"
    )
    device_hash: Mapped[str | None] = mapped_column(
        String(64), nullable=True, comment="SHA-256 hash of bound device"
    )
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    event: Mapped["Event"] = relationship(back_populates="tickets", lazy="raise")  # noqa: F821
    tier: Mapped["SeatTier"] = relationship(back_populates="tickets", lazy="raise")  # noqa: F821
    transfers: Mapped[list["OwnershipTransfer"]] = relationship(back_populates="ticket", lazy="raise")  # noqa: F821


@event.listens_for(Ticket, "before_insert")
def _assign_ticket_number(_mapper, _connection, target: Ticket) -> None:
    """T2-ORD: 모든 발권 경로에 티켓번호를 보장하는 단일 choke point.

    go 제거 후 `ticket_number` 는 소비자 티켓 URL·QR·지갑의 유일한 키다. 발권 경로가
    여러 곳(internal_commerce 주문생성·purchase_processor·payment_expiry 승계·추첨)이라
    호출부마다 부여하면 **한 군데만 빠져도 접근 불가 티켓**이 생긴다. mapper before_insert 는
    컬럼 default 적용 **전에** 실행되므로 여기서 id 를 확정하고 번호를 파생한다.
    """
    if target.id is None:
        target.id = uuid.uuid4()
    if target.ticket_number is None:
        target.ticket_number = derive_ticket_number(target.id)
