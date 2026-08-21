"""add unique constraint on venue_sections(venue_id, name)

Revision ID: vs_uniq_0422
Revises: fig_sec_0420
Create Date: 2026-04-22

seats/sync와 grid-layout/sync가 동시에 실행되던 시절 race condition으로
같은 (venue_id, name) 조합의 중복 행이 생성되던 버그 재발 방지.
"""

from __future__ import annotations

from alembic import op


revision = "vs_uniq_0422"
down_revision = "fig_sec_0420"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 기존 중복 정리: 같은 (venue_id, name) 중 width 가 NULL 인 stale 행 제거
    op.execute(
        """
        DELETE FROM venue_sections a
        USING venue_sections b
        WHERE a.venue_id = b.venue_id
          AND a.name = b.name
          AND a.id <> b.id
          AND (a.width IS NULL AND b.width IS NOT NULL)
        """
    )
    # 그래도 남아있는 중복은 더 오래된 id 만 남기고 삭제 (결정적 기준)
    op.execute(
        """
        DELETE FROM venue_sections a
        USING venue_sections b
        WHERE a.venue_id = b.venue_id
          AND a.name = b.name
          AND a.id > b.id
        """
    )
    op.create_unique_constraint(
        "uq_venue_sections_venue_name",
        "venue_sections",
        ["venue_id", "name"],
    )


def downgrade() -> None:
    op.drop_constraint(
        "uq_venue_sections_venue_name", "venue_sections", type_="unique"
    )
