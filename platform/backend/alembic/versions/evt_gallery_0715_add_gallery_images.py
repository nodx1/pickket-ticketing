"""events.gallery_images 갤러리(최대 4장) 컬럼 추가

go가 이벤트 생성/패치 시 내부 커머스 API로 gallery_images 배열을 전송한다.
각 원소: {url: str, variants: {wide,portrait,thumb,og}|null}. 최대 4장.
소비자는 이 배열로 캐러셀을 렌더한다(마스터/렌디션은 기존 image_url/image_variants).

Revision ID: evt_gallery_0715
Revises: evt_img_variants_0715
Create Date: 2026-07-15
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "evt_gallery_0715"
down_revision = "evt_img_variants_0715"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"
    json_type = postgresql.JSONB() if is_pg else sa.JSON()
    op.add_column("events", sa.Column("gallery_images", json_type, nullable=True))


def downgrade() -> None:
    op.drop_column("events", "gallery_images")
