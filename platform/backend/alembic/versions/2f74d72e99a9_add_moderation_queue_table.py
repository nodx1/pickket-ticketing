"""add moderation_queue table

Revision ID: 2f74d72e99a9
Revises: a3b4c5d6e7f8
Create Date: 2026-04-03
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, ENUM as PG_ENUM

# revision identifiers, used by Alembic.
revision = "2f74d72e99a9"
down_revision = "a3b4c5d6e7f8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Create enums — use PG_ENUM with create_type=False to prevent
    # DuplicateObject error when the type already exists.
    moderation_content_type_enum = PG_ENUM(
        "review", "comment", "message",
        name="moderation_content_type_enum",
        create_type=False,
    )
    moderation_status_enum = PG_ENUM(
        "pending", "approved", "rejected",
        name="moderation_status_enum",
        create_type=False,
    )
    op.execute("DO $$ BEGIN CREATE TYPE moderation_content_type_enum AS ENUM ('review','comment','message'); EXCEPTION WHEN duplicate_object THEN NULL; END $$")
    op.execute("DO $$ BEGIN CREATE TYPE moderation_status_enum AS ENUM ('pending','approved','rejected'); EXCEPTION WHEN duplicate_object THEN NULL; END $$")

    op.create_table(
        "moderation_queue",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "content_type",
            moderation_content_type_enum,
            nullable=False,
            index=True,
        ),
        sa.Column("content_id", UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("content_text", sa.Text(), nullable=False),
        sa.Column("author_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False, index=True),
        sa.Column("flag_reason", sa.Text(), nullable=False),
        sa.Column("flag_confidence", sa.Float(), nullable=False, server_default="0.0"),
        sa.Column("flag_action", sa.String(10), nullable=False, server_default="flag"),
        sa.Column(
            "status",
            moderation_status_enum,
            nullable=False,
            server_default="pending",
            index=True,
        ),
        sa.Column("reviewer_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("reviewer_note", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_table("moderation_queue")
    op.execute("DROP TYPE IF EXISTS moderation_status_enum")
    op.execute("DROP TYPE IF EXISTS moderation_content_type_enum")
