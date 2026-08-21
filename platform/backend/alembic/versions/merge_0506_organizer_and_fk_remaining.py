"""Merge organizer_fields_0506 + c185eb510d0e into single head.

Revision ID: merge_0506_organizer_fk
Revises: c185eb510d0e, organizer_fields_0506
Create Date: 2026-05-06
"""
from alembic import op  # noqa: F401
import sqlalchemy as sa  # noqa: F401


revision = "merge_0506_organizer_fk"
down_revision = ("c185eb510d0e", "organizer_fields_0506")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
