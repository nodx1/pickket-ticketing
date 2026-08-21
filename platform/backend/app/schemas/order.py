import uuid
from datetime import datetime
from urllib.parse import urlparse

from pydantic import BaseModel, Field, field_validator


class OrderCreate(BaseModel):
    tier_id: uuid.UUID
    quantity: int = Field(default=1, ge=1, le=4)
    time_slot_start: datetime | None = None
    time_slot_end: datetime | None = None


class OrderResponse(BaseModel):
    id: uuid.UUID
    # 상세통합 S2b(§2.1): 게스트(비회원) 주문은 user_id 가 NULL(소유는 guest_id).
    # 종전 non-null 이라 게스트 confirm 의 _to_response 가 ValidationError 로 깨졌음 —
    # nullable 로 완화(회원 주문 계약은 불변, nullable 은 superset).
    user_id: uuid.UUID | None = None
    guest_id: uuid.UUID | None = None
    event_id: uuid.UUID
    tier_id: uuid.UUID | None
    order_type: str
    status: str
    quantity: int
    unit_price: float
    total_amount: float
    payment_currency: str
    payment_id: str | None = None
    pg_provider: str | None = None
    pg_transaction_id: str | None = None
    payment_deadline: datetime | None = None
    payment_started_at: datetime | None = None
    pg_approved_at: datetime | None = None
    authorized_at: datetime | None = None
    captured_at: datetime | None = None
    payment_failed_at: datetime | None = None
    payment_failed_reason: str | None = None
    time_slot_start: datetime | None = None
    time_slot_end: datetime | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


_ALLOWED_REDIRECT_DOMAINS = {"pickket.kr", "www.pickket.kr", "localhost"}


class PaymentPrepareRequest(BaseModel):
    idempotency_key: str | None = Field(default=None, max_length=120)
    success_url: str | None = Field(None, max_length=500)
    fail_url: str | None = Field(None, max_length=500)
    # 나이스 구형 결제창 사용자 선택 결제수단(CARD/BANK/VBANK/CELLPHONE/EASYPAY 등).
    # 서버가 화이트리스트 정규화(오염값→CARD)한다. 미지정 시 CARD. 토스/포트원은 무시.
    pay_method: str | None = Field(default=None, max_length=32)

    @field_validator("success_url", "fail_url", mode="before")
    @classmethod
    def validate_redirect_url(cls, v: str | None) -> str | None:
        if v is None:
            return v
        parsed = urlparse(v)
        if parsed.scheme not in ("https", "http", "pickket"):
            raise ValueError("Redirect URL must use http(s) or pickket:// scheme")
        if parsed.scheme == "pickket":
            return v  # Deep-link scheme — skip domain check
        host = (parsed.hostname or "").lower()
        if host not in _ALLOWED_REDIRECT_DOMAINS and not host.endswith(".pickket.kr"):
            raise ValueError(
                f"Redirect URL domain '{host}' is not allowed. "
                "Only pickket.kr and its subdomains are permitted."
            )
        return v


class PaymentPrepareResponse(BaseModel):
    order_id: uuid.UUID
    provider: str
    payment_id: str
    amount: float
    currency: str
    redirect_url: str
    payment_deadline: datetime
    status: str
    # 구형 결제창(JS SDK)이 요구하는 provider 별 form params.
    # nicepay 구형은 서버가 계산한 payForm(MID·SignData·ReturnURL·MallReserved 등)을
    # consumer 로 내려줘야 결제창을 띄울 수 있다(MerchantKey 는 서버전용 → 서명 서버계산).
    # 토스/mock/포트원은 None(기존 8필드 계약 무변, 추가 optional 필드).
    provider_params: dict | None = None


class PaymentConfirm(BaseModel):
    pg_provider: str = "portone"
    # 수동 결제확정(dev/test, PAYMENT_MANUAL_API_ENABLED) 시 클라이언트가
    # pg_transaction_id를 생략하면 주문마다 고유한 placeholder를 생성한다.
    # 과거 상수 "stub_txn" 기본값은 orders.pg_transaction_id UNIQUE 제약과
    # 충돌해, 두 번째 주문 확정부터 500(IntegrityError)을 유발했다(라이브 시뮬 발견).
    pg_transaction_id: str = Field(default_factory=lambda: f"stub_txn_{uuid.uuid4().hex[:16]}")
    payment_id: str | None = None
    amount: float | None = Field(default=None, gt=0)


class PaymentVoidRequest(BaseModel):
    reason: str = Field(default="authorization_voided", max_length=300)


class PaymentWebhookResponse(BaseModel):
    ok: bool = True
    message: str = "accepted"


class RefundRequest(BaseModel):
    reason: str = Field(..., min_length=1, max_length=500)
    amount: float | None = Field(default=None, gt=0)
    ticket_ids: list[uuid.UUID] | None = Field(default=None, min_length=1, max_length=100)
    idempotency_key: str | None = Field(default=None, max_length=120)


class RefundResponse(BaseModel):
    refund_id: uuid.UUID
    order_id: uuid.UUID
    status: str
    refund_status: str
    refund_amount: float
    original_amount: float
    reason: str
    requires_approval: bool
    ticket_ids: list[uuid.UUID]
    refunded_at: datetime


class PartialRefundItem(BaseModel):
    ticket_id: uuid.UUID
    amount: float = Field(..., gt=0)


class PartialRefundRequest(BaseModel):
    items: list[PartialRefundItem] = Field(..., min_length=1)
    reason: str = Field(default="부분 환불 요청", min_length=1, max_length=500)
    idempotency_key: str | None = Field(default=None, max_length=120)


class QuantityRefundRequest(BaseModel):
    quantity: int = Field(..., ge=1)
    reason: str = Field(default="수량 기반 환불", min_length=1, max_length=500)
    idempotency_key: str | None = Field(default=None, max_length=120)
