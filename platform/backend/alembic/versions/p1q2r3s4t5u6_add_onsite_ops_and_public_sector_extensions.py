"""add onsite ops and public sector extensions

Revision ID: p1q2r3s4t5u6
Revises: n8o9p0q1r2s3
Create Date: 2026-03-07 20:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision: str = "p1q2r3s4t5u6"
down_revision: Union[str, Sequence[str], None] = "n8o9p0q1r2s3"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("tickets", sa.Column("nfc_uid", sa.String(length=64), nullable=True))
    op.create_unique_constraint("uq_tickets_nfc_uid", "tickets", ["nfc_uid"])

    op.add_column("events", sa.Column("discount_policies", sa.JSON(), nullable=True))
    op.add_column("events", sa.Column("resident_priority", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("events", sa.Column("resident_priority_days", sa.Integer(), nullable=False, server_default="7"))
    op.add_column("events", sa.Column("nft_enabled", sa.Boolean(), nullable=False, server_default=sa.false()))

    op.create_table(
        "nft_tickets",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("ticket_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("tickets.id"), nullable=False, unique=True),
        sa.Column("event_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("events.id"), nullable=False),
        sa.Column("owner_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("token_name", sa.String(length=200), nullable=False),
        sa.Column("description", sa.String(length=1000), nullable=False),
        sa.Column("image_url", sa.String(length=500), nullable=False),
        sa.Column("attributes", sa.JSON(), nullable=True),
        sa.Column("chain", sa.String(length=50), nullable=True),
        sa.Column("contract_address", sa.String(length=200), nullable=True),
        sa.Column("token_id", sa.Integer(), nullable=True),
        sa.Column("tx_hash", sa.String(length=200), nullable=True),
        sa.Column("minted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("status", sa.String(length=30), nullable=False, server_default="pending"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("idx_nft_tickets_event_status", "nft_tickets", ["event_id", "status"])
    op.create_index("idx_nft_tickets_owner", "nft_tickets", ["owner_id"])

    op.create_table(
        "public_facilities",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("facility_type", sa.String(length=50), nullable=False),
        sa.Column("address", sa.String(length=500), nullable=False),
        sa.Column("city", sa.String(length=100), nullable=False),
        sa.Column("district", sa.String(length=100), nullable=True),
        sa.Column("lat", sa.Float(), nullable=True),
        sa.Column("lng", sa.Float(), nullable=True),
        sa.Column("capacity", sa.Integer(), nullable=True),
        sa.Column("amenities", sa.JSON(), nullable=True),
        sa.Column("accessibility", sa.JSON(), nullable=True),
        sa.Column("operating_hours", sa.JSON(), nullable=True),
        sa.Column("organizer_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("photos", sa.JSON(), nullable=True),
        sa.Column("kakao_map_id", sa.String(length=100), nullable=True),
        sa.Column("naver_map_id", sa.String(length=100), nullable=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("idx_public_facilities_city_type", "public_facilities", ["city", "facility_type"])
    op.create_index("idx_public_facilities_organizer", "public_facilities", ["organizer_id"])

    op.create_table(
        "proxy_bookings",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("booker_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("actual_user_name", sa.String(length=100), nullable=False),
        sa.Column("actual_user_phone", sa.String(length=30), nullable=False),
        sa.Column("requested_quantity", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("event_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("events.id"), nullable=False),
        sa.Column("tier_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("seat_tiers.id"), nullable=False),
        sa.Column("order_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("orders.id"), nullable=True),
        sa.Column("status", sa.String(length=30), nullable=False, server_default="registered"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("idx_proxy_bookings_booker", "proxy_bookings", ["booker_id"])
    op.create_index("idx_proxy_bookings_event", "proxy_bookings", ["event_id"])


def downgrade() -> None:
    op.drop_index("idx_proxy_bookings_event", table_name="proxy_bookings")
    op.drop_index("idx_proxy_bookings_booker", table_name="proxy_bookings")
    op.drop_table("proxy_bookings")

    op.drop_index("idx_public_facilities_organizer", table_name="public_facilities")
    op.drop_index("idx_public_facilities_city_type", table_name="public_facilities")
    op.drop_table("public_facilities")

    op.drop_index("idx_nft_tickets_owner", table_name="nft_tickets")
    op.drop_index("idx_nft_tickets_event_status", table_name="nft_tickets")
    op.drop_table("nft_tickets")

    op.drop_column("events", "nft_enabled")
    op.drop_column("events", "resident_priority_days")
    op.drop_column("events", "resident_priority")
    op.drop_column("events", "discount_policies")

    op.drop_constraint("uq_tickets_nfc_uid", "tickets", type_="unique")
    op.drop_column("tickets", "nfc_uid")
