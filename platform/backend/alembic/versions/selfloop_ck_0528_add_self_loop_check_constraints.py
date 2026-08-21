"""§36 P1: Add self-loop CHECK constraints to prevent self-referencing rows.

- friendships: user_id <> friend_id
- follows: follower_id <> following_id
- ownership_transfers: from_user_id <> to_user_id

Revision ID: selfloop_ck_0528
Revises: transfer_sec_0528
Create Date: 2026-05-28
"""
from alembic import op

revision = "selfloop_ck_0528"
down_revision = "transfer_sec_0528"
branch_labels = None
depends_on = None

_CHECK_CONSTRAINTS = [
    ("ck_friendship_no_self_loop", "friendships", "user_id <> friend_id"),
    ("ck_follows_no_self_loop", "follows", "follower_id <> following_id"),
    ("ck_ownership_transfers_no_self_loop", "ownership_transfers", "from_user_id <> to_user_id"),
]


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    for name, table, condition in _CHECK_CONSTRAINTS:
        op.execute(
            f"""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = '{name}'
                      AND conrelid = '{table}'::regclass
                ) THEN
                    ALTER TABLE {table}
                        ADD CONSTRAINT {name} CHECK ({condition}) NOT VALID;
                    ALTER TABLE {table} VALIDATE CONSTRAINT {name};
                END IF;
            END$$;
            """
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    for name, table, _ in reversed(_CHECK_CONSTRAINTS):
        op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {name}")
