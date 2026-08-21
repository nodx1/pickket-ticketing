"""normalize eventstatus enum labels to lowercase

Revision ID: norm_eventstatus_0407
Revises: sec_pwd_hist_0407a
Create Date: 2026-04-07
"""
from alembic import op

# revision identifiers, used by Alembic.
revision = "norm_eventstatus_0407"
down_revision = "sec_pwd_hist_0407a"
branch_labels = None
depends_on = None

# All uppercase enum labels that need lowercase normalization
_RENAMES = [
    ("eventstatus", "DRAFT", "draft"),
    ("eventstatus", "PENDING_REVIEW", "pending_review"),
    ("eventstatus", "UNDER_REVIEW", "under_review"),
    ("eventstatus", "REVISION_REQUESTED", "revision_requested"),
    ("eventstatus", "APPROVED", "approved"),
    ("eventstatus", "BIDDING_OPEN", "bidding_open"),
    ("eventstatus", "BIDDING_CLOSED", "bidding_closed"),
    ("eventstatus", "ALLOCATING", "allocating"),
    ("eventstatus", "ALLOCATED", "allocated"),
    ("eventstatus", "COMPLETED", "completed"),
    ("eventstatus", "CANCELLED", "cancelled"),
]


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    for type_name, old_label, new_label in _RENAMES:
        op.execute(f"""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM pg_type t
                    JOIN pg_enum e ON e.enumtypid = t.oid
                    WHERE t.typname = '{type_name}' AND e.enumlabel = '{old_label}'
                ) AND NOT EXISTS (
                    SELECT 1 FROM pg_type t
                    JOIN pg_enum e ON e.enumtypid = t.oid
                    WHERE t.typname = '{type_name}' AND e.enumlabel = '{new_label}'
                ) THEN
                    ALTER TYPE {type_name} RENAME VALUE '{old_label}' TO '{new_label}';
                END IF;
            END
            $$;
        """)


def downgrade() -> None:
    # PostgreSQL enum value rename is safe to keep on downgrade
    pass
