import uuid
from pydantic import BaseModel


class TierStatusResponse(BaseModel):
    tier_id: uuid.UUID
    tier_name: str
    sale_mode: str
    total_seats: int
    sold_seats: int
    remaining_seats: int
    total_revenue: float
    avg_price: float
    competition_ratio: float
    waitlist_size: int


class EventDashboardResponse(BaseModel):
    event_id: uuid.UUID
    event_name: str
    current_phase: str
    tier_statuses: list[TierStatusResponse]
    total_revenue: float
    total_sold: int
    total_remaining: int
    fair_gini: float | None = None
    fair_overbidding: float | None = None
    fair_surplus: float | None = None


class ComplianceReportResponse(BaseModel):
    event_id: uuid.UUID
    total_transactions: int
    anomalies_blocked: int
    identity_verified_pct: float
    price_cap_violations: int
    audit_entries_count: int
    engine_report: dict | None = None
