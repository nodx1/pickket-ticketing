"""운영 작업보드(ops_tasks) — 사람(admin UI)과 AI 에이전트(서비스토큰 API)가 공유하는 SSOT.

설계: docs/OPS_ORCHESTRATION_PLAN.md §3. assignee/created_by 는 "user:<이름>" 또는
"agent:<에이전트명>" 문자열 — 사람·AI 를 한 보드에서 구분 추적한다.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import String, DateTime, ForeignKey, Text, JSON, Index
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")

OPS_TASK_STATUSES = ("backlog", "in_progress", "review", "blocked", "done")
OPS_TASK_LABELS = ("frontend", "backend", "security", "cs", "sales", "ops", "bug", "feature")
OPS_TASK_PRIORITIES = ("critical", "high", "medium", "low")


class OpsTask(Base):
    __tablename__ = "ops_tasks"
    __table_args__ = (
        Index("ix_ops_tasks_status_priority", "status", "priority"),
        Index("ix_ops_tasks_due", "due_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    body: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="backlog", index=True)
    label: Mapped[str] = mapped_column(String(20), nullable=False, default="ops", index=True)
    priority: Mapped[str] = mapped_column(String(10), nullable=False, default="medium")
    # "user:<이름>" | "agent:<이름>" — FK 아님(에이전트는 users 에 없음).
    assignee: Mapped[str | None] = mapped_column(String(100), nullable=True, index=True)
    created_by: Mapped[str] = mapped_column(String(100), nullable=False)
    source: Mapped[str] = mapped_column(String(50), nullable=False, default="manual")
    links: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    due_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class OpsTaskComment(Base):
    __tablename__ = "ops_task_comments"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    task_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("ops_tasks.id", ondelete="CASCADE"), nullable=False, index=True
    )
    author: Mapped[str] = mapped_column(String(100), nullable=False)  # user:/agent:
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )
