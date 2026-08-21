"""merge level2 branches: seat_map_templates + organizer_messaging

레벨2(go DB 완전제거) 영역 A(seatmpl_0724)·C(orgmsg_0724)가 각각
unify8_0723 위에서 분기 생성 → 두 head를 병합해 레벨2 단일 head로 잇는다.
스키마 변경 없음(순수 merge).

Revision ID: lvl2mrg_0724
Revises: seatmpl_0724, orgmsg_0724
Create Date: 2026-07-24
"""
from alembic import op  # noqa: F401
import sqlalchemy as sa  # noqa: F401


revision = "lvl2mrg_0724"
down_revision = ("seatmpl_0724", "orgmsg_0724")
branch_labels = None
depends_on = None


def upgrade() -> None:
    pass


def downgrade() -> None:
    pass
