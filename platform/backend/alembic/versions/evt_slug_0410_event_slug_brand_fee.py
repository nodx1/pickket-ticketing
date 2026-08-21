"""add event slug, brand colors, service_fee_rate for DICE+Laylo absorption

Revision ID: evt_slug_0410
Revises: wh_del_0409
Create Date: 2026-04-10

Related:
- DICE+Laylo DNA 흡수 프로젝트 v0.3 (Track A, A1+A4)
- /e/<slug> 실데이터 연결 + All-In Pricing 완결

Adds four columns to `events`:

- `slug` VARCHAR(80) UNIQUE NOT NULL — canonical `/e/<slug>` identifier.
  Backfilled from existing titles via slugify + short uuid.

- `brand_color` VARCHAR(9) — organizer accent (#RRGGBB or #RRGGBBAA).
  NULL falls back to Pickket default (#FF3366).

- `brand_color_fg` VARCHAR(9) — foreground pair for brand_color.
  NULL falls back to white.

- `service_fee_rate` NUMERIC(5,4) — All-In Pricing (P1) 단일 소스.
  Defaults to 0.11 (11%).

Note: `ticket_open_at`은 기존 `desired_open_date` 컬럼을 재사용.
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers
revision = "evt_slug_0410"
down_revision = "wh_del_0409"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Add columns as nullable first so backfill can run.
    op.add_column(
        "events",
        sa.Column("slug", sa.String(length=80), nullable=True),
    )
    op.add_column(
        "events",
        sa.Column("brand_color", sa.String(length=9), nullable=True),
    )
    op.add_column(
        "events",
        sa.Column("brand_color_fg", sa.String(length=9), nullable=True),
    )
    op.add_column(
        "events",
        sa.Column(
            "service_fee_rate",
            sa.Numeric(precision=5, scale=4),
            nullable=False,
            server_default=sa.text("0.1100"),
        ),
    )

    # 2. Backfill slug for existing rows.
    #    lower(slugify(title)) trimmed to 60 chars + '-' + first 8 chars of id.
    op.execute(
        """
        UPDATE events
        SET slug = LOWER(
            SUBSTRING(
                regexp_replace(
                    COALESCE(NULLIF(trim(title), ''), 'event'),
                    '[^a-zA-Z0-9가-힣]+',
                    '-',
                    'g'
                ),
                1, 60
            )
        ) || '-' || SUBSTRING(id::text, 1, 8)
        WHERE slug IS NULL
        """
    )

    # 3. Trim leading/trailing hyphens.
    op.execute(
        """
        UPDATE events
        SET slug = regexp_replace(slug, '(^-+|-+$)', '', 'g')
        WHERE slug LIKE '-%' OR slug LIKE '%-'
        """
    )

    # 4. Enforce NOT NULL + UNIQUE.
    op.alter_column("events", "slug", nullable=False)
    op.create_unique_constraint("uq_events_slug", "events", ["slug"])
    op.create_index("idx_events_slug", "events", ["slug"])


def downgrade() -> None:
    op.drop_index("idx_events_slug", table_name="events")
    op.drop_constraint("uq_events_slug", "events", type_="unique")
    op.drop_column("events", "service_fee_rate")
    op.drop_column("events", "brand_color_fg")
    op.drop_column("events", "brand_color")
    op.drop_column("events", "slug")
