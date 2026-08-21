"""DLQ 모니터링: 큐 메시지 확인 + Telegram 알림 발송 Celery task.

P1-15: DLQ depth 감시, threshold 초과 시 Telegram Bot API 알림.
- DLQ 이름, 메시지 수, 가장 오래된 메시지 나이, 샘플 태스크 이름 포함
- 5분마다 Celery beat으로 실행
"""

import json
import logging
import time
from datetime import datetime, timezone

import redis
from celery import shared_task

from app.core.config import settings
from app.middleware.metrics import CELERY_TASK_DURATION, CELERY_TASKS_TOTAL

logger = logging.getLogger(__name__)

# #32: read the **durable** record list written by the dlq.dead_letter task,
# not the transient broker queue (which the worker consumes → always ~0 depth).
DLQ_KEY = "dlq:records"


def _redis_client() -> redis.Redis:
    """DLQ 조회용 Redis 클라이언트 생성."""
    return redis.from_url(settings.CELERY_BROKER_URL, decode_responses=False)


def _get_dlq_depth() -> int:
    """Redis를 통해 DLQ 큐의 메시지 수를 조회."""
    try:
        r = _redis_client()
        count = r.llen(DLQ_KEY)
        return count or 0
    except Exception as exc:
        logger.error("DLQ 메시지 카운트 조회 실패: %s", exc)
        return -1


def _peek_dlq_messages(limit: int = 10) -> list[bytes]:
    """DLQ 큐의 최근 메시지를 peek (제거하지 않음)."""
    try:
        r = _redis_client()
        raw_messages = r.lrange(DLQ_KEY, 0, limit - 1)
        return raw_messages or []
    except Exception as exc:
        logger.error("DLQ 메시지 peek 실패: %s", exc)
        return []


def _extract_task_info(raw_messages: list[bytes]) -> list[dict]:
    """DLQ 메시지에서 태스크 정보 추출.

    Returns list of dicts with keys: task_name, task_id, timestamp, error
    """
    results = []
    for raw in raw_messages:
        try:
            text = raw.decode("utf-8", errors="replace") if isinstance(raw, bytes) else str(raw)
            body = json.loads(text)

            # #32: durable record written by dlq.dead_letter — flat dict with
            # original_task / original_task_id / exception / recorded_at.
            if isinstance(body, dict) and "original_task" in body and "headers" not in body:
                results.append({
                    "task_name": body.get("original_task", "unknown"),
                    "task_id": body.get("original_task_id", "unknown"),
                    "error": (body.get("exception") or "")[:200],
                    "timestamp": body.get("recorded_at"),
                })
                continue

            # Celery DLQ 메시지 구조: kwargs에 original_task 등이 들어있음
            # celery_app.py의 on_task_failure에서 send_task로 보낸 구조
            headers = body.get("headers", {})
            kwargs = {}

            # Celery 메시지 프로토콜: body 안에 직접 또는 headers.kwargsrepr
            if "kwargsrepr" in headers:
                try:
                    kwargs = json.loads(headers["kwargsrepr"].replace("'", '"'))
                except Exception:
                    logger.debug("dlq kwargsrepr parsing failed", exc_info=True)

            # body[1]이 kwargs인 경우 (Celery protocol v2)
            if isinstance(body.get("body"), str):
                try:
                    decoded_body = json.loads(body["body"])
                    if isinstance(decoded_body, list) and len(decoded_body) >= 2:
                        kwargs = decoded_body[1] if isinstance(decoded_body[1], dict) else {}
                except Exception:
                    logger.debug("dlq body decoding failed", exc_info=True)

            # 직접 kwargs가 있는 경우
            if not kwargs and isinstance(body, dict):
                kwargs = body.get("kwargs", body)

            task_name = kwargs.get("original_task", headers.get("task", "unknown"))
            task_id = kwargs.get("original_task_id", headers.get("id", "unknown"))
            error = kwargs.get("exception", "")[:200]

            # 타임스탬프 추출: headers.eta, properties.timestamp, 또는 없으면 None
            timestamp = None
            props = body.get("properties", {})
            if props.get("timestamp"):
                timestamp = props["timestamp"]
            elif headers.get("eta"):
                timestamp = headers["eta"]

            results.append({
                "task_name": task_name,
                "task_id": task_id,
                "error": error,
                "timestamp": timestamp,
            })
        except Exception:
            results.append({
                "task_name": "parse_error",
                "task_id": "unknown",
                "error": "메시지 파싱 실패",
                "timestamp": None,
            })
    return results


def _compute_oldest_age(task_infos: list[dict]) -> str | None:
    """가장 오래된 메시지의 나이를 사람이 읽기 쉬운 문자열로 반환."""
    timestamps = []
    for info in task_infos:
        ts = info.get("timestamp")
        if ts is None:
            continue
        try:
            if isinstance(ts, (int, float)):
                timestamps.append(ts)
            elif isinstance(ts, str):
                # ISO format 파싱 시도
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                timestamps.append(dt.timestamp())
        except Exception:
            logger.debug("dlq timestamp parsing failed", exc_info=True)
            continue

    if not timestamps:
        return None

    oldest = min(timestamps)
    age_seconds = time.time() - oldest

    if age_seconds < 60:
        return f"{int(age_seconds)}초"
    elif age_seconds < 3600:
        return f"{int(age_seconds / 60)}분"
    elif age_seconds < 86400:
        return f"{int(age_seconds / 3600)}시간 {int((age_seconds % 3600) / 60)}분"
    else:
        return f"{int(age_seconds / 86400)}일 {int((age_seconds % 86400) / 3600)}시간"


