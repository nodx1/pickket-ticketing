"""분석 집계 모델 — P2-12 Data Warehouse + Cohort Analysis.

일별 메트릭 집계 및 코호트 분석 데이터를 저장합니다.
ETL 태스크(etl_aggregation)에서 매일 새벽 3시에 생성됩니다.
"""

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import Date, String, Float, Integer, Index, DateTime, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class DailyAggregate(Base):
    """일별 집계 메트릭.

    Examples:
        date=2026-04-01, metric_name="orders_count", dimension="event_category",
        dimension_value="concert", value=150
    """
    __tablename__ = "daily_aggregates"
    __table_args__ = (
        UniqueConstraint("agg_date", "metric_name", "dimension", "dimension_value",
                         name="uq_daily_agg_metric"),
        Index("idx_daily_agg_date_metric", "agg_date", "metric_name"),
        Index("idx_daily_agg_dimension", "dimension", "dimension_value"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    agg_date: Mapped[date] = mapped_column(Date, nullable=False)
    metric_name: Mapped[str] = mapped_column(String(80), nullable=False)
    dimension: Mapped[str] = mapped_column(String(50), nullable=False, default="total")
    dimension_value: Mapped[str] = mapped_column(String(100), nullable=False, default="all")
    value: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class CohortMetric(Base):
    """코호트 분석 메트릭.

    가입월(cohort_month) 기준으로 N개월 후(period_months)의
    리텐션, LTV 등의 메트릭을 추적합니다.

    Examples:
        cohort_month=2026-01, period_months=3, metric_name="retention_rate", value=0.42
    """
    __tablename__ = "cohort_metrics"
    __table_args__ = (
        UniqueConstraint("cohort_month", "period_months", "metric_name",
                         name="uq_cohort_metric"),
        Index("idx_cohort_month_metric", "cohort_month", "metric_name"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    cohort_month: Mapped[date] = mapped_column(Date, nullable=False)
    period_months: Mapped[int] = mapped_column(Integer, nullable=False)
    metric_name: Mapped[str] = mapped_column(String(80), nullable=False)
    value: Mapped[float] = mapped_column(Float, nullable=False, default=0)
    sample_size: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
