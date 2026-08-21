"""운영 작업보드 ops_tasks + ops_task_comments — 사람·AI 공용 SSOT (OPS_ORCHESTRATION_PLAN §3)

Revision ID: ops_board_0718
Revises: evt_gallery_0715
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "ops_board_0718"
down_revision = "evt_gallery_0715"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "ops_tasks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="backlog"),
        sa.Column("label", sa.String(20), nullable=False, server_default="ops"),
        sa.Column("priority", sa.String(10), nullable=False, server_default="medium"),
        sa.Column("assignee", sa.String(100), nullable=True),
        sa.Column("created_by", sa.String(100), nullable=False),
        sa.Column("source", sa.String(50), nullable=False, server_default="manual"),
        sa.Column("links", postgresql.JSONB(), nullable=True),
        sa.Column("due_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
        sa.CheckConstraint(
            "status IN ('backlog','in_progress','review','blocked','done')", name="ck_ops_tasks_status"
        ),
        sa.CheckConstraint(
            "label IN ('frontend','backend','security','cs','sales','ops','bug','feature')",
            name="ck_ops_tasks_label",
        ),
        sa.CheckConstraint(
            "priority IN ('critical','high','medium','low')", name="ck_ops_tasks_priority"
        ),
    )
    op.create_index("ix_ops_tasks_status", "ops_tasks", ["status"])
    op.create_index("ix_ops_tasks_label", "ops_tasks", ["label"])
    op.create_index("ix_ops_tasks_assignee", "ops_tasks", ["assignee"])
    op.create_index("ix_ops_tasks_status_priority", "ops_tasks", ["status", "priority"])
    op.create_index("ix_ops_tasks_due", "ops_tasks", ["due_at"])

    op.create_table(
        "ops_task_comments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "task_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ops_tasks.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("author", sa.String(100), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("NOW()")),
    )
    op.create_index("ix_ops_task_comments_task", "ops_task_comments", ["task_id"])


def downgrade() -> None:
    op.drop_table("ops_task_comments")
    op.drop_table("ops_tasks")
