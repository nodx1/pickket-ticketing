import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel


class NfcBindRequest(BaseModel):
    nfc_uid: str


class NfcTicketLookupResponse(BaseModel):
    ticket_id: uuid.UUID
    event_id: uuid.UUID
    tier_id: uuid.UUID
    current_owner_id: uuid.UUID
    status: str
    nfc_uid: str | None = None


class NftTicketResponse(BaseModel):
    id: uuid.UUID
    ticket_id: uuid.UUID
    event_id: uuid.UUID
    owner_id: uuid.UUID
    token_name: str
    description: str
    image_url: str
    attributes: list[dict[str, Any]] | None = None
    chain: str | None = None
    contract_address: str | None = None
    token_id: int | None = None
    tx_hash: str | None = None
    minted_at: datetime | None = None
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}


class EventNftListResponse(BaseModel):
    items: list[NftTicketResponse]
    total: int
