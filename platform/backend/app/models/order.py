import uuid
from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum as PyEnum

from sqlalchemy import CheckConstraint, String, Integer, ForeignKey, Enum, DateTime, JSON, Index, Text, text, Numeric
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship, validates

from app.core.database import Base
from app.core.pii import EncryptedString, phone_lookup_digest
from app.models.types import Money

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class OrderStatus(str, PyEnum):
    PENDING = "pending"
    PAYMENT_REQUIRED = "payment_required"
    AUTHORIZED = "authorized"
    PAID = "paid"
    CONFIRMED = "confirmed"
    CANCELLED = "cancelled"
    EXPIRED = "expired"
    PARTIALLY_REFUNDED = "partially_refunded"
    REFUNDED = "refunded"
    DEPOSIT_HELD = "deposit_held"
    DEPOSIT_REFUNDED = "deposit_refunded"
    DEPOSIT_FORFEITED = "deposit_forfeited"


# Valid state transitions — enforced at application level
VALID_ORDER_TRANSITIONS: dict[str, set[str]] = {
    OrderStatus.PENDING: {OrderStatus.PAYMENT_REQUIRED, OrderStatus.CANCELLED, OrderStatus.EXPIRED, OrderStatus.CONFIRMED},
    OrderStatus.PAYMENT_REQUIRED: {OrderStatus.AUTHORIZED, OrderStatus.CONFIRMED, OrderStatus.CANCELLED, OrderStatus.EXPIRED},
    OrderStatus.AUTHORIZED: {OrderStatus.CONFIRMED, OrderStatus.CANCELLED},
    OrderStatus.CONFIRMED: {OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED, OrderStatus.REFUNDED},
    OrderStatus.PAID: {OrderStatus.PARTIALLY_REFUNDED, OrderStatus.REFUNDED},
    # PARTIALLY_REFUNDED → PARTIALLY_REFUNDED 자기전이 허용: 부분환불 다회(여러 티켓 순차 환불).
    # (§2.6 SSOT 단일화 — internal_commerce._ORDER_TRANSITIONS 흡수. 잔액 소진 시 → REFUNDED.)
    OrderStatus.PARTIALLY_REFUNDED: {OrderStatus.PARTIALLY_REFUNDED, OrderStatus.REFUNDED},
    OrderStatus.DEPOSIT_HELD: {OrderStatus.DEPOSIT_REFUNDED, OrderStatus.DEPOSIT_FORFEITED},
    # Terminal states — no transitions out
    OrderStatus.CANCELLED: set(),
    OrderStatus.EXPIRED: set(),
    OrderStatus.REFUNDED: set(),
    OrderStatus.DEPOSIT_REFUNDED: set(),
    OrderStatus.DEPOSIT_FORFEITED: set(),
}


def validate_order_transition(current: OrderStatus, target: OrderStatus) -> None:
    """Raise ValueError if the status transition is not allowed."""
    allowed = VALID_ORDER_TRANSITIONS.get(current, set())
    if target not in allowed:
        raise ValueError(
            f"Invalid order status transition: {current.value} → {target.value}"
        )


class OrderType(str, PyEnum):
    PURCHASE = "purchase"
    RESALE_BUY = "resale_buy"
    RESALE_SELL = "resale_sell"
    DEPOSIT = "deposit"


