"""P3-16: Programmatic SEO service.

Auto-generates SEO-optimized content and metadata:
- Dynamic meta tags for events
- Structured data (JSON-LD) generation
- Sitemap generation for all public events
- Category/venue landing page metadata
- Social sharing (OG/Twitter) meta optimization
"""

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import select, func, and_
from sqlalchemy.ext.asyncio import AsyncSession


@dataclass
class SEOMeta:
    title: str
    description: str
    keywords: list[str] = field(default_factory=list)
    og_title: str = ""
    og_description: str = ""
    og_image: str = ""
    og_type: str = "website"
    twitter_card: str = "summary_large_image"
    canonical_url: str = ""
    robots: str = "index, follow"


@dataclass
class JsonLdEvent:
    name: str
    description: str
    start_date: str
    end_date: str | None
    location_name: str
    location_address: str
    image: str
    url: str
    offers_low_price: str
    offers_high_price: str
    offers_currency: str = "KRW"
    performer_names: list[str] = field(default_factory=list)
    organizer_name: str = ""
    event_status: str = "EventScheduled"
    event_attendance_mode: str = "OfflineEventAttendanceMode"

    def to_dict(self) -> dict:
        ld = {
            "@context": "https://schema.org",
            "@type": "Event",
            "name": self.name,
            "description": self.description,
            "startDate": self.start_date,
            "image": self.image,
            "url": self.url,
            "eventStatus": f"https://schema.org/{self.event_status}",
            "eventAttendanceMode": f"https://schema.org/{self.event_attendance_mode}",
            "location": {
                "@type": "Place",
                "name": self.location_name,
                "address": {
                    "@type": "PostalAddress",
                    "streetAddress": self.location_address,
                },
            },
            "offers": {
                "@type": "AggregateOffer",
                "lowPrice": self.offers_low_price,
                "highPrice": self.offers_high_price,
                "priceCurrency": self.offers_currency,
                "availability": "https://schema.org/InStock",
                "url": self.url,
            },
        }

        if self.end_date:
            ld["endDate"] = self.end_date

        if self.performer_names:
            ld["performer"] = [
                {"@type": "Person", "name": name}
                for name in self.performer_names
            ]

        if self.organizer_name:
            ld["organizer"] = {
                "@type": "Organization",
                "name": self.organizer_name,
            }

        return ld


@dataclass
class SitemapEntry:
    loc: str
    lastmod: str
    changefreq: str = "weekly"
    priority: float = 0.7


# ── Meta Generation ───────────────────────────────────────────────────────────

CATEGORY_LABELS = {
    "concert": "콘서트",
    "musical": "뮤지컬",
    "classic": "클래식",
    "sports": "스포츠",
    "exhibition": "전시",
    "festival": "페스티벌",
    "esports": "e스포츠",
}

BASE_URL = "https://www.pickket.kr"


async def generate_event_meta(
    db: AsyncSession,
    event_id: uuid.UUID,
) -> SEOMeta:
    """Generate SEO metadata for an event page."""
    from app.models.event import Event

    event = await db.get(Event, event_id)
    if not event:
        return SEOMeta(
            title="이벤트 | Pickket",
            description="Pickket에서 다양한 이벤트를 만나보세요",
        )

    title = getattr(event, "title", "이벤트")
    category = getattr(event, "category", "")
    venue_name = getattr(event, "venue_name", "")
    description_text = getattr(event, "description", "") or ""
    image_url = getattr(event, "image_url", "") or ""

    cat_label = CATEGORY_LABELS.get(category, category)
    start_date = getattr(event, "start_date", None)
    date_str = ""
    if start_date:
        if isinstance(start_date, datetime):
            date_str = start_date.strftime("%Y년 %m월 %d일")
        else:
            date_str = str(start_date)

    # Build meta title (max ~60 chars)
    meta_title = f"{title}"
    if cat_label:
        meta_title += f" | {cat_label}"
    meta_title += " | Pickket"
    if len(meta_title) > 65:
        meta_title = f"{title[:50]}... | Pickket"

    # Build meta description (max ~155 chars)
    parts = []
    if date_str:
        parts.append(date_str)
    if venue_name:
        parts.append(venue_name)
    if description_text:
        parts.append(description_text[:80])
    meta_desc = " · ".join(parts)
    if len(meta_desc) > 155:
        meta_desc = meta_desc[:152] + "..."
    if not meta_desc:
        meta_desc = f"{title} 티켓을 Pickket에서 공정하게 구매하세요"

    # Keywords
    keywords = [title, "티켓", "Pickket"]
    if cat_label:
        keywords.append(cat_label)
    if venue_name:
        keywords.append(venue_name)

    canonical = f"{BASE_URL}/events/{event_id}"

    return SEOMeta(
        title=meta_title,
        description=meta_desc,
        keywords=keywords,
        og_title=title,
        og_description=meta_desc,
        og_image=image_url,
        og_type="event",
        canonical_url=canonical,
    )


