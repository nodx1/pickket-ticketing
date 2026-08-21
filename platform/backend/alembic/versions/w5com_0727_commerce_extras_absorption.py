"""W5-COMMERCE: go 상거래 부가기능 흡수 (레벨2 컷오버 wave5)

go DB 완전 제거를 위해 아래 go-local 테이블을 v2 로 옮긴다. **기능은 하나도 폐기하지 않는다**
(대표 결정 2026-07-27) — 동적 가격·환불정책까지 전부 v2 에 자리를 만든다.

| go 테이블 | v2 | 이 마이그레이션 |
|---|---|---|
| `group_bookings`       | `group_bookings`        | 신설 |
| `refund_policies`      | `event_refund_policies` | 신설 (+ go 에 없던 write 경로 신설) |
| `pricing_rules`        | `tier_pricing_rules`    | 신설 |
| `price_history`        | `tier_price_history`    | 신설 |
| `promo_codes`          | `discount_codes`        | `deleted_at` 가산 |
| `product_bundle_items` | `seat_tiers.bundle_items` | 없음(이미 존재 — W2-PS) |

prod 는 전면 초기화 예정이라 **백필하지 않는다**(최종형). 전부 가산적(IF NOT EXISTS)이라
재실행 안전하다.

## `discount_codes.deleted_at` 이 왜 필요한가
go 는 프로모코드 삭제를 "go 행 DELETE + v2 는 is_active=false 로 보존"으로 처리했다.
정본이 v2 하나가 되면 하드 DELETE 밖에 남지 않는데, 그러면 그 코드로 발생한 주문의
사용량(used_count) 근거가 사라진다. 소프트 삭제로 원장을 보존하면서 목록에서만 감춘다.

Revision ID: w5com_0727
Revises: w2_mrg_0727
"""

from alembic import op

revision = "w5com_0727"
down_revision = "w2_mrg_0727"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── 1) 단체예약 ──────────────────────────────────────────────────────────
    # product_ref / order_ref 는 go 식별자(= external_ref)라 FK 를 걸지 않는다.
    # 티어가 재생성되거나 go 주문 앵커가 정리돼도 신청 이력이 파괴되면 안 된다.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS group_bookings (
            id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            event_id          UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            product_ref       VARCHAR(100) NOT NULL,
            order_ref         VARCHAR(100),
            order_number      VARCHAR(64),
            organization_name VARCHAR(200) NOT NULL,
            contact_name      VARCHAR(100) NOT NULL,
            contact_email     VARCHAR(255) NOT NULL,
            contact_phone     VARCHAR(40),
            attendee_count    INTEGER NOT NULL,
            discount_rate     NUMERIC(12,2) NOT NULL DEFAULT 0,
            notes             TEXT,
            rejection_reason  TEXT,
            approved_by_ref   VARCHAR(100),
            approved_at       TIMESTAMPTZ,
            status            VARCHAR(20) NOT NULL DEFAULT 'pending',
            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT ck_group_bookings_attendee_min CHECK (attendee_count >= 2),
            CONSTRAINT ck_group_bookings_discount_rate CHECK (discount_rate >= 0 AND discount_rate <= 100),
            CONSTRAINT ck_group_bookings_status CHECK (status IN ('pending', 'confirmed', 'cancelled'))
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_group_bookings_event ON group_bookings (event_id, created_at)"
    )

    # ── 2) 환불 정책 ─────────────────────────────────────────────────────────
    # 이벤트당 1건. go 는 다건에서 `ORDER BY created_at DESC LIMIT 1` 로 골랐는데,
    # 금액 산정 입력이 "어느 행이 유효한지 모르는 상태"인 건 위험하다 → UNIQUE 로 고정.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS event_refund_policies (
            id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            event_id    UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
            title       VARCHAR(200) NOT NULL,
            description TEXT,
            refund_type VARCHAR(20) NOT NULL DEFAULT 'partial',
            rules       JSONB NOT NULL DEFAULT '[]'::jsonb,
            created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_event_refund_policies_event UNIQUE (event_id),
            CONSTRAINT ck_event_refund_policies_type CHECK (refund_type IN ('full', 'partial'))
        )
        """
    )

    # ── 3) 동적 가격 규칙 + 가격 이력 ────────────────────────────────────────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS tier_pricing_rules (
            id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tier_id    UUID NOT NULL REFERENCES seat_tiers(id) ON DELETE CASCADE,
            rule_type  VARCHAR(30) NOT NULL,
            config     JSONB NOT NULL DEFAULT '{}'::jsonb,
            priority   INTEGER NOT NULL DEFAULT 0,
            is_active  BOOLEAN NOT NULL DEFAULT TRUE,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT ck_tier_pricing_rules_type
                CHECK (rule_type IN ('demand', 'time', 'inventory', 'surge'))
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_tier_pricing_rules_tier ON tier_pricing_rules (tier_id, priority)"
    )
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS tier_price_history (
            id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            tier_id    UUID NOT NULL REFERENCES seat_tiers(id) ON DELETE CASCADE,
            old_price  NUMERIC(12,2) NOT NULL,
            new_price  NUMERIC(12,2) NOT NULL,
            rule_id    UUID REFERENCES tier_pricing_rules(id) ON DELETE SET NULL,
            reason     TEXT,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_tier_price_history_tier ON tier_price_history (tier_id, applied_at)"
    )

    # ── 4) 프로모코드 소프트 삭제 ────────────────────────────────────────────
    op.execute("ALTER TABLE discount_codes ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ")


def downgrade() -> None:
    op.execute("ALTER TABLE discount_codes DROP COLUMN IF EXISTS deleted_at")
    op.execute("DROP TABLE IF EXISTS tier_price_history")
    op.execute("DROP TABLE IF EXISTS tier_pricing_rules")
    op.execute("DROP TABLE IF EXISTS event_refund_policies")
    op.execute("DROP TABLE IF EXISTS group_bookings")
