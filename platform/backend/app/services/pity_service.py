"""Pity System Service — 연속 낙첨 보너스 + 보장 당첨권.

WP08: 연속 낙첨 횟수에 따라 추첨 가중치 보너스를 부여하고,
도메인별 임계값에 도달하면 보장 당첨권을 자동 발급합니다.

- domain-level pity: 해당 도메인(concert, sports 등)의 연속 낙첨 추적
- artist-level pity: 특정 아티스트에 대한 연속 낙첨 추적
- get_pity_bonus()는 max(domain_pity, artist_pity)를 반환
"""

import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.pity import PityTracker


# 도메인별 보장 당첨권 발급 임계값 (연속 낙첨 횟수)
GUARANTEED_THRESHOLDS: dict[str, int] = {
    "concert": 5,
    "festival": 4,
    "musical": 7,
    "classical": 8,
    "sports": 10,
    "exhibition": 10,
    "education": 8,
    "civic": 8,
}

# 연속 낙첨 횟수별 가중치 보너스 테이블
PITY_BONUS_TABLE: dict[int, float] = {
    0: 1.0,
    1: 1.0,
    2: 1.0,
    3: 1.10,
    4: 1.20,
    5: 1.30,
    6: 1.40,
    7: 1.40,
    8: 1.60,
    9: 1.60,
}
# 10+ → guaranteed (보장 당첨권 발급)

# 보장 당첨권 유효기간 (일)
GUARANTEED_EXPIRY_DAYS = 90


