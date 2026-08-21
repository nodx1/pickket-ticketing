"""F4 경품번호 + 추첨 — events.raffle_enabled + tickets.raffle_number
+ event_raffle_counters + raffle_draws

가산적(additive) 마이그레이션. F1(f1_admission_0721) 뒤 단일 head.
- events.raffle_enabled (bool, 기본 false) — 기존 이벤트 발권 동작 불변.
- tickets.raffle_number (int, nullable) + UNIQUE(event_id, raffle_number) WHERE not null.
- event_raffle_counters (event_id PK, last_number) — 이벤트별 번호 시퀀스(동시성 안전).
- raffle_draws — 추첨 실행 원장(seed·당첨번호·시각·실행자·풀크기, 감사가능).

Revision ID: f4_raffle_0721
Revises: f1_admission_0721
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "f4_raffle_0721"
down_revision = "f1_admission_0721"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # --- events.raffle_enabled (기본 false) ---
    event_cols = {c["name"] for c in insp.get_columns("events")}
    if "raffle_enabled" not in event_cols:
        op.add_column(
            "events",
            sa.Column(
                "raffle_enabled",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            ),
        )

    # --- tickets.raffle_number + 이벤트 스코프 부분 UNIQUE ---
    ticket_cols = {c["name"] for c in insp.get_columns("tickets")}
    if "raffle_number" not in ticket_cols:
        op.add_column("tickets", sa.Column("raffle_number", sa.Integer(), nullable=True))
    ticket_idx = {i["name"] for i in insp.get_indexes("tickets")}
    if "uq_tickets_event_raffle_number" not in ticket_idx:
        op.create_index(
            "uq_tickets_event_raffle_number",
            "tickets",
            ["event_id", "raffle_number"],
            unique=True,
            postgresql_where=sa.text("raffle_number IS NOT NULL"),
        )

    # --- event_raffle_counters (이벤트별 번호 시퀀스 카운터) ---
    if not insp.has_table("event_raffle_counters"):
        op.create_table(
            "event_raffle_counters",
            sa.Column(
                "event_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("events.id", ondelete="CASCADE"),
                primary_key=True,
            ),
            sa.Column("last_number", sa.Integer(), nullable=False, server_default=sa.text("0")),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.text("NOW()"),
            ),
        )

    # --- raffle_draws (추첨 실행 원장) ---
    if not insp.has_table("raffle_draws"):
        op.create_table(
            "raffle_draws",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "event_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("events.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("draw_key", sa.String(128), nullable=True),
            sa.Column("seed", sa.String(256), nullable=False),
            sa.Column("winner_count", sa.Integer(), nullable=False),
            sa.Column("pool_size", sa.Integer(), nullable=False),
            sa.Column("winning_numbers", postgresql.JSONB(), nullable=False),
            sa.Column("executed_by", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("executed_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("event_id", "draw_key", name="uq_raffle_draws_event_key"),
        )
        op.create_index("ix_raffle_draws_event", "raffle_draws", ["event_id"])


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if insp.has_table("raffle_draws"):
        raffle_idx = {i["name"] for i in insp.get_indexes("raffle_draws")}
        if "ix_raffle_draws_event" in raffle_idx:
            op.drop_index("ix_raffle_draws_event", table_name="raffle_draws")
        op.drop_table("raffle_draws")

    if insp.has_table("event_raffle_counters"):
        op.drop_table("event_raffle_counters")

    ticket_idx = {i["name"] for i in insp.get_indexes("tickets")}
    if "uq_tickets_event_raffle_number" in ticket_idx:
        op.drop_index("uq_tickets_event_raffle_number", table_name="tickets")
    ticket_cols = {c["name"] for c in insp.get_columns("tickets")}
    if "raffle_number" in ticket_cols:
        op.drop_column("tickets", "raffle_number")

    event_cols = {c["name"] for c in insp.get_columns("events")}
    if "raffle_enabled" in event_cols:
        op.drop_column("events", "raffle_enabled")
