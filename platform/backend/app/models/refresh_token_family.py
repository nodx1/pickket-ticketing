"""S-2(#26): 리프레시 토큰 패밀리 영속 백업 모델.

리프레시 토큰 회전(rotation) 유효성 상태는 1차로 Redis(원자적 Lua)에 저장되지만,
Redis 단독 의존은 단일 장애점이다: persistence 미설정 재시작 / flushall /
maxmemory eviction(allkeys-lru) 로 family 키가 TTL(7일) 전에 사라지면 정상
사용자가 세션 도중 대량 강제 로그아웃된다(가용성 장애).

이 테이블은 family 상태(현재 refresh 해시, 폐기 여부, 만료)를 DB 에 백업해, Redis
키가 유실됐을 때(가용성 폴백) 회전 검증을 이어가게 한다. 보안 동작(재사용 감지로
family revoke)은 Redis Lua 가 정본이며, DB 는 'Redis 가 키를 잃었을 때만' 참조하는
복구 경로다. 따라서 보안 약화 없이 가용성 단일 장애점만 완화한다.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class RefreshTokenFamily(Base):
    """리프레시 토큰 패밀리(=한 로그인 세션)의 영속 백업 레코드."""

    __tablename__ = "refresh_token_families"
    __table_args__ = (
        # (user_id, family_id) 로 회전 검증 시 단건 조회.
        Index(
            "uq_refresh_family_user_family",
            "user_id",
            "family_id",
            unique=True,
        ),
        # 만료/폐기 정리 배치용.
        Index("idx_refresh_family_expires", "expires_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
    )
    # JWT 의 family id(fid) — 한 세션 단위.
    family_id: Mapped[str] = mapped_column(String(64), nullable=False)
    # 현재 유효한 refresh 토큰의 해시(hash_token). 회전 시 갱신.
    current_token_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    # 재사용 감지/로그아웃으로 패밀리 폐기됨 — true 면 회전 거부(fail-closed).
    revoked: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    expires_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