def _send_telegram_alert(
    message_count: int,
    task_infos: list[dict],
    oldest_age: str | None,
) -> bool:
    """Telegram Bot API로 DLQ 알림 발송."""
    bot_token = settings.TELEGRAM_BOT_TOKEN
    chat_id = settings.TELEGRAM_CHAT_WARNING or settings.TELEGRAM_CHAT_ID
    if not bot_token or not chat_id:
        logger.warning("Telegram 설정 없음 — 알림 발송 건너뜀")
        return False

    try:
        import httpx

        task_names = list(dict.fromkeys(info["task_name"] for info in task_infos))[:5]
        task_names_str = ", ".join(f"<code>{name}</code>" for name in task_names)

        error_samples = [info["error"] for info in task_infos[:3] if info.get("error")]

        lines = [
            f"⚠️ <b>[WARNING] DLQ Alert: {message_count}건 미처리</b>",
            "",
            f"• <b>DLQ</b>: <code>{DLQ_KEY}</code>",
            f"• <b>메시지 수</b>: <b>{message_count}</b>건",
            f"• <b>환경</b>: <code>{settings.ENVIRONMENT}</code>",
            f"• <b>가장 오래된 메시지</b>: {oldest_age or '알 수 없음'}",
            f"• <b>샘플 태스크</b>: {task_names_str or '파싱 불가'}",
        ]

        if error_samples:
            lines.append("")
            lines.append("<b>에러 샘플:</b>")
            for err in error_samples:
                lines.append(f"  • <code>{err[:150]}</code>")

        lines.append("")
        lines.append(
            f"Threshold: {settings.DLQ_ALERT_THRESHOLD} | "
            f"{datetime.now(timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')}"
        )

        url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
        payload = {
            "chat_id": chat_id,
            "text": "\n".join(lines),
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }

        with httpx.Client(timeout=10.0) as client:
            resp = client.post(url, json=payload)
            resp.raise_for_status()

        logger.info("DLQ Telegram 알림 발송 성공 (메시지 %d건)", message_count)
        return True

    except Exception as exc:
        logger.error("DLQ Telegram 알림 발송 실패: %s", exc)
        return False


@shared_task(
    name="app.tasks.dlq_monitor.monitor_dlq",
    bind=True,
    max_retries=1,
    acks_late=True,
    queue="analytics",
)
def monitor_dlq(self):
    """DLQ 큐 모니터링 — threshold 초과 시 Telegram 알림 발송.

    5분마다 실행 (Celery beat). DLQ_ALERT_THRESHOLD 이상의 메시지가 있으면:
    1. 메시지 내용을 파싱하여 태스크 정보 추출
    2. 가장 오래된 메시지 나이 계산
    3. Telegram Bot API로 상세 알림 발송
    """
    _task_name = "monitor_dlq"
    _start = time.perf_counter()

    try:
        message_count = _get_dlq_depth()

        if message_count < 0:
            logger.warning("DLQ 모니터링: 큐 상태 확인 불가")
            return {"status": "error", "message": "큐 상태 확인 불가"}

        threshold = settings.DLQ_ALERT_THRESHOLD

        if message_count < threshold:
            logger.debug("DLQ 모니터링: 큐 메시지 %d건 (threshold %d 미만)", message_count, threshold)
            _duration = time.perf_counter() - _start
            try:
                CELERY_TASK_DURATION.labels(task_name=_task_name, status="success").observe(
                    _duration
                )
                CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="success").inc()
            except Exception:
                logger.debug("dlq metrics recording failed", exc_info=True)
            return {"status": "ok", "message_count": message_count, "threshold": threshold}

        # threshold 초과 — 메시지 분석
        raw_messages = _peek_dlq_messages(limit=10)
        task_infos = _extract_task_info(raw_messages)
        oldest_age = _compute_oldest_age(task_infos)

        # 로그 기록 (디버깅용)
        for i, info in enumerate(task_infos):
            logger.warning(
                "DLQ 메시지 [%d/%d]: task=%s id=%s error=%s",
                i + 1,
                message_count,
                info["task_name"],
                info["task_id"],
                info["error"][:300],
            )

        # Telegram 알림 발송
        webhook_sent = _send_telegram_alert(message_count, task_infos, oldest_age)

        _duration = time.perf_counter() - _start
        try:
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="success").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="success").inc()
        except Exception:
            logger.debug("dlq metrics recording failed", exc_info=True)

        logger.info(
            "DLQ 모니터링 완료: messages=%d threshold=%d oldest=%s webhook_sent=%s (%.2fs)",
            message_count,
            threshold,
            oldest_age or "unknown",
            webhook_sent,
            _duration,
        )

        return {
            "status": "alert",
            "message_count": message_count,
            "threshold": threshold,
            "oldest_age": oldest_age,
            "webhook_sent": webhook_sent,
            "sample_tasks": [info["task_name"] for info in task_infos],
            "sample_count": len(task_infos),
        }

    except Exception as exc:
        _duration = time.perf_counter() - _start
        try:
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="failure").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="failure").inc()
        except Exception:
            logger.debug("dlq metrics recording failed", exc_info=True)

        logger.error("DLQ 모니터링 실패: %s", exc)
        raise self.retry(exc=exc, countdown=60)
