"""Level2 T2-ORD: absorb go-only commerce columns (orders/attendees/products).

Revision ID: ctord_0727
Revises: lvl2wh_0725
Create Date: 2026-07-27

go DB 완전 제거(레벨2 컷오버 T2-ORD)의 선행 스키마 확장. **가산적 전용** —
기존 컬럼/제약 변경 없음, 전부 nullable 또는 default 보유 → 무중단.

흡수 대상(go → v2):
  * attendees.ticket_number  → tickets.ticket_number
      🔴 소비자 티켓 URL 키(`/tickets/[n]`·QR·PDF·Apple/Google 지갑 진입점).
      v2 는 `tickets.id`(UUID)로 키잉해 **키 체계가 달랐다**. go 제거 시 이미 발급된
      티켓의 URL 이 전부 깨지므로, go 가 생성하던 사람이 읽는 티켓번호를 v2 가 보관한다.
      전역 유니크(go `attendees.ticket_number TEXT NOT NULL UNIQUE` 동등) — 단 NULL 허용
      (v2-네이티브 발권분은 아직 번호가 없을 수 있음) → partial unique index.
  * attendees.answers        → tickets.answers      (예매 설문 응답 JSONB)
  * orders.memo / fraud_score / fraud_flags / source → orders 동명 컬럼
  * products 메타 전체       → seat_tiers
      v2 tier 는 name/capacity/base_price/sale_mode/sale_window 만 가지고 있어
      상품 설명·세금·이미지·정렬·구매수량 제한·번들이 go 제거 시 소실된다.
      sale_window 는 기존 bidding_opens_at/bidding_closes_at 재사용(신규 컬럼 없음).
"""

from alembic import op


revision = "ctord_0727"
down_revision = "lvl2wh_0725"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── tickets: 티켓번호(소비자 URL 키) + 예매 설문 응답 ──────────────────────
    op.execute("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS ticket_number VARCHAR(64)")
    op.execute("ALTER TABLE tickets ADD COLUMN IF NOT EXISTS answers JSONB")
    # 전역 유니크(go 동등). NULL 다수 허용해야 하므로 partial unique.
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_tickets_ticket_number "
        "ON tickets(ticket_number) WHERE ticket_number IS NOT NULL"
    )

    # ── orders: 주문 워크플로 메모 · 사기탐지 · 유입경로 ────────────────────────
    op.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS memo TEXT")
    # go 원형(`fraud_score INT DEFAULT 0`, `fraud_flags JSONB DEFAULT '[]'`)과 동일하게 nullable.
    op.execute("ALTER TABLE orders ADD COLUMN IF NOT EXISTS fraud_score INTEGER DEFAULT 0")
    op.execute(
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS fraud_flags JSONB DEFAULT '[]'::jsonb"
    )
    op.execute(
        "ALTER TABLE orders ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'direct'"
    )

    # ── seat_tiers: go products 메타 흡수 ─────────────────────────────────────
    op.execute("ALTER TABLE seat_tiers ADD COLUMN IF NOT EXISTS description TEXT")
    op.execute(
        "ALTER TABLE seat_tiers ADD COLUMN IF NOT EXISTS product_type VARCHAR(20) "
        "NOT NULL DEFAULT 'ticket'"
    )
    op.execute(
        "ALTER TABLE seat_tiers ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) "
        "NOT NULL DEFAULT 'public'"
    )
    # 원 단위 정수 퍼센트(go products.tax_rate INTEGER DEFAULT 10 동등).
    op.execute(
        "ALTER TABLE seat_tiers ADD COLUMN IF NOT EXISTS tax_rate INTEGER NOT NULL DEFAULT 10"
    )
    op.execute(
        "ALTER TABLE seat_tiers ADD COLUMN IF NOT EXISTS tax_included BOOLEAN NOT NULL DEFAULT TRUE"
    )
    op.execute("ALTER TABLE seat_tiers ADD COLUMN IF NOT EXISTS image_url VARCHAR(500)")
    op.execute(
        "ALTER TABLE seat_tiers ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0"
    )
    op.execute(
        "ALTER TABLE seat_tiers ADD COLUMN IF NOT EXISTS min_per_order INTEGER NOT NULL DEFAULT 1"
    )
    op.execute("ALTER TABLE seat_tiers ADD COLUMN IF NOT EXISTS max_per_order INTEGER")
    op.execute(
        "ALTER TABLE seat_tiers ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE"
    )
    # 번들 구성(go product_bundle_items 대체): [{"external_ref": "<go productId>", "quantity": 1}]
    # 별도 테이블 대신 JSONB — 번들은 tier 의 종속 메타이고 참조 무결성은 go 상품 삭제 시
    # write-through 가 재전송하므로 FK 가 필요 없다.
    op.execute("ALTER TABLE seat_tiers ADD COLUMN IF NOT EXISTS bundle_items JSONB")

    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_seat_tiers_event_sort "
        "ON seat_tiers(event_id, sort_order)"
    )
    op.execute(
        """
        DO $$ BEGIN
          ALTER TABLE seat_tiers
            ADD CONSTRAINT ck_seat_tiers_product_type_valid
            CHECK (product_type IN ('ticket', 'addon', 'bundle', 'donation'));
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
        """
    )
    op.execute(
        """
        DO $$ BEGIN
          ALTER TABLE seat_tiers
            ADD CONSTRAINT ck_seat_tiers_visibility_valid
            CHECK (visibility IN ('public', 'private', 'hidden'));
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE seat_tiers DROP CONSTRAINT IF EXISTS ck_seat_tiers_visibility_valid")
    op.execute("ALTER TABLE seat_tiers DROP CONSTRAINT IF EXISTS ck_seat_tiers_product_type_valid")
    op.execute("DROP INDEX IF EXISTS idx_seat_tiers_event_sort")
    for col in (
        "bundle_items",
        "is_active",
        "max_per_order",
        "min_per_order",
        "sort_order",
        "image_url",
        "tax_included",
        "tax_rate",
        "visibility",
        "product_type",
        "description",
    ):
        op.execute(f"ALTER TABLE seat_tiers DROP COLUMN IF EXISTS {col}")
    for col in ("source", "fraud_flags", "fraud_score", "memo"):
        op.execute(f"ALTER TABLE orders DROP COLUMN IF EXISTS {col}")
    op.execute("DROP INDEX IF EXISTS uq_tickets_ticket_number")
    op.execute("ALTER TABLE tickets DROP COLUMN IF EXISTS answers")
    op.execute("ALTER TABLE tickets DROP COLUMN IF EXISTS ticket_number")
