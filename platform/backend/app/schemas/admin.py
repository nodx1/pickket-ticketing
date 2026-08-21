"""Admin API schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class PlatformKPIResponse(BaseModel):
    total_users: int
    total_organizers: int
    total_events: int
    active_events: int
    total_communities: int
    total_tickets: int
    new_users_7d: int
    new_events_7d: int


class AdminUserItem(BaseModel):
    id: uuid.UUID
    email: str
    name: str
    is_organizer: bool
    is_admin: bool
    is_active: bool
    is_verified: bool
    verification_level: int
    abuse_score: float
    admin_role: str | None = None
    created_at: datetime


class AdminUserListResponse(BaseModel):
    users: list[AdminUserItem]
    total: int


class AdminEventItem(BaseModel):
    id: uuid.UUID
    title: str
    organizer_id: uuid.UUID
    category: str
    status: str
    total_seats: int
    bid_count: int
    is_featured: bool
    event_date: datetime
    created_at: datetime


class AdminEventListResponse(BaseModel):
    events: list[AdminEventItem]
    total: int


class AdminCommunityItem(BaseModel):
    id: uuid.UUID
    name: str
    artist_name: str
    subject_name: str | None
    community_type: str
    domain: str | None
    organizer_id: uuid.UUID
    member_count: int
    is_official: bool
    is_active: bool
    created_at: datetime


class AdminCommunityListResponse(BaseModel):
    communities: list[AdminCommunityItem]
    total: int


class UserRoleUpdate(BaseModel):
    is_organizer: bool | None = None
    is_admin: bool | None = None


class UserBanAction(BaseModel):
    reason: str = ""


class AuditEntryResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID | None = None
    action: str
    actor_id: uuid.UUID | None = None
    resource_type: str | None = None
    resource_id: str | None = None
    old_value: dict | None = None
    new_value: dict | None = None
    created_at: datetime


class AuditLogResponse(BaseModel):
    entries: list[AuditEntryResponse]
    total: int


# ── Admin Order / Ticket (CS lookup) ──────────────────────────────


class AdminOrderItem(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    user_email: str | None = None
    user_name: str | None = None
    event_id: uuid.UUID
    event_title: str | None = None
    order_type: str
    status: str
    quantity: int
    total_amount: float
    payment_id: str | None = None
    pg_transaction_id: str | None = None
    created_at: datetime


class AdminOrderListResponse(BaseModel):
    orders: list[AdminOrderItem]
    total: int


class AdminTicketItem(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    event_title: str | None = None
    tier_id: uuid.UUID
    status: str
    purchase_price: float
    sale_mode: str
    created_at: datetime


class AdminTicketListResponse(BaseModel):
    tickets: list[AdminTicketItem]
    total: int


# ── Finance ───────────────────────────────────────────────────────


class FinanceSummaryResponse(BaseModel):
    gross_revenue: float
    platform_fees: float
    pg_fees: float = 0.0
    total_refunds: float
    net_settlement: float
    order_count: int
    refund_count: int
    daily_revenue: list[dict] | None = None  # [{date, amount}]


class FinanceByEventItem(BaseModel):
    event_id: uuid.UUID
    event_title: str
    category: str
    organizer_id: uuid.UUID
    gross_revenue: float
    platform_fee: float
    pg_fee: float = 0.0
    refund_total: float
    net_settlement: float
    ticket_count: int


class FinanceByEventResponse(BaseModel):
    events: list[FinanceByEventItem]
    total: int


class FinanceByOrganizerItem(BaseModel):
    organizer_id: uuid.UUID
    organizer_name: str
    organizer_email: str
    event_count: int
    gross_revenue: float
    platform_fee: float
    pg_fee: float = 0.0
    net_settlement: float


class FinanceByOrganizerResponse(BaseModel):
    organizers: list[FinanceByOrganizerItem]
    total: int


# ── Bulk operations ───────────────────────────────────────────────


class BulkActionRequest(BaseModel):
    ids: list[uuid.UUID] = Field(..., max_length=500)
    reason: str = ""


class BulkEventReviewRequest(BaseModel):
    ids: list[uuid.UUID] = Field(..., max_length=500)
    action: str  # approve / reject / revision_requested
    comment: str = ""


class BulkActionResponse(BaseModel):
    success_count: int
    failed_count: int
    detail: str


# ── Admin notifications ──────────────────────────────────────────


class AdminNotificationSend(BaseModel):
    user_ids: list[uuid.UUID] = Field(..., max_length=1000)
    title: str
    message: str
    notification_type: str = "admin_notice"


class AdminNotificationBroadcast(BaseModel):
    target: str  # "all", "organizers", "users"
    title: str
    message: str


class AdminNotificationHistoryItem(BaseModel):
    id: uuid.UUID
    sender_id: uuid.UUID
    target: str
    title: str
    message: str
    recipient_count: int
    created_at: datetime


class AdminNotificationHistoryResponse(BaseModel):
    notifications: list[AdminNotificationHistoryItem]
    total: int


# ── Health / RBAC ────────────────────────────────────────────────


class HealthDetailedResponse(BaseModel):
    status: str  # "healthy" / "degraded" / "unhealthy"
    database: dict  # {connected: bool, latency_ms: float}
    database_read: dict | None = None  # {connected: bool, latency_ms: float, is_separate: bool}
    redis: dict  # {connected: bool, latency_ms: float}
    storage: dict  # {status: str, provider: str, latency_ms: float | None}
    celery: dict  # {workers: int, active_tasks: int}
    scheduler: dict  # {status, last_heartbeat_at, age_seconds}
    backup: dict  # {status, last_success_at, age_seconds, backup_id, last_error}
    uptime_seconds: float
    error_count_24h: int


class AdminRoleUpdate(BaseModel):
    admin_role: str | None = None  # "super_admin", "admin", "moderator", "finance_admin", "cs_agent", "viewer", None


# ── Custom Reports ─────────────────────────────────────────────


class ReportRequest(BaseModel):
    report_type: str  # sales_summary, user_growth, event_performance, refund_analysis
    date_from: str | None = None  # YYYY-MM-DD
    date_to: str | None = None  # YYYY-MM-DD
    format: str = "json"  # json or csv


class ReportResponse(BaseModel):
    report_type: str
    generated_at: datetime
    data: list[dict]
    summary: dict
