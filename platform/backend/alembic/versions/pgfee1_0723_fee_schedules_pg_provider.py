"""멀티PG 정합 (3) — fee_schedules.pg_provider 축 가산 추가

메인 세션(feat/nicepay)과의 공유 스키마 조율:
현재 fee_schedules.pg_fee_rate/pg_fee_fixed 는 provider 축이 없는 단일값 →
토스·나이스 PG 요율 차이가 정산에 반영 안 됨(compute_fees 가 provider 미인지).

이 마이그는 fee_schedules 에 pg_provider(nullable) 컬럼을 가산한다.
  - pg_provider IS NULL  = provider 무관 기본 요율(현행 하위호환 — 모든 provider 에 적용)
  - pg_provider = 'nicepay'|'toss'|... = 그 provider 전용 요율 오버라이드(pg_fee_rate/fixed)

compute_fees(provider) 소비 규칙(계약):
  같은 (organizer_id/event_id, effective 구간) 내에서
    ORDER BY (pg_provider = :provider) DESC NULLS LAST  → provider 매치행 우선, 없으면 NULL 기본행.
  platform_fee_rate 는 어느 행이든 동일(운영규칙), pg_fee_rate/fixed 만 provider 별로 갈린다.
주문 확정 시 order.pg_provider 로 compute_fees(order.pg_provider) → orders.pg_fee_rate/pg_fee 동결(불변).

⚠️ 폴백 없음(대표 결정 2026-07-23): provider 는 주문별 확정값 하나(나이스 스위치, 토스 dormant).
가산적(additive)·비파괴 — nullable, server_default 없음. 기존 행은 NULL(기본 요율)로 안전.
컬럼 존재 가드로 재실행 안전. dev_v3 정본 squash 시 흡수(§6.4).

Revision ID: pgfee1_0723
Revises: map1_seatmap_0722
"""

import sqlalchemy as sa
from alembic import op

revision = "pgfee1_0723"
down_revision = "map1_seatmap_0722"
branch_labels = None
depends_on = None

# 정규화 provider 코드(공유 계약) — get_payment_gateway(provider) 키와 동일.
# portone 제외(대표 결정 2026-07-23): 현재 토스+나이스만. 추후 필요 시 CHECK 확장 마이그로 추가.
_PG_PROVIDERS = ("toss", "nicepay")


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = {c["name"] for c in insp.get_columns("fee_schedules")}
    if "pg_provider" not in existing:
        op.add_column(
            "fee_schedules",
            sa.Column("pg_provider", sa.String(length=20), nullable=True),
        )
    # provider 매치 조회 인덱스(event/organizer + provider) — compute_fees 핫패스.
    idx_names = {i["name"] for i in insp.get_indexes("fee_schedules")}
    if "idx_fee_schedule_pg_provider" not in idx_names:
        op.create_index(
            "idx_fee_schedule_pg_provider",
            "fee_schedules",
            ["event_id", "organizer_id", "pg_provider"],
        )
    # 값 도메인 가드(NULL 허용 + 정규화 코드) — CHECK.
    ck_names = {c["name"] for c in insp.get_check_constraints("fee_schedules")}
    if "ck_fee_schedules_pg_provider_valid" not in ck_names:
        providers_sql = ", ".join(f"'{p}'" for p in _PG_PROVIDERS)
        op.create_check_constraint(
            "ck_fee_schedules_pg_provider_valid",
            "fee_schedules",
            f"pg_provider IS NULL OR pg_provider IN ({providers_sql})",
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    ck_names = {c["name"] for c in insp.get_check_constraints("fee_schedules")}
    if "ck_fee_schedules_pg_provider_valid" in ck_names:
        op.drop_constraint("ck_fee_schedules_pg_provider_valid", "fee_schedules", type_="check")
    idx_names = {i["name"] for i in insp.get_indexes("fee_schedules")}
    if "idx_fee_schedule_pg_provider" in idx_names:
        op.drop_index("idx_fee_schedule_pg_provider", table_name="fee_schedules")
    existing = {c["name"] for c in insp.get_columns("fee_schedules")}
    if "pg_provider" in existing:
        op.drop_column("fee_schedules", "pg_provider")
