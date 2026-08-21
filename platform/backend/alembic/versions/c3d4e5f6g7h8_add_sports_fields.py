"""add sports fields to events

Revision ID: c3d4e5f6g7h8
Revises: a1b2c3d4e5f6
Create Date: 2026-03-02

"""
from alembic import op
import sqlalchemy as sa

revision = "c3d4e5f6g7h8"
down_revision = "d1e2f3a4b5c6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("events", sa.Column("home_team", sa.String(200), nullable=True))
    op.add_column("events", sa.Column("away_team", sa.String(200), nullable=True))
    op.add_column("events", sa.Column("match_status", sa.String(20), nullable=True))
    op.add_column("events", sa.Column("broadcast_url", sa.String(500), nullable=True))
    op.add_column("events", sa.Column("broadcast_platform", sa.String(100), nullable=True))
    op.add_column("events", sa.Column("parking_info", sa.Text(), nullable=True))


def downgrade() -> None:
    op.drop_column("events", "parking_info")
    op.drop_column("events", "broadcast_platform")
    op.drop_column("events", "broadcast_url")
    op.drop_column("events", "match_status")
    op.drop_column("events", "away_team")
    op.drop_column("events", "home_team")
