"""Add event category CHECK and partial QR hash index.

Revision ID: db_integrity_0528
Revises: audit_p1_0528
Create Date: 2026-05-28 00:00:00.000000
"""

import sqlalchemy as sa
from alembic import context, op


revision = "db_integrity_0528"
down_revision = "audit_p1_0528"
branch_labels = None
depends_on = None


CATEGORY_CONSTRAINT = "ck_events_category_valid"
# v2 SSOT category set — MUST include `classical` and `esports` (live domain
# per CLAUDE.md + present in real data) plus the newer `education`/`civic`.
# The original list dropped classical/esports, so this VALIDATE could never
# pass on any DB holding those rows. Keep in sync with event.py CHECK and
# category_ssot_0531.
CATEGORY_EXPR = (
    "category IN ('concert','musical','sports','classical','exhibition',"
    "'festival','esports','education','civic')"
)
# Legacy value -> v2 SSOT (run BEFORE validating so old rows don't trip the CHECK).
CATEGORY_FORWARD_MAP = {
    "theater": "concert",
    "fan_meeting": "concert",
    "conference": "education",
    "other": "civic",
}
QR_INDEX = "uq_tickets_qr_code_hash"


def _constraint_exists(bind, table: str, name: str) -> bool:
    result = bind.execute(
        sa.text(
            "SELECT 1 FROM information_schema.table_constraints "
            "WHERE table_name = :table AND constraint_name = :name"
        ),
        {"table": table, "name": name},
    )
    return result.scalar() is not None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    op.execute(f"ALTER TABLE tickets DROP CONSTRAINT IF EXISTS {QR_INDEX}")
    op.execute(f"DROP INDEX IF EXISTS {QR_INDEX}")

    # Map legacy category values to the v2 SSOT set BEFORE validating the CHECK,
    # so historical rows (theater/fan_meeting/conference/other) don't fail VALIDATE.
    # No silent 'civic' catch-all — an unexpected value should fail loudly here
    # rather than corrupt data.
    for _legacy, _target in CATEGORY_FORWARD_MAP.items():
        op.execute(
            sa.text("UPDATE events SET category = :t WHERE category = :l").bindparams(
                t=_target, l=_legacy
            )
        )

    if context.is_offline_mode():
        op.execute(
            f"DO $$ BEGIN "
            f"ALTER TABLE events ADD CONSTRAINT {CATEGORY_CONSTRAINT} "
            f"CHECK ({CATEGORY_EXPR}) NOT VALID; "
            f"EXCEPTION WHEN duplicate_object THEN NULL; "
            f"END $$"
        )
        op.execute(f"ALTER TABLE events VALIDATE CONSTRAINT {CATEGORY_CONSTRAINT}")
    elif not _constraint_exists(bind, "events", CATEGORY_CONSTRAINT):
        op.execute(
            f"ALTER TABLE events ADD CONSTRAINT {CATEGORY_CONSTRAINT} "
            f"CHECK ({CATEGORY_EXPR}) NOT VALID"
        )
        op.execute(f"ALTER TABLE events VALIDATE CONSTRAINT {CATEGORY_CONSTRAINT}")

    op.execute(
        f"CREATE UNIQUE INDEX IF NOT EXISTS {QR_INDEX} "
        "ON tickets (qr_code_hash) "
        "WHERE qr_code_hash IS NOT NULL"
    )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    op.execute(f"DROP INDEX IF EXISTS {QR_INDEX}")
    op.execute(f"ALTER TABLE events DROP CONSTRAINT IF EXISTS {CATEGORY_CONSTRAINT}")
    op.execute(
        f"DO $$ BEGIN "
        f"ALTER TABLE tickets ADD CONSTRAINT {QR_INDEX} UNIQUE (qr_code_hash); "
        f"EXCEPTION WHEN duplicate_object THEN NULL; "
        f"END $$"
    )
