import logging
from datetime import datetime

from fastapi import APIRouter, Request

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/metrics/web-vitals")
async def collect_web_vitals(request: Request):
    """Collect Web Vitals metrics from frontend for RUM monitoring."""
    try:
        body = await request.json()
        name = body.get("name", "unknown")
        value = body.get("value", 0)
        rating = body.get("rating", "unknown")
        url = body.get("url", "/")

        logger.info(
            "WebVital: %s=%.1f rating=%s url=%s",
            name, float(value), rating, url,
        )

        # Store in Redis for aggregation (TTL 24h)
        try:
            from app.core.redis import get_redis
            redis = get_redis()
            date_key = datetime.utcnow().strftime("%Y%m%d")
            await redis.hincrby(f"v2:wv:{name}:{date_key}", rating, 1)
        except Exception:
            logger.debug("metrics recording failed", exc_info=True)

    except Exception:
        logger.debug("Failed to parse web-vitals payload")

    return {"ok": True}
