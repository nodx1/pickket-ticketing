"""add image_assets table

Revision ID: 550dacce513f
Revises: p1q2r3s4t5u6
Create Date: 2026-03-09 11:01:41.728927

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "550dacce513f"
down_revision: Union[str, Sequence[str], None] = "p1q2r3s4t5u6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "image_assets",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("uploader_id", sa.UUID(), nullable=False),
        sa.Column("original_key", sa.String(length=500), nullable=False),
        sa.Column("original_url", sa.String(length=500), nullable=False),
        sa.Column("content_type", sa.String(length=50), nullable=False),
        sa.Column("file_size", sa.Integer(), nullable=False),
        sa.Column("width", sa.Integer(), nullable=True),
        sa.Column("height", sa.Integer(), nullable=True),
        sa.Column("variants", sa.Text(), nullable=True),
        sa.Column("blurhash", sa.String(length=100), nullable=True),
        sa.Column("upload_type", sa.String(length=20), nullable=False),
        sa.Column("entity_type", sa.String(length=50), nullable=True),
        sa.Column("entity_id", sa.UUID(), nullable=True),
        sa.Column("processing_status", sa.String(length=20), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.ForeignKeyConstraint(["uploader_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("original_key"),
    )
    op.create_index(op.f("ix_image_assets_entity_id"), "image_assets", ["entity_id"], unique=False)
    op.create_index(
        op.f("ix_image_assets_upload_type"),
        "image_assets",
        ["upload_type"],
        unique=False,
    )
    op.create_index(
        op.f("ix_image_assets_uploader_id"),
        "image_assets",
        ["uploader_id"],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_image_assets_uploader_id"), table_name="image_assets")
    op.drop_index(op.f("ix_image_assets_upload_type"), table_name="image_assets")
    op.drop_index(op.f("ix_image_assets_entity_id"), table_name="image_assets")
    op.drop_table("image_assets")
