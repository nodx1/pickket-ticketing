"""Add organizer portal tables and event fields.

Revision ID: c1d2e3f4g5h6
Revises: b1c2d3e4f5g6
Create Date: 2026-03-02

New tables: organizer_profiles, organizer_requests, open_notices,
participant_slots, participant_assignments, discounts, final_calls,
promotions, bridge_pages, partnership_requests, package_products,
package_items, ticket_issuance_requests.

Event model: add organizer portal fields + new status enum values.
"""
from alembic import op
import sqlalchemy as sa

revision = "c1d2e3f4g5h6"
down_revision = "b1c2d3e4f5g6"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"

    # ── Add new EventStatus enum values ──
    if is_pg:
        op.execute("""
            DO $$
            BEGIN
                ALTER TYPE eventstatus ADD VALUE IF NOT EXISTS 'pending_review';
                ALTER TYPE eventstatus ADD VALUE IF NOT EXISTS 'under_review';
                ALTER TYPE eventstatus ADD VALUE IF NOT EXISTS 'revision_requested';
                ALTER TYPE eventstatus ADD VALUE IF NOT EXISTS 'approved';
            EXCEPTION WHEN duplicate_object THEN NULL;
            END $$;
        """)

    # ── Add organizer portal columns to events ──
    op.add_column("events", sa.Column("age_rating", sa.String(20), nullable=True))
    op.add_column("events", sa.Column("seat_type", sa.String(20), nullable=True, server_default="assigned"))
    op.add_column("events", sa.Column("seat_map_url", sa.String(500), nullable=True))
    op.add_column("events", sa.Column("allocation_ratio", sa.Float, nullable=True))
    op.add_column("events", sa.Column("delivery_method", sa.String(20), nullable=True, server_default="mobile"))
    op.add_column("events", sa.Column("mobile_ticket_enabled", sa.Boolean, nullable=True, server_default="true"))
    op.add_column("events", sa.Column("ticket_display_info", sa.Text, nullable=True))
    op.add_column("events", sa.Column("desired_open_date", sa.DateTime(timezone=True), nullable=True))
    op.add_column("events", sa.Column("notice", sa.Text, nullable=True))
    op.add_column("events", sa.Column("description_images", sa.Text, nullable=True))
    op.add_column("events", sa.Column("participant_enabled", sa.Boolean, nullable=True, server_default="false"))
    op.add_column("events", sa.Column("board_types", sa.Text, nullable=True))
    op.add_column("events", sa.Column("event_date_end", sa.DateTime(timezone=True), nullable=True))

    # ── organizer_profiles ──
    op.create_table(
        "organizer_profiles",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("user_id", sa.Uuid, sa.ForeignKey("users.id"), nullable=False, unique=True),
        sa.Column("company_name", sa.String(200), nullable=False),
        sa.Column("business_number", sa.String(20), nullable=False),
        sa.Column("representative_name", sa.String(100), nullable=False),
        sa.Column("address", sa.Text, nullable=True),
        sa.Column("contact_phone", sa.String(20), nullable=False),
        sa.Column("contact_email", sa.String(200), nullable=False),
        sa.Column("primary_domains", sa.Text, nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("approved_by", sa.Uuid, nullable=True),
        sa.Column("rejection_reason", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    # ── organizer_requests ──
    op.create_table(
        "organizer_requests",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("organizer_id", sa.Uuid, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("event_id", sa.Uuid, sa.ForeignKey("events.id"), nullable=True),
        sa.Column("request_type", sa.String(30), nullable=False),
        sa.Column("status", sa.String(30), nullable=False, server_default="draft"),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("content", sa.Text, nullable=True),
        sa.Column("attachments", sa.Text, nullable=True),
        sa.Column("reviewer_id", sa.Uuid, sa.ForeignKey("users.id"), nullable=True),
        sa.Column("reviewer_comment", sa.Text, nullable=True),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("extra_data", sa.Text, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("idx_org_req_organizer", "organizer_requests", ["organizer_id"])
    op.create_index("idx_org_req_type_status", "organizer_requests", ["request_type", "status"])

    # ── open_notices ──
    op.create_table(
        "open_notices",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("event_id", sa.Uuid, sa.ForeignKey("events.id"), nullable=False),
        sa.Column("organizer_id", sa.Uuid, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("category", sa.String(50), nullable=True),
        sa.Column("notice_type", sa.String(20), nullable=False, server_default="general"),
        sa.Column("publish_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("open_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("event_info", sa.Text, nullable=True),
        sa.Column("discount_info", sa.Text, nullable=True),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("participant_info", sa.Text, nullable=True),
        sa.Column("notice_image_url", sa.String(500), nullable=True),
        sa.Column("video_url", sa.String(500), nullable=True),
        sa.Column("region", sa.String(100), nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="draft"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("idx_open_notice_event", "open_notices", ["event_id"])
    op.create_index("idx_open_notice_status_publish", "open_notices", ["status", "publish_at"])

    # ── participant_slots ──
    op.create_table(
        "participant_slots",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("event_id", sa.Uuid, sa.ForeignKey("events.id"), nullable=False),
        sa.Column("slot_name", sa.String(200), nullable=False),
        sa.Column("sort_order", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("idx_participant_slot_event", "participant_slots", ["event_id"])

    # ── participant_assignments ──
    op.create_table(
        "participant_assignments",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("slot_id", sa.Uuid, sa.ForeignKey("participant_slots.id", ondelete="CASCADE"), nullable=False),
        sa.Column("session_date", sa.DateTime(timezone=True), nullable=False),
        sa.Column("participant_name", sa.String(200), nullable=False),
        sa.Column("participant_image_url", sa.String(500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("idx_participant_assign_slot", "participant_assignments", ["slot_id"])

    # ── discounts ──
    op.create_table(
        "discounts",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("event_id", sa.Uuid, sa.ForeignKey("events.id"), nullable=False),
        sa.Column("discount_type", sa.String(20), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("rate", sa.Float, nullable=True),
        sa.Column("amount", sa.Numeric(12, 2), nullable=True),
        sa.Column("conditions", sa.Text, nullable=True),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("idx_discount_event", "discounts", ["event_id"])

    # ── final_calls ──
    op.create_table(
        "final_calls",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("event_id", sa.Uuid, sa.ForeignKey("events.id"), nullable=False),
        sa.Column("organizer_id", sa.Uuid, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("discount_price", sa.Numeric(12, 2), nullable=False),
        sa.Column("sale_opens_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("session_ids", sa.Text, nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("idx_final_call_event", "final_calls", ["event_id"])

    # ── promotions ──
    op.create_table(
        "promotions",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("event_id", sa.Uuid, sa.ForeignKey("events.id"), nullable=False),
        sa.Column("organizer_id", sa.Uuid, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("promotion_type", sa.String(20), nullable=False),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("content", sa.Text, nullable=True),
        sa.Column("start_date", sa.DateTime(timezone=True), nullable=False),
        sa.Column("end_date", sa.DateTime(timezone=True), nullable=False),
        sa.Column("prizes", sa.Text, nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="draft"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("idx_promotion_event", "promotions", ["event_id"])

    # ── bridge_pages ──
    op.create_table(
        "bridge_pages",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("organizer_id", sa.Uuid, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("slug", sa.String(200), nullable=False, unique=True),
        sa.Column("content", sa.Text, nullable=True),
        sa.Column("event_ids", sa.Text, nullable=False),
        sa.Column("images", sa.Text, nullable=True),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default="true"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )

    # ── partnership_requests ──
    op.create_table(
        "partnership_requests",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("event_id", sa.Uuid, sa.ForeignKey("events.id"), nullable=False),
        sa.Column("organizer_id", sa.Uuid, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("partner_type", sa.String(20), nullable=False),
        sa.Column("partner_ids", sa.Text, nullable=True),
        sa.Column("discount_info", sa.Text, nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("idx_partnership_event", "partnership_requests", ["event_id"])

    # ── package_products ──
    op.create_table(
        "package_products",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("organizer_id", sa.Uuid, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("name", sa.String(300), nullable=False),
        sa.Column("sub_title", sa.String(300), nullable=True),
        sa.Column("category", sa.String(50), nullable=False),
        sa.Column("desired_open_date", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="draft"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("idx_package_organizer", "package_products", ["organizer_id"])

    # ── package_items ──
    op.create_table(
        "package_items",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("package_id", sa.Uuid, sa.ForeignKey("package_products.id", ondelete="CASCADE"), nullable=False),
        sa.Column("event_id", sa.Uuid, sa.ForeignKey("events.id"), nullable=False),
        sa.Column("seat_tier", sa.String(100), nullable=True),
        sa.Column("regular_price", sa.Numeric(12, 2), nullable=False),
        sa.Column("discount_price", sa.Numeric(12, 2), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("idx_package_item_package", "package_items", ["package_id"])

    # ── ticket_issuance_requests ──
    op.create_table(
        "ticket_issuance_requests",
        sa.Column("id", sa.Uuid, primary_key=True),
        sa.Column("event_id", sa.Uuid, sa.ForeignKey("events.id"), nullable=False),
        sa.Column("organizer_id", sa.Uuid, sa.ForeignKey("users.id"), nullable=False),
        sa.Column("issue_type", sa.String(20), nullable=False),
        sa.Column("seat_info", sa.Text, nullable=True),
        sa.Column("ticket_display_info", sa.Text, nullable=True),
        sa.Column("quantity", sa.Integer, nullable=False),
        sa.Column("delivery_method", sa.String(20), nullable=False),
        sa.Column("recipient_name", sa.String(100), nullable=True),
        sa.Column("recipient_phone", sa.String(20), nullable=True),
        sa.Column("delivery_address", sa.Text, nullable=True),
        sa.Column("attachments", sa.Text, nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("idx_ticket_issuance_event", "ticket_issuance_requests", ["event_id"])
    op.create_index("idx_ticket_issuance_organizer", "ticket_issuance_requests", ["organizer_id"])


def downgrade() -> None:
    # Drop tables in reverse dependency order
    op.drop_table("ticket_issuance_requests")
    op.drop_table("package_items")
    op.drop_table("package_products")
    op.drop_table("partnership_requests")
    op.drop_table("bridge_pages")
    op.drop_table("promotions")
    op.drop_table("final_calls")
    op.drop_table("discounts")
    op.drop_table("participant_assignments")
    op.drop_table("participant_slots")
    op.drop_table("open_notices")
    op.drop_table("organizer_requests")
    op.drop_table("organizer_profiles")

    # Drop event columns
    for col in [
        "event_date_end", "board_types", "participant_enabled",
        "description_images", "notice", "desired_open_date",
        "ticket_display_info", "mobile_ticket_enabled",
        "delivery_method", "allocation_ratio", "seat_map_url",
        "seat_type", "age_rating",
    ]:
        op.drop_column("events", col)
