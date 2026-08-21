"""Add community system, domain configs, and event community link.

Creates fanclubs and fanclub_memberships tables, adds community fields
to events, and creates domain_configs table.

Revision ID: b1c2d3e4f5g6
Revises: a1b2c3d4e5f6
Create Date: 2026-03-02
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

revision = "b1c2d3e4f5g6"
down_revision = "c4d5e6f7a8b9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # --- Create fanclubs table (with all columns including community fields) ---
    op.create_table(
        "fanclubs",
        sa.Column("id", UUID(as_uuid=True), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("artist_name", sa.String(200), nullable=False),
        sa.Column("artist_id", UUID(as_uuid=True), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("logo_url", sa.String(500), nullable=True),
        sa.Column("organizer_id", UUID(as_uuid=True), nullable=False),
        sa.Column("max_members", sa.Integer(), server_default="500000"),
        sa.Column("is_official", sa.Boolean(), server_default="false"),
        sa.Column("is_active", sa.Boolean(), server_default="true"),
        sa.Column("community_type", sa.String(30), nullable=False, server_default="fanclub"),
        sa.Column("subject_name", sa.String(200), nullable=True),
        sa.Column("domain", sa.String(50), nullable=True),
        sa.Column("custom_tier_labels", sa.Text(), nullable=True),
        sa.Column("custom_member_label", sa.String(50), nullable=True),
        sa.Column("event_type_template", sa.String(50), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["organizer_id"], ["users.id"]),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_fanclubs_artist_name", "fanclubs", ["artist_name"])
    op.create_index("idx_fanclubs_organizer_id", "fanclubs", ["organizer_id"])
    op.create_index("idx_fanclubs_community_type", "fanclubs", ["community_type"])
    op.create_index("idx_fanclubs_domain", "fanclubs", ["domain"])

    # --- Create fanclub_memberships table ---
    op.create_table(
        "fanclub_memberships",
        sa.Column("id", UUID(as_uuid=True), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), nullable=False),
        sa.Column("fanclub_id", UUID(as_uuid=True), nullable=False),
        sa.Column("tier", sa.String(20), server_default="basic"),
        sa.Column("status", sa.String(20), server_default="pending"),
        sa.Column("membership_code", sa.String(100), nullable=True),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("joined_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"]),
        sa.ForeignKeyConstraint(["fanclub_id"], ["fanclubs.id"]),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("user_id", "fanclub_id", name="uq_user_fanclub"),
    )
    op.create_index("idx_membership_fanclub_status", "fanclub_memberships", ["fanclub_id", "status"])
    op.create_index("idx_membership_user_active", "fanclub_memberships", ["user_id", "status"])
    op.create_index("idx_membership_fanclub_tier", "fanclub_memberships", ["fanclub_id", "tier"])

    # --- Events table: add community_id and subject_name ---
    op.add_column("events", sa.Column("community_id", sa.Uuid(), nullable=True))
    op.add_column("events", sa.Column("subject_name", sa.String(200), nullable=True))

    op.create_foreign_key(
        "fk_events_community_id",
        "events",
        "fanclubs",
        ["community_id"],
        ["id"],
    )
    op.create_index("idx_events_community_id", "events", ["community_id"])

    # --- Domain configs table ---
    op.create_table(
        "domain_configs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("domain", sa.String(50), nullable=False),
        sa.Column("config_key", sa.String(100), nullable=False),
        sa.Column("config_value", sa.Text(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("domain", "config_key", name="uq_domain_config_key"),
    )


def downgrade() -> None:
    op.drop_table("domain_configs")

    op.drop_index("idx_events_community_id", table_name="events")
    op.drop_constraint("fk_events_community_id", "events", type_="foreignkey")
    op.drop_column("events", "subject_name")
    op.drop_column("events", "community_id")

    op.drop_table("fanclub_memberships")

    op.drop_index("idx_fanclubs_domain", table_name="fanclubs")
    op.drop_index("idx_fanclubs_community_type", table_name="fanclubs")
    op.drop_index("idx_fanclubs_organizer_id", table_name="fanclubs")
    op.drop_index("idx_fanclubs_artist_name", table_name="fanclubs")
    op.drop_table("fanclubs")
