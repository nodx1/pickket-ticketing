"""events.image_variants 렌디션 맵 컬럼 추가

go가 이벤트 생성/패치 시 내부 커머스 API로 image_variants 맵을 전송한다.
키: wide(16:9)/portrait(3:4)/thumb(4:3)/og(1200x630) → 각 절대 이미지 URL.
마스터 이미지는 기존 image_url이며 소비자는 variants[key] 없으면 image_url로 폴백.

Revision ID: evt_img_variants_0715
Revises: rtf_0611
Create Date: 2026-07-15
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "evt_img_variants_0715"
down_revision = "rtf_0611"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"
    json_type = postgresql.JSONB() if is_pg else sa.JSON()
    op.add_column("events", sa.Column("image_variants", json_type, nullable=True))


def downgrade() -> None:
    op.drop_column("events", "image_variants")
