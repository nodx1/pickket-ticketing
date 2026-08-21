"""CS 티켓 Pydantic 스키마."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


# ─── Enums (mirrors model enums for validation) ────────────────────────────

class TicketCategoryEnum:
    REFUND = "refund"
    PAYMENT = "payment"
    ACCOUNT = "account"
    EVENT = "event"
    TECHNICAL = "technical"
    OTHER = "other"
    ALL = ["refund", "payment", "account", "event", "technical", "other"]


class TicketStatusEnum:
    OPEN = "open"
    IN_PROGRESS = "in_progress"
    WAITING_CUSTOMER = "waiting_customer"
    RESOLVED = "resolved"
    CLOSED = "closed"
    ALL = ["open", "in_progress", "waiting_customer", "resolved", "closed"]


class TicketPriorityEnum:
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    URGENT = "urgent"
    ALL = ["low", "normal", "high", "urgent"]


# ─── Request schemas ───────────────────────────────────────────────────────

class CSTicketCreate(BaseModel):
    subject: str = Field(..., min_length=1, max_length=300)
    description: str = Field(..., min_length=1)
    category: str = Field(default="other")
    priority: str = Field(default="normal")
    reporter_id: uuid.UUID
    assignee_id: uuid.UUID | None = None
    event_id: uuid.UUID | None = None
    related_order_id: uuid.UUID | None = None


class CSTicketUpdate(BaseModel):
    subject: str | None = None
    description: str | None = None
    status: str | None = None
    priority: str | None = None
    assignee_id: uuid.UUID | None = None
    category: str | None = None


class CSTicketCommentCreate(BaseModel):
    content: str = Field(..., min_length=1)
    is_internal: bool = False


# ─── Response schemas ──────────────────────────────────────────────────────

class CSTicketCommentResponse(BaseModel):
    id: uuid.UUID
    ticket_id: uuid.UUID
    author_id: uuid.UUID
    author_name: str | None = None
    author_email: str | None = None
    content: str
    is_internal: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class CSTicketResponse(BaseModel):
    id: uuid.UUID
    subject: str
    description: str
    category: str
    status: str
    priority: str
    reporter_id: uuid.UUID
    reporter_name: str | None = None
    reporter_email: str | None = None
    assignee_id: uuid.UUID | None
    assignee_name: str | None = None
    assignee_email: str | None = None
    event_id: uuid.UUID | None
    event_title: str | None = None
    related_order_id: uuid.UUID | None
    sla_deadline: datetime | None
    escalated: bool
    created_at: datetime
    updated_at: datetime
    resolved_at: datetime | None
    comment_count: int = 0

    model_config = {"from_attributes": True}


class CSTicketListResponse(BaseModel):
    tickets: list[CSTicketResponse]
    total: int


class CSTicketDetailResponse(CSTicketResponse):
    comments: list[CSTicketCommentResponse] = []


class CSTicketStatsResponse(BaseModel):
    total: int
    open: int
    in_progress: int
    waiting_customer: int
    resolved: int
    closed: int
    overdue: int
