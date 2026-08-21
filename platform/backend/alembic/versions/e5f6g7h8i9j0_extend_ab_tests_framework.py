"""extend ab_tests with full experiment framework (P1-10)

Revision ID: e5f6g7h8i9j0
Revises: d4e5f6g7h8i0
Create Date: 2026-04-03
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "e5f6g7h8i9j0"
down_revision: Union[str, Sequence[str], None] = "d4e5f6g7h8i0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── Extend ab_tests table with new columns ──
    op.add_column(
        "ab_tests",
        sa.Column("description", sa.String(1000), nullable=True),
    )
    op.add_column(
        "ab_tests",
        sa.Column(
            "status",
            sa.String(20),
            server_default="DRAFT",
            nullable=False,
        ),
    )
    op.add_column(
        "ab_tests",
        sa.Column("target_audience", postgresql.JSON(), nullable=True),
    )
    op.add_column(
        "ab_tests",
        sa.Column("metric_key", sa.String(200), nullable=True),
    )
    op.add_column(
        "ab_tests",
        sa.Column("start_date", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "ab_tests",
        sa.Column("end_date", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "ab_tests",
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    # Make event_page_id nullable (new tests may not be page-scoped)
    op.alter_column(
        "ab_tests",
        "event_page_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=True,
    )

    # Add unique constraint on name
    op.create_unique_constraint("uq_ab_tests_name", "ab_tests", ["name"])

    # ── ABTestAssignment table ──
    op.create_table(
        "ab_test_assignments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "test_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ab_tests.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("variant_name", sa.String(200), nullable=False),
        sa.Column(
            "assigned_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("test_id", "user_id", name="uq_ab_assignment_test_user"),
    )
    op.create_index(
        "ix_ab_test_assignments_test_id", "ab_test_assignments", ["test_id"]
    )
    op.create_index(
        "ix_ab_test_assignments_user_id", "ab_test_assignments", ["user_id"]
    )

    # ── ABTestEvent table ──
    op.create_table(
        "ab_test_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "test_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("ab_tests.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("variant_name", sa.String(200), nullable=False),
        sa.Column("event_type", sa.String(100), nullable=False),
        sa.Column("value", sa.Float(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_ab_test_events_test_id", "ab_test_events", ["test_id"]
    )
    op.create_index(
        "ix_ab_test_events_user_id", "ab_test_events", ["user_id"]
    )
    op.create_index(
        "ix_ab_test_events_event_type", "ab_test_events", ["event_type"]
    )


def downgrade() -> None:
    op.drop_index("ix_ab_test_events_event_type", table_name="ab_test_events")
    op.drop_index("ix_ab_test_events_user_id", table_name="ab_test_events")
    op.drop_index("ix_ab_test_events_test_id", table_name="ab_test_events")
    op.drop_table("ab_test_events")

    op.drop_index("ix_ab_test_assignments_user_id", table_name="ab_test_assignments")
    op.drop_index("ix_ab_test_assignments_test_id", table_name="ab_test_assignments")
    op.drop_table("ab_test_assignments")

    op.drop_constraint("uq_ab_tests_name", "ab_tests", type_="unique")

    op.alter_column(
        "ab_tests",
        "event_page_id",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=False,
    )

    op.drop_column("ab_tests", "created_by")
    op.drop_column("ab_tests", "end_date")
    op.drop_column("ab_tests", "start_date")
    op.drop_column("ab_tests", "metric_key")
    op.drop_column("ab_tests", "target_audience")
    op.drop_column("ab_tests", "status")
    op.drop_column("ab_tests", "description")
