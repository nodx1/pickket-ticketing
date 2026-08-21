"""상거래 부가기능 모델 — 레벨2 컷오버 wave5 **W5-COMMERCE**.

go DB 완전 제거에 맞춰 아래 go-local 테이블을 v2 로 흡수한다.

| go 테이블 | v2 대응 | 비고 |
|---|---|---|
| `group_bookings`        | `group_bookings` (이 파일)        | 단체예약 워크플로 |
| `refund_policies`       | `event_refund_policies` (이 파일) | 이벤트별 커스텀 환불 규칙 |
| `pricing_rules`         | `tier_pricing_rules` (이 파일)    | 동적 가격 규칙 |
| `price_history`         | `tier_price_history` (이 파일)    | 가격 변경 이력 |
| `promo_codes`           | 기존 `discount_codes`             | 이미 v2 정본(신설 없음) |
| `product_bundle_items`  | 기존 `seat_tiers.bundle_items`    | 이미 v2 JSONB(신설 없음) |

## 🔴 돈이 걸린 테이블이다
`event_refund_policies.rules` 는 환불액 산정의 입력이고, `tier_price_history` 는 결제액이
언제 왜 바뀌었는지의 유일한 증거다. 조회 실패를 "정책 없음"·"이력 없음"으로 흘리면
표시액과 실제 처리액이 갈라진다 — 라우트는 전부 fail-closed(503)로 끊는다.

## 소유 경계
전부 `event_id` 스코프다. 테넌트 경계는 organizer 가 호출 **전에**
`resolveOwnedV2EventId`(= `GET /internal/events/{id}?organizer_ref=`)로 강제한다.
이 테이블들에 `account_id` 를 중복 보관하지 않는 이유: 두 곳에 있으면 언젠가 갈라진다.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.types import Money

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


# ── 단체예약 ────────────────────────────────────────────────────────────────

GROUP_BOOKING_STATUSES = ("pending", "confirmed", "cancelled")


class GroupBooking(Base):
    """단체예약 신청·승인 워크플로 (go `group_bookings` 흡수).

    ## 상태 전이 (v2 가 원자 집행 — go 라우트 가드의 이관)
    `pending → confirmed` · `pending → cancelled` · `confirmed → cancelled` 만 허용.
    재승인(`confirmed → confirmed`)·부활(`cancelled → confirmed`)은 409.
    go 시절 이 가드는 라우트 안의 read-then-write 였고 동시 2회 승인 시 v2 주문이
    **중복 생성**될 수 있었다(감사 P0-9 의 잔여 레이스). 여기서는 `SELECT ... FOR UPDATE`
    로 행을 잠그고 판정하므로 동시 요청 중 하나만 통과한다.

    ## 상품/주문 참조를 왜 FK 로 걸지 않는가
    - `product_ref` = go 상품 id(= v2 `seat_tiers.external_ref`). 티어는 external_ref 로
      주소지정되고 삭제/재생성될 수 있어 하드 FK 는 신청 이력을 파괴한다.
    - `order_ref` = go order id(= v2 `orders.external_ref`). go 주문 앵커는 아직 go 소유라
      v2 orders.id 로 결속하지 않는다. 주문번호는 승인 시점 **스냅샷**으로 보관해
      목록 조회가 주문 테이블 조인에 의존하지 않게 한다(조인 실패 = 목록 소실 방지).
    """

    __tablename__ = "group_bookings"
    __table_args__ = (
        Index("idx_group_bookings_event", "event_id", "created_at"),
        CheckConstraint("attendee_count >= 2", name="ck_group_bookings_attendee_min"),
        CheckConstraint(
            "discount_rate >= 0 AND discount_rate <= 100",
            name="ck_group_bookings_discount_rate",
        ),
        CheckConstraint(
            "status IN ('pending', 'confirmed', 'cancelled')",
            name="ck_group_bookings_status",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    # go 상품 id(= seat_tiers.external_ref). 표시용 상품명/가격은 조회 시 티어에서 해석한다.
    product_ref: Mapped[str] = mapped_column(String(100), nullable=False)
    # 승인으로 생성된 go 주문 id(= orders.external_ref) + 표시용 주문번호 스냅샷.
    order_ref: Mapped[str | None] = mapped_column(String(100), nullable=True)
    order_number: Mapped[str | None] = mapped_column(String(64), nullable=True)

    organization_name: Mapped[str] = mapped_column(String(200), nullable=False)
    contact_name: Mapped[str] = mapped_column(String(100), nullable=False)
    contact_email: Mapped[str] = mapped_column(String(255), nullable=False)
    contact_phone: Mapped[str | None] = mapped_column(String(40), nullable=True)
    attendee_count: Mapped[int] = mapped_column(Integer, nullable=False)
    # 승인 시 적용한 단체 할인율(%). 0 = 정가.
    discount_rate: Mapped[float] = mapped_column(Money, nullable=False, default=0)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    rejection_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # go 세션 사용자 id(문자열 보관 — v2 users 와 결속하지 않는다).
    approved_by_ref: Mapped[str | None] = mapped_column(String(100), nullable=True)
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


# ── 환불 정책 ───────────────────────────────────────────────────────────────


class EventRefundPolicy(Base):
    """이벤트별 커스텀 환불 규칙 (go `refund_policies` 흡수).

    ## ⚠️ go 시절 이 기능은 **반쪽**이었다
    실측 결과 go 에는 `SELECT` 만 있고 **INSERT/UPDATE 경로가 하나도 없었다**(writer 0).
    즉 커스텀 정책은 DB 를 손으로 만지지 않는 한 절대 생기지 않았고, 화면·환불 API 는
    언제나 기본규칙(`lib/refund/calculator.ts` defaultRules)으로만 동작했다.
    W5-COMMERCE 는 이 테이블을 옮기면서 **write 경로(PUT/DELETE)를 신설**해 기능을 실제로
    작동시킨다.

    ## `rules` 형식 (go `RefundRule[]` 과 동형 — 계산기 입력 그대로)
    `[{"daysBefore": 10, "percent": 100, "label": "D-10 이전"}, ...]`
    - `daysBefore` 내림차순 매칭. 저장 시 v2 가 형식을 검증한다(형식 오류 = 400).
    - 빈 배열은 저장하지 않는다 — "규칙 0개"는 환불 전면 불가로 오독될 수 있어,
      기본규칙으로 돌아가려면 `DELETE`(정책 제거)를 쓴다.

    이벤트당 1건(UNIQUE). go 는 `ORDER BY created_at DESC LIMIT 1` 로 다건 중 최신을 골랐는데,
    그건 "어느 게 유효한지 모르는 상태"라 금액 산정 입력으로는 위험하다 — 단일 행으로 고정한다.
    """

    __tablename__ = "event_refund_policies"
    __table_args__ = (
        UniqueConstraint("event_id", name="uq_event_refund_policies_event"),
        CheckConstraint(
            "refund_type IN ('full', 'partial')", name="ck_event_refund_policies_type"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    refund_type: Mapped[str] = mapped_column(String(20), nullable=False, default="partial")
    rules: Mapped[list] = mapped_column(_JSON_TYPE, nullable=False, default=list)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )


# ── 동적 가격 ───────────────────────────────────────────────────────────────

PRICING_RULE_TYPES = ("demand", "time", "inventory", "surge")


class TierPricingRule(Base):
    """동적 가격 규칙 (go `pricing_rules` 흡수). 티어(=상품) 스코프.

    ⚠️ **집행 엔진은 아직 없다.** go 에서도 규칙은 저장·조회만 됐고 가격을 실제로 바꾸는
    코드는 없었다(적용 경로 grep 0건). 이관은 규칙 보관·조회 계약을 그대로 옮긴 것이며,
    "규칙이 자동으로 가격을 바꾼다"는 보장은 **여기에도 없다**. 그 사실을 숨기지 않기 위해
    이력(`TierPriceHistory`)에는 실제 발생한 변경만 기록한다(규칙 기인 여부는 `rule_id`).
    """

    __tablename__ = "tier_pricing_rules"
    __table_args__ = (
        Index("idx_tier_pricing_rules_tier", "tier_id", "priority"),
        CheckConstraint(
            "rule_type IN ('demand', 'time', 'inventory', 'surge')",
            name="ck_tier_pricing_rules_type",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tier_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seat_tiers.id", ondelete="CASCADE"), nullable=False
    )
    rule_type: Mapped[str] = mapped_column(String(30), nullable=False)
    config: Mapped[dict] = mapped_column(_JSON_TYPE, nullable=False, default=dict)
    priority: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )


class TierPriceHistory(Base):
    """가격 변경 이력 (go `price_history` 흡수).

    ## go 에서는 writer 가 없었다 → v2 에서 **실제로 기록된다**
    go `price_history` 도 SELECT 만 있고 INSERT 가 없어 화면은 언제나 비어 있었다.
    v2 에서는 티어 upsert(`_do_upsert_tiers`)가 `base_price` 변경을 감지해 이 표에 남긴다.
    가격 정본이 v2 티어 한 곳이므로, 그 한 곳에서 기록하면 **누락 경로가 없다**.
    """

    __tablename__ = "tier_price_history"
    __table_args__ = (Index("idx_tier_price_history_tier", "tier_id", "applied_at"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tier_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seat_tiers.id", ondelete="CASCADE"), nullable=False
    )
    old_price: Mapped[float] = mapped_column(Money, nullable=False)
    new_price: Mapped[float] = mapped_column(Money, nullable=False)
    # 규칙 기인 변경이면 그 규칙. 수동 변경이면 NULL.
    rule_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tier_pricing_rules.id", ondelete="SET NULL"), nullable=True
    )
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    applied_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
