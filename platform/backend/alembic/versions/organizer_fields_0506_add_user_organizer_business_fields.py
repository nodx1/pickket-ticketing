"""Add organizer-business fields to users (BFF integration with go).

Revision ID: organizer_fields_0506
Revises: 136c71056299
Create Date: 2026-05-06
"""
from alembic import op
import sqlalchemy as sa


revision = "organizer_fields_0506"
down_revision = "136c71056299"
branch_labels = None
depends_on = None


_NEW_COLUMNS = (
    ("business_name", sa.String(200)),
    ("business_registration_number", sa.String(512)),  # encrypted
    ("business_representative", sa.String(100)),
    ("business_phone", sa.String(50)),
    ("settlement_bank", sa.String(50)),
    ("settlement_account_holder", sa.String(100)),
    ("settlement_account_number", sa.String(512)),  # encrypted
    ("go_organizer_id", sa.String(100)),
)


def upgrade() -> None:
    with op.batch_alter_table("users") as batch_op:
        for name, col_type in _NEW_COLUMNS:
            batch_op.add_column(sa.Column(name, col_type, nullable=True))
    op.create_index(
        "ix_users_go_organizer_id", "users", ["go_organizer_id"], unique=False
    )


def downgrade() -> None:
    op.drop_index("ix_users_go_organizer_id", table_name="users")
    with op.batch_alter_table("users") as batch_op:
        for name, _ in _NEW_COLUMNS:
            batch_op.drop_column(name)
