"""organizer_profiles: 계정 화면 v2 전환용 가산 컬럼 (레벨2 컷오버 T1)

go `accounts` 가 비워지면서 주최자 계정/설정/알림 화면이 전부 404 로 파손됐다.
읽기·쓰기 정본을 v2 `organizer_profiles` 로 옮기는데, go `accounts` 에만 있던
운영 설정 3개가 v2 에 없어 가산한다.

  - notification_prefs : 주최자 알림 수신 설정(JSONB, 6키). go accounts.notification_prefs 대체.
  - timezone / currency: go accounts 의 조직 로케일. 현재 값 도메인은 Asia/Seoul · KRW 단일이나,
                         화면이 그대로 노출·수정하므로 컬럼으로 보존한다.

⚠️ 전부 **가산(nullable/default)** 이다. 기존 컬럼 의미는 바꾸지 않는다.

Revision ID: mainfix_0727
Revises: w5_mrg3_0727
Create Date: 2026-07-27
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "mainfix_0727"
down_revision: Union[str, Sequence[str], None] = "w5_mrg3_0727"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column(
        "organizer_profiles",
        sa.Column("notification_prefs", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
    )
    op.add_column(
        "organizer_profiles",
        sa.Column("timezone", sa.String(length=64), nullable=False, server_default="Asia/Seoul"),
    )
    op.add_column(
        "organizer_profiles",
        sa.Column("currency", sa.String(length=8), nullable=False, server_default="KRW"),
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column("organizer_profiles", "currency")
    op.drop_column("organizer_profiles", "timezone")
    op.drop_column("organizer_profiles", "notification_prefs")
