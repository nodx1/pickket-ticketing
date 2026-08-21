"""GeoIP 이상 로그인 탐지 서비스.

인터파크 2023 크리덴셜 스터핑 대비:
- MaxMind GeoLite2 DB로 국가 조회
- 마지막 로그인 국가와 비교
- 국가 변경 시 알림
"""
import logging
from uuid import UUID

from app.core.config import settings

logger = logging.getLogger(__name__)

_GEO_KEY = "v2:login:geo:{user_id}"

# Singleton GeoIP reader — avoid opening DB on every request
_geoip_reader = None


def _get_reader():
    global _geoip_reader
    if _geoip_reader is None:
        try:
            import geoip2.database
            _geoip_reader = geoip2.database.Reader(settings.GEOIP_DB_PATH)
        except Exception:
            logger.warning("Failed to open GeoIP database", exc_info=True)
    return _geoip_reader


def _lookup_country(ip: str) -> str | None:
    """IP → 국가 코드 (ISO 3166-1 alpha-2).

    MaxMind GeoLite2 DB 사용. 미설정 시 None.
    Private IP는 건너뜀.
    """
    if not settings.GEOIP_ENABLED or not settings.GEOIP_DB_PATH:
        return None

    # Private/loopback IP 필터링
    import ipaddress
    try:
        addr = ipaddress.ip_address(ip)
        if addr.is_private or addr.is_loopback or addr.is_reserved:
            return None
    except ValueError:
        return None

    try:
        reader = _get_reader()
        if not reader:
            return None
        response = reader.country(ip)
        return response.country.iso_code
    except Exception:
        logger.debug("GeoIP lookup failed for %s", ip, exc_info=True)
        return None


async def check_geo_anomaly(
    user_id: UUID, ip: str, email: str = ""
) -> dict | None:
    """국가 변경 탐지. 변경 시 알림 + 결과 반환.

    비차단 — 실패 시 None.
    """
    if not settings.GEOIP_ENABLED:
        return None

    try:
        country = _lookup_country(ip)
        if not country:
            return None

        from app.core.redis import get_redis
        redis = get_redis()
        geo_key = f"v2:login:geo:{user_id}"

        prev_country = await redis.get(geo_key)
        if isinstance(prev_country, bytes):
            prev_country = prev_country.decode()

        await redis.setex(geo_key, 86400 * 90, country)  # 90일 보관

        if prev_country and prev_country != country:
            logger.warning(
                "GeoIP anomaly: user=%s changed %s → %s (ip=%s)",
                user_id, prev_country, country, ip,
            )
            try:
                from app.core.alerting import send_ops_alert
                await send_ops_alert(
                    f"🌍 GeoIP 이상 로그인 탐지\n"
                    f"사용자: {email or str(user_id)}\n"
                    f"국가 변경: {prev_country} → {country}\n"
                    f"IP: {ip}",
                    level="warning",
                    alert_key=f"geo:{user_id}",
                )
            except Exception:
                pass
            return {"prev": prev_country, "current": country, "ip": ip}

        return None
    except Exception:
        logger.debug("GeoIP check failed for %s", user_id, exc_info=True)
        return None
