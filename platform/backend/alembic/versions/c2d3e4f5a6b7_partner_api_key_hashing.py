"""partner api key hashing — store bcrypt hash + prefix

Revision ID: c2d3e4f5a6b7
Revises: ba7a28ec6a39
Create Date: 2026-03-09 13:00:00.000000

"""
from typing import Sequence, Union

import bcrypt
from alembic import context, op
import sqlalchemy as sa
from sqlalchemy import text

# revision identifiers, used by Alembic.
revision: str = "c2d3e4f5a6b7"
down_revision: Union[str, Sequence[str], None] = "ba7a28ec6a39"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # 1. Add new columns (nullable temporarily for data migration)
    op.add_column("partners", sa.Column("api_key_prefix", sa.String(16), nullable=True))
    op.add_column("partners", sa.Column("api_key_hash", sa.String(128), nullable=True))

    if context.is_offline_mode():
        op.execute("ALTER TABLE partners DROP CONSTRAINT IF EXISTS partners_api_key_key")
        op.drop_column("partners", "api_key")
        op.alter_column("partners", "api_key_prefix", nullable=False)
        op.alter_column("partners", "api_key_hash", nullable=False)
        op.create_index("ix_partners_api_key_prefix", "partners", ["api_key_prefix"])
        return

    # 2. Data migration: populate prefix and hash from existing plaintext api_key
    conn = op.get_bind()
    partners = conn.execute(text("SELECT id, api_key FROM partners")).fetchall()
    for partner_id, api_key in partners:
        if api_key:
            prefix = api_key[:16]
            hashed = bcrypt.hashpw(api_key.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
            conn.execute(
                text(
                    "UPDATE partners SET api_key_prefix = :prefix, api_key_hash = :hash "
                    "WHERE id = :id"
                ),
                {"prefix": prefix, "hash": hashed, "id": partner_id},
            )

    # 3. Drop the old plaintext api_key column (find unique constraint name dynamically)
    inspector = sa.inspect(conn)
    for uq in inspector.get_unique_constraints("partners"):
        if "api_key" in uq["column_names"]:
            op.drop_constraint(uq["name"], "partners", type_="unique")
            break
    op.drop_column("partners", "api_key")

    # 4. Make new columns NOT NULL
    op.alter_column("partners", "api_key_prefix", nullable=False)
    op.alter_column("partners", "api_key_hash", nullable=False)

    # 5. Add index on prefix for efficient lookup
    op.create_index("ix_partners_api_key_prefix", "partners", ["api_key_prefix"])


def downgrade() -> None:
    # Reverse: recreate api_key column, cannot restore original values
    op.drop_index("ix_partners_api_key_prefix", table_name="partners")
    op.add_column(
        "partners",
        sa.Column("api_key", sa.String(64), nullable=True),
    )
    # Populate api_key with a new random value for each partner (originals are lost)
    conn = op.get_bind()
    import secrets

    partners = conn.execute(text("SELECT id FROM partners")).fetchall()
    for (partner_id,) in partners:
        new_key = secrets.token_hex(32)
        conn.execute(
            text("UPDATE partners SET api_key = :key WHERE id = :id"),
            {"key": new_key, "id": partner_id},
        )
    op.alter_column("partners", "api_key", nullable=False)
    op.create_unique_constraint("uq_partners_api_key", "partners", ["api_key"])

    op.drop_column("partners", "api_key_hash")
    op.drop_column("partners", "api_key_prefix")