class PityService:
    """연속 낙첨 추적 및 보장 당첨권 관리 서비스."""

    def __init__(self, session: AsyncSession):
        self.session = session

    async def _get_or_create_tracker(
        self,
        user_id: uuid.UUID,
        domain: str,
        artist_id: uuid.UUID | None = None,
    ) -> PityTracker:
        """기존 트래커 조회 또는 신규 생성."""
        result = await self.session.execute(
            select(PityTracker).where(
                PityTracker.user_id == user_id,
                PityTracker.domain == domain,
                PityTracker.artist_id == artist_id
                if artist_id is not None
                else PityTracker.artist_id.is_(None),
            )
        )
        tracker = result.scalar_one_or_none()
        if tracker is None:
            tracker = PityTracker(
                user_id=user_id,
                domain=domain,
                artist_id=artist_id,
                consecutive_losses=0,
                guaranteed_ticket=False,
            )
            self.session.add(tracker)
            await self.session.flush()
        return tracker

    def _lookup_bonus(self, consecutive_losses: int) -> float:
        """연속 낙첨 횟수에 따른 보너스 배율 조회."""
        if consecutive_losses >= 10:
            # 10+ 는 사실상 guaranteed인데, 보너스가 필요하면 최대값 반환
            return PITY_BONUS_TABLE.get(9, 1.6)
        return PITY_BONUS_TABLE.get(consecutive_losses, 1.0)

    async def get_pity_bonus(
        self,
        user_id: uuid.UUID,
        domain: str,
        artist_id: uuid.UUID | None = None,
    ) -> float:
        """현재 pity 보너스 배율 반환.

        domain-level pity와 artist-level pity 중 더 높은 값을 반환합니다.
        """
        domain_tracker = await self._get_or_create_tracker(user_id, domain, None)
        domain_bonus = self._lookup_bonus(domain_tracker.consecutive_losses)

        if artist_id is None:
            return domain_bonus

        artist_tracker = await self._get_or_create_tracker(user_id, domain, artist_id)
        artist_bonus = self._lookup_bonus(artist_tracker.consecutive_losses)

        return max(domain_bonus, artist_bonus)

    async def record_loss(
        self,
        user_id: uuid.UUID,
        domain: str,
        artist_id: uuid.UUID | None = None,
    ) -> None:
        """낙첨 기록: consecutive_losses 증가, 임계값 도달 시 보장 당첨권 발급."""
        now = datetime.now(timezone.utc)
        trackers_to_update = [
            await self._get_or_create_tracker(user_id, domain, None),
        ]
        if artist_id is not None:
            trackers_to_update.append(await self._get_or_create_tracker(user_id, domain, artist_id))

        threshold = GUARANTEED_THRESHOLDS.get(domain, 10)

        for tracker in trackers_to_update:
            tracker.consecutive_losses += 1
            tracker.last_loss_at = now
            tracker.updated_at = now

            if tracker.consecutive_losses >= threshold and not tracker.guaranteed_ticket:
                tracker.guaranteed_ticket = True
                tracker.guaranteed_expires_at = now + timedelta(days=GUARANTEED_EXPIRY_DAYS)

        await self.session.flush()

    async def record_win(
        self,
        user_id: uuid.UUID,
        domain: str,
        artist_id: uuid.UUID | None = None,
    ) -> None:
        """당첨 기록: consecutive_losses 초기화, guaranteed_ticket 해제."""
        now = datetime.now(timezone.utc)
        trackers_to_update = [
            await self._get_or_create_tracker(user_id, domain, None),
        ]
        if artist_id is not None:
            trackers_to_update.append(await self._get_or_create_tracker(user_id, domain, artist_id))

        for tracker in trackers_to_update:
            tracker.consecutive_losses = 0
            tracker.guaranteed_ticket = False
            tracker.guaranteed_expires_at = None
            tracker.last_win_at = now
            tracker.updated_at = now

        await self.session.flush()

    async def has_guaranteed_ticket(
        self,
        user_id: uuid.UUID,
        domain: str,
    ) -> bool:
        """보장 당첨권 보유 여부 확인 (만료 체크 포함)."""
        now = datetime.now(timezone.utc)
        result = await self.session.execute(
            select(PityTracker).where(
                PityTracker.user_id == user_id,
                PityTracker.domain == domain,
                PityTracker.guaranteed_ticket.is_(True),
            )
        )
        trackers = result.scalars().all()

        for tracker in trackers:
            if tracker.guaranteed_expires_at is None:
                # 만료 없이 보장 (방어적)
                return True
            expires = tracker.guaranteed_expires_at
            if expires.tzinfo is None:
                expires = expires.replace(tzinfo=timezone.utc)
            if expires > now:
                return True

        return False

    async def use_guaranteed_ticket(
        self,
        user_id: uuid.UUID,
        domain: str,
    ) -> bool:
        """보장 당첨권 사용: guaranteed_ticket=False, consecutive_losses=0.

        Returns:
            True if a guaranteed ticket was consumed, False if none available.
        """
        now = datetime.now(timezone.utc)
        result = await self.session.execute(
            select(PityTracker).where(
                PityTracker.user_id == user_id,
                PityTracker.domain == domain,
                PityTracker.guaranteed_ticket.is_(True),
            )
        )
        trackers = result.scalars().all()

        used = False
        for tracker in trackers:
            if tracker.guaranteed_expires_at is not None:
                expires = tracker.guaranteed_expires_at
                if expires.tzinfo is None:
                    expires = expires.replace(tzinfo=timezone.utc)
                if expires <= now:
                    # 만료됨 — 자동 정리
                    tracker.guaranteed_ticket = False
                    tracker.guaranteed_expires_at = None
                    tracker.updated_at = now
                    continue

            tracker.guaranteed_ticket = False
            tracker.guaranteed_expires_at = None
            tracker.consecutive_losses = 0
            tracker.last_win_at = now
            tracker.updated_at = now
            used = True

        await self.session.flush()
        return used

    async def get_tracker_info(
        self,
        user_id: uuid.UUID,
        domain: str,
        artist_id: uuid.UUID | None = None,
    ) -> dict:
        """트래커 정보를 dict로 반환 (API 응답용)."""
        tracker = await self._get_or_create_tracker(user_id, domain, artist_id)
        threshold = GUARANTEED_THRESHOLDS.get(domain, 10)
        return {
            "consecutive_losses": tracker.consecutive_losses,
            "guaranteed_ticket": tracker.guaranteed_ticket,
            "guaranteed_expires_at": (
                tracker.guaranteed_expires_at.isoformat() if tracker.guaranteed_expires_at else None
            ),
            "bonus_multiplier": self._lookup_bonus(tracker.consecutive_losses),
            "threshold": threshold,
            "losses_until_guaranteed": max(0, threshold - tracker.consecutive_losses),
        }
