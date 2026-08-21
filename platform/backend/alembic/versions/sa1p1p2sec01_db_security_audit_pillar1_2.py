"""DB Security Audit: seat duplication prevention + audit trail triggers.

Pillar 1: Partial unique index on tickets to prevent double-booking seats
Pillar 2: DB-level audit triggers for ticket/order state changes + audit log immutability

Revision ID: sa1p1p2sec01
Revises: os1p2r3e4v5n
Create Date: 2026-04-05
"""
from alembic import op

revision = "sa1p1p2sec01"
down_revision = "os1p2r3e4v5n"
branch_labels = None
depends_on = None


def upgrade():
    # Ensure enum values from prior migrations are committed
    op.execute("COMMIT")
    # ── Pillar 1: Prevent double-booking same seat ──
    # Only one ACTIVE or PENDING ticket can exist for a given seat
    op.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS
            ix_tickets_seat_active
        ON tickets (event_id, seat_id)
        WHERE seat_id IS NOT NULL
          AND status IN ('active'::ticketstatus, 'pending'::ticketstatus)
    """)

    # ── Pillar 2a: Ticket status change audit trigger ──
    op.execute("""
        CREATE OR REPLACE FUNCTION trg_ticket_status_audit()
        RETURNS TRIGGER AS $$
        BEGIN
            IF OLD.status IS DISTINCT FROM NEW.status THEN
                INSERT INTO audit_logs (
                    id, action, resource_type, resource_id,
                    old_value, new_value, event_id, tier_id, created_at
                ) VALUES (
                    gen_random_uuid(),
                    'ticket.status_change',
                    'ticket',
                    NEW.id::text,
                    jsonb_build_object('status', OLD.status),
                    jsonb_build_object('status', NEW.status,
                                      'current_owner_id', NEW.current_owner_id::text),
                    NEW.event_id,
                    NEW.tier_id,
                    now()
                );
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    """)
    op.execute("""
        DROP TRIGGER IF EXISTS trg_ticket_status_audit ON tickets;
        CREATE TRIGGER trg_ticket_status_audit
            AFTER UPDATE OF status ON tickets
            FOR EACH ROW
            EXECUTE FUNCTION trg_ticket_status_audit();
    """)

    # ── Pillar 2b: Order status change audit trigger ──
    op.execute("""
        CREATE OR REPLACE FUNCTION trg_order_status_audit()
        RETURNS TRIGGER AS $$
        BEGIN
            IF OLD.status IS DISTINCT FROM NEW.status THEN
                INSERT INTO audit_logs (
                    id, action, resource_type, resource_id,
                    old_value, new_value, event_id, tier_id, created_at
                ) VALUES (
                    gen_random_uuid(),
                    'order.status_change',
                    'order',
                    NEW.id::text,
                    jsonb_build_object('status', OLD.status),
                    jsonb_build_object('status', NEW.status,
                                      'total_amount', NEW.total_amount::text),
                    NEW.event_id,
                    NEW.tier_id,
                    now()
                );
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql;
    """)
    op.execute("""
        DROP TRIGGER IF EXISTS trg_order_status_audit ON orders;
        CREATE TRIGGER trg_order_status_audit
            AFTER UPDATE OF status ON orders
            FOR EACH ROW
            EXECUTE FUNCTION trg_order_status_audit();
    """)

    # ── Pillar 2c: Audit log immutability — prevent UPDATE/DELETE ──
    op.execute("""
        CREATE OR REPLACE FUNCTION trg_audit_logs_immutable()
        RETURNS TRIGGER AS $$
        BEGIN
            RAISE EXCEPTION 'audit_logs is append-only: % not allowed', TG_OP;
        END;
        $$ LANGUAGE plpgsql;
    """)
    op.execute("""
        DROP TRIGGER IF EXISTS trg_audit_logs_no_update ON audit_logs;
        CREATE TRIGGER trg_audit_logs_no_update
            BEFORE UPDATE ON audit_logs
            FOR EACH ROW
            EXECUTE FUNCTION trg_audit_logs_immutable();
    """)
    op.execute("""
        DROP TRIGGER IF EXISTS trg_audit_logs_no_delete ON audit_logs;
        CREATE TRIGGER trg_audit_logs_no_delete
            BEFORE DELETE ON audit_logs
            FOR EACH ROW
            EXECUTE FUNCTION trg_audit_logs_immutable();
    """)

    # ── Pillar 2d: sold_count auto-sync trigger ──
    # When a ticket is inserted as ACTIVE or status changes to ACTIVE, increment sold_count
    # When a ticket moves away from ACTIVE/PENDING to CANCELLED/EXPIRED, decrement sold_count
    op.execute("""
        CREATE OR REPLACE FUNCTION trg_sync_sold_count()
        RETURNS TRIGGER AS $$
        BEGIN
            IF TG_OP = 'INSERT' THEN
                IF NEW.status IN ('active', 'pending') THEN
                    UPDATE seat_tiers SET sold_count = sold_count + 1
                    WHERE id = NEW.tier_id;
                END IF;
                RETURN NEW;
            ELSIF TG_OP = 'UPDATE' THEN
                -- Leaving active/pending
                IF OLD.status IN ('active', 'pending')
                   AND NEW.status NOT IN ('active', 'pending') THEN
                    UPDATE seat_tiers SET sold_count = GREATEST(0, sold_count - 1)
                    WHERE id = NEW.tier_id;
                -- Entering active/pending
                ELSIF OLD.status NOT IN ('active', 'pending')
                   AND NEW.status IN ('active', 'pending') THEN
                    UPDATE seat_tiers SET sold_count = sold_count + 1
                    WHERE id = NEW.tier_id;
                END IF;
                RETURN NEW;
            END IF;
            RETURN NULL;
        END;
        $$ LANGUAGE plpgsql;
    """)
    op.execute("""
        DROP TRIGGER IF EXISTS trg_sync_sold_count ON tickets;
        CREATE TRIGGER trg_sync_sold_count
            AFTER INSERT OR UPDATE OF status ON tickets
            FOR EACH ROW
            EXECUTE FUNCTION trg_sync_sold_count();
    """)


def downgrade():
    op.execute("DROP TRIGGER IF EXISTS trg_sync_sold_count ON tickets")
    op.execute("DROP FUNCTION IF EXISTS trg_sync_sold_count()")
    op.execute("DROP TRIGGER IF EXISTS trg_audit_logs_no_delete ON audit_logs")
    op.execute("DROP TRIGGER IF EXISTS trg_audit_logs_no_update ON audit_logs")
    op.execute("DROP FUNCTION IF EXISTS trg_audit_logs_immutable()")
    op.execute("DROP TRIGGER IF EXISTS trg_order_status_audit ON orders")
    op.execute("DROP FUNCTION IF EXISTS trg_order_status_audit()")
    op.execute("DROP TRIGGER IF EXISTS trg_ticket_status_audit ON tickets")
    op.execute("DROP FUNCTION IF EXISTS trg_ticket_status_audit()")
    op.execute("DROP INDEX IF EXISTS ix_tickets_seat_active")
