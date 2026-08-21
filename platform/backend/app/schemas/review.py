"""Review schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class ReviewCreate(BaseModel):
    rating: int = Field(..., ge=1, le=5)
    title: str = Field(..., min_length=1, max_length=200)
    content: str = Field(..., min_length=10, max_length=2000)


class ReviewResponse(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    event_id: uuid.UUID
    rating: int
    title: str
    content: str
    is_verified_attendee: bool
    helpful_count: int
    reviewer_name: str = ""
    created_at: datetime

    model_config = {"from_attributes": True}


class ReviewSummary(BaseModel):
    average_rating: float
    total_reviews: int
    rating_distribution: dict[int, int]  # {5: 10, 4: 5, 3: 2, 2: 1, 1: 0}
