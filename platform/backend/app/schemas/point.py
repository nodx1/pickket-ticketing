"""Pydantic schemas for Point system API responses."""

import uuid
from datetime import datetime

from pydantic import BaseModel


class PointBalanceResponse(BaseModel):
    """Combined balance for both point types."""

    fan: int
    social: int

    model_config = {"from_attributes": True}


class PointTransactionResponse(BaseModel):
    """Single point transaction record."""

    id: uuid.UUID
    wallet_id: uuid.UUID
    tx_type: str
    amount: int
    balance_after: int
    reference_id: uuid.UUID | None
    description: str | None
    created_at: datetime

    model_config = {"from_attributes": True}


class PointHistoryResponse(BaseModel):
    """Paginated transaction history."""

    transactions: list[PointTransactionResponse]
    total: int
