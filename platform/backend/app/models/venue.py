import uuid

from sqlalchemy import String, Integer, Float, Text, ForeignKey, UniqueConstraint, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class Venue(Base):
    __tablename__ = "venues"
    __table_args__ = (
        Index("idx_venue_city", "city"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    city: Mapped[str] = mapped_column(String(50), nullable=False)
    address: Mapped[str] = mapped_column(String(300), nullable=False, default="")
    total_capacity: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    map_svg_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    map_width: Mapped[int] = mapped_column(Integer, default=1000)
    map_height: Mapped[int] = mapped_column(Integer, default=800)
    thumbnail_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    seating_chart_url: Mapped[str | None] = mapped_column(String(500), nullable=True)

    sections: Mapped[list["VenueSection"]] = relationship(back_populates="venue", lazy="raise")


class VenueSection(Base):
    __tablename__ = "venue_sections"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    venue_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("venues.id", ondelete="RESTRICT"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(50), nullable=False)
    label: Mapped[str] = mapped_column(String(20), nullable=False)
    capacity: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    svg_path: Mapped[str | None] = mapped_column(Text, nullable=True)
    center_x: Mapped[float] = mapped_column(Float, default=0.0)
    center_y: Mapped[float] = mapped_column(Float, default=0.0)
    floor: Mapped[int] = mapped_column(Integer, default=1)
    color: Mapped[str] = mapped_column(String(20), default="#1E2A78")
    view_image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # 피그마 빌더에서 그린 섹션 메타데이터 (go → v2 sync)
    kind: Mapped[str] = mapped_column(String(20), nullable=False, default="assigned")
    rotation: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)
    width: Mapped[float | None] = mapped_column(Float, nullable=True)
    height: Mapped[float | None] = mapped_column(Float, nullable=True)

    venue: Mapped["Venue"] = relationship(back_populates="sections", lazy="raise")

    __table_args__ = (
        UniqueConstraint("venue_id", "name", name="uq_venue_sections_venue_name"),
    )
