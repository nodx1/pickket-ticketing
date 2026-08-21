"""레벨2 W5-CONTENT — go 콘텐츠·표시 계열 6테이블 v2 흡수

go DB 완전 제거 컷오버. 아래 6개를 v2 정본으로 신설한다(기능 폐기 아님 — 전부 이관).

  go widget_configs      → organizer_widget_configs
  go ticket_designs      → organizer_ticket_designs
  go bridge_pages        → organizer_bridge_pages       (v2 기존 `bridge_pages` 와 **다른 개념**)
  go open_notices        → organizer_open_notices       (v2 기존 `open_notices` 와 **다른 개념**)
  go event_facilities    → organizer_event_facilities   (v2 `event_facilities` 는 소비자 투영)
  go event_participants  → organizer_event_participants (v2 `event_participants` 는 소비자 투영)

## 왜 `organizer_` 접두사인가
v2 에는 이미 같은 이름의 테이블이 4개 있는데 전부 다른 개념이다. 재사용하면
소비자 노출 투영에 미발행 공지·숨김 출연진·거래처 단가가 섞여 들어간다(모델 파일 주석 참조).
정본은 여기, 투영은 `event_participants`/`event_announcements`/`event_facilities` 로 분리한다.

## 데이터 이관 없음
2026-07-27 대표 결정으로 prod 를 전면 초기화한다 → 백필·기존 행 호환 폴백을 넣지 않는다.
스키마만 최종형으로 만든다.

가산적·비파괴. 테이블 존재 가드로 재실행 안전(부분 실패 후 재적용 가능).

Revision ID: w5cnt_0727
Revises: w2_mrg_0727
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "w5cnt_0727"
down_revision = "w2_mrg_0727"
branch_labels = None
depends_on = None


_TABLES = (
    "organizer_event_participants",
    "organizer_open_notices",
    "organizer_event_facilities",
    "organizer_widget_configs",
    "organizer_ticket_designs",
    "organizer_bridge_pages",
)


def _ts_columns() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                  server_default=sa.text("now()")),
    ]


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = set(insp.get_table_names())

    if "organizer_event_participants" not in existing:
        op.create_table(
            "organizer_event_participants",
            sa.Column("id", UUID(as_uuid=True), primary_key=True,
                      server_default=sa.text("gen_random_uuid()")),
            sa.Column("event_id", UUID(as_uuid=True),
                      sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False),
            sa.Column("name", sa.String(length=200), nullable=False),
            sa.Column("role", sa.String(length=50), nullable=False,
                      server_default=sa.text("'performer'")),
            sa.Column("bio", sa.Text(), nullable=True),
            sa.Column("image_url", sa.String(length=2000), nullable=True),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default=sa.text("0")),
            # 숨김 출연진도 정본에는 남는다. 소비자 투영에는 is_visible=true 만 복사된다.
            sa.Column("is_visible", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            sa.Column("social_links", JSONB(), nullable=True),
            *_ts_columns(),
        )
        op.create_index(
            "idx_org_event_participants_event_sort",
            "organizer_event_participants", ["event_id", "sort_order"],
        )

    if "organizer_open_notices" not in existing:
        op.create_table(
            "organizer_open_notices",
            sa.Column("id", UUID(as_uuid=True), primary_key=True,
                      server_default=sa.text("gen_random_uuid()")),
            sa.Column("event_id", UUID(as_uuid=True),
                      sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False),
            sa.Column("notice_type", sa.String(length=50), nullable=False,
                      server_default=sa.text("'general'")),
            sa.Column("title", sa.String(length=300), nullable=False),
            sa.Column("content", sa.Text(), nullable=False),
            # 미발행 초안도 정본에는 남는다. 소비자 투영에는 is_published=true 만 복사된다.
            sa.Column("is_published", sa.Boolean(), nullable=False,
                      server_default=sa.text("false")),
            sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
            *_ts_columns(),
        )
        op.create_index(
            "idx_org_open_notices_event_published",
            "organizer_open_notices", ["event_id", "is_published"],
        )

    if "organizer_event_facilities" not in existing:
        op.create_table(
            "organizer_event_facilities",
            sa.Column("id", UUID(as_uuid=True), primary_key=True,
                      server_default=sa.text("gen_random_uuid()")),
            sa.Column("event_id", UUID(as_uuid=True),
                      sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False),
            sa.Column("name", sa.String(length=200), nullable=False),
            sa.Column("category", sa.String(length=50), nullable=False,
                      server_default=sa.text("'general'")),
            sa.Column("quantity", sa.Integer(), nullable=False, server_default=sa.text("1")),
            sa.Column("status", sa.String(length=50), nullable=False,
                      server_default=sa.text("'planned'")),
            # vendor/cost/notes 는 내부 전용 — 소비자 투영에 복사하지 않는다(거래처 단가 노출 금지).
            sa.Column("vendor", sa.String(length=200), nullable=True),
            sa.Column("cost", sa.BigInteger(), nullable=False, server_default=sa.text("0")),
            sa.Column("notes", sa.Text(), nullable=True),
            *_ts_columns(),
        )
        op.create_index(
            "idx_org_event_facilities_event", "organizer_event_facilities", ["event_id"],
        )

    if "organizer_widget_configs" not in existing:
        op.create_table(
            "organizer_widget_configs",
            sa.Column("id", UUID(as_uuid=True), primary_key=True,
                      server_default=sa.text("gen_random_uuid()")),
            sa.Column("event_id", UUID(as_uuid=True),
                      sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False,
                      unique=True),
            sa.Column("mode", sa.String(length=20), nullable=False,
                      server_default=sa.text("'button'")),
            sa.Column("theme", JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
            # go 는 text[] 였다. JSONB 배열로 통일한다 — 순서·중복에 의미가 없어 손실 없음.
            sa.Column("allowed_domains", JSONB(), nullable=False,
                      server_default=sa.text("'[]'::jsonb")),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("true")),
            *_ts_columns(),
        )

    if "organizer_ticket_designs" not in existing:
        op.create_table(
            "organizer_ticket_designs",
            sa.Column("id", UUID(as_uuid=True), primary_key=True,
                      server_default=sa.text("gen_random_uuid()")),
            sa.Column("event_id", UUID(as_uuid=True),
                      sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False,
                      unique=True),
            sa.Column("name", sa.String(length=200), nullable=False,
                      server_default=sa.text("'기본 티켓 디자인'")),
            sa.Column("status", sa.String(length=20), nullable=False,
                      server_default=sa.text("'draft'")),
            sa.Column("canvas_json", JSONB(), nullable=False,
                      server_default=sa.text("'{}'::jsonb")),
            sa.Column("preview_image_url", sa.String(length=2000), nullable=True),
            *_ts_columns(),
        )

    if "organizer_bridge_pages" not in existing:
        op.create_table(
            "organizer_bridge_pages",
            sa.Column("id", UUID(as_uuid=True), primary_key=True,
                      server_default=sa.text("gen_random_uuid()")),
            sa.Column("event_id", UUID(as_uuid=True),
                      sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False,
                      unique=True),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.text("false")),
            sa.Column("title", sa.String(length=300), nullable=False, server_default=sa.text("''")),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("countdown_target", sa.DateTime(timezone=True), nullable=True),
            sa.Column("background_color", sa.String(length=20), nullable=False,
                      server_default=sa.text("'#6C5CE7'")),
            sa.Column("logo_url", sa.String(length=2000), nullable=True),
            sa.Column("custom_css", sa.Text(), nullable=True),
            *_ts_columns(),
        )


def downgrade() -> None:
    for table in reversed(_TABLES):
        op.execute(sa.text(f"DROP TABLE IF EXISTS {table} CASCADE"))
