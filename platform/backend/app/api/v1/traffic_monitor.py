"""Admin API for traffic monitoring — P2-13: AI Traffic Monitoring.

Provides real-time traffic class distribution and anomaly alerts.
Admin-only access.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.middleware.auth import get_current_admin
from app.middleware.traffic_metrics import get_anomaly_alerts, get_traffic_breakdown
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────────────────


class TrafficClassCounts(BaseModel):
    human: int = 0
    agent: int = 0
    broker: int = 0
    bot: int = 0


class TrafficClassRatios(BaseModel):
    human: float = 0.0
    agent: float = 0.0
    broker: float = 0.0
    bot: float = 0.0


class TrafficWindowData(BaseModel):
    total: int
    counts: TrafficClassCounts
    ratios: TrafficClassRatios


class TrafficBreakdownResponse(BaseModel):
    """Traffic class distribution for multiple time windows."""

    windows: dict[str, TrafficWindowData]
    generated_at: str


class AnomalyAlert(BaseModel):
    timestamp: float
    bot_ratio: float
    bot_count: int
    total_requests: int
    window_seconds: int
    message: str


class AnomalyAlertsResponse(BaseModel):
    alerts: list[AnomalyAlert]
    total: int
    generated_at: str


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.get(
    "/admin/traffic/breakdown",
    response_model=TrafficBreakdownResponse,
    summary="실시간 트래픽 클래스 분포",
)
async def get_traffic_class_breakdown(
    admin: User = Depends(get_current_admin),
) -> TrafficBreakdownResponse:
    """실시간 트래픽 클래스 분포를 반환합니다.

    5분 / 1시간 / 24시간 윈도우별 HUMAN/AGENT/BROKER/BOT 분류 결과를 제공합니다.
    """
    raw = get_traffic_breakdown()

    windows = {}
    for window_name, data in raw.items():
        windows[window_name] = TrafficWindowData(
            total=data["total"],
            counts=TrafficClassCounts(**data["counts"]),
            ratios=TrafficClassRatios(**data["ratios"]),
        )

    return TrafficBreakdownResponse(
        windows=windows,
        generated_at=datetime.now(timezone.utc).isoformat(),
    )


@router.get(
    "/admin/traffic/anomalies",
    response_model=AnomalyAlertsResponse,
    summary="최근 트래픽 이상 감지 알림",
)
async def get_traffic_anomalies(
    admin: User = Depends(get_current_admin),
) -> AnomalyAlertsResponse:
    """최근 트래픽 이상 감지 알림 목록을 반환합니다.

    봇 트래픽 비율이 5분 윈도우에서 20%를 초과하면 경고가 생성됩니다.
    최근 100건까지 보관됩니다.
    """
    alerts = get_anomaly_alerts()

    return AnomalyAlertsResponse(
        alerts=[AnomalyAlert(**a) for a in alerts],
        total=len(alerts),
        generated_at=datetime.now(timezone.utc).isoformat(),
    )
