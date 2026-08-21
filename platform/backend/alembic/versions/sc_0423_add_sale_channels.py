"""add sale_channels column to events

Revision ID: sc_0423_add_sale_channels
Revises: vs_uniq_0422
Create Date: 2026-04-23

sale_channels: go에서 주최자가 설정한 판매 채널 목록.
기본값 ['self'] — 주최자 단독 판매 페이지만.
marketplace 토글 on 시 ['self', 'marketplace'] — v2 consumer 에도 노출.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "sc_0423_add_sale_channels"
down_revision = "8aaab60dee34"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # sale_channels: text[] — 기본 {self, marketplace}.
    # 기존 이벤트는 v2 consumer 에 계속 노출되게 하고, go가 events/sync 시 명시적으로
    # saleChannels 넣어야 축소 (['self'] 만 지정하면 consumer 숨김).
    op.add_column(
        "events",
        sa.Column(
            "sale_channels",
            postgresql.ARRAY(sa.Text()),
            server_default="{self,marketplace}",
            nullable=False,
        ),
    )
    # 기존 이벤트에 명시적 backfill (server_default 는 새 insert 에만 적용되는 경우 대비)
    op.execute(
        "UPDATE events SET sale_channels = ARRAY['self','marketplace'] "
        "WHERE sale_channels IS NULL OR sale_channels = '{}'::text[]"
    )
    # marketplace 노출 이벤트 lookup 용 GIN 인덱스
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_events_sale_channels_gin "
        "ON events USING GIN (sale_channels)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_events_sale_channels_gin")
    op.drop_column("events", "sale_channels")
