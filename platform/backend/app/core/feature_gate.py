import logging

from fastapi import HTTPException, status

from app.core.config import settings

logger = logging.getLogger(__name__)


SALE_MODE_UNAVAILABLE_DETAIL = "지원하지 않는 판매 모드입니다."

# 항상 허용되는 기본 판매 모드
_BASE_MODES = {"fixed_fcfs", "point_lottery", "queue"}

# feature flag로 제어되는 판매 모드 (flag key → sale_mode value)
_GATED_MODES: dict[str, str] = {
    "fanclub_presale_enabled": "fanclub_presale",
}


async def ensure_sale_mode_enabled(sale_mode: str) -> None:
    """Validate that a sale mode is supported for current launch phase.

    fixed_fcfs, point_lottery, queue는 항상 허용.
    fanclub_presale는 feature flag (어드민/Redis)로 제어.
    """
    if sale_mode in _BASE_MODES:
        return

    # feature flag로 게이트된 모드 확인
    from app.core.feature_flags import get_feature_flag

    for flag_key, mode_value in _GATED_MODES.items():
        if sale_mode == mode_value:
            enabled = await get_feature_flag(flag_key, False)
            if enabled:
                return
            break

    valid_modes = set(_BASE_MODES)
    for flag_key, mode_value in _GATED_MODES.items():
        enabled = await get_feature_flag(flag_key, False)
        if enabled:
            valid_modes.add(mode_value)

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail=f"{SALE_MODE_UNAVAILABLE_DETAIL} "
        f"지원 모드: {', '.join(sorted(valid_modes))}",
    )


# ── Kill Switches ──

RESALE_UNAVAILABLE_DETAIL = "리세일 마켓이 현재 비활성화되어 있습니다."
QUEUE_UNAVAILABLE_DETAIL = "대기열 서비스가 현재 비활성화되어 있습니다."
NEW_PAYMENT_UNAVAILABLE_DETAIL = "결제 서비스가 현재 점검 중입니다."


def ensure_resale_enabled() -> None:
    if not settings.RESALE_ENABLED:
        from app.middleware.metrics import KILL_SWITCH_BLOCKED_TOTAL

        try:
            KILL_SWITCH_BLOCKED_TOTAL.labels(feature="resale").inc()
        except Exception:
            logger.debug("kill switch metric failed for resale", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=RESALE_UNAVAILABLE_DETAIL,
        )


def ensure_queue_enabled() -> None:
    if not settings.QUEUE_ENABLED:
        from app.middleware.metrics import KILL_SWITCH_BLOCKED_TOTAL

        try:
            KILL_SWITCH_BLOCKED_TOTAL.labels(feature="queue").inc()
        except Exception:
            logger.debug("kill switch metric failed for queue", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=QUEUE_UNAVAILABLE_DETAIL,
        )


def ensure_new_payment_flow_enabled() -> None:
    if not settings.NEW_PAYMENT_FLOW_ENABLED:
        from app.middleware.metrics import KILL_SWITCH_BLOCKED_TOTAL

        try:
            KILL_SWITCH_BLOCKED_TOTAL.labels(feature="new_payment_flow").inc()
        except Exception:
            logger.debug("kill switch metric failed for new_payment_flow", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=NEW_PAYMENT_UNAVAILABLE_DETAIL,
        )
