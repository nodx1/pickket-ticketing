"""
Group Service
==============
Manages group formation for group bidding / group ticket purchases.
"""

import secrets
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, func
from sqlalchemy.orm import selectinload
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.group import GroupModel, GroupMemberModel
from app.models.event import SeatTier
from app.models.user import User


class GroupService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def create_group(
        self,
        leader_id: uuid.UUID,
        event_id: uuid.UUID,
        tier_id: uuid.UUID,
        require_adjacent: bool = True,
    ) -> GroupModel:
        # Check tier exists and allows group tickets
        tier_result = await self.session.execute(select(SeatTier).where(SeatTier.id == tier_id))
        tier = tier_result.scalar_one_or_none()
        if not tier:
            raise ValueError("티어를 찾을 수 없습니다.")
        if not tier.allow_group_tickets:
            raise ValueError("이 티어는 그룹 티켓을 허용하지 않습니다.")

        # Check user isn't already in a group for this event
        existing = await self.get_user_group_for_event(leader_id, event_id)
        if existing:
            raise ValueError("이미 이 이벤트의 그룹에 참여 중입니다.")

        # Generate unique 8-char code
        code = self._generate_code()

        group = GroupModel(
            group_code=code,
            leader_user_id=leader_id,
            event_id=event_id,
            tier_id=tier_id,
            require_adjacent=require_adjacent,
        )
        self.session.add(group)
        await self.session.flush()

        # Add leader as first member
        member = GroupMemberModel(
            group_id=group.id,
            user_id=leader_id,
            status="joined",
            joined_at=datetime.now(timezone.utc),
        )
        self.session.add(member)
        await self.session.flush()

        return group

    async def join_by_code(self, user_id: uuid.UUID, code: str) -> GroupMemberModel:
        # Find group
        result = await self.session.execute(select(GroupModel).where(GroupModel.group_code == code))
        group = result.scalar_one_or_none()
        if not group:
            raise ValueError("그룹 코드를 찾을 수 없습니다.")

        # Check not already in this group
        existing = await self.session.execute(
            select(GroupMemberModel).where(
                GroupMemberModel.group_id == group.id,
                GroupMemberModel.user_id == user_id,
            )
        )
        if existing.scalar_one_or_none():
            raise ValueError("이미 이 그룹에 참여 중입니다.")

        # Check not in another group for same event
        other_group = await self.get_user_group_for_event(user_id, group.event_id)
        if other_group:
            raise ValueError("이미 이 이벤트의 다른 그룹에 참여 중입니다.")

        # Check group capacity
        tier_result = await self.session.execute(
            select(SeatTier).where(SeatTier.id == group.tier_id)
        )
        tier = tier_result.scalar_one_or_none()
        max_size = tier.max_group_size if tier else 4

        member_count = await self.session.execute(
            select(func.count(GroupMemberModel.id)).where(
                GroupMemberModel.group_id == group.id,
                GroupMemberModel.status == "joined",
            )
        )
        current_count = member_count.scalar() or 0
        if current_count >= max_size:
            raise ValueError(f"그룹 최대 인원({max_size}명)을 초과했습니다.")

        member = GroupMemberModel(
            group_id=group.id,
            user_id=user_id,
            status="joined",
            joined_at=datetime.now(timezone.utc),
        )
        self.session.add(member)
        await self.session.flush()
        return member

    async def leave_group(self, group_id: uuid.UUID, user_id: uuid.UUID) -> None:
        group_result = await self.session.execute(
            select(GroupModel).where(GroupModel.id == group_id)
        )
        group = group_result.scalar_one_or_none()
        if not group:
            raise ValueError("그룹을 찾을 수 없습니다.")

        # If leader leaves, disband the group
        if group.leader_user_id == user_id:
            members_result = await self.session.execute(
                select(GroupMemberModel).where(GroupMemberModel.group_id == group_id)
            )
            for m in members_result.scalars().all():
                m.status = "left"
            await self.session.flush()
            return

        # Regular member leaves
        result = await self.session.execute(
            select(GroupMemberModel).where(
                GroupMemberModel.group_id == group_id,
                GroupMemberModel.user_id == user_id,
            )
        )
        member = result.scalar_one_or_none()
        if member:
            member.status = "left"
            await self.session.flush()

    async def get_group(self, group_id: uuid.UUID) -> dict | None:
        result = await self.session.execute(select(GroupModel).where(GroupModel.id == group_id))
        group = result.scalar_one_or_none()
        if not group:
            return None

        # Get tier info for max_size
        tier_result = await self.session.execute(
            select(SeatTier).where(SeatTier.id == group.tier_id)
        )
        tier = tier_result.scalar_one_or_none()
        max_size = tier.max_group_size if tier else 4

        # Get members with user names
        members_result = await self.session.execute(
            select(GroupMemberModel, User.name)
            .join(User, User.id == GroupMemberModel.user_id)
            .where(
                GroupMemberModel.group_id == group_id,
                GroupMemberModel.status == "joined",
            )
        )
        members = []
        for member, user_name in members_result.all():
            members.append(
                {
                    "user_id": str(member.user_id),
                    "user_name": user_name,
                    "status": member.status,
                    "joined_at": member.joined_at,
                }
            )

        return {
            "id": str(group.id),
            "group_code": group.group_code,
            "leader_user_id": str(group.leader_user_id),
            "event_id": str(group.event_id),
            "tier_id": str(group.tier_id),
            "require_adjacent": group.require_adjacent,
            "members": members,
            "max_size": max_size,
        }

    async def get_user_group_for_event(
        self, user_id: uuid.UUID, event_id: uuid.UUID
    ) -> GroupModel | None:
        result = await self.session.execute(
            select(GroupModel)
            .join(GroupMemberModel, GroupMemberModel.group_id == GroupModel.id)
            .where(
                GroupMemberModel.user_id == user_id,
                GroupMemberModel.status == "joined",
                GroupModel.event_id == event_id,
            )
        )
        return result.scalar_one_or_none()

    async def get_user_groups(self, user_id: uuid.UUID) -> list[dict]:
        # 1) 유저가 참여한 그룹 ID 목록 조회
        result = await self.session.execute(
            select(GroupModel.id)
            .join(GroupMemberModel, GroupMemberModel.group_id == GroupModel.id)
            .where(
                GroupMemberModel.user_id == user_id,
                GroupMemberModel.status == "joined",
            )
        )
        group_ids = [row[0] for row in result.all()]
        if not group_ids:
            return []

        # 2) 그룹 + 티어 정보를 한번에 로드
        groups_result = await self.session.execute(
            select(GroupModel, SeatTier.max_group_size)
            .outerjoin(SeatTier, SeatTier.id == GroupModel.tier_id)
            .where(GroupModel.id.in_(group_ids))
        )
        group_rows = groups_result.all()

        # 3) 모든 그룹의 멤버를 한번에 로드 (N+1 제거)
        members_result = await self.session.execute(
            select(GroupMemberModel, User.name)
            .join(User, User.id == GroupMemberModel.user_id)
            .where(
                GroupMemberModel.group_id.in_(group_ids),
                GroupMemberModel.status == "joined",
            )
        )
        # 그룹별 멤버 매핑
        members_by_group: dict[uuid.UUID, list[dict]] = {}
        for member, user_name in members_result.all():
            members_by_group.setdefault(member.group_id, []).append(
                {
                    "user_id": str(member.user_id),
                    "user_name": user_name,
                    "status": member.status,
                    "joined_at": member.joined_at,
                }
            )

        # 4) 결과 조합
        groups = []
        for group, max_group_size in group_rows:
            groups.append(
                {
                    "id": str(group.id),
                    "group_code": group.group_code,
                    "leader_user_id": str(group.leader_user_id),
                    "event_id": str(group.event_id),
                    "tier_id": str(group.tier_id),
                    "require_adjacent": group.require_adjacent,
                    "members": members_by_group.get(group.id, []),
                    "max_size": max_group_size if max_group_size else 4,
                }
            )
        return groups

    def _generate_code(self) -> str:
        return secrets.token_hex(4).upper()
