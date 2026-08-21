"""Domain configuration service — resolves code defaults + DB overrides with in-memory cache."""

import json
import time
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.domain_defaults import get_domain_defaults
from app.models.domain_config import DomainConfig

CACHE_TTL_SECONDS = 300  # 5 minutes

_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _cache_get(domain: str) -> dict[str, Any] | None:
    entry = _cache.get(domain)
    if entry and (time.monotonic() - entry[0]) < CACHE_TTL_SECONDS:
        return entry[1]
    return None


def _cache_set(domain: str, config: dict[str, Any]) -> None:
    _cache[domain] = (time.monotonic(), config)


def invalidate_cache(domain: str | None = None) -> None:
    if domain:
        _cache.pop(domain, None)
    else:
        _cache.clear()


async def get_domain_config(db: AsyncSession, domain: str) -> dict[str, Any]:
    """Get merged domain config (code defaults + DB overrides)."""
    cached = _cache_get(domain)
    if cached is not None:
        return cached

    # Start with code defaults
    config = dict(get_domain_defaults(domain))

    # Apply DB overrides
    result = await db.execute(select(DomainConfig).where(DomainConfig.domain == domain))
    overrides = result.scalars().all()
    for override in overrides:
        try:
            config[override.config_key] = json.loads(override.config_value)
        except json.JSONDecodeError:
            config[override.config_key] = override.config_value

    _cache_set(domain, config)
    return config


async def set_domain_config(db: AsyncSession, domain: str, key: str, value: Any) -> DomainConfig:
    """Set or update a domain config override."""
    result = await db.execute(
        select(DomainConfig).where(
            DomainConfig.domain == domain,
            DomainConfig.config_key == key,
        )
    )
    existing = result.scalar_one_or_none()

    serialized = json.dumps(value) if not isinstance(value, str) else value

    if existing:
        existing.config_value = serialized
    else:
        existing = DomainConfig(
            domain=domain,
            config_key=key,
            config_value=serialized,
        )
        db.add(existing)

    await db.flush()
    invalidate_cache(domain)
    return existing
