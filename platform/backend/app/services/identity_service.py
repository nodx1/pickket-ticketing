"""
Identity Service
=================
Stub for PASS/NICE identity verification integration.
Handles CI/DI hash storage and duplicate detection.
"""

import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.repositories.user_repo import UserRepository


class IdentityService:
    """Service for identity verification (PASS/NICE stub)."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.user_repo = UserRepository(session)
        self._enabled = settings.IDENTITY_PROVIDER not in ("stub", "none")

    def _ensure_enabled(self) -> None:
        if not self._enabled:
            raise ValueError(
                "Identity verification is not configured. "
                "Set IDENTITY_PROVIDER to 'pass' or 'portone' to enable."
            )

    async def verify_identity(self, user_id: uuid.UUID, ci_hash: str, di_hash: str) -> dict:
        """
        Verify a user's identity (stub implementation).

        In production, this would call PASS or NICE API for real-name verification.
        Currently stores CI/DI hashes and updates verification_level.

        Args:
            user_id: The user's UUID.
            ci_hash: Connecting Information hash (unique per person).
            di_hash: Duplicated Information hash (site-specific).

        Returns:
            Dict with verification status and level.

        Raises:
            ValueError: If user not found or CI already registered to another user.
        """
        self._ensure_enabled()
        user = await self.user_repo.get(user_id)
        if not user:
            raise ValueError(f"User {user_id} not found")

        # Check for duplicate CI (same person registering multiple accounts)
        is_duplicate = await self.check_duplicate_ci(ci_hash)
        if is_duplicate:
            # Check if it's the same user re-verifying
            existing = await self.user_repo.get_by_ci_hash(ci_hash)
            if existing and existing.id != user_id:
                raise ValueError("This identity is already registered to another account")

        # Update user verification data
        user.ci_hash = ci_hash
        user.di_hash = di_hash
        user.verification_level = 2  # REAL_NAME
        user.is_verified = True
        await self.session.flush()

        return {
            "verified": True,
            "level": 2,
            "user_id": str(user_id),
        }

    async def check_duplicate_ci(self, ci_hash: str) -> bool:
        """
        Check if another user has the same CI hash.

        Args:
            ci_hash: Connecting Information hash to check.

        Returns:
            True if a user with this CI hash already exists.
        """
        existing = await self.user_repo.get_by_ci_hash(ci_hash)
        return existing is not None

    async def verify_phone(self, user_id: uuid.UUID, phone: str) -> dict:
        """
        Verify a user's phone number (stub).

        Args:
            user_id: The user's UUID.
            phone: Phone number to verify.

        Returns:
            Dict with verification status and level.

        Raises:
            ValueError: If user not found.
        """
        self._ensure_enabled()
        user = await self.user_repo.get(user_id)
        if not user:
            raise ValueError(f"User {user_id} not found")

        # Only upgrade if currently unverified
        if user.verification_level < 1:
            user.verification_level = 1  # PHONE
        user.phone = phone
        await self.session.flush()

        return {
            "verified": True,
            "level": user.verification_level,
            "user_id": str(user_id),
        }

    async def verify_foreign(self, user_id: uuid.UUID, passport_hash: str) -> dict:
        """
        Verify a foreign user's identity (stub).

        Args:
            user_id: The user's UUID.
            passport_hash: Hashed passport identifier.

        Returns:
            Dict with verification status and level.

        Raises:
            ValueError: If user not found.
        """
        self._ensure_enabled()
        user = await self.user_repo.get(user_id)
        if not user:
            raise ValueError(f"User {user_id} not found")

        user.di_hash = passport_hash
        user.verification_level = 3  # FOREIGN_ALT
        user.is_verified = True
        await self.session.flush()

        return {
            "verified": True,
            "level": 3,
            "user_id": str(user_id),
        }
