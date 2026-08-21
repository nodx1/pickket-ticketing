"""[go타워 W3.4 감사 🟠] sold_count 트리거 정정 — USED/TRANSFERRED 오감소 차단

버그: trg_sync_sold_count 가 active/pending 이탈이면 **무조건 −1**.
W3.1 체크인(→USED)이 매번 sold_count −1 → USED 는 자리 점유인데 sold 에서 빠짐.
→ GA(capacity−sold_count) 오버셀 + 리포트 판매수가 체크인하며 줄어듦. 빅뱅 전 필수.

정정: "점유(occupies inventory)" = status NOT IN ('cancelled','expired').
  USED·TRANSFERRED·active·pending 전부 sold 카운트. cancelled/expired 만 −1.
  (SQLite 수동 경로는 이미 cancelled/expired 에서만 차감 — 일관.)

PG-only(테스트 SQLite 는 트리거 없음).

Revision ID: gowt_e_0602
Revises: gowt_d_0602
Create Date: 2026-06-02
"""
from alembic import op


revision = "gowt_e_0602"
down_revision = "gowt_d_0602"
branch_labels = None
depends_on = None


_FIXED = """
    CREATE OR REPLACE FUNCTION trg_sync_sold_count()
    RETURNS TRIGGER AS $$
    DECLARE
        old_occupies boolean;
        new_occupies boolean;
    BEGIN
        IF TG_OP = 'INSERT' THEN
            IF NEW.status NOT IN ('cancelled', 'expired') THEN
                UPDATE seat_tiers SET sold_count = sold_count + 1 WHERE id = NEW.tier_id;
            END IF;
            RETURN NEW;
        ELSIF TG_OP = 'UPDATE' THEN
            old_occupies := OLD.status NOT IN ('cancelled', 'expired');
            new_occupies := NEW.status NOT IN ('cancelled', 'expired');
            IF old_occupies AND NOT new_occupies THEN
                UPDATE seat_tiers SET sold_count = GREATEST(0, sold_count - 1) WHERE id = NEW.tier_id;
            ELSIF new_occupies AND NOT old_occupies THEN
                UPDATE seat_tiers SET sold_count = sold_count + 1 WHERE id = NEW.tier_id;
            END IF;
            RETURN NEW;
        END IF;
        RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
"""

_OLD = """
    CREATE OR REPLACE FUNCTION trg_sync_sold_count()
    RETURNS TRIGGER AS $$
    BEGIN
        IF TG_OP = 'INSERT' THEN
            IF NEW.status IN ('active', 'pending') THEN
                UPDATE seat_tiers SET sold_count = sold_count + 1 WHERE id = NEW.tier_id;
            END IF;
            RETURN NEW;
        ELSIF TG_OP = 'UPDATE' THEN
            IF OLD.status IN ('active', 'pending')
               AND NEW.status NOT IN ('active', 'pending') THEN
                UPDATE seat_tiers SET sold_count = GREATEST(0, sold_count - 1) WHERE id = NEW.tier_id;
            ELSIF OLD.status NOT IN ('active', 'pending')
               AND NEW.status IN ('active', 'pending') THEN
                UPDATE seat_tiers SET sold_count = sold_count + 1 WHERE id = NEW.tier_id;
            END IF;
            RETURN NEW;
        END IF;
        RETURN NULL;
    END;
    $$ LANGUAGE plpgsql;
"""


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    op.execute(_FIXED)


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    op.execute(_OLD)
