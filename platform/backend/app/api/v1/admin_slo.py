"""SLO/SLI 대시보드 API — admin 전용.

Redis에 기록된 시간별 SLO 버킷을 집계하여 30일 가용성, 에러 버짓, 평균 지연 반환.
"""

import logging
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends

from app.middleware.auth import get_current_admin
from app.models.user import User

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/admin/slo", tags=["admin-slo"])

# SLO 목표
_SLO_TARGET = 0.999  # 99.9%
_SLO_WINDOW_DAYS = 30


@router.get("")
async def get_slo_summary(
    days: int = 30,
    _user: User = Depends(get_current_admin),
):
    """30일 SLO 요약: 가용성, 에러 버짓, 평균 지연, 시간별 추이."""
    from app.core.redis import get_redis

    redis = get_redis()
    if redis is None:
        return {"error": "Redis not available"}

    days = min(days, 35)  # TTL 35일 이내
    now = datetime.now(timezone.utc)

    total_requests = 0
    total_errors = 0
    total_latency = 0.0
    total_slow = 0
    hourly_data = []

    for day_offset in range(days):
        date = now - timedelta(days=day_offset)
        date_str = date.strftime("%Y-%m-%d")

        for hour in range(24):
            key = f"v2:slo:{date_str}:{hour:02d}"
            data = await redis.hgetall(key)
            if not data:
                continue

            h_total = int(data.get("total", 0))
            h_errors = int(data.get("errors", 0))
            h_latency = float(data.get("latency_sum", 0))
            h_slow = int(data.get("slow_2s", 0))

            total_requests += h_total
            total_errors += h_errors
            total_latency += h_latency
            total_slow += h_slow

            if h_total > 0:
                hourly_data.append({
                    "date": date_str,
                    "hour": hour,
                    "total": h_total,
                    "errors": h_errors,
                    "availability": round(1 - (h_errors / h_total), 6),
                    "avg_latency_ms": round((h_latency / h_total) * 1000, 1),
                })

    # 전체 집계
    availability = (1 - (total_errors / total_requests)) if total_requests > 0 else 1.0
    avg_latency_ms = (total_latency / total_requests * 1000) if total_requests > 0 else 0.0

    # 에러 버짓 계산
    allowed_errors = total_requests * (1 - _SLO_TARGET)
    error_budget_remaining = max(0, allowed_errors - total_errors)
    error_budget_pct = (error_budget_remaining / allowed_errors * 100) if allowed_errors > 0 else 100.0

    return {
        "period_days": days,
        "slo_target": _SLO_TARGET,
        "summary": {
            "total_requests": total_requests,
            "total_errors": total_errors,
            "availability": round(availability, 6),
            "availability_pct": f"{availability * 100:.3f}%",
            "avg_latency_ms": round(avg_latency_ms, 1),
            "slow_requests_2s": total_slow,
            "slo_met": availability >= _SLO_TARGET,
        },
        "error_budget": {
            "allowed_errors": round(allowed_errors),
            "consumed_errors": total_errors,
            "remaining": round(error_budget_remaining),
            "remaining_pct": round(error_budget_pct, 1),
        },
        "hourly": hourly_data[-168:],  # 최근 7일(168시간)만 반환
    }
