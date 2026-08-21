"""Pydantic schemas for event page management."""

import re
import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, field_validator


# ── Theme schema ──

class PageThemeUpdate(BaseModel):
    """Partial update for page_theme JSON."""
    accent: str | None = None
    accent_light: str | None = None  # camelCase alias handled via model_config
    accent_glow: str | None = None
    bg: str | None = None
    surface: str | None = None
    text: str | None = None
    text_secondary: str | None = None
    fair: str | None = None
    hot: str | None = None
    logo_url: str | None = None
    og_image: str | None = None

    model_config = {"populate_by_name": True}

    @field_validator("accent", "accent_light", "accent_glow", "bg", "surface", "text", "text_secondary", "fair", "hot", mode="before")
    @classmethod
    def validate_color(cls, v: str | None) -> str | None:
        if v is None:
            return v
        # Allow hex colors and rgba() values
        if v.startswith("rgba(") or v.startswith("rgb("):
            return v
        if not re.match(r"^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$", v):
            raise ValueError(f"Invalid color format: {v}")
        return v

    def to_theme_dict(self) -> dict:
        """Convert to camelCase dict matching frontend PageTheme interface."""
        mapping = {
            "accent": "accent",
            "accent_light": "accentLight",
            "accent_glow": "accentGlow",
            "bg": "bg",
            "surface": "surface",
            "text": "text",
            "text_secondary": "textSecondary",
            "fair": "fair",
            "hot": "hot",
            "logo_url": "logoUrl",
            "og_image": "ogImage",
        }
        result = {}
        for py_key, js_key in mapping.items():
            val = getattr(self, py_key)
            if val is not None:
                result[js_key] = val
        return result


# ── Page data schema ──

class PageDataUpdate(BaseModel):
    """Update page_data (Puck JSON blob)."""
    page_data: dict[str, Any]


class PageWhiteLabelUpdate(BaseModel):
    """Update white-label branding toggles for a page."""
    white_label: bool
    white_label_config: dict[str, Any] | None = None


# ── Template schema ──

VALID_TEMPLATES = {"concert", "festival", "exhibition", "conference", "fanmeeting", "esports", "classical", "sports"}

class PageTemplateUpdate(BaseModel):
    page_template: str

    @field_validator("page_template")
    @classmethod
    def validate_template(cls, v: str) -> str:
        if v not in VALID_TEMPLATES:
            raise ValueError(f"Invalid template. Must be one of: {', '.join(sorted(VALID_TEMPLATES))}")
        return v


# ── Response schema ──

class PageSectionsUpdate(BaseModel):
    """Update page builder sections (ordered list of section blocks)."""
    sections: list[dict[str, Any]]


class EventPageDetailResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    subdomain_slug: str
    page_template: str | None
    page_data: dict | None
    page_theme: dict | None
    white_label: bool = False
    white_label_config: dict | None = None
    sections: list[dict] | None = None
    page_published: bool
    published_at: datetime | None
    created_at: datetime
    updated_at: datetime | None

    model_config = {"from_attributes": True}
