from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.audit_log import AuditLog
from app.tests.conftest import TestSession


@pytest.mark.asyncio
async def test_prune_audit_logs_deletes_only_expired_rows(client, monkeypatch):
    from app.tasks.audit_retention import _prune_audit_logs

    monkeypatch.setattr("app.tasks.audit_retention.async_session", TestSession)

    old_retention = settings.AUDIT_LOG_RETENTION_DAYS
    settings.AUDIT_LOG_RETENTION_DAYS = 30

    try:
        old_log = AuditLog(
            action="test.old",
            resource_type="test",
            created_at=datetime.now(timezone.utc) - timedelta(days=45),
        )
        fresh_log = AuditLog(
            action="test.fresh",
            resource_type="test",
            created_at=datetime.now(timezone.utc) - timedelta(days=5),
        )

        async with TestSession() as session:
            session.add_all([old_log, fresh_log])
            await session.commit()

        result = await _prune_audit_logs()
        assert result["deleted"] >= 1

        async with TestSession() as session:
            rows = (
                await session.execute(
                    select(AuditLog).where(AuditLog.action.in_(["test.old", "test.fresh"]))
                )
            ).scalars().all()

        actions = {row.action for row in rows}
        assert "test.old" not in actions
        assert "test.fresh" in actions
    finally:
        settings.AUDIT_LOG_RETENTION_DAYS = old_retention
