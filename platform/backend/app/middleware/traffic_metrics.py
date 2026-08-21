"""Traffic classification metrics middleware — P2-13: AI Traffic Monitoring.

Classifies each request and records Prometheus counters by traffic class.
Includes anomaly detection: warns if bot ratio exceeds threshold in a sliding window.
"""

from __future__ import annotations

import collections
import logging
import time

from starlette.types import ASGIApp, Receive, Scope, Send

from app.services.traffic_classifier import TrafficClass, classify_request

logger = logging.getLogger(__name__)

# ── Prometheus metrics (graceful fallback if prometheus_client not installed) ─

try:
    from prometheus_client import Counter as _Counter
except ModuleNotFoundError:
    class _Metric:
        def labels(self, **kwargs):
            return self

        def inc(self):
            return None

    def _Counter(*args, **kwargs):
        return _Metric()


TRAFFIC_CLASS_COUNTER = _Counter(
    "pickket_requests_by_class_total",
    "Total HTTP requests by traffic class",
    ["traffic_class"],
)

# ── Anomaly detection: sliding window for bot ratio ──────────────────────────

_ANOMALY_WINDOW_SECONDS = 300  # 5 minutes
_BOT_RATIO_THRESHOLD = 0.20  # 20%
_ALERT_COOLDOWN_SECONDS = 300  # Don't re-alert within 5 minutes
_MIN_REQUESTS_FOR_ALERT = 50  # Need enough data to avoid false positives

_request_log: collections.deque[tuple[float, TrafficClass]] = collections.deque()
_anomaly_alerts: collections.deque[dict] = collections.deque(maxlen=100)
_last_alert_time: float = 0.0


def _record_and_check_anomaly(traffic_class: TrafficClass) -> None:
    """Record a classified request and check for bot ratio anomaly."""
    global _last_alert_time

    now = time.monotonic()
    _request_log.append((now, traffic_class))

    # Trim entries outside the window
    cutoff = now - _ANOMALY_WINDOW_SECONDS
    while _request_log and _request_log[0][0] < cutoff:
        _request_log.popleft()

    # Check cooldown
    if now - _last_alert_time < _ALERT_COOLDOWN_SECONDS:
        return

    total = len(_request_log)
    if total < _MIN_REQUESTS_FOR_ALERT:
        return

    bot_count = sum(1 for _, cls in _request_log if cls == TrafficClass.BOT)
    bot_ratio = bot_count / total

    if bot_ratio > _BOT_RATIO_THRESHOLD:
        _last_alert_time = now
        alert = {
            "timestamp": time.time(),
            "bot_ratio": round(bot_ratio, 4),
            "bot_count": bot_count,
            "total_requests": total,
            "window_seconds": _ANOMALY_WINDOW_SECONDS,
            "message": (
                f"봇 트래픽 비율 경고: {bot_ratio:.1%} "
                f"({bot_count}/{total} requests in {_ANOMALY_WINDOW_SECONDS}s)"
            ),
        }
        _anomaly_alerts.append(alert)
        logger.warning(
            "Traffic anomaly detected: bot ratio %.1f%% (%d/%d) in %ds window",
            bot_ratio * 100,
            bot_count,
            total,
            _ANOMALY_WINDOW_SECONDS,
        )


def get_anomaly_alerts() -> list[dict]:
    """Return recent anomaly alerts (up to 100)."""
    return list(_anomaly_alerts)


def get_traffic_breakdown() -> dict:
    """Get traffic breakdown for the current sliding window.

    Returns counts and ratios for each traffic class across
    different time windows (5min, 1h, 24h — approximated from in-memory data).
    """
    now = time.monotonic()

    windows = {
        "5min": 300,
        "1h": 3600,
        "24h": 86400,
    }

    result = {}
    for window_name, window_seconds in windows.items():
        cutoff = now - window_seconds
        entries = [(ts, cls) for ts, cls in _request_log if ts >= cutoff]
        total = len(entries)

        counts = {tc.value: 0 for tc in TrafficClass}
        for _, cls in entries:
            counts[cls.value] += 1

        ratios = {
            k: round(v / total, 4) if total > 0 else 0.0
            for k, v in counts.items()
        }

        result[window_name] = {
            "total": total,
            "counts": counts,
            "ratios": ratios,
        }

    return result


class TrafficMetricsMiddleware:
    """Pure ASGI middleware that classifies requests and tracks traffic metrics."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")

        # Skip metrics/health endpoints to avoid self-counting
        if path in ("/metrics", "/health", "/health/live", "/health/ready"):
            await self.app(scope, receive, send)
            return

        # Build a minimal request object for classification
        from starlette.requests import Request

        request = Request(scope)
        traffic_class = classify_request(request)

        # Store in request scope for downstream access
        scope.setdefault("state", {})
        if hasattr(request, "state"):
            request.state.traffic_class = traffic_class

        # Increment Prometheus counter
        TRAFFIC_CLASS_COUNTER.labels(traffic_class=traffic_class.value).inc()

        # Record for anomaly detection
        _record_and_check_anomaly(traffic_class)

        await self.app(scope, receive, send)
