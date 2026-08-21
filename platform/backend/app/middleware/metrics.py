import asyncio
import collections
import ipaddress
import logging
import re
import time
from contextlib import contextmanager

from starlette.requests import Request
from starlette.responses import Response

_metrics_logger = logging.getLogger(__name__)

try:
    from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest
except ModuleNotFoundError:
    CONTENT_TYPE_LATEST = "text/plain; version=0.0.4; charset=utf-8"

    class _Metric:
        def labels(self, **kwargs):
            return self

        def inc(self):
            return None

        def dec(self):
            return None

        def observe(self, value):
            return None

    def Counter(*args, **kwargs):
        return _Metric()

    def Histogram(*args, **kwargs):
        return _Metric()

    def Gauge(*args, **kwargs):
        return _Metric()

    def generate_latest():
        return b""


REQUEST_COUNT = Counter(
    "http_requests_total",
    "Total HTTP requests",
    ["method", "endpoint", "status_code"],
)

REQUEST_LATENCY = Histogram(
    "http_request_duration_seconds",
    "HTTP request latency in seconds",
    ["method", "endpoint"],
    buckets=[0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0],
)

ACTIVE_REQUESTS = Gauge(
    "http_active_requests",
    "Currently active HTTP requests",
)

# ── Business & Infrastructure Metrics ──

DB_QUERY_DURATION = Histogram(
    "db_query_duration_seconds",
    "Database query execution time in seconds",
    ["operation"],
    buckets=[0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5],
)

CELERY_TASK_DURATION = Histogram(
    "celery_task_duration_seconds",
    "Celery task execution time in seconds",
    ["task_name", "status"],
    buckets=[0.1, 0.5, 1.0, 5.0, 10.0, 30.0, 60.0, 120.0],
)

CELERY_TASKS_TOTAL = Counter(
    "celery_tasks_total",
    "Total Celery tasks executed",
    ["task_name", "status"],
)

TICKETS_SOLD_TOTAL = Counter(
    "tickets_sold_total",
    "Total tickets sold",
    ["event_id"],
)

# T1-2(F1): go→v2 phase-transition (mode×status) 매핑 결과 계측.
# outcome: mapped | unmapped | gated(flag OFF 로 전파 보류)
PHASE_TRANSITION_TOTAL = Counter(
    "phase_transition_total",
    "go→v2 phase-transition mapping outcomes",
    ["phase", "status", "outcome"],
)

ACTIVE_BIDS = Gauge(
    "active_bids_total",
    "Currently active bids",
)

CACHE_HITS = Counter(
    "cache_hits_total",
    "Total cache hits",
    ["key_prefix"],
)

CACHE_MISSES = Counter(
    "cache_misses_total",
    "Total cache misses",
    ["key_prefix"],
)

PAYMENT_TOTAL = Counter(
    "payment_total",
    "Total payment transactions",
    ["status", "provider"],
)

# ── Stage 6: Business Metrics ──

BOOKING_TOTAL = Counter(
    "booking_total",
    "Total booking attempts",
    ["result"],  # success, failed, expired
)

PAYMENT_CONFIRM_DURATION = Histogram(
    "payment_confirm_duration_seconds",
    "Payment confirmation latency",
    buckets=[0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0],
)

RESALE_MATCH_TOTAL = Counter(
    "resale_match_total",
    "Total resale order matches",
    ["result"],  # matched, no_match, self_trade_blocked, wash_trade_blocked
)

RESALE_MATCH_DURATION = Histogram(
    "resale_match_duration_seconds",
    "Resale matching cycle duration",
    buckets=[0.01, 0.05, 0.1, 0.5, 1.0, 5.0],
)

QUEUE_JOIN_TOTAL = Counter(
    "queue_join_total",
    "Total queue join attempts",
    ["result"],  # success, failed, rate_limited
)

QUEUE_ACTIVE_USERS = Gauge(
    "queue_active_users",
    "Currently active users in queue",
    ["event_id"],
)

WEBHOOK_RECEIVED_TOTAL = Counter(
    "webhook_received_total",
    "Total webhooks received",
    ["status"],  # valid, invalid_signature, expired_timestamp, duplicate
)

RECONCILIATION_MISMATCHES_TOTAL = Counter(
    "reconciliation_mismatches_total",
    "Total reconciliation mismatches found",
)

RECONCILIATION_CHECKED_TOTAL = Counter(
    "reconciliation_checked_total",
    "Total orders checked in reconciliation",
)

TRANSFER_TOTAL = Counter(
    "transfer_total",
    "Total ticket transfers",
    ["result"],  # success, failed, expired
)

KILL_SWITCH_BLOCKED_TOTAL = Counter(
    "kill_switch_blocked_total",
    "Requests blocked by kill switches",
    ["feature"],  # resale, queue, new_payment_flow
)

AUTH_FAILURE_TOTAL = Counter(
    "auth_failure_total",
    "Authentication/authorization failures",
    ["reason"],  # invalid_token, expired, forbidden, rate_limited
)


@contextmanager
def track_db_query(operation: str = "query"):
    """Context manager to track DB query duration."""
    start = time.perf_counter()
    try:
        yield
    finally:
        duration = time.perf_counter() - start
        DB_QUERY_DURATION.labels(operation=operation).observe(duration)


# ── Error Rate Alerting ─────────────────────────────────────────────────────

