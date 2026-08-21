"""이벤트 주최자 표기 엔티티 — go `organizers` / `event_organizers` 흡수(레벨2 W2-EVT).

기존 v2 모델과의 구분(중요):
- `organizer_profiles` : v2 user 1:1 사업자 프로필 (계정 그 자체)
- `organizer_team_members` : v2 user 계정을 가진 협업자 (초대·권한)
- **`event_hosts`(이 파일)** : v2 user 계정이 **없는** 순수 표기용 주최/주관/후원 엔티티.
  하나의 organizer(=v2 user)가 N개를 카탈로그로 보유하고, 이벤트마다 골라 붙인다.
  go 는 `organizers.account_id` 로 테넌트를 갈랐는데, v2 에서는 `events.organizer_id`
  와 **같은 축**인 `event_hosts.organizer_id`(users.id)가 그 경계다.

`event_host_links` 는 go `event_organizers`(이벤트↔주최자 M:N + 역할 + 표시순서) 대응.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# go event_organizers.role CHECK 와 동일 집합. 표시 정렬 우선순위도 이 순서를 따른다.
EVENT_HOST_ROLES: tuple[str, ...] = ("host", "coordinator", "sponsor")
EVENT_HOST_ROLE_ORDER: dict[str, int] = {r: i for i, r in enumerate(EVENT_HOST_ROLES)}


class EventHost(Base):
    """주최자 표기 엔티티(go `organizers`).

    테넌트 경계 = `organizer_id`(users.id). 모든 조회·변경 쿼리에 이 조건이 **필수**다.
    """

    __tablename__ = "event_hosts"
    __table_args__ = (
        UniqueConstraint("organizer_id", "slug", name="uq_event_hosts_organizer_slug"),
        Index("idx_event_hosts_organizer", "organizer_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organizer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    slug: Mapped[str] = mapped_column(String(120), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
    logo_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # 연락처 공개 여부 / 공개 카탈로그 노출 여부 — 둘 다 fail-closed 기본값(false).
    contact_public: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )
    is_published: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default=text("false")
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class EventHostLink(Base):
    """이벤트↔주최자 연결(go `event_organizers`).

    go 는 여기에도 `account_id` 를 중복 저장했지만, v2 는 `events.organizer_id` /
    `event_hosts.organizer_id` 두 축이 이미 테넌트를 고정하므로 중복 컬럼을 두지 않는다
    (두 경계가 어긋나 split-brain 이 나는 경로를 아예 없앤다). 대신 링크를 만드는 쓰기
    경로에서 이벤트 소유·host 소유를 **둘 다** 검증한다.
    """

    __tablename__ = "event_host_links"
    __table_args__ = (
        UniqueConstraint("event_id", "host_id", "role", name="uq_event_host_links_event_host_role"),
        # go event_organizers.role CHECK 이관 — DB 레벨에서도 역할 오염을 막는다.
        CheckConstraint(
            "role IN ('host','coordinator','sponsor')", name="ck_event_host_links_role"
        ),
        Index("idx_event_host_links_event", "event_id"),
        Index("idx_event_host_links_host", "host_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False, index=True
    )
    host_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("event_hosts.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    role: Mapped[str] = mapped_column(
        String(20), nullable=False, default="host", server_default="host"
    )
    display_order: Mapped[int] = mapped_column(
        Integer, nullable=False, default=0, server_default="0"
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )
