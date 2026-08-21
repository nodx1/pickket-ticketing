"""[보안 S-2/#26] 리프레시 토큰 패밀리 영속 백업 테이블

리프레시 토큰 회전 유효성 상태가 Redis 에만 존재 → 단일 장애점.
Redis persistence 미설정 재시작 / flushall / maxmemory eviction(allkeys-lru) 로
family 키가 TTL(7일) 전에 사라지면 정상 사용자가 세션 도중 대량 강제 로그아웃된다.

이 테이블은 family 상태(현재 refresh 해시, 폐기 여부, 만료)를 DB 에 백업해, Redis 키
유실 시 회전 검증을 이어가는 가용성 폴백을 제공한다. 보안 동작(재사용 감지 → revoke)은
Redis Lua 가 정본이며 DB 는 'Redis 가 키를 잃었을 때만' 참조한다(보안 약화 없음).

Revision ID: rtf_0611
Revises: fin_major_0611
Create Date: 2026-06-11
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "rtf_0611"
down_revision = "fin_major_0611"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"
    uuid_type = postgresql.UUID(as_uuid=True) if is_pg else sa.String(36)

    op.create_table(
        "refresh_token_families",
        sa.Column("id", uuid_type, primary_key=True),
        sa.Column(
            "user_id",
            uuid_type,
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("family_id", sa.String(64), nullable=False),
        sa.Column("current_token_hash", sa.String(128), nullable=False),
        sa.Column(
            "revoked", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("CURRENT_TIMESTAMP"),
        ),
    )
    op.create_index(
        "uq_refresh_family_user_family",
        "refresh_token_families",
        ["user_id", "family_id"],
        unique=True,
    )
    op.create_index(
        "idx_refresh_family_expires",
        "refresh_token_families",
        ["expires_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_refresh_family_expires", table_name="refresh_token_families")
    op.drop_index("uq_refresh_family_user_family", table_name="refresh_token_families")
    op.drop_table("refresh_token_families")