async def generate_event_jsonld(
    db: AsyncSession,
    event_id: uuid.UUID,
) -> dict:
    """Generate JSON-LD structured data for an event."""
    from app.models.event import Event
    from app.models.tier import Tier

    event = await db.get(Event, event_id)
    if not event:
        return {}

    # Get price range from tiers
    tiers_result = await db.execute(
        select(
            func.min(Tier.price).label("min_price"),
            func.max(Tier.price).label("max_price"),
        ).where(Tier.event_id == event_id)
    )
    tier_row = tiers_result.first()
    low = str(tier_row.min_price or 0) if tier_row else "0"
    high = str(tier_row.max_price or 0) if tier_row else "0"

    start_date = getattr(event, "start_date", None)
    end_date = getattr(event, "end_date", None)

    jsonld = JsonLdEvent(
        name=getattr(event, "title", ""),
        description=getattr(event, "description", "") or "",
        start_date=start_date.isoformat() if start_date else "",
        end_date=end_date.isoformat() if end_date else None,
        location_name=getattr(event, "venue_name", "") or "",
        location_address=getattr(event, "venue_address", "") or "",
        image=getattr(event, "image_url", "") or "",
        url=f"{BASE_URL}/events/{event_id}",
        offers_low_price=low,
        offers_high_price=high,
    )

    return jsonld.to_dict()


# ── Category Landing Pages ────────────────────────────────────────────────────

async def generate_category_meta(category: str) -> SEOMeta:
    """Generate SEO metadata for a category landing page."""
    cat_label = CATEGORY_LABELS.get(category, category)

    return SEOMeta(
        title=f"{cat_label} 이벤트 | Pickket",
        description=f"Pickket에서 {cat_label} 이벤트를 찾아보세요. 공정한 티켓 배분 시스템으로 원하는 {cat_label} 티켓을 구매하세요.",
        keywords=[cat_label, "티켓", f"{cat_label} 이벤트", "Pickket"],
        og_title=f"{cat_label} | Pickket",
        og_description=f"{cat_label} 이벤트 — 공정한 티켓팅",
        canonical_url=f"{BASE_URL}/events?category={category}",
    )


# ── Sitemap Generation ────────────────────────────────────────────────────────

async def generate_sitemap_entries(
    db: AsyncSession,
    limit: int = 10000,
) -> list[SitemapEntry]:
    """Generate sitemap entries for all public events."""
    from app.models.event import Event

    entries = [
        SitemapEntry(loc=BASE_URL, lastmod=datetime.now(timezone.utc).strftime("%Y-%m-%d"), changefreq="daily", priority=1.0),
    ]

    # Category pages
    for category in CATEGORY_LABELS:
        entries.append(SitemapEntry(
            loc=f"{BASE_URL}/events?category={category}",
            lastmod=datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            changefreq="daily",
            priority=0.8,
        ))

    # Event pages
    events_result = await db.execute(
        select(Event.id, Event.updated_at)
        .where(Event.status == "published")
        .order_by(Event.updated_at.desc())
        .limit(limit)
    )

    for row in events_result.all():
        lastmod = row.updated_at.strftime("%Y-%m-%d") if row.updated_at else datetime.now(timezone.utc).strftime("%Y-%m-%d")
        entries.append(SitemapEntry(
            loc=f"{BASE_URL}/events/{row.id}",
            lastmod=lastmod,
            changefreq="weekly",
            priority=0.7,
        ))

    return entries


def render_sitemap_xml(entries: list[SitemapEntry]) -> str:
    """Render sitemap entries as XML string."""
    lines = ['<?xml version="1.0" encoding="UTF-8"?>']
    lines.append('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">')

    for entry in entries:
        lines.append("  <url>")
        lines.append(f"    <loc>{entry.loc}</loc>")
        lines.append(f"    <lastmod>{entry.lastmod}</lastmod>")
        lines.append(f"    <changefreq>{entry.changefreq}</changefreq>")
        lines.append(f"    <priority>{entry.priority}</priority>")
        lines.append("  </url>")

    lines.append("</urlset>")
    return "\n".join(lines)
