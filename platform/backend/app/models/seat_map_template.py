"""좌석맵 템플릿 — go 좌석빌더 v2 흡수(레벨2 영역A).

go 의 seat_map_templates(organizer/migrations/147) 를 v2 로 이관한다.
- account_id NULL == 시스템 시드(5종). is_system=True.
- account_id 있으면 조직이 저장한 커스텀 템플릿.
- layout(JSONB) 은 go 원본 규격 그대로 보관(변환 없음). seats/landmarks/tiers 프리셋 포함.

go 는 account_id(UUID) 로 조직을 식별하므로, v2 에서도 organizer_id 대신 go account_id 를
그대로 저장한다(organizer_id 매핑 없이 조직 경계만 유지 — 크로스테넌트 격리).
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, CheckConstraint, DateTime, Index, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# Postgres 는 JSONB, 테스트(SQLite)는 JSON 으로 렌더(코드베이스 컨벤션).
_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")

_VALID_TEMPLATE_CATEGORIES = (
    "concert",
    "theater",
    "festival",
    "booth",
    "convention",
    "sports",
    "custom",
)


class SeatMapTemplate(Base):
    __tablename__ = "seat_map_templates"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # go account_id(조직) — NULL == 시스템 시드. FK 없음(go 계정 = v2 외부 식별자).
    organizer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    category: Mapped[str] = mapped_column(String(50), nullable=False)
    thumbnail_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    layout: Mapped[dict] = mapped_column(_JSON_TYPE, nullable=False)
    is_system: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
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

    __table_args__ = (
        CheckConstraint(
            "category IN ('concert','theater','festival','booth','convention','sports','custom')",
            name="seat_map_templates_category_check",
        ),
        Index("idx_seat_map_templates_organizer", "organizer_id"),
        Index("idx_seat_map_templates_category", "category"),
        Index(
            "idx_seat_map_templates_system",
            "is_system",
            postgresql_where=text("is_system = true"),
        ),
    )
