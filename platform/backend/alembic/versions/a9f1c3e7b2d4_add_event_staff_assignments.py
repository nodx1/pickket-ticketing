"""add event staff assignments table

Revision ID: a9f1c3e7b2d4
Revises: c7d8e9f0a1b2
Create Date: 2026-02-22 21:05:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "a9f1c3e7b2d4"
down_revision: Union[str, Sequence[str], None] = "c7d8e9f0a1b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    role_enum = postgresql.ENUM("checkin", "supervisor", name="eventstaffrole", create_type=False)
    role_enum.create(op.get_bind(), checkfirst=True)

    op.create_table(
        "event_staff_assignments",
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("event_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "role",
            role_enum,
            nullable=False,
            server_default="checkin",
        ),
        sa.Column(
            "is_active",
            sa.Boolean(),
            nullable=False,
            server_default=sa.true(),
        ),
        sa.Column("created_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.ForeignKeyConstraint(["event_id"], ["events.id"]),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("event_id", "user_id", name="uq_event_staff_assignment"),
    )
    op.create_index(
        "idx_event_staff_event_active",
        "event_staff_assignments",
        ["event_id", "is_active"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("idx_event_staff_event_active", table_name="event_staff_assignments")
    op.drop_table("event_staff_assignments")
    role_enum = postgresql.ENUM("checkin", "supervisor", name="eventstaffrole", create_type=False)
    role_enum.drop(op.get_bind(), checkfirst=True)
