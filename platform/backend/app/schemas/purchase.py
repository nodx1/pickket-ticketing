import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class PurchaseRequest(BaseModel):
    quantity: int = Field(default=1, ge=1, le=4)
    group_id: uuid.UUID | None = None
    seat_ids: list[uuid.UUID] | None = Field(default=None, max_length=4)
    queue_token: str | None = Field(
        default=None,
        max_length=128,
        description="큐 토큰. 대기열 활성 시 서버에서 발급받은 토큰을 전달하면 값 검증까지 수행.",
    )
    idempotency_key: str = Field(
        default_factory=lambda: uuid.uuid4().hex,
        min_length=8,
        max_length=64,
        description="클라이언트 멱등성 키. 미전송 시 서버에서 자동 생성.",
    )
    time_slot_start: datetime | None = None
    time_slot_end: datetime | None = None


class PurchaseResponse(BaseModel):
    success: bool
    order_id: uuid.UUID | None = None
    ticket_ids: list[uuid.UUID] = []
    sale_mode: str = ""
    unit_price: float = 0.0
    total_price: float = 0.0
    waitlist_position: int | None = None
    processing: bool = False  # True when async purchase is queued (poll /orders/{id}/status)
    message: str
