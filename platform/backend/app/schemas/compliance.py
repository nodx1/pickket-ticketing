"""Studio compliance report schemas (P2-16)."""

from datetime import datetime

from pydantic import BaseModel, Field


class AnomalyFlag(BaseModel):
    anomaly_id: str
    user_id: str
    score: float
    reasons: list[str]
    is_blocked: bool
    created_at: datetime


class PriceViolation(BaseModel):
    tier_id: str
    tier_name: str
    base_price: float
    avg_actual_price: float
    min_actual_price: float
    max_actual_price: float
    deviation_pct: float = Field(description="기본가 대비 편차(%)")


class ComplianceReport(BaseModel):
    event_id: str
    event_title: str

    # Overall score: green (80-100), yellow (50-79), red (0-49)
    compliance_score: int = Field(ge=0, le=100)
    score_level: str = Field(description="green / yellow / red")

    # Bid anomalies
    total_anomalies: int
    blocked_anomalies: int
    anomaly_flags: list[AnomalyFlag]

    # Price compliance
    price_violations: list[PriceViolation]
    price_compliance_ok: bool

    # Refund & complaint rates
    total_orders: int
    refund_count: int
    refund_rate: float = Field(description="환불률 (%)")
    complaint_count: int
    complaint_rate: float = Field(description="불만율 (%)")

    generated_at: datetime
