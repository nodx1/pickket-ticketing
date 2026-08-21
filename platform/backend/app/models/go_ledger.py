"""레벨2 컷오버 T2-REST — go 전용 원장 2종의 v2 이관.

go DB 완전 제거 대상 중, **v2 에 대응 테이블이 하나도 없어서 그냥 DROP 하면 데이터가
무성(無聲) 소실되는** 두 원장을 v2 정본으로 옮긴다.

1) TaxInvoice / `tax_invoices`
   세금계산서·현금영수증 발행 원장 = **규제(국세) 데이터**. go `tax_invoices`(mig011)는
   어느 컷오버 트랙에도 편입되지 않아 폐기 시 발행 이력이 사라진다.
   go 원본과의 차이(의도된 개선):
     · `receipt_type` 컬럼 신설 — go 는 현금영수증을 `business_number='-'`,
       `company_name='현금영수증'` 이라는 문자열 하드코딩으로 구분했다(질의 불가).
     · `tax_amount` 를 보존 — go 는 공급가/세액을 계산만 하고 저장하지 않았다.
     · **중복 발행 차단** — go 는 멱등장치가 전혀 없어 더블클릭이면 같은 주문에
       세금계산서가 2건 쌓였다. (order_id, receipt_type) 부분 유니크로 봉쇄한다.
   테넌트 경계: `organizer_id`(v2 user) — go account_id 는 `_resolve_organizer` 로
   해석해 저장한다. 조회는 반드시 organizer_id 로 스코프한다.

2) SeatFunnelEvent / `seat_funnel_events`
   좌석 선택 퍼널(view→hover→select→hold→checkout→complete/abandon) 텔레메트리.
   `internal_commerce_read.py` 가 seat-analytics 응답의 `funnel` 을 **None 하드코딩**하고
   "seat_funnel_events 테이블 미존재 — 별도 신설" 이라 주석으로 남긴 그 테이블이다.
   집계는 `COUNT(DISTINCT session_id)` 이므로 **중복 수집이 결과를 바꾸지 않는다**
   → at-least-once 수집으로 충분하고 멱등키가 필요 없다(설계상 증명).
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# PG 는 JSONB, 테스트(SQLite)는 JSON 으로 렌더 — 리포 전역 관례(_JSON_TYPE)를 따른다.
_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")

# SQLite 는 INTEGER PRIMARY KEY 만 autoincrement 한다(BIGINT 는 NOT NULL 위반).
# PG 는 BIGSERIAL 그대로, 테스트만 INTEGER 로 렌더한다.
_BIGSERIAL_PK = BigInteger().with_variant(Integer(), "sqlite")


# 발행 종류 / 상태 — go 의 CHECK 를 그대로 옮기되 receipt_type 을 명시화.
RECEIPT_TYPES = ("tax_invoice", "cash_receipt")
TAX_INVOICE_STATUSES = ("requested", "issued", "cancelled")

FUNNEL_STEPS = (
    "view",
    "hover",
    "select",
    "hold",
    "checkout",
    "complete",
    "abandon",
)


class TaxInvoice(Base):
    """세금계산서·현금영수증 발행 원장 (규제 데이터, go tax_invoices 이관)."""

    __tablename__ = "tax_invoices"
    __table_args__ = (
        CheckConstraint(
            "receipt_type IN ('tax_invoice','cash_receipt')",
            name="ck_tax_invoices_receipt_type",
        ),
        CheckConstraint(
            "status IN ('requested','issued','cancelled')",
            name="ck_tax_invoices_status",
        ),
        Index("idx_tax_invoices_order", "order_id"),
        Index("idx_tax_invoices_organizer_created", "organizer_id", "created_at"),
        # 취소되지 않은 발행은 (주문, 종류) 당 1건 — 동시 2회 요청의 두 번째가
        # unique violation 으로 튕기고, 호출부는 기존 행을 멱등 재생한다.
        Index(
            "uq_tax_invoices_order_type_active",
            "order_id",
            "receipt_type",
            unique=True,
            postgresql_where=text("status <> 'cancelled'"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orders.id", ondelete="CASCADE"), nullable=False
    )
    # 테넌트 경계. v2 organizer(user) id — go account_id 는 여기 저장하지 않는다.
    organizer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)

    receipt_type: Mapped[str] = mapped_column(String(20), nullable=False)
    business_number: Mapped[str | None] = mapped_column(String(40), nullable=True)
    company_name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    # 현금영수증 식별번호는 개인정보 → 원문 저장 금지. 마스킹된 꼬리 4자리만 남긴다.
    identity_tail: Mapped[str | None] = mapped_column(String(8), nullable=True)

    amount: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)
    tax_amount: Mapped[int] = mapped_column(BigInteger, nullable=False, default=0)

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="requested")
    provider: Mapped[str | None] = mapped_column(String(50), nullable=True)
    issued_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    meta: Mapped[dict] = mapped_column(_JSON_TYPE, nullable=False, default=dict)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )


class SeatFunnelEvent(Base):
    """좌석 선택 퍼널 텔레메트리 (go seat_funnel_events 이관).

    집계가 COUNT(DISTINCT session_id) 이라 중복 삽입이 결과에 영향을 주지 않는다.
    수집 실패는 fail-soft(호출부가 삼킴) — 분석 때문에 구매 경로를 막지 않는다.
    """

    __tablename__ = "seat_funnel_events"
    __table_args__ = (
        CheckConstraint(
            "step IN ('view','hover','select','hold','checkout','complete','abandon')",
            name="ck_seat_funnel_step",
        ),
        Index("idx_seat_funnel_event_step", "event_id", "step", "created_at"),
        Index("idx_seat_funnel_created_at", "created_at"),
    )

    id: Mapped[int] = mapped_column(_BIGSERIAL_PK, primary_key=True, autoincrement=True)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    # 좌석맵 참조는 느슨하게(FK 없음) — v2 좌석맵은 events.map_data(JSON) 라 대상 테이블이 없다.
    seat_map_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    session_id: Mapped[str] = mapped_column(String(100), nullable=False)
    step: Mapped[str] = mapped_column(String(20), nullable=False)
    seat_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    meta: Mapped[dict] = mapped_column(
        "metadata", _JSON_TYPE, nullable=False, default=dict
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )


__all__ = [
    "TaxInvoice",
    "SeatFunnelEvent",
    "RECEIPT_TYPES",
    "TAX_INVOICE_STATUSES",
    "FUNNEL_STEPS",
]
