"""encrypt user pii columns

Revision ID: r4s5t6u7v8w9
Revises: p2a9b0c1d2e3
Create Date: 2026-04-04 09:30:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "r4s5t6u7v8w9"
down_revision: Union[str, Sequence[str], None] = "p2a9b0c1d2e3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.alter_column(
            "users",
            "phone",
            existing_type=sa.String(length=20),
            type_=sa.String(length=512),
            existing_nullable=True,
            postgresql_using="phone::varchar(512)",
        )
        op.alter_column(
            "users",
            "date_of_birth",
            existing_type=sa.Date(),
            type_=sa.String(length=512),
            existing_nullable=True,
            postgresql_using="date_of_birth::text",
        )
    else:  # pragma: no cover - SQLite compatibility path
        with op.batch_alter_table("users") as batch_op:
            batch_op.alter_column(
                "phone",
                existing_type=sa.String(length=20),
                type_=sa.String(length=512),
                existing_nullable=True,
            )
            batch_op.alter_column(
                "date_of_birth",
                existing_type=sa.Date(),
                type_=sa.String(length=512),
                existing_nullable=True,
            )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.alter_column(
            "users",
            "date_of_birth",
            existing_type=sa.String(length=512),
            type_=sa.Date(),
            existing_nullable=True,
            postgresql_using="""
            CASE
                WHEN date_of_birth IS NULL OR date_of_birth = '' THEN NULL
                WHEN date_of_birth LIKE 'enc::%' THEN NULL
                ELSE date_of_birth::date
            END
            """,
        )
        op.alter_column(
            "users",
            "phone",
            existing_type=sa.String(length=512),
            type_=sa.String(length=20),
            existing_nullable=True,
            postgresql_using="left(phone, 20)",
        )
    else:  # pragma: no cover - SQLite compatibility path
        with op.batch_alter_table("users") as batch_op:
            batch_op.alter_column(
                "date_of_birth",
                existing_type=sa.String(length=512),
                type_=sa.Date(),
                existing_nullable=True,
            )
            batch_op.alter_column(
                "phone",
                existing_type=sa.String(length=512),
                type_=sa.String(length=20),
                existing_nullable=True,
            )
