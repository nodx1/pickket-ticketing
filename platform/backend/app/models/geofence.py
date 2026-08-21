"""GeofenceSubscription model (Phase E.1).

사용자가 즐겨찾는 이벤트·공연장 근처 진입 시 포그라운드에서 알림을 트리거.
서버측 주기 조회는 v1 에서 보류, 클라이언트가 위치 업데이트 시
`POST /geofences/check` 를 호출해 매칭 판정한다.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import Float, ForeignKey, DateTime, Index, Integer
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class GeofenceSubscription(Base):
    __tablename__ = "geofence_subscriptions"
    __table_args__ = (
        Index("idx_geofence_user", "user_id"),
        Index("idx_geofence_event", "event_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="SET NULL"), nullable=True
    )
    venue_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("venues.id", ondelete="SET NULL"), nullable=True
    )
    lat: Mapped[float] = mapped_column(Float, nullable=False)
    lng: Mapped[float] = mapped_column(Float, nullable=False)
    radius_m: Mapped[int] = mapped_column(Integer, default=1000, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
