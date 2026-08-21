"""[go write-through Slice B] SeatTier.external_ref + Seat.external_ref

SPEC §1.6 — external_ref 매핑을 tier/seat 으로 확장(Event 는 gowt_a 에서 완료).
go productId↔v2 tier_id, go seatId↔v2 seat_id 매핑 + write-through 멱등 upsert.

Revision ID: gowt_b_0602
Revises: gowt_a_0601
Create Date: 2026-06-02
"""
from alembic import op
import sqlalchemy as sa


revision = "gowt_b_0602"
down_revision = "gowt_a_0601"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("seat_tiers", sa.Column("external_ref", sa.String(100), nullable=True))
    op.create_index("ix_seat_tiers_external_ref", "seat_tiers", ["external_ref"], unique=True)
    op.add_column("seats", sa.Column("external_ref", sa.String(100), nullable=True))
    op.create_index("ix_seats_external_ref", "seats", ["external_ref"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_seats_external_ref", table_name="seats")
    op.drop_column("seats", "external_ref")
    op.drop_index("ix_seat_tiers_external_ref", table_name="seat_tiers")
    op.drop_column("seat_tiers", "external_ref")
