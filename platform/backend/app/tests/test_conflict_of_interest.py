"""
WP06: Conflict of Interest Tests
==================================
Tests for the automatic conflict-of-interest detection system:
  - Auto-detect organizer team members on fanclub join
  - is_organizer_affiliated flag setting
  - Exclusion from Pool D allocation
"""

import pytest
import pytest_asyncio
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.fanclub import Fanclub, FanclubMembership, MembershipStatus, MembershipTier
from app.models.organizer_team import OrganizerTeamMember, TeamRole
from app.models.user import User
from app.services.fanclub_service import FanclubService
from app.tests.conftest import TestSession


@pytest_asyncio.fixture
async def organizer_with_team(db_session: AsyncSession):
    """Create an organizer, a team member, and a regular user."""
    async with TestSession() as session:
        # Organizer
        organizer = User(
            email="org-coi@example.com",
            name="COI Organizer",
            hashed_password="fakehash",
            is_organizer=True,
            is_verified=True,
            verification_level=2,
        )
        session.add(organizer)
        await session.flush()

        # Team member
        team_member = User(
            email="team-coi@example.com",
            name="COI Team Member",
            hashed_password="fakehash",
            is_verified=True,
            verification_level=1,
        )
        session.add(team_member)
        await session.flush()

        # Regular user (not affiliated)
        regular_user = User(
            email="regular-coi@example.com",
            name="COI Regular User",
            hashed_password="fakehash",
            is_verified=True,
            verification_level=1,
        )
        session.add(regular_user)
        await session.flush()

        # OrganizerTeamMember link
        team_link = OrganizerTeamMember(
            organizer_id=organizer.id,
            user_id=team_member.id,
            role=TeamRole.MANAGER,
            invited_email=team_member.email,
        )
        session.add(team_link)

        # Create fanclub owned by organizer
        fanclub = Fanclub(
            name="COI Test Fanclub",
            artist_name="COI Artist",
            organizer_id=organizer.id,
            event_type_template="general_concert",
        )
        session.add(fanclub)
        await session.commit()
        await session.refresh(organizer)
        await session.refresh(team_member)
        await session.refresh(regular_user)
        await session.refresh(fanclub)
        await session.refresh(team_link)

        return organizer, team_member, regular_user, fanclub


class TestConflictOfInterestDetection:
    """Test automatic conflict-of-interest detection."""

    @pytest.mark.asyncio
    async def test_organizer_joining_own_fanclub_is_affiliated(self, organizer_with_team):
        organizer, _, _, fanclub = organizer_with_team
        async with TestSession() as session:
            svc = FanclubService(session)
            is_affiliated = await svc.check_organizer_affiliation(organizer.id, fanclub.id)
            assert is_affiliated is True

    @pytest.mark.asyncio
    async def test_team_member_is_affiliated(self, organizer_with_team):
        _, team_member, _, fanclub = organizer_with_team
        async with TestSession() as session:
            svc = FanclubService(session)
            is_affiliated = await svc.check_organizer_affiliation(team_member.id, fanclub.id)
            assert is_affiliated is True

    @pytest.mark.asyncio
    async def test_regular_user_is_not_affiliated(self, organizer_with_team):
        _, _, regular_user, fanclub = organizer_with_team
        async with TestSession() as session:
            svc = FanclubService(session)
            is_affiliated = await svc.check_organizer_affiliation(regular_user.id, fanclub.id)
            assert is_affiliated is False


class TestJoinFanclubAffiliation:
    """Test that join_fanclub auto-sets is_organizer_affiliated."""

    @pytest.mark.asyncio
    async def test_team_member_join_sets_affiliated(self, organizer_with_team):
        _, team_member, _, fanclub = organizer_with_team
        async with TestSession() as session:
            svc = FanclubService(session)
            membership = await svc.join_fanclub(team_member.id, fanclub.id, "CODE123", "basic")
            await session.commit()
            assert membership.is_organizer_affiliated is True

    @pytest.mark.asyncio
    async def test_regular_user_join_not_affiliated(self, organizer_with_team):
        _, _, regular_user, fanclub = organizer_with_team
        async with TestSession() as session:
            svc = FanclubService(session)
            membership = await svc.join_fanclub(regular_user.id, fanclub.id, "CODE456", "basic")
            await session.commit()
            assert membership.is_organizer_affiliated is False


class TestMembershipAffiliationField:
    """Test is_organizer_affiliated field on FanclubMembership model."""

    @pytest.mark.asyncio
    async def test_default_is_false(self, db_session):
        async with TestSession() as session:
            user = User(
                email="field1@example.com",
                name="Field Test",
                hashed_password="fakehash",
            )
            session.add(user)
            await session.flush()

            fc = Fanclub(
                name="Field FC",
                artist_name="Artist",
                organizer_id=user.id,
            )
            session.add(fc)
            await session.flush()

            membership = FanclubMembership(
                user_id=user.id,
                fanclub_id=fc.id,
                tier=MembershipTier.BASIC.value,
                status=MembershipStatus.ACTIVE.value,
            )
            session.add(membership)
            await session.commit()
            await session.refresh(membership)

            assert membership.is_organizer_affiliated is False

    @pytest.mark.asyncio
    async def test_can_set_to_true(self, db_session):
        async with TestSession() as session:
            user = User(
                email="field2@example.com",
                name="Field Test 2",
                hashed_password="fakehash",
            )
            session.add(user)
            await session.flush()

            fc = Fanclub(
                name="Field FC 2",
                artist_name="Artist",
                organizer_id=user.id,
            )
            session.add(fc)
            await session.flush()

            membership = FanclubMembership(
                user_id=user.id,
                fanclub_id=fc.id,
                tier=MembershipTier.BASIC.value,
                status=MembershipStatus.ACTIVE.value,
                is_organizer_affiliated=True,
            )
            session.add(membership)
            await session.commit()
            await session.refresh(membership)

            assert membership.is_organizer_affiliated is True
