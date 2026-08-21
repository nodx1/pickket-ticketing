"""update events with uppercase status values to lowercase

Revision ID: fix_eventstatus_data_0407
Revises: norm_eventstatus_0407
Create Date: 2026-04-07

The enum type has both uppercase and lowercase labels.
Data may reference uppercase labels. This migration updates
all event rows to use the lowercase label equivalents.
"""
from alembic import op

# revision identifiers, used by Alembic.
revision = "fix_eventstatus_data_0407"
down_revision = "norm_eventstatus_0407"
branch_labels = None
depends_on = None

_MAPPING = [
    ("DRAFT", "draft"),
    ("PENDING_REVIEW", "pending_review"),
    ("UNDER_REVIEW", "under_review"),
    ("REVISION_REQUESTED", "revision_requested"),
    ("APPROVED", "approved"),
    ("BIDDING_OPEN", "bidding_open"),
    ("BIDDING_CLOSED", "bidding_closed"),
    ("ALLOCATING", "allocating"),
    ("ALLOCATED", "allocated"),
    ("COMPLETED", "completed"),
    ("CANCELLED", "cancelled"),
]


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    for old_val, new_val in _MAPPING:
        # Update data to use lowercase enum label
        op.execute(
            f"UPDATE events SET status = '{new_val}' "
            f"WHERE status::text = '{old_val}'"
        )


def downgrade() -> None:
    pass
