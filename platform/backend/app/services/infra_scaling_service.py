"""인프라 자동 스케일링 서비스 — ECS pre-warm + Cloudflare Waiting Room 제어.

이벤트 오픈 전 자동으로 인프라를 준비하고, 오픈 후 복원하는 서비스.
Celery task (event_open_orchestrator)에서 호출.

흐름:
  오픈 5분 전 → ECS 태스크 스케일업 + Waiting Room 활성화
  오픈 30분 후 → ECS 복원 + Waiting Room 비활성화
"""

import logging
from datetime import datetime, timezone

import boto3
import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# ── ECS Auto Scaling ────────────────────────────────────────────────────────


def scale_ecs_service(
    *,
    min_capacity: int,
    max_capacity: int,
    cluster: str | None = None,
    service: str | None = None,
) -> dict:
    """ECS 서비스 Application Auto Scaling min/max 조정.

    boto3 application-autoscaling을 사용하여 scalable target의
    min/max capacity를 변경. desired count는 자동으로 따라감.

    Returns:
        {"success": bool, "resource_id": str, "min": int, "max": int, "error": str?}
    """
    cluster = cluster or settings.ECS_CLUSTER_NAME
    service = service or settings.ECS_SERVICE_NAME

    if not cluster or not service:
        return {"success": False, "error": "ECS_CLUSTER_NAME or ECS_SERVICE_NAME not configured"}

    resource_id = f"service/{cluster}/{service}"

    try:
        client = boto3.client(
            "application-autoscaling",
            region_name=settings.AWS_REGION,
        )

        client.register_scalable_target(
            ServiceNamespace="ecs",
            ResourceId=resource_id,
            ScalableDimension="ecs:service:DesiredCount",
            MinCapacity=min_capacity,
            MaxCapacity=max_capacity,
        )

        logger.info(
            "ECS scaling updated: %s → min=%d, max=%d",
            resource_id, min_capacity, max_capacity,
        )
        return {
            "success": True,
            "resource_id": resource_id,
            "min": min_capacity,
            "max": max_capacity,
        }
    except Exception as exc:
        logger.error("ECS scaling failed for %s: %s", resource_id, exc)
        return {"success": False, "resource_id": resource_id, "error": str(exc)}


def get_ecs_service_status(
    cluster: str | None = None,
    service: str | None = None,
) -> dict:
    """현재 ECS 서비스 상태 조회 (running count, desired count)."""
    cluster = cluster or settings.ECS_CLUSTER_NAME
    service = service or settings.ECS_SERVICE_NAME

    if not cluster or not service:
        return {"success": False, "error": "ECS not configured"}

    try:
        client = boto3.client("ecs", region_name=settings.AWS_REGION)
        response = client.describe_services(
            cluster=cluster,
            services=[service],
        )
        svc = response["services"][0] if response.get("services") else None
        if not svc:
            return {"success": False, "error": f"Service {service} not found"}

        return {
            "success": True,
            "running_count": svc.get("runningCount", 0),
            "desired_count": svc.get("desiredCount", 0),
            "pending_count": svc.get("pendingCount", 0),
            "status": svc.get("status", "UNKNOWN"),
        }
    except Exception as exc:
        logger.error("ECS status check failed: %s", exc)
        return {"success": False, "error": str(exc)}


# ── Cloudflare Waiting Room ──────���──────────────────────────────────────────


def set_waiting_room_enabled(enabled: bool) -> dict:
    """Cloudflare Waiting Room 활성화/비활성화.

    Returns:
        {"success": bool, "enabled": bool, "error": str?}
    """
    api_token = settings.CF_API_TOKEN
    zone_id = settings.CF_ZONE_ID
    wr_id = settings.CF_WAITING_ROOM_ID

    if not api_token or not zone_id or not wr_id:
        return {"success": False, "error": "Cloudflare Waiting Room not configured"}

    url = f"https://api.cloudflare.com/client/v4/zones/{zone_id}/waiting_rooms/{wr_id}"

    try:
        response = httpx.patch(
            url,
            headers={
                "Authorization": f"Bearer {api_token}",
                "Content-Type": "application/json",
            },
            json={"enabled": enabled},
            timeout=10.0,
        )
        data = response.json()

        if data.get("success"):
            state = "enabled" if enabled else "disabled"
            logger.info("Cloudflare Waiting Room %s", state)
            return {"success": True, "enabled": enabled}
        else:
            errors = data.get("errors", [])
            error_msg = errors[0].get("message", "Unknown error") if errors else "Unknown error"
            logger.error("Cloudflare Waiting Room toggle failed: %s", error_msg)
            return {"success": False, "error": error_msg}
    except Exception as exc:
        logger.error("Cloudflare Waiting Room API call failed: %s", exc)
        return {"success": False, "error": str(exc)}


