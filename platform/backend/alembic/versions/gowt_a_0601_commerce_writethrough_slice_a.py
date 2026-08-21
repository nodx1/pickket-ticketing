"""[go write-through Slice A] FeeSchedule 정액(fixed) fee + Event.external_ref

P0 SPEC §2.7 — go fee 구조({fee_type, fee_percentage, fee_fixed}, go migration 072,
기본 3%+₩300 percentage_plus_fixed) 미러를 위해 fee_schedules에:
  - fee_type        (percentage | fixed | percentage_plus_fixed)
  - platform_fee_fixed (정액, Numeric(12,2))
  - pg_fee_fixed       (정액, Numeric(12,2))
를 추가. 기존은 rate-only 라 ₩300 정액 유실 → 청구(rate만)≠정산 어긋남.
이제 정률+정액 동결(order.platform_fee 절대금액)로 청구=정산 자동 정합.

P0 SPEC §1.6 — Event.external_ref: go event id ↔ v2 canonical id 매핑.
write-through 멱등 upsert(중복 create 방지) + go 양방향 매핑 보관.

Revision ID: gowt_a_0601
Revises: dom_enum_0601
Create Date: 2026-06-01
"""
from alembic import op
import sqlalchemy as sa


revision = "gowt_a_0601"
down_revision = "dom_enum_0601"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # fee_schedules: 정액 fee 컬럼 (server_default 로 기존 행 안전 백필 = percentage/0)
    op.add_column(
        "fee_schedules",
        sa.Column("fee_type", sa.String(30), nullable=False, server_default="percentage"),
    )
    op.add_column(
        "fee_schedules",
        sa.Column(
            "platform_fee_fixed", sa.Numeric(12, 2), nullable=False, server_default="0"
        ),
    )
    op.add_column(
        "fee_schedules",
        sa.Column("pg_fee_fixed", sa.Numeric(12, 2), nullable=False, server_default="0"),
    )
    op.create_check_constraint(
        "ck_fee_schedules_fee_type_valid",
        "fee_schedules",
        "fee_type IN ('percentage', 'fixed', 'percentage_plus_fixed')",
    )

    # events: go id 매핑 (NULL 다중 허용 — 기존 v2-네이티브 이벤트는 external_ref 없음)
    op.add_column("events", sa.Column("external_ref", sa.String(100), nullable=True))
    op.create_index(
        "ix_events_external_ref", "events", ["external_ref"], unique=True
    )


def downgrade() -> None:
    op.drop_index("ix_events_external_ref", table_name="events")
    op.drop_column("events", "external_ref")
    op.drop_constraint("ck_fee_schedules_fee_type_valid", "fee_schedules", type_="check")
    op.drop_column("fee_schedules", "pg_fee_fixed")
    op.drop_column("fee_schedules", "platform_fee_fixed")
    op.drop_column("fee_schedules", "fee_type")
