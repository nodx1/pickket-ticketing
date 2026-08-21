"""add program_notes and stage_info to events

Revision ID: d4e5f6g7h8i9
Revises: c3d4e5f6g7h8
Create Date: 2026-03-02
"""
from alembic import op
import sqlalchemy as sa

revision = "d4e5f6g7h8i9"
down_revision = "c3d4e5f6g7h8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("events", sa.Column("program_notes", sa.Text(), nullable=True))
    op.add_column("events", sa.Column("stage_info", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("events", "stage_info")
    op.drop_column("events", "program_notes")
