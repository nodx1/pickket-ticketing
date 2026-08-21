"""add survey_responses table

Revision ID: w4x5y6z7a8b9
Revises: v3w4x5y6z7a8
Create Date: 2026-03-15
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "w4x5y6z7a8b9"
down_revision = "v3w4x5y6z7a8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "survey_responses",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("survey_id", sa.String(50), nullable=False, index=True),
        sa.Column("user_id", sa.Uuid(), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("fingerprint", sa.String(64), nullable=True),
        sa.Column("answers", sa.JSON(), nullable=False),
        sa.Column("metadata_info", sa.JSON(), nullable=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.func.now()),
    )
    op.create_index("ix_survey_dedup", "survey_responses", ["survey_id", "fingerprint"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_survey_dedup", table_name="survey_responses")
    op.drop_table("survey_responses")
