"""Level2 B2-3 webhook event scope, external ref, and durable dispatch idempotency.

Revision ID: lvl2wh_0725
Revises: lvl2idem_0725
Create Date: 2026-07-25

Additive only. Existing organizer-wide v2 subscriptions remain valid with a
NULL event_id/external_ref; go-flipped subscriptions always populate both.
"""

from alembic import op


revision = "lvl2wh_0725"
down_revision = "lvl2idem_0725"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE webhook_subscriptions "
        "ADD COLUMN IF NOT EXISTS event_id UUID"
    )
    op.execute(
        "ALTER TABLE webhook_subscriptions "
        "ADD COLUMN IF NOT EXISTS external_ref VARCHAR(100)"
    )
    op.execute(
        "ALTER TABLE webhook_subscriptions "
        "ADD COLUMN IF NOT EXISTS name VARCHAR(200)"
    )
    op.execute(
        "ALTER TABLE webhook_subscriptions "
        "ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW()"
    )
    op.execute(
        "ALTER TABLE webhook_deliveries "
        "ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(200)"
    )
    op.execute(
        "UPDATE webhook_subscriptions "
        "SET updated_at = COALESCE(updated_at, created_at, NOW())"
    )
    op.execute(
        "ALTER TABLE webhook_subscriptions "
        "ALTER COLUMN updated_at SET NOT NULL"
    )

    # PostgreSQL has no ADD CONSTRAINT IF NOT EXISTS. Guard catalog lookups so
    # an interrupted/retried deployment remains safe.
    op.execute(
        """
        DO $$ BEGIN
          ALTER TABLE webhook_subscriptions
            ADD CONSTRAINT fk_webhook_subscriptions_event_id
            FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE;
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
        """
    )
    op.execute(
        """
        DO $$ BEGIN
          ALTER TABLE webhook_subscriptions
            ADD CONSTRAINT uq_webhook_sub_organizer_external_ref
            UNIQUE (organizer_id, external_ref);
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
        """
    )
    op.execute(
        """
        DO $$ BEGIN
          ALTER TABLE webhook_deliveries
            ADD CONSTRAINT uq_webhook_delivery_subscription_idempotency
            UNIQUE (subscription_id, idempotency_key);
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_webhook_sub_event_active "
        "ON webhook_subscriptions(event_id, is_active)"
    )


def downgrade() -> None:
    op.execute(
        "DROP INDEX IF EXISTS idx_webhook_sub_event_active"
    )
    op.execute(
        "ALTER TABLE webhook_deliveries "
        "DROP CONSTRAINT IF EXISTS uq_webhook_delivery_subscription_idempotency"
    )
    op.execute(
        "ALTER TABLE webhook_subscriptions "
        "DROP CONSTRAINT IF EXISTS uq_webhook_sub_organizer_external_ref"
    )
    op.execute(
        "ALTER TABLE webhook_subscriptions "
        "DROP CONSTRAINT IF EXISTS fk_webhook_subscriptions_event_id"
    )
    op.execute(
        "ALTER TABLE webhook_deliveries "
        "DROP COLUMN IF EXISTS idempotency_key"
    )
    op.execute(
        "ALTER TABLE webhook_subscriptions "
        "DROP COLUMN IF EXISTS updated_at"
    )
    op.execute(
        "ALTER TABLE webhook_subscriptions "
        "DROP COLUMN IF EXISTS name"
    )
    op.execute(
        "ALTER TABLE webhook_subscriptions "
        "DROP COLUMN IF EXISTS external_ref"
    )
    op.execute(
        "ALTER TABLE webhook_subscriptions "
        "DROP COLUMN IF EXISTS event_id"
    )
