"""
Fanclub Service
================
Manages fanclub creation, membership lifecycle, and tier-based weight scoring.
"""

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.fanclub import (
    Fanclub,
    FanclubMembership,
    MembershipStatus,
    MembershipTier,
)
from app.models.event import Event
from app.models.organizer_team import OrganizerTeamMember
from app.models.user import User

logger = logging.getLogger(__name__)

# Tier-based fanclub weight for fan_weight v2 calculation
TIER_WEIGHTS = {
    MembershipTier.VIP.value: 1.0,
    MembershipTier.PREMIUM.value: 0.7,
    MembershipTier.BASIC.value: 0.4,
}


class FanclubService:
    def __init__(self, session: AsyncSession):
        self.session = session

    # ── Fanclub CRUD ──

    async def create_fanclub(self, organizer_id: uuid.UUID, data: dict) -> Fanclub:
        artist_name = data.get("artist_name") or data.get("subject_name", "")
        subject_name = data.get("subject_name") or artist_name
        fanclub = Fanclub(
            organizer_id=organizer_id,
            name=data["name"],
            artist_name=artist_name,
            artist_id=data.get("artist_id"),
            description=data.get("description"),
            logo_url=data.get("logo_url"),
            max_members=data.get("max_members", 500000),
            is_official=data.get("is_official", False),
            community_type=data.get("community_type", "fanclub"),
            subject_name=subject_name,
            domain=data.get("domain"),
            custom_tier_labels=data.get("custom_tier_labels"),
            custom_member_label=data.get("custom_member_label"),
            event_type_template=data.get("event_type_template"),
        )
        self.session.add(fanclub)
        await self.session.flush()
        return fanclub

    async def get_fanclub(self, fanclub_id: uuid.UUID) -> Fanclub | None:
        result = await self.session.execute(select(Fanclub).where(Fanclub.id == fanclub_id))
        return result.scalar_one_or_none()

    async def list_fanclubs(self, skip: int = 0, limit: int = 20) -> tuple[list[Fanclub], int]:
        count_result = await self.session.execute(
            select(func.count(Fanclub.id)).where(Fanclub.is_active == True)
        )
        total = count_result.scalar() or 0

        result = await self.session.execute(
            select(Fanclub)
            .where(Fanclub.is_active == True)
            .order_by(Fanclub.created_at.desc())
            .offset(skip)
            .limit(limit)
        )
        return list(result.scalars().all()), total

    async def list_by_organizer(self, organizer_id: uuid.UUID) -> list[Fanclub]:
        result = await self.session.execute(
            select(Fanclub)
            .where(Fanclub.organizer_id == organizer_id)
            .order_by(Fanclub.created_at.desc())
        )
        return list(result.scalars().all())

    async def get_member_count(self, fanclub_id: uuid.UUID) -> int:
        result = await self.session.execute(
            select(func.count(FanclubMembership.id)).where(
                FanclubMembership.fanclub_id == fanclub_id,
                FanclubMembership.status == MembershipStatus.ACTIVE.value,
            )
        )
        return result.scalar() or 0

    # ── Membership ──

    async def join_fanclub(
        self,
        user_id: uuid.UUID,
        fanclub_id: uuid.UUID,
        membership_code: str,
        tier: str = "basic",
    ) -> FanclubMembership:
        # Check fanclub exists and is active
        fanclub = await self.get_fanclub(fanclub_id)
        if not fanclub or not fanclub.is_active:
            raise ValueError("커뮤니티를 찾을 수 없습니다.")

        # Check max members
        count = await self.get_member_count(fanclub_id)
        if count >= fanclub.max_members:
            raise ValueError("커뮤니티 최대 인원을 초과했습니다.")

        # Check duplicate
        existing = await self.session.execute(
            select(FanclubMembership).where(
                FanclubMembership.user_id == user_id,
                FanclubMembership.fanclub_id == fanclub_id,
            )
        )
        if existing.scalar_one_or_none():
            raise ValueError("이미 가입된 커뮤니티입니다.")

        # Validate tier
        if tier not in [t.value for t in MembershipTier]:
            tier = MembershipTier.BASIC.value

        # WP06: Check organizer affiliation (conflict of interest)
        is_affiliated = await self.check_organizer_affiliation(user_id, fanclub_id)
        if is_affiliated:
            logger.info(
                "Conflict of interest detected: user %s is affiliated with organizer of fanclub %s",
                user_id,
                fanclub_id,
            )

        membership = FanclubMembership(
            user_id=user_id,
            fanclub_id=fanclub_id,
            membership_code=membership_code,
            tier=tier,
            status=MembershipStatus.ACTIVE.value,
            verified_at=datetime.now(timezone.utc),
            is_organizer_affiliated=is_affiliated,
        )
        self.session.add(membership)
        await self.session.flush()

        # Sync legacy flag
        await self._sync_legacy_flag(user_id)

        return membership

    async def verify_membership(self, membership_id: uuid.UUID) -> FanclubMembership:
        result = await self.session.execute(
            select(FanclubMembership).where(FanclubMembership.id == membership_id)
        )
        membership = result.scalar_one_or_none()
        if not membership:
            raise ValueError("멤버십을 찾을 수 없습니다.")

        membership.status = MembershipStatus.ACTIVE.value
        membership.verified_at = datetime.now(timezone.utc)
        await self.session.flush()
        await self._sync_legacy_flag(membership.user_id)
        return membership

    async def remove_member(self, fanclub_id: uuid.UUID, user_id: uuid.UUID) -> None:
        result = await self.session.execute(
            select(FanclubMembership).where(
                FanclubMembership.fanclub_id == fanclub_id,
                FanclubMembership.user_id == user_id,
            )
        )
        membership = result.scalar_one_or_none()
        if membership:
            membership.status = MembershipStatus.REVOKED.value
            await self.session.flush()
            await self._sync_legacy_flag(user_id)

    async def list_members(
        self,
        fanclub_id: uuid.UUID,
        status: str | None = None,
        tier: str | None = None,
        search: str | None = None,
        skip: int = 0,
        limit: int = 50,
    ) -> tuple[list[dict], int]:
        query = (
            select(FanclubMembership, User.name, User.email)
            .join(User, User.id == FanclubMembership.user_id)
            .where(FanclubMembership.fanclub_id == fanclub_id)
        )
        count_query = select(func.count(FanclubMembership.id)).where(
            FanclubMembership.fanclub_id == fanclub_id
        )

        if status:
            query = query.where(FanclubMembership.status == status)
            count_query = count_query.where(FanclubMembership.status == status)
        if tier:
            query = query.where(FanclubMembership.tier == tier)
            count_query = count_query.where(FanclubMembership.tier == tier)
        if search:
            search_pattern = f"%{search}%"
            query = query.where(
                (User.name.ilike(search_pattern)) | (User.email.ilike(search_pattern))
            )
            count_query = count_query.join(User, User.id == FanclubMembership.user_id).where(
                (User.name.ilike(search_pattern)) | (User.email.ilike(search_pattern))
            )

        total = (await self.session.execute(count_query)).scalar() or 0

        result = await self.session.execute(
            query.order_by(FanclubMembership.joined_at.desc()).offset(skip).limit(limit)
        )
        rows = result.all()
        members = []
        for membership, user_name, user_email in rows:
            members.append(
                {
                    "membership": membership,
                    "user_name": user_name,
                    "user_email": user_email,
                }
            )
        return members, total

    async def bulk_import_members(
        self,
        fanclub_id: uuid.UUID,
        entries: list[dict],
    ) -> dict:
        fanclub = await self.get_fanclub(fanclub_id)
        if not fanclub:
            raise ValueError("커뮤니티를 찾을 수 없습니다.")

        successful = 0
        failed = 0
        errors: list[str] = []

        # Pre-fetch all users by email in batch (avoids N+1)
        all_emails = [e.get("email", "").strip() for e in entries if e.get("email", "").strip()]
        users_result = await self.session.execute(
            select(User).where(User.email.in_(all_emails))
        )
        users_by_email = {u.email: u for u in users_result.scalars().all()}

        # Pre-fetch existing memberships for this fanclub (avoids N+1)
        existing_result = await self.session.execute(
            select(FanclubMembership.user_id).where(
                FanclubMembership.fanclub_id == fanclub_id,
            )
        )
        existing_user_ids = set(existing_result.scalars().all())

        for entry in entries:
            email = entry.get("email", "").strip()
            code = entry.get("membership_code", "")
            tier = entry.get("tier", "basic")

            if not email:
                failed += 1
                errors.append("빈 이메일")
                continue

            user = users_by_email.get(email)
            if not user:
                failed += 1
                errors.append(f"{email}: 미등록 사용자")
                continue

            # Check duplicate using pre-fetched set
            if user.id in existing_user_ids:
                failed += 1
                errors.append(f"{email}: 이미 가입됨")
                continue

            if tier not in [t.value for t in MembershipTier]:
                tier = MembershipTier.BASIC.value

            # WP06: Check organizer affiliation
            is_affiliated = await self.check_organizer_affiliation(user.id, fanclub_id)

            membership = FanclubMembership(
                user_id=user.id,
                fanclub_id=fanclub_id,
                membership_code=code,
                tier=tier,
                status=MembershipStatus.ACTIVE.value,
                verified_at=datetime.now(timezone.utc),
                is_organizer_affiliated=is_affiliated,
            )
            self.session.add(membership)
            successful += 1

            # Sync legacy flag
            user.is_fanclub_member = True

        if successful > 0:
            await self.session.flush()

        return {
            "total_processed": len(entries),
            "successful": successful,
            "failed": failed,
            "errors": errors[:50],  # Cap error messages
        }

    # ── Weight Calculation ──

    async def get_membership_tier_weight(self, user_id: uuid.UUID, event_id: uuid.UUID) -> float:
        """Get community membership weight for a user for the event.

        Matching priority:
          1. event.community_id (direct link, highest priority)
          2. event.artist_id (legacy artist matching)
          3. event.organizer_id (fallback)

        Returns: VIP=1.0, PREMIUM=0.7, BASIC=0.4, no membership=0.0
        """
        event_result = await self.session.execute(select(Event).where(Event.id == event_id))
        event = event_result.scalar_one_or_none()
        if not event:
            return 0.0

        base_query = (
            select(FanclubMembership)
            .join(Fanclub, Fanclub.id == FanclubMembership.fanclub_id)
            .where(
                FanclubMembership.user_id == user_id,
                FanclubMembership.status == MembershipStatus.ACTIVE.value,
            )
        )

        # Priority 1: direct community_id link
        if event.community_id:
            result = await self.session.execute(base_query.where(Fanclub.id == event.community_id))
            membership = result.scalar_one_or_none()
            if membership:
                return TIER_WEIGHTS.get(membership.tier, 0.4)

        # Priority 2: artist_id match
        if event.artist_id:
            result = await self.session.execute(
                base_query.where(Fanclub.artist_id == event.artist_id)
            )
            membership = result.scalar_one_or_none()
            if membership:
                return TIER_WEIGHTS.get(membership.tier, 0.4)

        # Priority 3: organizer_id fallback
        result = await self.session.execute(
            base_query.where(Fanclub.organizer_id == event.organizer_id)
        )
        membership = result.scalar_one_or_none()
        if not membership:
            return 0.0
        return TIER_WEIGHTS.get(membership.tier, 0.4)

    async def is_member_for_event(self, user_id: uuid.UUID, event_id: uuid.UUID) -> bool:
        weight = await self.get_membership_tier_weight(user_id, event_id)
        return weight > 0.0

    # ── User memberships ──

    async def get_user_memberships(self, user_id: uuid.UUID) -> list[dict]:
        result = await self.session.execute(
            select(FanclubMembership, Fanclub.name, Fanclub.artist_name, Fanclub.logo_url)
            .join(Fanclub, Fanclub.id == FanclubMembership.fanclub_id)
            .where(
                FanclubMembership.user_id == user_id,
                FanclubMembership.status.in_(
                    [
                        MembershipStatus.ACTIVE.value,
                        MembershipStatus.PENDING.value,
                    ]
                ),
            )
            .order_by(FanclubMembership.joined_at.desc())
        )
        rows = result.all()
        memberships = []
        for m, fc_name, fc_artist, fc_logo in rows:
            memberships.append(
                {
                    "id": str(m.id),
                    "fanclub_id": str(m.fanclub_id),
                    "fanclub_name": fc_name,
                    "artist_name": fc_artist,
                    "logo_url": fc_logo,
                    "tier": m.tier,
                    "status": m.status,
                    "expires_at": m.expires_at.isoformat() if m.expires_at else None,
                    "joined_at": m.joined_at.isoformat() if m.joined_at else None,
                }
            )
        return memberships

    # ── Conflict of Interest (WP06) ──

    async def check_organizer_affiliation(self, user_id: uuid.UUID, fanclub_id: uuid.UUID) -> bool:
        """Check if the user is affiliated with the organizer of this fanclub.

        Returns True if:
          1. The user IS the organizer of the fanclub, OR
          2. The user is a team member of the organizer (via OrganizerTeamMember)
        """
        fanclub = await self.get_fanclub(fanclub_id)
        if not fanclub:
            return False

        # Case 1: User is the organizer themselves
        if fanclub.organizer_id == user_id:
            return True

        # Case 2: User is a team member of the organizer
        result = await self.session.execute(
            select(OrganizerTeamMember).where(
                OrganizerTeamMember.organizer_id == fanclub.organizer_id,
                OrganizerTeamMember.user_id == user_id,
            )
        )
        team_member = result.scalar_one_or_none()
        return team_member is not None

    async def get_affiliation_status(self, user_id: uuid.UUID, fanclub_id: uuid.UUID) -> bool:
        """Get is_organizer_affiliated for a specific membership.

        Returns False if no membership exists.
        """
        result = await self.session.execute(
            select(FanclubMembership).where(
                FanclubMembership.user_id == user_id,
                FanclubMembership.fanclub_id == fanclub_id,
            )
        )
        membership = result.scalar_one_or_none()
        if not membership:
            return False
        return membership.is_organizer_affiliated

    async def is_organizer_affiliated_for_event(
        self, user_id: uuid.UUID, event_id: uuid.UUID
    ) -> bool:
        """Check if a user has organizer affiliation for any fanclub related to an event.

        Checks all active memberships linked to the event via community_id,
        artist_id, or organizer_id.
        """
        event_result = await self.session.execute(select(Event).where(Event.id == event_id))
        event = event_result.scalar_one_or_none()
        if not event:
            return False

        # Build conditions matching the tier weight lookup priority
        conditions = []

        if event.community_id:
            conditions.append(Fanclub.id == event.community_id)

        if event.artist_id:
            conditions.append(Fanclub.artist_id == event.artist_id)

        conditions.append(Fanclub.organizer_id == event.organizer_id)

        for cond in conditions:
            result = await self.session.execute(
                select(FanclubMembership)
                .join(Fanclub, Fanclub.id == FanclubMembership.fanclub_id)
                .where(
                    FanclubMembership.user_id == user_id,
                    FanclubMembership.status == MembershipStatus.ACTIVE.value,
                    FanclubMembership.is_organizer_affiliated == True,
                    cond,
                )
            )
            if result.scalar_one_or_none():
                return True

        return False

    # ── Internal ──

    async def _sync_legacy_flag(self, user_id: uuid.UUID) -> None:
        """Keep user.is_fanclub_member in sync with active memberships."""
        result = await self.session.execute(
            select(func.count(FanclubMembership.id)).where(
                FanclubMembership.user_id == user_id,
                FanclubMembership.status == MembershipStatus.ACTIVE.value,
            )
        )
        has_active = (result.scalar() or 0) > 0

        user_result = await self.session.execute(select(User).where(User.id == user_id))
        user = user_result.scalar_one_or_none()
        if user:
            user.is_fanclub_member = has_active
            await self.session.flush()
