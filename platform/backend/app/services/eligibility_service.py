"""
Eligibility Service
====================
Checks user eligibility using engine's check_eligibility + compute_abuse_score.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from talkfile_engine.eligibility import (
    EligibilityResult,
    UserEligibility,
    VerificationLevel,
    check_eligibility,
    compute_abuse_score,
    compute_pool_seats,
)

from app.models.user import User
from app.repositories.user_repo import UserRepository


def _get_verification_level(user: User) -> VerificationLevel:
    """Map user's integer verification_level to engine VerificationLevel enum."""
    if user.verification_level >= 3:
        return VerificationLevel.FOREIGN_ALT
    if user.verification_level >= 2:
        return VerificationLevel.REAL_NAME
    if user.verification_level >= 1:
        return VerificationLevel.PHONE
    return VerificationLevel.UNVERIFIED


def _is_new_user(user: User) -> bool:
    """Determine if user signed up within the last 6 months."""
    created_at = user.created_at
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    days = (datetime.now(timezone.utc) - created_at).days
    return days < 180


class EligibilityService:
    """Service for checking user eligibility for ticket pools."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.user_repo = UserRepository(session)

    async def check(
        self,
        user_id: uuid.UUID,
        multi_account_same_ip: int = 0,
        rapid_cancel_count: int = 0,
        bot_signature_detected: bool = False,
    ) -> EligibilityResult:
        """
        Check which pools a user is eligible for.

        Recomputes abuse score from latest signals and updates the user record
        before running the eligibility check.

        Args:
            user_id: The user's UUID.
            multi_account_same_ip: Number of accounts sharing the same IP.
            rapid_cancel_count: Number of rapid cancellations.
            bot_signature_detected: Whether a bot signature was detected.

        Returns:
            EligibilityResult with eligible_pools, is_blocked, block_reason.

        Raises:
            ValueError: If user not found.
        """
        user = await self.user_repo.get(user_id)
        if not user:
            raise ValueError(f"User {user_id} not found")

        # Recompute abuse score using engine's rule-based detection
        abuse_score = compute_abuse_score(
            multi_account_same_ip=multi_account_same_ip,
            rapid_cancel_count=rapid_cancel_count,
            bot_signature_detected=bot_signature_detected,
        )
        # Use the higher of the existing or newly computed score
        user.abuse_score = max(user.abuse_score, abuse_score)

        user_eligibility = UserEligibility(
            user_id=str(user.id),
            verification_level=_get_verification_level(user),
            is_new_user=_is_new_user(user),
            is_fanclub_member=user.is_fanclub_member,
            abuse_score=user.abuse_score,
        )

        return check_eligibility(user_eligibility)

    async def check_batch(self, user_ids: list[uuid.UUID]) -> dict[uuid.UUID, EligibilityResult]:
        """
        Batch check eligibility for multiple users.

        Args:
            user_ids: List of user UUIDs.

        Returns:
            Mapping of user_id to EligibilityResult.
        """
        from sqlalchemy import select
        from app.models.user import User as UserModel

        if not user_ids:
            return {}

        result = await self.session.execute(select(UserModel).where(UserModel.id.in_(user_ids)))
        users = list(result.scalars().all())

        results: dict[uuid.UUID, EligibilityResult] = {}
        for user in users:
            user_eligibility = UserEligibility(
                user_id=str(user.id),
                verification_level=_get_verification_level(user),
                is_new_user=_is_new_user(user),
                is_fanclub_member=user.is_fanclub_member,
                abuse_score=user.abuse_score,
            )
            results[user.id] = check_eligibility(user_eligibility)

        return results

    def get_verification_level(self, user: User) -> VerificationLevel:
        """Get verification level for a user model instance (non-async helper)."""
        return _get_verification_level(user)

    @staticmethod
    def compute_pool_allocation(
        tier_capacity: int, user_count: int | None = None
    ) -> dict[str, int]:
        """
        Compute seat allocation per pool using engine compute_pool_seats().

        Args:
            tier_capacity: Total number of seats to allocate across pools.
            user_count: Optional (unused currently, reserved for future demand-based adjustment).

        Returns:
            Dict mapping pool name to seat count, e.g. {"A": 65, "D": 10, "B": 15, "C": 10}.
        """
        pool_seats = compute_pool_seats(total_seats=tier_capacity)
        return {pool.name: seats for pool, seats in pool_seats.items()}
