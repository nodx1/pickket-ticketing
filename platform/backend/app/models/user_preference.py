"""User onboarding preferences (취향: 카테고리/장르/아티스트).

app 온보딩이 POST /users/me/preferences 로 보내던 genres/artist_ids 가
v2에 수신 라우트·저장 테이블이 없어 404로 유실되던 것을 막는 SSOT 테이블.
(MASTER_DB_REDESIGN_SPEC §A point/app 검수 P1-6)
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import DateTime, ForeignKey, JSON
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class UserPreference(Base):
    __tablename__ = "user_preferences"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        unique=True,
        index=True,
        nullable=False,
    )
    # 온보딩 취향 — list[str] JSON (categories: 소문자 v2 카테고리, genres/artist_ids: app 전송)
    categories: Mapped[list | None] = mapped_column(_JSON_TYPE, nullable=True, default=None)
    genres: Mapped[list | None] = mapped_column(_JSON_TYPE, nullable=True, default=None)
    artist_ids: Mapped[list | None] = mapped_column(_JSON_TYPE, nullable=True, default=None)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
