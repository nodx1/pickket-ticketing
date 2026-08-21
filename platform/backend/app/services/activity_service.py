"""P2-7: Multi-device continuity — 최근 활동 서비스.

Redis sorted set 기반 사용자 활동 기록 및 조회.
TTL: 24시간, score = timestamp.
"""

import json
import logging
import time
import uuid
from enum import Enum

from app.core.redis import get_redis, v2_key

logger = logging.getLogger(__name__)

# v2: prefix enforced via v2_key() per DOMAIN_MODEL_STANDARD §7.
# Migration 2026-04-21: previous prefixes ("activity", "device", "cart") will
# expire naturally within 24 hours (see _ACTIVITY_TTL). No dual-read needed.
_ACTIVITY_PREFIX = "activity"
_DEVICE_PREFIX = "device"
_CART_PREFIX = "cart"
_ACTIVITY_TTL = 86400  # 24 hours
_DEVICE_TTL = 120  # 2 minutes heartbeat timeout


class ActivityType(str, Enum):
    PAGE_VIEW = "page_view"
    CART_UPDATE = "cart_update"
    BID_PLACED = "bid_placed"
    SEARCH = "search"


class ActivityService:
    """사용자 활동 기록/조회 서비스 (Redis sorted set)."""

    def __init__(self):
        self._redis = get_redis()

    def _activity_key(self, user_id: uuid.UUID) -> str:
        return v2_key(f"{_ACTIVITY_PREFIX}:{user_id}")

    def _device_key(self, user_id: uuid.UUID) -> str:
        return v2_key(f"{_DEVICE_PREFIX}:{user_id}")

    def _cart_key(self, user_id: uuid.UUID) -> str:
        return v2_key(f"{_CART_PREFIX}:{user_id}")

    async def record_activity(
        self,
        user_id: uuid.UUID,
        activity_type: ActivityType,
        metadata: dict | None = None,
    ) -> None:
        """활동 기록을 Redis sorted set에 저장 (score = timestamp)."""
        try:
            key = self._activity_key(user_id)
            now = time.time()
            entry = json.dumps(
                {
                    "type": activity_type.value,
                    "metadata": metadata or {},
                    "ts": now,
                },
                default=str,
            )
            await self._redis.zadd(key, {entry: now})
            await self._redis.expire(key, _ACTIVITY_TTL)

            # 오래된 항목 정리 (최대 100개 유지)
            count = await self._redis.zcard(key)
            if count > 100:
                await self._redis.zremrangebyrank(key, 0, count - 101)
        except Exception:
            logger.warning(
                "Failed to record activity for user %s", user_id, exc_info=True
            )

    async def get_recent_activities(
        self, user_id: uuid.UUID, limit: int = 10
    ) -> list[dict]:
        """최근 활동 조회 (최신순)."""
        try:
            key = self._activity_key(user_id)
            # 최신순 정렬: zrevrange
            entries = await self._redis.zrevrange(key, 0, limit - 1)
            result = []
            for raw in entries:
                try:
                    result.append(json.loads(raw))
                except (json.JSONDecodeError, TypeError):
                    continue
            return result
        except Exception:
            logger.warning(
                "Failed to get activities for user %s", user_id, exc_info=True
            )
            return []

    async def update_cart(
        self, user_id: uuid.UUID, cart_data: dict
    ) -> None:
        """현재 장바구니 상태를 Redis에 저장."""
        try:
            key = self._cart_key(user_id)
            await self._redis.setex(
                key, _ACTIVITY_TTL, json.dumps(cart_data, default=str)
            )
            # 장바구니 업데이트도 활동으로 기록
            await self.record_activity(
                user_id,
                ActivityType.CART_UPDATE,
                {"event_id": cart_data.get("event_id"), "item_count": len(cart_data.get("items", []))},
            )
        except Exception:
            logger.warning(
                "Failed to update cart for user %s", user_id, exc_info=True
            )

    async def get_cart(self, user_id: uuid.UUID) -> dict | None:
        """현재 장바구니 상태 조회."""
        try:
            key = self._cart_key(user_id)
            raw = await self._redis.get(key)
            if raw:
                return json.loads(raw)
            return None
        except Exception:
            logger.warning(
                "Failed to get cart for user %s", user_id, exc_info=True
            )
            return None

    async def heartbeat(
        self,
        user_id: uuid.UUID,
        device_id: str,
        device_info: dict | None = None,
    ) -> None:
        """디바이스 heartbeat 업데이트 (presence 관리)."""
        try:
            key = self._device_key(user_id)
            now = time.time()
            entry = json.dumps(
                {
                    "device_id": device_id,
                    "info": device_info or {},
                    "last_seen": now,
                },
                default=str,
            )
            await self._redis.hset(key, device_id, entry)
            await self._redis.expire(key, _DEVICE_TTL)
        except Exception:
            logger.warning(
                "Failed to update heartbeat for user %s device %s",
                user_id,
                device_id,
                exc_info=True,
            )

    async def get_active_devices(self, user_id: uuid.UUID) -> list[dict]:
        """현재 활성 디바이스 목록 조회."""
        try:
            key = self._device_key(user_id)
            all_devices = await self._redis.hgetall(key)
            now = time.time()
            result = []
            for _device_id, raw in all_devices.items():
                try:
                    data = json.loads(raw)
                    # heartbeat timeout 체크
                    if now - data.get("last_seen", 0) < _DEVICE_TTL:
                        result.append(data)
                except (json.JSONDecodeError, TypeError):
                    continue
            return result
        except Exception:
            logger.warning(
                "Failed to get devices for user %s", user_id, exc_info=True
            )
            return []
