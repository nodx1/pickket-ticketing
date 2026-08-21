"""fix cascade delete on financial/audit foreign keys

Change ondelete from CASCADE to RESTRICT on user_id FKs for:
billing_keys, point_wallets, point_transactions,
attendance_records, attendance_streaks, delegation_tokens

Revision ID: fk01cascade01
Revises: c3d4e5f6g7h8
Create Date: 2026-04-05
"""
from alembic import op

# revision identifiers, used by Alembic.
revision = "fk01cascade01"
down_revision = "sa2p3p4sec02"
branch_labels = None
depends_on = None

# (table_name, constraint_name)
_FK_TARGETS = [
    ("billing_keys", "billing_keys_user_id_fkey"),
    ("point_wallets", "point_wallets_user_id_fkey"),
    ("point_transactions", "point_transactions_user_id_fkey"),
    ("attendance_records", "attendance_records_user_id_fkey"),
    ("attendance_streaks", "attendance_streaks_user_id_fkey"),
    ("delegation_tokens", "delegation_tokens_user_id_fkey"),
]


def upgrade() -> None:
    for table, fk_name in _FK_TARGETS:
        op.drop_constraint(fk_name, table, type_="foreignkey")
        op.create_foreign_key(
            fk_name, table, "users", ["user_id"], ["id"], ondelete="RESTRICT"
        )


def downgrade() -> None:
    for table, fk_name in _FK_TARGETS:
        op.drop_constraint(fk_name, table, type_="foreignkey")
        op.create_foreign_key(
            fk_name, table, "users", ["user_id"], ["id"], ondelete="CASCADE"
        )
