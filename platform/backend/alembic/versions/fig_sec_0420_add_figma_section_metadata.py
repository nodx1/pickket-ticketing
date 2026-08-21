"""add figma layout metadata columns to venue_sections

Revision ID: fig_sec_0420
Revises: badge_seed_0416
Create Date: 2026-04-20

피그마 빌더에서 그린 섹션의 위치/회전/종류/크기를 그대로 소비자 화면에
재현하기 위해 venue_sections에 kind/rotation/width/height 컬럼을 추가한다.
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "fig_sec_0420"
down_revision = "badge_seed_0416"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "venue_sections",
        sa.Column(
            "kind",
            sa.String(length=20),
            nullable=False,
            server_default="assigned",
        ),
    )
    op.add_column(
        "venue_sections",
        sa.Column("rotation", sa.Float(), nullable=False, server_default="0"),
    )
    op.add_column(
        "venue_sections",
        sa.Column("width", sa.Float(), nullable=True),
    )
    op.add_column(
        "venue_sections",
        sa.Column("height", sa.Float(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("venue_sections", "height")
    op.drop_column("venue_sections", "width")
    op.drop_column("venue_sections", "rotation")
    op.drop_column("venue_sections", "kind")
