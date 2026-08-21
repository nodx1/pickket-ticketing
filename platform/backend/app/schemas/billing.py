"""Schemas for billing key (saved card) management and one-click payment."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


# ── Card registration ──────────────────────────────────────────────
#
# AUDIT 2026-04-20 §38 P0 (PCI-DSS):
# 서버는 절대 PAN(card_number) / 비밀번호 앞 2자리 / 생년월일을 수신하지 않는다.
# 클라이언트(모바일/웹)가 PortOne Browser/RN SDK를 통해 빌링키를 직접 발급받고,
# 서버에는 발급된 opaque billing_key + 마스킹된 카드 메타만 전송한다.
# 이로써 백엔드는 PCI-DSS 범위(scope)에서 완전히 제외된다.


class BillingTokenRequest(BaseModel):
    """PortOne 프론트 SDK가 발급한 빌링키를 수신. PAN/비밀번호/생년월일 없음."""
    billing_key: str = Field(
        ..., min_length=10, max_length=512,
        description="PortOne에서 프론트 SDK로 발급받은 opaque 빌링키 토큰",
    )
    card_type: str = Field(..., description='"credit" | "check" | "gift"')
    last_four: str = Field(..., min_length=4, max_length=4, description="카드 뒷 4자리")
    card_brand: str = Field(..., description='"visa" | "master" | "amex" | ...')
    nickname: str | None = Field(None, max_length=50)
    set_default: bool = Field(False, description="기본 결제 수단으로 설정")


class CardResponse(BaseModel):
    """Masked card information returned to client."""
    id: uuid.UUID
    card_type: str
    last_four: str
    card_brand: str
    is_default: bool
    nickname: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class CardListResponse(BaseModel):
    cards: list[CardResponse]
    count: int


# ── One-click payment ──────────────────────────────────────────────

class OneClickPayRequest(BaseModel):
    """One-click payment using a saved card."""
    order_id: uuid.UUID
    billing_key_id: uuid.UUID | None = Field(
        None, description="Specific card to charge. If null, uses default card."
    )
    idempotency_key: str | None = Field(None, max_length=120)


class OneClickPayResponse(BaseModel):
    order_id: uuid.UUID
    status: str
    payment_id: str
    pg_transaction_id: str | None = None
    amount: float
    currency: str
    card_last_four: str
    card_brand: str
