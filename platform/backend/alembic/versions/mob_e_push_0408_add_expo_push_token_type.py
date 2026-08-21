"""add token_type to push_subscriptions + nullable p256dh/auth for Expo

Revision ID: mob_e_push_0408
Revises: fix_eventstatus_data_0407
Create Date: 2026-04-08

Phase E.0 (mobile master plan): Expo push token 지원을 위해 PushSubscription 에
token_type 컬럼 추가하고 VAPID 전용인 p256dh/auth 를 nullable 로 전환.
Expo 토큰은 endpoint 에 'ExponentPushToken[...]' 형식으로 저장되며 p256dh/auth 불필요.
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "mob_e_push_0408"
down_revision = "fix_eventstatus_data_0407"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "push_subscriptions",
        sa.Column(
            "token_type",
            sa.String(length=16),
            nullable=False,
            server_default="vapid",
        ),
    )
    op.alter_column(
        "push_subscriptions",
        "p256dh",
        existing_type=sa.String(length=512),
        nullable=True,
    )
    op.alter_column(
        "push_subscriptions",
        "auth",
        existing_type=sa.String(length=512),
        nullable=True,
    )


def downgrade() -> None:
    op.alter_column(
        "push_subscriptions",
        "auth",
        existing_type=sa.String(length=512),
        nullable=False,
    )
    op.alter_column(
        "push_subscriptions",
        "p256dh",
        existing_type=sa.String(length=512),
        nullable=False,
    )
    op.drop_column("push_subscriptions", "token_type")
