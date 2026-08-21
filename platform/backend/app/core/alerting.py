"""운영 알림 — Telegram Bot API 통합.

심각도별 라우팅, Redis 쿨다운, 배포 중 억제, Actionable 알림(런북 링크).
비즈니스 로직 차단 없이 best-effort 발송.
"""

import logging

logger = logging.getLogger(__name__)

# 심각도별 쿨다운 (초)
_COOLDOWN_MAP = {
    "critical": 600,   # 10분
    "warning": 1800,   # 30분
    "info": 3600,      # 60분
}

_TELEGRAM_API = "https://api.telegram.org/bot{token}/sendMessage"


def _resolve_chat_id(level: str) -> str:
    """심각도에 맞는 Telegram 채팅방 ID 반환. 개별 ID 없으면 fallback."""
    from app.core.config import settings

    level_chats = {
        "critical": settings.TELEGRAM_CHAT_CRITICAL,
        "warning": settings.TELEGRAM_CHAT_WARNING,
        "info": settings.TELEGRAM_CHAT_INFO,
    }
    return level_chats.get(level, "") or settings.TELEGRAM_CHAT_ID


def _get_bot_token() -> str:
    from app.core.config import settings
    return settings.TELEGRAM_BOT_TOKEN


async def _should_alert(alert_key: str, cooldown_seconds: int) -> bool:
    """Redis 기반 쿨다운 — 같은 알림이 cooldown 내 이미 발송됐으면 False."""
    try:
        from app.core.redis import get_redis

        redis = get_redis()
        if redis is None:
            return True
        key = f"v2:alert:cooldown:{alert_key}"
        created = await redis.set(key, "1", nx=True, ex=cooldown_seconds)
        return bool(created)
    except Exception:
        logger.debug("쿨다운 체크 실패, 알림 발송 허용", exc_info=True)
        return True


async def _is_deploying() -> bool:
    """배포 중인지 확인 (Redis deploy:in_progress 키)."""
    try:
        from app.core.redis import get_redis

        redis = get_redis()
        if redis is None:
            return False
        return bool(await redis.exists("v2:deploy:in_progress"))
    except Exception:
        return False


def _build_message(
    level: str,
    title: str,
    details: dict,
    *,
    runbook_url: str = "",
) -> str:
    """Telegram HTML 메시지 생성."""
    emoji_map = {"info": "ℹ️", "warning": "⚠️", "critical": "🚨"}
    emoji = emoji_map.get(level, "🔔")

    lines = [f"{emoji} <b>[{level.upper()}] {title}</b>", ""]

    for k, v in details.items():
        lines.append(f"• <b>{k}</b>: <code>{str(v)[:200]}</code>")

    if runbook_url:
        lines.append("")
        lines.append(f'📋 <a href="{runbook_url}">대응 절차 보기</a>')

    return "\n".join(lines)


async def send_ops_alert(
    level: str,
    title: str,
    details: dict,
    *,
    mention: bool = False,
    runbook_url: str = "",
    alert_key: str = "",
) -> None:
    """운영 알림 발송 (async).

    Args:
        level: "info" | "warning" | "critical"
        title: 알림 제목
        details: 상세 정보 dict
        mention: True (미사용, 호환성 유지)
        runbook_url: 대응 절차 링크
        alert_key: 쿨다운용 고유 키 (미지정 시 title 기반)
    """
    token = _get_bot_token()
    chat_id = _resolve_chat_id(level)
    if not token or not chat_id:
        return

    # 배포 중 warning/info 억제 (critical은 항상 발송)
    if level != "critical" and await _is_deploying():
        logger.debug("배포 중 알림 억제: [%s] %s", level, title)
        return

    # 쿨다운 체크
    cooldown_key = alert_key or title
    cooldown_secs = _COOLDOWN_MAP.get(level, 1800)
    if not await _should_alert(cooldown_key, cooldown_secs):
        logger.debug("쿨다운 중 알림 스킵: [%s] %s", level, title)
        return

    text = _build_message(level, title, details, runbook_url=runbook_url)
    url = _TELEGRAM_API.format(token=token)
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }

    try:
        import httpx

        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(url, json=payload)
    except Exception:
        logger.warning("운영 알림 발송 실패: %s", title, exc_info=True)


def send_ops_alert_sync(
    level: str,
    title: str,
    details: dict,
    *,
    mention: bool = False,
    runbook_url: str = "",
    alert_key: str = "",
) -> None:
    """운영 알림 발송 (sync — Celery 태스크용)."""
    token = _get_bot_token()
    chat_id = _resolve_chat_id(level)
    if not token or not chat_id:
        return

    # sync에서는 배포 억제/쿨다운 체크를 단순화
    try:
        import redis as sync_redis

        from app.core.config import settings

        if settings.REDIS_URL:
            r = sync_redis.from_url(settings.REDIS_URL, decode_responses=True)

            if level != "critical" and r.exists("v2:deploy:in_progress"):
                logger.debug("배포 중 알림 억제 (sync): [%s] %s", level, title)
                return

            cooldown_key = alert_key or title
            cooldown_secs = _COOLDOWN_MAP.get(level, 1800)
            key = f"v2:alert:cooldown:{cooldown_key}"
            if not r.set(key, "1", nx=True, ex=cooldown_secs):
                logger.debug("쿨다운 중 알림 스킵 (sync): [%s] %s", level, title)
                return
    except Exception:
        logger.debug("alert cooldown check failed (sync)", exc_info=True)

    text = _build_message(level, title, details, runbook_url=runbook_url)
    url = _TELEGRAM_API.format(token=token)
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }

    try:
        import httpx

        with httpx.Client(timeout=5.0) as client:
            client.post(url, json=payload)
    except Exception:
        logger.warning("운영 알림 발송 실패 (sync): %s", title, exc_info=True)
