"""ETL 집계 태스크 — P2-12 Data Warehouse + Cohort Analysis.

매일 새벽 3시(KST) 실행되는 Celery 주기 태스크.
user_behaviors, orders, tickets 데이터를 집계하여 summary 테이블에 저장합니다.

- DailyAggregate: 일별 메트릭 집계 (주문수, 매출, 가입자 등)
- CohortMetric: 가입월 기준 리텐션, LTV 등 코호트 분석
"""

import logging
from datetime import date, datetime, timezone, timedelta

from sqlalchemy import select, func, text, and_, extract, distinct, case
from celery import shared_task

from app.core.database import SyncSession
from app.middleware.metrics import CELERY_TASK_DURATION, CELERY_TASKS_TOTAL

logger = logging.getLogger(__name__)


def _yesterday() -> date:
    return (datetime.now(timezone.utc) - timedelta(days=1)).date()


@shared_task(
    name="app.tasks.etl_aggregation.daily_etl_aggregation",
    bind=True,
    max_retries=3,
    acks_late=True,
    time_limit=600,        # 10분 타임아웃
    soft_time_limit=540,   # 9분 soft limit
)
def daily_etl_aggregation(self, target_date: str | None = None):
    """일별 ETL 집계 실행.

    Args:
        target_date: 집계 대상 날짜 (YYYY-MM-DD). None이면 어제 날짜.
    """
    import time
    start = time.monotonic()
    task_name = "daily_etl_aggregation"

    try:
        agg_date = date.fromisoformat(target_date) if target_date else _yesterday()
        logger.info("ETL 집계 시작: date=%s", agg_date)

        with SyncSession() as session:
            _aggregate_daily_metrics(session, agg_date)
            _aggregate_cohort_metrics(session, agg_date)
            session.commit()

        duration = time.monotonic() - start
        logger.info("ETL 집계 완료: date=%s duration=%.2fs", agg_date, duration)

        try:
            CELERY_TASKS_TOTAL.labels(task=task_name, status="success").inc()
            CELERY_TASK_DURATION.labels(task=task_name).observe(duration)
        except Exception:
            logger.debug("etl metrics recording failed", exc_info=True)

    except Exception as exc:
        logger.exception("ETL 집계 실패: %s", exc)
        try:
            CELERY_TASKS_TOTAL.labels(task=task_name, status="failure").inc()
        except Exception:
            logger.debug("etl failure metrics recording failed", exc_info=True)
        raise self.retry(exc=exc, countdown=60 * (self.request.retries + 1))


def _aggregate_daily_metrics(session, agg_date: date) -> None:
    """일별 메트릭 집계 — orders, users, tickets, behaviors."""
    from app.models.analytics_aggregate import DailyAggregate
    from app.models.order import Order, OrderStatus
    from app.models.user import User
    from app.models.user_behavior import UserBehavior

    next_date = agg_date + timedelta(days=1)

    # 기존 해당 날짜 집계 삭제 (재실행 대비 idempotent)
    session.execute(
        text("DELETE FROM daily_aggregates WHERE agg_date = :d"),
        {"d": agg_date},
    )

    metrics = []

    # 1) 주문 수 & 매출
    order_result = session.execute(
        select(
            func.count(Order.id).label("cnt"),
            func.coalesce(func.sum(Order.total_amount), 0).label("revenue"),
        ).where(
            and_(
                Order.created_at >= datetime.combine(agg_date, datetime.min.time()),
                Order.created_at < datetime.combine(next_date, datetime.min.time()),
                Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
            )
        )
    )
    row = order_result.one()
    metrics.append(DailyAggregate(
        agg_date=agg_date, metric_name="orders_count",
        dimension="total", dimension_value="all",
        value=float(row.cnt), count=int(row.cnt),
    ))
    metrics.append(DailyAggregate(
        agg_date=agg_date, metric_name="revenue",
        dimension="total", dimension_value="all",
        value=float(row.revenue), count=int(row.cnt),
    ))

    # 2) 신규 가입자 수
    signup_result = session.execute(
        select(func.count(User.id)).where(
            and_(
                User.created_at >= datetime.combine(agg_date, datetime.min.time()),
                User.created_at < datetime.combine(next_date, datetime.min.time()),
            )
        )
    )
    signup_count = signup_result.scalar() or 0
    metrics.append(DailyAggregate(
        agg_date=agg_date, metric_name="signups",
        dimension="total", dimension_value="all",
        value=float(signup_count), count=int(signup_count),
    ))

    # 3) DAU (behavior events의 unique user 수)
    dau_result = session.execute(
        select(func.count(distinct(UserBehavior.user_id))).where(
            and_(
                UserBehavior.created_at >= datetime.combine(agg_date, datetime.min.time()),
                UserBehavior.created_at < datetime.combine(next_date, datetime.min.time()),
                UserBehavior.user_id.is_not(None),
            )
        )
    )
    dau = dau_result.scalar() or 0
    metrics.append(DailyAggregate(
        agg_date=agg_date, metric_name="dau",
        dimension="total", dimension_value="all",
        value=float(dau), count=int(dau),
    ))

    # 4) Behavior event별 집계
    behavior_result = session.execute(
        select(
            UserBehavior.event_type,
            func.count(UserBehavior.id).label("cnt"),
        ).where(
            and_(
                UserBehavior.created_at >= datetime.combine(agg_date, datetime.min.time()),
                UserBehavior.created_at < datetime.combine(next_date, datetime.min.time()),
            )
        ).group_by(UserBehavior.event_type)
    )
    for brow in behavior_result.all():
        metrics.append(DailyAggregate(
            agg_date=agg_date, metric_name="behavior_events",
            dimension="event_type", dimension_value=str(brow.event_type),
            value=float(brow.cnt), count=int(brow.cnt),
        ))

    session.add_all(metrics)
    logger.info("일별 메트릭 %d건 집계 완료: date=%s", len(metrics), agg_date)


