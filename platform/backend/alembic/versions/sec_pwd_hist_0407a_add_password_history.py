"""add password_history table (쿠팡 2025 대비)

Revision ID: sec_pwd_hist_0407a
Revises: sec_mfa_0406b
Create Date: 2026-04-07
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

# revision identifiers, used by Alembic.
revision = "sec_pwd_hist_0407a"
down_revision = "sec_mfa_0406b"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "password_history",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("hashed_password", sa.String(255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    # MFA 백업 코드 컬럼 추가
    op.add_column("users", sa.Column("mfa_backup_codes", sa.String(2048), nullable=True))


def downgrade() -> None:
    op.drop_column("users", "mfa_backup_codes")
    op.drop_table("password_history")