class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (
        # 상세통합 S1(§2.1): user_id nullable 화에 따라 user 스코프 인덱스 partial 화(게스트 행 제외).
        Index(
            "idx_order_user_event",
            "user_id",
            "event_id",
            postgresql_where=text("user_id IS NOT NULL"),
        ),
        Index(
            "uq_orders_payment_id",
            "payment_id",
            unique=True,
            postgresql_where=text("payment_id IS NOT NULL"),
        ),
        Index(
            "uq_orders_pg_transaction_id",
            "pg_transaction_id",
            unique=True,
            postgresql_where=text("pg_transaction_id IS NOT NULL"),
        ),
        Index(
            "uq_orders_payment_webhook_event_id",
            "payment_webhook_event_id",
            unique=True,
            postgresql_where=text("payment_webhook_event_id IS NOT NULL"),
        ),
        # WP-3: Order status lookup
        Index("idx_order_status", "status"),
        # WP-3: User orders by status
        Index(
            "idx_order_user_status",
            "user_id",
            "status",
            postgresql_where=text("user_id IS NOT NULL"),
        ),
        # WP-5: FK index for tier lookups
        Index("idx_order_tier_id", "tier_id"),
        # P0-11: hotpath composite indexes
        Index(
            "idx_order_user_status_created",
            "user_id",
            "status",
            "created_at",
            postgresql_where=text("user_id IS NOT NULL"),
        ),
        Index("idx_order_event_status", "event_id", "status"),
        # DB reconcile: 기존 DB 인덱스 모델 선언 동기화
        Index("idx_order_status_deadline", "status", "payment_deadline"),
        Index("ix_orders_event_id", "event_id"),
        Index("ix_orders_not_deleted", "id", postgresql_where=text("deleted_at IS NULL")),
        Index(
            "ix_orders_user_created",
            "user_id",
            "created_at",
            postgresql_where=text("user_id IS NOT NULL"),
        ),
        Index(
            "ix_orders_user_idempotency",
            "user_id",
            "payment_idempotency_key",
            unique=True,
            postgresql_where=text("payment_idempotency_key IS NOT NULL"),
        ),
        # §36 P0: financial integrity constraints
        CheckConstraint("total_amount >= 0", name="ck_orders_total_amount_nonneg"),
        CheckConstraint("quantity > 0", name="ck_orders_quantity_positive"),
        CheckConstraint("unit_price >= 0", name="ck_orders_unit_price_nonneg"),
        CheckConstraint("total_refunded >= 0", name="ck_orders_total_refunded_nonneg"),
        CheckConstraint(
            "total_refunded <= total_amount", name="ck_orders_total_refunded_lte_total"
        ),
        # SPEC §1.6 — go order id ↔ v2 canonical order_id 매핑(원자주문 멱등 dedup).
        Index("ix_orders_external_ref", "external_ref", unique=True),
        # 공개 티켓 조회용 keyed blind index. Fernet ciphertext는 비결정적이라 등호 조회 불가.
        Index("ix_orders_buyer_phone_lookup_hash", "buyer_phone_lookup_hash"),
        # 상세통합 S1(§2.1): 게스트 주문 인덱스. guest_id 있는 행만.
        Index(
            "idx_orders_guest",
            "guest_id",
            postgresql_where=text("guest_id IS NOT NULL"),
        ),
        # 상세통합 S1(§2.1): 구매자 정확히 하나 — 회원(user_id) XOR 게스트(guest_id).
        # 기존 행은 전부 user_id NOT NULL → 통과(초기화 전제, 데이터 없음).
        # CASE 형식(postgres '::int' 캐스트 대신) — postgres·sqlite 양쪽 파싱/강제 가능(테스트 DB 정합).
        CheckConstraint(
            "(CASE WHEN user_id IS NOT NULL THEN 1 ELSE 0 END) "
            "+ (CASE WHEN guest_id IS NOT NULL THEN 1 ELSE 0 END) = 1",
            name="ck_orders_buyer_exactly_one",
        ),
        # 멀티PG payment_method 대분류 값도메인(dev_v3 계약 (5), 마이그 paymeth1_0723).
        # 바이트 일치 — NULL 또는 대분류 집합만 허용(간편결제 세부는 payment_metadata).
        CheckConstraint(
            "payment_method IS NULL OR payment_method IN "
            "('card', 'vbank', 'transfer', 'mobile', 'easy_pay', 'point', 'free')",
            name="ck_orders_payment_method_valid",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # 상세통합 S1(§2.1): 회원 주문은 user_id, 게스트 주문은 guest_id — XOR(ck_orders_buyer_exactly_one).
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=True
    )
    # 게스트 주문 구매자(§2.1 C안). RESTRICT — 미청산 게스트 주문 있으면 guest 삭제 차단(회계보존).
    guest_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("guests.id", ondelete="RESTRICT"), nullable=True
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="RESTRICT"), nullable=False
    )
    tier_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seat_tiers.id", ondelete="RESTRICT"), nullable=True
    )
    order_type: Mapped[OrderType] = mapped_column(Enum(OrderType, values_callable=lambda e: [x.value for x in e]), default=OrderType.PURCHASE)
    status: Mapped[OrderStatus] = mapped_column(Enum(OrderStatus, values_callable=lambda e: [x.value for x in e]), default=OrderStatus.PENDING)
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    unit_price: Mapped[Decimal] = mapped_column(Money, nullable=False)
    total_amount: Mapped[Decimal] = mapped_column(Money, nullable=False)
    payment_currency: Mapped[str] = mapped_column(String(8), default="KRW", nullable=False)

    # Payment provider identifiers
    payment_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    payment_idempotency_key: Mapped[str | None] = mapped_column(String(120), nullable=True)
    pg_provider: Mapped[str | None] = mapped_column(String(50), nullable=True)
    pg_transaction_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    pg_approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    authorized_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    captured_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    payment_deadline: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    payment_started_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    payment_failed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    payment_failed_reason: Mapped[str | None] = mapped_column(String(300), nullable=True)
    payment_webhook_event_id: Mapped[str | None] = mapped_column(String(120), nullable=True)
    # 결제수단 대분류 저장(dev_v3 계약 (5), 마이그 paymeth1_0723). provider 원본
    # payMethod/method 를 대분류(card/vbank/transfer/mobile/easy_pay/point/free)로
    # 정규화해 확정 시 1회 기록 — 간편결제 세부(카카오/네이버/삼성)는 payment_metadata.
    payment_method: Mapped[str | None] = mapped_column(String(20), nullable=True)
    payment_metadata: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    total_refunded: Mapped[Decimal] = mapped_column(
        Money, default=0, server_default="0", nullable=False
    )
    # Fee 동결 — 주문 확정 시점 1회 기록(정산 역산 SSOT). MASTER N5/P0-3.
    # 단계3 expand: nullable, 기존 무영향. settlement는 이 값을 기간 SUM만.
    platform_fee_rate: Mapped[Decimal | None] = mapped_column(Numeric(6, 4), nullable=True)
    platform_fee: Mapped[Decimal | None] = mapped_column(Money, nullable=True)
    pg_fee_rate: Mapped[Decimal | None] = mapped_column(Numeric(6, 4), nullable=True)
    pg_fee: Mapped[Decimal | None] = mapped_column(Money, nullable=True)
    net_amount: Mapped[Decimal | None] = mapped_column(Money, nullable=True)
    fee_schedule_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("fee_schedules.id", ondelete="SET NULL"), nullable=True
    )
    affiliate_code: Mapped[str | None] = mapped_column(String(50), nullable=True)
    # ── T2-ORD: go orders 고유 컬럼 흡수(go DB 제거 선행). 전부 가산·기본값 보유. ──
    # 주최자 주문 워크플로 메모(운영 기록). go orders.memo 동등.
    memo: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 사기탐지 점수/플래그 — go fraud-detector 산출물. go orders.fraud_score/fraud_flags 동등.
    fraud_score: Mapped[int | None] = mapped_column(Integer, nullable=True, default=0)
    fraud_flags: Mapped[list | None] = mapped_column(_JSON_TYPE, nullable=True, default=list)
    # 유입경로: direct | manual | group | import. go orders.source 동등.
    source: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default=text("'direct'"), default="direct"
    )
    external_ref: Mapped[str | None] = mapped_column(String(100), nullable=True)  # go order id
    # 레벨2 재감사3차 P1 — external_ref(멱등키) **문맥 결속 지문**.
    # 최초 주문 생성 시 (event_id + 정규화 items + total_amount) 해시를 기록한다.
    # 같은 external_order_id 재사용 요청이 다른 이벤트/상품/수량/금액이면(fingerprint 불일치)
    # 옛 주문의 ticket_ids/금액을 재생하지 않고 409(IDEMPOTENCY_KEY_MISMATCH)로 차단한다.
    # (호출자 durable 토큰이 장바구니/이벤트 문맥 변경 후 재사용돼 **잘못된 event/티켓/금액
    #  조합**이 반환되던 결함 차단 — go 프론트 토큰 재발급과 이중 방어.)
    external_ref_fingerprint: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # 게스트 체크아웃(user_id 없는 go 주문)의 구매자 정보 — SPEC §3.1 #1.
    buyer_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # buyer_email 은 평문 유지 — internal_commerce_read 의 주문/참석자 검색이
    # buyer_email.ilike(%q%) 로 SQL 필터(조회키). 비결정적 Fernet ciphertext 는
    # 패턴매칭 불가 → 암호화 시 검색이 깨진다. 노출은 API 계층 마스킹(_mask_email)으로 방어.
    buyer_email: Mapped[str | None] = mapped_column(String(320), nullable=True)
    # PII 암호화(마이그 guest5_0723): guests.phone_enc 와 정합. EncryptedString 은
    # 앱계층 Fernet — DB 컬럼은 문자열(length=512, ciphertext 105자 수용). 비결정적
    # ciphertext를 SQL로 비교하지 않고 아래 keyed blind index를 조회한다.
    buyer_phone: Mapped[str | None] = mapped_column(EncryptedString(length=512), nullable=True)
    buyer_phone_lookup_hash: Mapped[str | None] = mapped_column(String(64), nullable=True)

    @validates("buyer_phone")
    def _sync_buyer_phone_lookup_hash(self, _key: str, value: str | None) -> str | None:
        """모든 ORM 주문 쓰기에서 암호문과 조회 index를 함께 갱신한다."""
        self.buyer_phone_lookup_hash = phone_lookup_digest(value)
        return value
    terms_agreed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    time_slot_start: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
        index=True,
    )
    time_slot_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    event: Mapped["Event"] = relationship(back_populates="orders", lazy="raise")  # noqa: F821
    tickets: Mapped[list["Ticket"]] = relationship(  # noqa: F821
        backref="order", foreign_keys="Ticket.purchase_order_id", lazy="raise"
    )
