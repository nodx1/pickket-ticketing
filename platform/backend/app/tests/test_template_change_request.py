"""
WP05: Template Change Request Tests
=====================================
Tests for the template change request workflow:
  - Organizer creates change request
  - Admin approves or rejects
  - Fanclub template is updated only on approval
"""

import pytest
import pytest_asyncio
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.fanclub import Fanclub, _VALID_EVENT_TYPE_TEMPLATES
from app.models.template_change import TemplateChangeRequest, TemplateChangeStatus
from app.models.audit_log import AuditLog
from app.models.user import User
from app.tests.conftest import TestSession


@pytest_asyncio.fixture
async def organizer_and_fanclub(db_session: AsyncSession):
    """Create an organizer user and a fanclub for testing."""
    async with TestSession() as session:
        organizer = User(
            email="org-tc@example.com",
            name="TC Organizer",
            hashed_password="fakehash",
            is_organizer=True,
            is_verified=True,
            verification_level=2,
        )
        session.add(organizer)
        await session.flush()

        fanclub = Fanclub(
            name="Test Fanclub",
            artist_name="Test Artist",
            organizer_id=organizer.id,
            event_type_template="general_concert",
        )
        session.add(fanclub)
        await session.commit()
        await session.refresh(organizer)
        await session.refresh(fanclub)
        return organizer, fanclub


@pytest_asyncio.fixture
async def admin_user(db_session: AsyncSession):
    """Create an admin user for testing."""
    async with TestSession() as session:
        admin = User(
            email="admin-tc@example.com",
            name="TC Admin",
            hashed_password="fakehash",
            is_admin=True,
            admin_role="super_admin",
            is_verified=True,
            verification_level=3,
        )
        session.add(admin)
        await session.commit()
        await session.refresh(admin)
        return admin


class TestTemplateChangeRequestModel:
    """Test TemplateChangeRequest model directly."""

    @pytest.mark.asyncio
    async def test_create_change_request(self, organizer_and_fanclub):
        organizer, fanclub = organizer_and_fanclub
        async with TestSession() as session:
            req = TemplateChangeRequest(
                fanclub_id=fanclub.id,
                old_template="general_concert",
                new_template="fanclub_exclusive",
                reason="팬클럽 전용 이벤트 위주로 변경",
                requested_by=organizer.id,
                status=TemplateChangeStatus.PENDING.value,
            )
            session.add(req)
            await session.commit()
            await session.refresh(req)

            assert req.id is not None
            assert req.status == "pending"
            assert req.new_template == "fanclub_exclusive"
            assert req.reviewed_by is None
            assert req.reviewed_at is None

    @pytest.mark.asyncio
    async def test_approve_change_request(self, organizer_and_fanclub, admin_user):
        organizer, fanclub = organizer_and_fanclub
        async with TestSession() as session:
            req = TemplateChangeRequest(
                fanclub_id=fanclub.id,
                old_template="general_concert",
                new_template="sports_match",
                reason="스포츠로 전환",
                requested_by=organizer.id,
                status=TemplateChangeStatus.PENDING.value,
            )
            session.add(req)
            await session.flush()

            # Approve
            req.status = TemplateChangeStatus.APPROVED.value
            req.reviewed_by = admin_user.id

            # Apply to fanclub
            fc_result = await session.execute(select(Fanclub).where(Fanclub.id == fanclub.id))
            fc = fc_result.scalar_one()
            fc.event_type_template = req.new_template

            await session.commit()
            await session.refresh(req)
            await session.refresh(fc)

            assert req.status == "approved"
            assert req.reviewed_by == admin_user.id
            assert fc.event_type_template == "sports_match"

    @pytest.mark.asyncio
    async def test_reject_change_request(self, organizer_and_fanclub, admin_user):
        organizer, fanclub = organizer_and_fanclub
        async with TestSession() as session:
            req = TemplateChangeRequest(
                fanclub_id=fanclub.id,
                old_template="general_concert",
                new_template="high_demand_tour",
                reason="대형 투어 전환",
                requested_by=organizer.id,
                status=TemplateChangeStatus.PENDING.value,
            )
            session.add(req)
            await session.flush()

            # Reject
            req.status = TemplateChangeStatus.REJECTED.value
            req.reviewed_by = admin_user.id
            req.rejection_reason = "현재 이벤트 유형과 맞지 않음"

            await session.commit()
            await session.refresh(req)

            assert req.status == "rejected"
            assert req.rejection_reason == "현재 이벤트 유형과 맞지 않음"

            # Fanclub template should NOT change
            fc_result = await session.execute(select(Fanclub).where(Fanclub.id == fanclub.id))
            fc = fc_result.scalar_one()
            assert fc.event_type_template == "general_concert"

    @pytest.mark.asyncio
    async def test_audit_entry_created(self, organizer_and_fanclub):
        """Audit entries are created with the template change request.

        Since WP05 audit entries for template changes use event_id=None
        (community-level action, not tied to a specific event).
        """
        organizer, fanclub = organizer_and_fanclub
        async with TestSession() as session:
            audit = AuditLog(
                actor_id=organizer.id,
                action="weight_template_change_request",
                resource_type="template_change",
                new_value={
                    "fanclub_id": str(fanclub.id),
                    "old_template": "general_concert",
                    "new_template": "fanclub_exclusive",
                    "result": "success",
                },
            )
            session.add(audit)
            await session.commit()
            await session.refresh(audit)

            assert audit.action == "weight_template_change_request"
            assert audit.new_value["old_template"] == "general_concert"
            assert audit.event_id is None


class TestFanclubEventTypeValidation:
    """WP04: Test event_type_template validation on Fanclub model."""

    @pytest.mark.asyncio
    async def test_valid_template_accepted(self, db_session):
        async with TestSession() as session:
            user = User(
                email="val1@example.com",
                name="Val Test",
                hashed_password="fakehash",
                is_organizer=True,
            )
            session.add(user)
            await session.flush()

            for template in _VALID_EVENT_TYPE_TEMPLATES:
                fc = Fanclub(
                    name=f"FC {template}",
                    artist_name="Artist",
                    organizer_id=user.id,
                    event_type_template=template,
                )
                session.add(fc)
            await session.commit()

    @pytest.mark.asyncio
    async def test_invalid_template_rejected(self, db_session):
        async with TestSession() as session:
            user = User(
                email="val2@example.com",
                name="Val Test 2",
                hashed_password="fakehash",
                is_organizer=True,
            )
            session.add(user)
            await session.flush()

            with pytest.raises(ValueError, match="Invalid event_type_template"):
                Fanclub(
                    name="FC Invalid",
                    artist_name="Artist",
                    organizer_id=user.id,
                    event_type_template="this_is_not_valid",
                )

    @pytest.mark.asyncio
    async def test_none_template_accepted(self, db_session):
        async with TestSession() as session:
            user = User(
                email="val3@example.com",
                name="Val Test 3",
                hashed_password="fakehash",
                is_organizer=True,
            )
            session.add(user)
            await session.flush()

            fc = Fanclub(
                name="FC None",
                artist_name="Artist",
                organizer_id=user.id,
                event_type_template=None,
            )
            session.add(fc)
            await session.commit()
            assert fc.event_type_template is None