def _aggregate_cohort_metrics(session, agg_date: date) -> None:
    """코호트 분석 — 가입월 기준 리텐션 및 LTV."""
    from app.models.analytics_aggregate import CohortMetric
    from app.models.user import User
    from app.models.order import Order, OrderStatus

    # 현재 월 기준으로 코호트 계산
    current_month_start = agg_date.replace(day=1)

    # 기존 코호트 메트릭 삭제 (재계산)
    session.execute(
        text("DELETE FROM cohort_metrics WHERE updated_at >= :today"),
        {"today": datetime.combine(agg_date, datetime.min.time())},
    )

    cohort_metrics = []

    # 최근 18개월의 코호트를 계산
    for months_ago in range(18):
        cohort_date = _months_back(current_month_start, months_ago)
        cohort_next = _months_forward(cohort_date, 1)

        # 해당 코호트의 가입자 수
        cohort_users_result = session.execute(
            select(func.count(User.id)).where(
                and_(
                    User.created_at >= datetime.combine(cohort_date, datetime.min.time()),
                    User.created_at < datetime.combine(cohort_next, datetime.min.time()),
                )
            )
        )
        cohort_size = cohort_users_result.scalar() or 0

        if cohort_size == 0:
            continue

        # 각 기간(period)별 리텐션 및 LTV 계산
        max_periods = months_ago + 1  # 현재 시점까지만 계산 가능
        for period in range(max_periods):
            period_start = _months_forward(cohort_date, period)
            period_end = _months_forward(cohort_date, period + 1)

            # 리텐션: 해당 기간에 주문한 코호트 유저 수
            retention_result = session.execute(
                select(func.count(distinct(Order.user_id))).where(
                    and_(
                        Order.created_at >= datetime.combine(period_start, datetime.min.time()),
                        Order.created_at < datetime.combine(period_end, datetime.min.time()),
                        Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
                        Order.user_id.in_(
                            select(User.id).where(
                                and_(
                                    User.created_at >= datetime.combine(cohort_date, datetime.min.time()),
                                    User.created_at < datetime.combine(cohort_next, datetime.min.time()),
                                )
                            )
                        ),
                    )
                )
            )
            active_users = retention_result.scalar() or 0
            retention_rate = active_users / cohort_size if cohort_size > 0 else 0

            cohort_metrics.append(CohortMetric(
                cohort_month=cohort_date,
                period_months=period,
                metric_name="retention_rate",
                value=round(retention_rate, 4),
                sample_size=cohort_size,
            ))

            # LTV: 해당 기간까지의 누적 매출 / 코호트 사이즈
            ltv_result = session.execute(
                select(func.coalesce(func.sum(Order.total_amount), 0)).where(
                    and_(
                        Order.created_at >= datetime.combine(cohort_date, datetime.min.time()),
                        Order.created_at < datetime.combine(period_end, datetime.min.time()),
                        Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
                        Order.user_id.in_(
                            select(User.id).where(
                                and_(
                                    User.created_at >= datetime.combine(cohort_date, datetime.min.time()),
                                    User.created_at < datetime.combine(cohort_next, datetime.min.time()),
                                )
                            )
                        ),
                    )
                )
            )
            cumulative_revenue = float(ltv_result.scalar() or 0)
            ltv = cumulative_revenue / cohort_size if cohort_size > 0 else 0

            cohort_metrics.append(CohortMetric(
                cohort_month=cohort_date,
                period_months=period,
                metric_name="ltv",
                value=round(ltv, 2),
                sample_size=cohort_size,
            ))

    session.add_all(cohort_metrics)
    logger.info("코호트 메트릭 %d건 집계 완료: date=%s", len(cohort_metrics), agg_date)


def _months_back(d: date, months: int) -> date:
    """date에서 months개월 전의 1일을 반환."""
    month = d.month - months
    year = d.year
    while month <= 0:
        month += 12
        year -= 1
    return date(year, month, 1)


def _months_forward(d: date, months: int) -> date:
    """date에서 months개월 후의 1일을 반환."""
    month = d.month + months
    year = d.year
    while month > 12:
        month -= 12
        year += 1
    return date(year, month, 1)