# Sliding-window error rate tracker (5-minute window, per-second buckets)
_ERROR_WINDOW_SECONDS = 300
_ERROR_RATE_THRESHOLD = 0.05  # 5%
_ALERT_COOLDOWN_SECONDS = 600  # Don't re-alert within 10 minutes

_request_counts: collections.deque[tuple[float, bool]] = collections.deque()
_last_alert_time: float = 0.0


def _record_request(is_error: bool) -> None:
    """Record a request outcome in the sliding window."""
    now = time.monotonic()
    _request_counts.append((now, is_error))
    # Trim entries outside the window
    cutoff = now - _ERROR_WINDOW_SECONDS
    while _request_counts and _request_counts[0][0] < cutoff:
        _request_counts.popleft()


async def _check_error_rate_alert() -> None:
    """Check error rate and fire a non-blocking Telegram alert if threshold exceeded."""
    global _last_alert_time

    from app.core.config import settings

    if not settings.TELEGRAM_BOT_TOKEN or not settings.TELEGRAM_CHAT_ID:
        return

    now = time.monotonic()
    if now - _last_alert_time < _ALERT_COOLDOWN_SECONDS:
        return

    if len(_request_counts) < 20:
        # Need at least 20 requests in the window to avoid false positives
        return

    error_count = sum(1 for _, is_err in _request_counts if is_err)
    total = len(_request_counts)
    error_rate = error_count / total if total > 0 else 0.0

    if error_rate < _ERROR_RATE_THRESHOLD:
        return

    _last_alert_time = now

    # Fire non-blocking Telegram alert (best-effort, never blocks request processing)
    asyncio.ensure_future(
        _send_telegram_error_alert(
            error_rate=error_rate,
            error_count=error_count,
            total=total,
        )
    )


async def _send_telegram_error_alert(
    *,
    error_rate: float,
    error_count: int,
    total: int,
) -> None:
    """Send error rate alert via Telegram Bot API. Non-blocking, best-effort."""
    try:
        import httpx

        from app.core.config import settings

        chat_id = settings.TELEGRAM_CHAT_CRITICAL or settings.TELEGRAM_CHAT_ID
        # Skip the network call entirely when Telegram is not configured.
        # Avoids a pointless POST to .../botNone/sendMessage (and, in tests, a
        # stray background HTTP task that outlives the request).
        if not settings.TELEGRAM_BOT_TOKEN or not chat_id:
            return
        text = (
            f"\U0001f6a8 <b>[CRITICAL] API Error Rate Alert</b>\n\n"
            f"\u2022 <b>Error rate</b>: <b>{error_rate:.1%}</b> "
            f"({error_count}/{total} requests in 5min)\n"
            f"\u2022 <b>Threshold</b>: {_ERROR_RATE_THRESHOLD:.0%}\n"
            f"\u2022 <b>Environment</b>: <code>{settings.ENVIRONMENT}</code>"
        )
        url = f"https://api.telegram.org/bot{settings.TELEGRAM_BOT_TOKEN}/sendMessage"
        payload = {
            "chat_id": chat_id,
            "text": text,
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
        async with httpx.AsyncClient(timeout=5.0) as client:
            await client.post(url, json=payload)
    except Exception:
        _metrics_logger.debug("Failed to send error rate Telegram alert", exc_info=True)


_UUID_RE = re.compile(
    r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
)


class PrometheusMiddleware:
    """Pure ASGI middleware for Prometheus metrics collection."""

    def __init__(self, app):  # noqa: ANN001
        self.app = app

    async def __call__(self, scope, receive, send):  # noqa: ANN001
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        path = scope.get("path", "")
        if path == "/metrics":
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "GET")
        normalized_path = _UUID_RE.sub("{id}", path)

        ACTIVE_REQUESTS.inc()
        start = time.perf_counter()
        status_code = "500"

        async def send_wrapper(message):  # noqa: ANN001
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = str(message.get("status", 500))
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception:
            status_code = "500"
            raise
        finally:
            duration = time.perf_counter() - start
            ACTIVE_REQUESTS.dec()
            REQUEST_COUNT.labels(method=method, endpoint=normalized_path, status_code=status_code).inc()
            REQUEST_LATENCY.labels(method=method, endpoint=normalized_path).observe(duration)

            is_error = status_code.startswith("5")
            _record_request(is_error)
            if is_error:
                try:
                    await _check_error_rate_alert()
                except Exception:
                    logger.debug("Failed to evaluate error rate alert", exc_info=True)


def _is_allowed_metrics_client(client_ip: str) -> bool:
    """Check if client IP is in the allowed CIDR ranges for metrics access."""
    from app.core.config import settings

    try:
        addr = ipaddress.ip_address(client_ip)
    except ValueError:
        return False
    for cidr_str in settings.METRICS_ALLOWED_CIDRS.split(","):
        cidr_str = cidr_str.strip()
        if not cidr_str:
            continue
        try:
            if addr in ipaddress.ip_network(cidr_str, strict=False):
                return True
        except ValueError:
            continue
    return False


def metrics_endpoint(request: Request) -> Response:
    """Expose Prometheus metrics -- restricted to allowed CIDRs."""
    client_ip = request.client.host if request.client else ""
    if not _is_allowed_metrics_client(client_ip):
        return Response(status_code=403, content="Forbidden")
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
