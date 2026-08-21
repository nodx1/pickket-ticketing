"""감사 로그 리포지토리 — WP-16 통합.

AuditLog(audit_logs) 통합 모델 기반. 하위 호환을 위해 event_id 기반 조회 유지.
"""

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.audit_log import AuditLog
from app.repositories.base import BaseRepository


class AuditRepository(BaseRepository[AuditLog]):
    """WP-16: AuditLog 통합 모델 기반 리포지토리."""

    def __init__(self, session: AsyncSession):
        super().__init__(AuditLog, session)

    async def log(
        self,
        event_id: uuid.UUID | None,
        action: str,
        *,
        resource_type: str = "event",
        **kwargs,
    ) -> AuditLog:
        """감사 로그 기록 (write_audit_log 대체 가능).

        하위 호환: event_id, action 위치 인자 유지.
        AuditEntryModel 필드 매핑:
          user_id → actor_id
          details → new_value
          ip_hash → ip_address
        """
        # AuditEntryModel 호환 필드 매핑
        if "user_id" in kwargs:
            kwargs.setdefault("actor_id", kwargs.pop("user_id"))
        if "details" in kwargs:
            kwargs.setdefault("new_value", kwargs.pop("details"))
        if "ip_hash" in kwargs:
            kwargs.setdefault("ip_address", kwargs.pop("ip_hash"))
        if "admin_id" in kwargs:
            kwargs.setdefault("actor_id", kwargs.pop("admin_id"))
        # result 필드를 new_value dict에 포함
        result_val = kwargs.pop("result", None)
        if result_val and isinstance(kwargs.get("new_value"), dict):
            kwargs["new_value"]["result"] = result_val

        entry = AuditLog(
            event_id=event_id,
            action=action,
            resource_type=resource_type,
            resource_id=str(event_id) if event_id else None,
            **kwargs,
        )
        self.session.add(entry)
        await self.session.flush()
        return entry

    async def get_by_event(
        self, event_id: uuid.UUID, skip: int = 0, limit: int = 100
    ) -> list[AuditLog]:
        result = await self.session.execute(
            select(AuditLog)
            .where(AuditLog.event_id == event_id)
            .order_by(AuditLog.created_at.desc())
            .offset(skip)
            .limit(limit)
        )
        return list(result.scalars().all())

    async def count_by_event(self, event_id: uuid.UUID) -> int:
        result = await self.session.execute(
            select(func.count(AuditLog.id)).where(AuditLog.event_id == event_id)
        )
        return result.scalar() or 0
