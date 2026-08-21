"""코호트 분석 API — P2-12 Data Warehouse + Cohort Analysis.

GET /api/v1/admin/cohort/retention  — 리텐션 히트맵 데이터
GET /api/v1/admin/cohort/ltv        — 코호트별 LTV 추세
"""

import logging
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_admin
from app.models.analytics_aggregate import CohortMetric, DailyAggregate
from app.models.user import User

logger = logging.getLogger(__name__)
router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────────────────


class RetentionCell(BaseModel):
    cohort_month: str         # "2026-01"
    period_months: int        # 0, 1, 2, ...
    retention_rate: float     # 0.0 ~ 1.0
    sample_size: int


class RetentionHeatmapResponse(BaseModel):
    cohorts: list[str]               # ["2026-01", "2026-02", ...]
    periods: list[int]               # [0, 1, 2, 3, ...]
    cells: list[RetentionCell]


class LTVDataPoint(BaseModel):
    cohort_month: str
    period_months: int
    ltv: float
    sample_size: int


class LTVTrendResponse(BaseModel):
    cohorts: list[str]
    data: list[LTVDataPoint]


class DailyMetricPoint(BaseModel):
    date: str
    metric_name: str
    value: float
    count: int


class DailyMetricsResponse(BaseModel):
    metrics: list[DailyMetricPoint]


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.get("/admin/cohort/retention", response_model=RetentionHeatmapResponse)
async def get_retention_heatmap(
    months: int = Query(12, ge=1, le=36, description="과거 몇 개월의 코호트를 조회할지"),
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_read_db),
):
    """코호트별 리텐션 히트맵 데이터.

    가입월 기준으로 각 기간(period_months)별 리텐션율을 반환합니다.
    """
    result = await db.execute(
        select(CohortMetric)
        .where(CohortMetric.metric_name == "retention_rate")
        .order_by(CohortMetric.cohort_month.asc(), CohortMetric.period_months.asc())
    )
    metrics = list(result.scalars().all())

    if not metrics:
        return RetentionHeatmapResponse(cohorts=[], periods=[], cells=[])

    cohort_set: set[str] = set()
    period_set: set[int] = set()
    cells: list[RetentionCell] = []

    for m in metrics:
        cohort_str = m.cohort_month.strftime("%Y-%m")
        cohort_set.add(cohort_str)
        period_set.add(m.period_months)
        cells.append(RetentionCell(
            cohort_month=cohort_str,
            period_months=m.period_months,
            retention_rate=m.value,
            sample_size=m.sample_size,
        ))

    return RetentionHeatmapResponse(
        cohorts=sorted(cohort_set)[-months:],
        periods=sorted(period_set),
        cells=cells,
    )


@router.get("/admin/cohort/ltv", response_model=LTVTrendResponse)
async def get_ltv_trend(
    months: int = Query(12, ge=1, le=36, description="과거 몇 개월의 코호트를 조회할지"),
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_read_db),
):
    """코호트별 LTV(고객 생애 가치) 추세.

    가입월 기준으로 누적 LTV를 기간별로 반환합니다.
    """
    result = await db.execute(
        select(CohortMetric)
        .where(CohortMetric.metric_name == "ltv")
        .order_by(CohortMetric.cohort_month.asc(), CohortMetric.period_months.asc())
    )
    metrics = list(result.scalars().all())

    if not metrics:
        return LTVTrendResponse(cohorts=[], data=[])

    cohort_set: set[str] = set()
    data: list[LTVDataPoint] = []

    for m in metrics:
        cohort_str = m.cohort_month.strftime("%Y-%m")
        cohort_set.add(cohort_str)
        data.append(LTVDataPoint(
            cohort_month=cohort_str,
            period_months=m.period_months,
            ltv=m.value,
            sample_size=m.sample_size,
        ))

    return LTVTrendResponse(
        cohorts=sorted(cohort_set)[-months:],
        data=data,
    )


@router.get("/admin/cohort/daily-metrics", response_model=DailyMetricsResponse)
async def get_daily_metrics(
    metric_name: str = Query(..., description="메트릭명 (e.g. orders_count, revenue, signups)"),
    days: int = Query(30, ge=1, le=365, description="과거 며칠간의 데이터"),
    dimension: str | None = Query(None, description="차원 필터 (e.g. event_category)"),
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_read_db),
):
    """일별 집계 메트릭 조회."""
    stmt = select(DailyAggregate).where(
        DailyAggregate.metric_name == metric_name
    )

    if dimension:
        stmt = stmt.where(DailyAggregate.dimension == dimension)

    stmt = stmt.order_by(DailyAggregate.agg_date.desc()).limit(days)

    result = await db.execute(stmt)
    aggregates = list(result.scalars().all())

    return DailyMetricsResponse(
        metrics=[
            DailyMetricPoint(
                date=a.agg_date.isoformat(),
                metric_name=a.metric_name,
                value=a.value,
                count=a.count,
            )
            for a in aggregates
        ]
    )
