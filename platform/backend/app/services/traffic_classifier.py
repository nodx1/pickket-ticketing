"""AI traffic classifier — classifies requests into HUMAN / AUTH_AGENT / BROKER / BOT.

Part of P2-13: AI Traffic Monitoring.
"""

from __future__ import annotations

import enum
import logging
import re

from fastapi import Request

logger = logging.getLogger(__name__)

# ── Known bot User-Agent patterns ────────────────────────────────────────────

_BOT_UA_PATTERNS: list[re.Pattern[str]] = [
    re.compile(p, re.IGNORECASE)
    for p in [
        r"bot[/\s;)]",
        r"spider",
        r"crawl",
        r"scrapy",
        r"headless",
        r"phantomjs",
        r"selenium",
        r"puppeteer",
        r"playwright",
        r"wget",
        r"curl[/\s]",
        r"python-requests",
        r"httpx",
        r"aiohttp",
        r"go-http-client",
        r"java/",
        r"libwww-perl",
        r"node-fetch",
        r"axios/",
        r"okhttp",
        r"googlebot",
        r"bingbot",
        r"yandexbot",
        r"baiduspider",
        r"slurp",
        r"duckduckbot",
        r"facebookexternalhit",
        r"twitterbot",
        r"applebot",
        r"semrushbot",
        r"ahrefsbot",
        r"dotbot",
        r"mj12bot",
    ]
]

# Patterns indicating a real browser
_BROWSER_UA_PATTERNS: list[re.Pattern[str]] = [
    re.compile(p, re.IGNORECASE)
    for p in [
        r"mozilla/5\.0",
        r"chrome/",
        r"firefox/",
        r"safari/",
        r"edg/",
        r"opera/",
    ]
]


class TrafficClass(str, enum.Enum):
    """Traffic classification types."""

    HUMAN = "human"
    AUTH_AGENT = "agent"
    BROKER = "broker"
    BOT = "bot"


def classify_request(request: Request) -> TrafficClass:
    """Classify an incoming request into a traffic category.

    Classification priority (first match wins):
    1. Authorization header with delegation token type → AUTH_AGENT
    2. X-API-Key header present → BROKER (partner API)
    3. Bot-like User-Agent → BOT
    4. Missing/empty User-Agent → BOT
    5. Normal browser User-Agent → HUMAN
    """

    # 1. Check for AI agent delegation token
    auth_header = request.headers.get("authorization", "")
    if auth_header:
        # Delegation tokens include type=delegation in the JWT payload,
        # but we can also check the X-Delegation-Token header pattern
        if request.headers.get("x-delegation-token"):
            return TrafficClass.AUTH_AGENT
        # Check if request state has delegation info (set by delegation middleware)
        if hasattr(request.state, "delegation") and request.state.delegation:
            return TrafficClass.AUTH_AGENT

    # 2. Check for partner API key → BROKER
    if request.headers.get("x-api-key"):
        return TrafficClass.BROKER

    # 3. Check User-Agent for bot patterns
    user_agent = request.headers.get("user-agent", "")

    if not user_agent or len(user_agent) < 10:
        return TrafficClass.BOT

    # Check known bot patterns
    for pattern in _BOT_UA_PATTERNS:
        if pattern.search(user_agent):
            return TrafficClass.BOT

    # 4. Normal browser
    for pattern in _BROWSER_UA_PATTERNS:
        if pattern.search(user_agent):
            return TrafficClass.HUMAN

    # Unknown UA — default to bot
    return TrafficClass.BOT
