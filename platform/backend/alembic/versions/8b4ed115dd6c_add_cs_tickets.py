"""add cs_tickets

Revision ID: 8b4ed115dd6c
Revises: 2de5477f9407
Create Date: 2026-04-03
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "8b4ed115dd6c"
down_revision = "2de5477f9407"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "cs_tickets",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("subject", sa.String(300), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("category", sa.String(20), nullable=False, server_default="other"),
        sa.Column("status", sa.String(20), nullable=False, server_default="open"),
        sa.Column("priority", sa.String(20), nullable=False, server_default="normal"),
        sa.Column(
            "reporter_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "assignee_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=True,
        ),
        sa.Column(
            "event_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("events.id"),
            nullable=True,
        ),
        sa.Column(
            "related_order_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("orders.id"),
            nullable=True,
        ),
        sa.Column("sla_deadline", sa.DateTime(timezone=True), nullable=True),
        sa.Column("escalated", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_index("idx_cs_ticket_status", "cs_tickets", ["status"])
    op.create_index("idx_cs_ticket_priority", "cs_tickets", ["priority"])
    op.create_index("idx_cs_ticket_assignee", "cs_tickets", ["assignee_id"])
    op.create_index("idx_cs_ticket_reporter", "cs_tickets", ["reporter_id"])
    op.create_index("idx_cs_ticket_category", "cs_tickets", ["category"])
    op.create_index("idx_cs_ticket_created", "cs_tickets", ["created_at"])
    op.create_index("idx_cs_ticket_sla", "cs_tickets", ["sla_deadline"])

    op.create_table(
        "cs_ticket_comments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "ticket_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("cs_tickets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "author_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column("is_internal", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )

    op.create_index("idx_cs_comment_ticket", "cs_ticket_comments", ["ticket_id"])
    op.create_index("idx_cs_comment_created", "cs_ticket_comments", ["created_at"])


def downgrade() -> None:
    op.drop_index("idx_cs_comment_created", table_name="cs_ticket_comments")
    op.drop_index("idx_cs_comment_ticket", table_name="cs_ticket_comments")
    op.drop_table("cs_ticket_comments")

    op.drop_index("idx_cs_ticket_sla", table_name="cs_tickets")
    op.drop_index("idx_cs_ticket_created", table_name="cs_tickets")
    op.drop_index("idx_cs_ticket_category", table_name="cs_tickets")
    op.drop_index("idx_cs_ticket_reporter", table_name="cs_tickets")
    op.drop_index("idx_cs_ticket_assignee", table_name="cs_tickets")
    op.drop_index("idx_cs_ticket_priority", table_name="cs_tickets")
    op.drop_index("idx_cs_ticket_status", table_name="cs_tickets")
    op.drop_table("cs_tickets")
