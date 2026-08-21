"""update ck_events_status to include review workflow statuses

Revision ID: f9e8d7c6b5a4
Revises: a8b9c0d1e2f3, ab01cd02ef03
Create Date: 2026-03-30 08:50:00.000000

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "f9e8d7c6b5a4"
down_revision: Union[str, None] = "ab01cd02ef03"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


OLD_VALUES = (
    "'draft','bidding_open','bidding_closed','allocating',"
    "'allocated','completed','cancelled'"
)

NEW_VALUES = (
    "'draft','bidding_open','bidding_closed','allocating',"
    "'allocated','completed','cancelled',"
    "'pending_review','under_review','revision_requested','approved'"
)


def upgrade() -> None:
    op.drop_constraint("ck_events_status", "events", type_="check")
    op.create_check_constraint(
        "ck_events_status",
        "events",
        f"lower(status::text) IN ({NEW_VALUES})",
    )


def downgrade() -> None:
    op.drop_constraint("ck_events_status", "events", type_="check")
    op.create_check_constraint(
        "ck_events_status",
        "events",
        f"lower(status::text) IN ({OLD_VALUES})",
    )
