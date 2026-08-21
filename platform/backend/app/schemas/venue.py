import uuid

from pydantic import BaseModel


class VenueSectionResponse(BaseModel):
    id: uuid.UUID
    venue_id: uuid.UUID
    name: str
    label: str
    capacity: int
    svg_path: str | None = None
    center_x: float = 0.0
    center_y: float = 0.0
    floor: int = 1
    color: str = "#1E2A78"
    view_image_url: str | None = None
    # 피그마 빌더 메타데이터 (go sync)
    kind: str = "assigned"
    rotation: float = 0.0
    width: float | None = None
    height: float | None = None

    model_config = {"from_attributes": True}


class VenueResponse(BaseModel):
    id: uuid.UUID
    name: str
    city: str
    address: str = ""
    total_capacity: int = 0
    map_svg_url: str | None = None
    map_width: int = 1000
    map_height: int = 800
    thumbnail_url: str | None = None
    seating_chart_url: str | None = None
    sections: list[VenueSectionResponse] = []

    model_config = {"from_attributes": True}


class VenueCreate(BaseModel):
    name: str
    city: str
    address: str = ""
    total_capacity: int = 0
    map_svg_url: str | None = None
    map_width: int = 1000
    map_height: int = 800
    thumbnail_url: str | None = None
    seating_chart_url: str | None = None
