"""[실서버 전 H3] read/inventory 핫패스 인덱스

감사 H3: 입장·재고 피크 풀스캔 제거.
- seats.hold_id (partial): hold confirm/release/reaper 의 hold_id 조회.
- seats(status, held_until): reaper 만료 hold 회수 범위.
- tickets(event_id, checked_in_at): 대시보드 체크인수 집계.

Revision ID: gowt_f_0602
Revises: gowt_e_0602
Create Date: 2026-06-02
"""
from alembic import op
import sqlalchemy as sa


revision = "gowt_f_0602"
down_revision = "gowt_e_0602"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.create_index(
            "ix_seats_hold_id", "seats", ["hold_id"],
            postgresql_where=sa.text("hold_id IS NOT NULL"),
        )
    else:
        op.create_index("ix_seats_hold_id", "seats", ["hold_id"])
    op.create_index("ix_seats_status_held_until", "seats", ["status", "held_until"])
    op.create_index("ix_tickets_event_checked_in", "tickets", ["event_id", "checked_in_at"])


def downgrade() -> None:
    op.drop_index("ix_tickets_event_checked_in", table_name="tickets")
    op.drop_index("ix_seats_status_held_until", table_name="seats")
    op.drop_index("ix_seats_hold_id", table_name="seats")
