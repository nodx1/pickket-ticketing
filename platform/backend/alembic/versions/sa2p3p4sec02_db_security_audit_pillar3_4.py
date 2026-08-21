"""DB Security Audit: PII column encryption prep + soft delete columns.

Pillar 3: Widen PII columns for encrypted storage (Fernet produces ~200+ byte ciphertext)
Pillar 4: Add deleted_at columns for soft delete on critical financial/audit models

Revision ID: sa2p3p4sec02
Revises: sa1p1p2sec01
Create Date: 2026-04-05
"""
import sqlalchemy as sa
from alembic import op

revision = "sa2p3p4sec02"
down_revision = "sa1p1p2sec01"
branch_labels = None
depends_on = None


def upgrade():
    # ── Pillar 3: Widen PII columns for Fernet encrypted storage ──
    # organizer_profiles: contact_phone, business_number, representative_name,
    #                     address, contact_email
    op.alter_column("organizer_profiles", "contact_phone",
                    type_=sa.String(512), existing_type=sa.String(20))
    op.alter_column("organizer_profiles", "business_number",
                    type_=sa.String(512), existing_type=sa.String(20))
    op.alter_column("organizer_profiles", "representative_name",
                    type_=sa.String(512), existing_type=sa.String(100))
    op.alter_column("organizer_profiles", "address",
                    type_=sa.String(1024), existing_type=sa.Text())
    op.alter_column("organizer_profiles", "contact_email",
                    type_=sa.String(512), existing_type=sa.String(200))

    # proxy_bookings: actual_user_phone, actual_user_name
    op.alter_column("proxy_bookings", "actual_user_phone",
                    type_=sa.String(512), existing_type=sa.String(30))
    op.alter_column("proxy_bookings", "actual_user_name",
                    type_=sa.String(512), existing_type=sa.String(100))

    # users: payment_account_id
    op.alter_column("users", "payment_account_id",
                    type_=sa.String(512), existing_type=sa.String(100))

    # ── Pillar 4: Add soft delete (deleted_at) to critical tables ──
    # tickets — already uses status-based lifecycle, but adding deleted_at
    # for compliance (auditor requirement: no physical delete allowed)
    op.add_column("tickets", sa.Column(
        "deleted_at", sa.DateTime(timezone=True), nullable=True
    ))

    # orders
    op.add_column("orders", sa.Column(
        "deleted_at", sa.DateTime(timezone=True), nullable=True
    ))

    # organizer_profiles
    op.add_column("organizer_profiles", sa.Column(
        "deleted_at", sa.DateTime(timezone=True), nullable=True
    ))

    # refunds
    op.add_column("refunds", sa.Column(
        "deleted_at", sa.DateTime(timezone=True), nullable=True
    ))

    # organizer_settlements — critical for tax audit
    op.add_column("organizer_settlements", sa.Column(
        "deleted_at", sa.DateTime(timezone=True), nullable=True
    ))

    # Create partial indexes for soft-deleted queries (WHERE deleted_at IS NULL)
    op.create_index("ix_tickets_not_deleted", "tickets", ["id"],
                    postgresql_where=sa.text("deleted_at IS NULL"))
    op.create_index("ix_orders_not_deleted", "orders", ["id"],
                    postgresql_where=sa.text("deleted_at IS NULL"))
    op.create_index("ix_settlements_not_deleted", "organizer_settlements", ["id"],
                    postgresql_where=sa.text("deleted_at IS NULL"))


def downgrade():
    op.drop_index("ix_settlements_not_deleted", table_name="organizer_settlements")
    op.drop_index("ix_orders_not_deleted", table_name="orders")
    op.drop_index("ix_tickets_not_deleted", table_name="tickets")

    op.drop_column("organizer_settlements", "deleted_at")
    op.drop_column("refunds", "deleted_at")
    op.drop_column("organizer_profiles", "deleted_at")
    op.drop_column("orders", "deleted_at")
    op.drop_column("tickets", "deleted_at")

    op.alter_column("users", "payment_account_id",
                    type_=sa.String(100), existing_type=sa.String(512))
    op.alter_column("proxy_bookings", "actual_user_name",
                    type_=sa.String(100), existing_type=sa.String(512))
    op.alter_column("proxy_bookings", "actual_user_phone",
                    type_=sa.String(30), existing_type=sa.String(512))
    op.alter_column("organizer_profiles", "contact_email",
                    type_=sa.String(200), existing_type=sa.String(512))
    op.alter_column("organizer_profiles", "address",
                    type_=sa.Text(), existing_type=sa.String(1024))
    op.alter_column("organizer_profiles", "representative_name",
                    type_=sa.String(100), existing_type=sa.String(512))
    op.alter_column("organizer_profiles", "business_number",
                    type_=sa.String(20), existing_type=sa.String(512))
    op.alter_column("organizer_profiles", "contact_phone",
                    type_=sa.String(20), existing_type=sa.String(512))
