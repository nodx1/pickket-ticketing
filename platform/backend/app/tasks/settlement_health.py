"""정산 건전성 모니터링 태스크.

위메프/티몬 2024 정산 지연 사태 대비:
- 미정산 주문 누적 감지
- 정산 금액 이상 편차 감지
- 6시간마다 실행 (Celery beat)
"""
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings

logger = logging.getLogger(__name__)


async def check_settlement_health(db: AsyncSession) -> dict:
    """정산 건전성 점검.

    Returns dict with health status and any alerts sent.
    """
    from app.models.order import Order, OrderStatus

    now = datetime.now(timezone.utc)
    overdue_threshold = now - timedelta(days=settings.SETTLEMENT_OVERDUE_DAYS)
    alerts = []

    try:
        # 1. 미정산 주문 수 (CONFIRMED 상태로 N일 초과)
        result = await db.execute(
            select(func.count(Order.id)).where(
                Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
                Order.created_at < overdue_threshold,
                Order.deleted_at.is_(None),
            )
        )
        overdue_count = result.scalar_one_or_none() or 0

        if overdue_count > 0:
            alerts.append(f"미정산 주문 {overdue_count}건 ({settings.SETTLEMENT_OVERDUE_DAYS}일 초과)")

        # 2. 총 미정산 금액
        result = await db.execute(
            select(func.coalesce(func.sum(Order.total_amount), 0)).where(
                Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
                Order.deleted_at.is_(None),
            )
        )
        unsettled_amount = result.scalar_one_or_none() or 0

        if unsettled_amount > settings.SETTLEMENT_ALERT_THRESHOLD_KRW:
            alerts.append(
                f"총 미정산 금액 ₩{unsettled_amount:,.0f} "
                f"(임계값 ₩{settings.SETTLEMENT_ALERT_THRESHOLD_KRW:,.0f} 초과)"
            )

        # Send alerts if any
        if alerts:
            try:
                from app.core.alerting import send_ops_alert
                await send_ops_alert(
                    "💰 정산 건전성 경고\n\n• " + "\n• ".join(alerts),
                    level="critical" if overdue_count > 10 else "warning",
                    alert_key="settlement_health",
                )
            except Exception:
                logger.error("Failed to send settlement health alert", exc_info=True)

        return {
            "healthy": len(alerts) == 0,
            "overdue_count": overdue_count,
            "unsettled_amount": unsettled_amount,
            "alerts": alerts,
        }
    except Exception:
        logger.error("Settlement health check failed", exc_info=True)
        return {"healthy": None, "error": "check_failed"}