def get_waiting_room_status() -> dict:
    """Cloudflare Waiting Room 현재 상태 조회."""
    api_token = settings.CF_API_TOKEN
    zone_id = settings.CF_ZONE_ID
    wr_id = settings.CF_WAITING_ROOM_ID

    if not api_token or not zone_id or not wr_id:
        return {"success": False, "error": "Cloudflare Waiting Room not configured"}

    url = f"https://api.cloudflare.com/client/v4/zones/{zone_id}/waiting_rooms/{wr_id}"

    try:
        response = httpx.get(
            url,
            headers={"Authorization": f"Bearer {api_token}"},
            timeout=10.0,
        )
        data = response.json()
        if data.get("success"):
            result = data.get("result", {})
            return {
                "success": True,
                "enabled": result.get("enabled", False),
                "total_active_users": result.get("total_active_users"),
                "new_users_per_minute": result.get("new_users_per_minute"),
            }
        return {"success": False, "error": str(data.get("errors", []))}
    except Exception as exc:
        return {"success": False, "error": str(exc)}


# ── Orchestration ───────────────────────────────────────────────────────────


def prewarm_for_event(event_id: str, event_title: str = "") -> dict:
    """이벤트 오픈 전 인프라 프리웜 실행.

    1. ECS 서비스를 PRE_SCALE_COUNT까지 스케일업
    2. Cloudflare Waiting Room 활성화

    Returns:
        {"ecs": {...}, "waiting_room": {...}}
    """
    logger.info("Pre-warming infrastructure for event %s (%s)", event_id, event_title)

    ecs_result = scale_ecs_service(
        min_capacity=settings.ECS_PREWARM_TASK_COUNT,
        max_capacity=settings.ECS_PREWARM_TASK_COUNT,
    )

    wr_result = set_waiting_room_enabled(True)

    # 운영 알림
    _send_orchestrator_alert(
        "info",
        f"이벤트 프리웜 시작: {event_title or event_id}",
        {
            "event_id": event_id,
            "ecs": ecs_result,
            "waiting_room": wr_result,
        },
    )

    return {"ecs": ecs_result, "waiting_room": wr_result}


def cooldown_after_event(event_id: str, event_title: str = "") -> dict:
    """이벤트 오픈 후 인프라 복원.

    1. ECS 서비스를 평상시 min으로 복원 (Target Tracking이 알아서 조절)
    2. Cloudflare Waiting Room 비활성화

    Returns:
        {"ecs": {...}, "waiting_room": {...}}
    """
    logger.info("Cooling down infrastructure after event %s (%s)", event_id, event_title)

    # 현재 max capacity 조회
    try:
        aas_client = boto3.client(
            "application-autoscaling",
            region_name=settings.AWS_REGION,
        )
        targets = aas_client.describe_scalable_targets(
            ServiceNamespace="ecs",
            ResourceIds=[f"service/{settings.ECS_CLUSTER_NAME}/{settings.ECS_SERVICE_NAME}"],
        )
        original_max = 20  # fallback
        if targets.get("ScalableTargets"):
            # prewarm에서 min=max로 잠갔으므로 원래 max 복원
            original_max = max(20, targets["ScalableTargets"][0].get("MaxCapacity", 20))
    except Exception:
        original_max = 20

    ecs_result = scale_ecs_service(
        min_capacity=settings.ECS_NORMAL_MIN_TASKS,
        max_capacity=original_max,
    )

    wr_result = set_waiting_room_enabled(False)

    _send_orchestrator_alert(
        "info",
        f"이벤트 쿨다운 완료: {event_title or event_id}",
        {
            "event_id": event_id,
            "ecs": ecs_result,
            "waiting_room": wr_result,
        },
    )

    return {"ecs": ecs_result, "waiting_room": wr_result}


def _send_orchestrator_alert(level: str, title: str, details: dict) -> None:
    """운영 알림 발송 (best-effort, sync context)."""
    try:
        from app.core.alerting import send_ops_alert_sync
        send_ops_alert_sync(level, title, details)
    except Exception:
        logger.debug("Failed to send orchestrator alert: %s", title, exc_info=True)
