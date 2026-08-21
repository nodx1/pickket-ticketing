"""경량 UEBA (User Entity Behavior Analytics) 서비스.

쿠팡 2025 내부자 유출 대비:
- 유저별 로그인 빈도, IP 다양성 추적
- 기준선 대비 이상 행동 탐지 → 알림
- 비차단 (알림만)
"""
import json
import logging
import time
from uuid import UUID

logger = logging.getLogger(__name__)

# Redis key patterns
_LOGIN_COUNT_KEY = "ueba:logins:{user_id}:{date}"  # daily login count
_IP_SET_KEY = "ueba:ips:{user_id}:{date}"  # daily unique IPs
_BASELINE_KEY = "ueba:baseline:{user_id}"

# Anomaly thresholds
LOGIN_ABSOLUTE_THRESHOLD = 20  # 하루 20회 이상 로그인 → 이상
IP_ANOMALY_THRESHOLD = 5  # 5+ unique IPs in a day (most users use 1-2)


async def record_login_event(user_id: UUID, ip: str, email: str = "") -> None:
    """로그인 이벤트 기록 및 이상 탐지.

    비차단 — 실패 시 무시.
    """
    try:
        from app.core.redis import get_redis
        redis = get_redis()

        from datetime import datetime, timezone
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        login_key = f"ueba:logins:{user_id}:{today}"
        ip_key = f"ueba:ips:{user_id}:{today}"

        pipe = redis.pipeline()
        pipe.incr(login_key)
        pipe.expire(login_key, 86400 * 7)  # 7일 보관
        pipe.sadd(ip_key, ip)
        pipe.expire(ip_key, 86400 * 7)
        pipe.scard(ip_key)
        results = await pipe.execute()

        login_count = int(results[0])
        unique_ips = int(results[4])

        # Check anomalies
        anomalies = []

        if login_count > LOGIN_ABSOLUTE_THRESHOLD:
            anomalies.append(f"일일 로그인 {login_count}회 (비정상)")

        if unique_ips >= IP_ANOMALY_THRESHOLD:
            anomalies.append(f"일일 고유 IP {unique_ips}개 (비정상)")

        if anomalies:
            logger.warning("UEBA anomaly: user=%s %s", user_id, ", ".join(anomalies))
            try:
                from app.core.alerting import send_ops_alert
                await send_ops_alert(
                    f"🔍 UEBA 이상 행동 탐지\n"
                    f"사용자: {email or str(user_id)}\n"
                    f"• " + "\n• ".join(anomalies) + f"\n"
                    f"IP: {ip}",
                    level="warning",
                    alert_key=f"ueba:{user_id}:{today}",
                )
            except Exception:
                pass
    except Exception:
        logger.debug("UEBA recording failed for %s", user_id, exc_info=True)
