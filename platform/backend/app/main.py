import asyncio
import hmac
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, ORJSONResponse
from starlette.routing import Route

from app.core.config import settings
from app.core.logging_config import setup_logging
from app.core.redis import init_redis, close_redis
from app.core.event_bus import EventBus
from app.api.v1.router import api_router
from app.middleware.metrics import PrometheusMiddleware, metrics_endpoint
from app.middleware.request_id import RequestIdMiddleware
from app.middleware.rate_limit import general_limiter, extract_client_ip
from app.middleware.cache_control import CacheControlMiddleware
from app.middleware.csrf import csrf_middleware, CSRFMiddleware
from app.middleware.traffic_metrics import TrafficMetricsMiddleware
from app.middleware.slo_tracker import SLOTrackerMiddleware

logger = logging.getLogger(__name__)


async def _warmup_cache():
    """Warm up Redis cache after server starts."""
    await asyncio.sleep(2)  # Wait for server to be ready
    try:
        import httpx

        async with httpx.AsyncClient(base_url="http://127.0.0.1:8000", timeout=10) as client:
            for path in ["/api/v1/events/trending", "/api/v1/events/featured", "/api/v1/events/categories"]:
                try:
                    await client.get(path)
                except Exception:
                    logger.debug("cache warmup failed for path %s", path, exc_info=True)
        logger.info("Cache warmup complete")
    except Exception:
        logger.debug("Cache warmup skipped")

async def _sync_inventory_counters():
    """Sync Redis inventory counters from DB for all active sale tiers.

    Runs once at startup, then periodically every 10 minutes to correct
    any drift caused by Redis failures, manual DB edits, or missed releases.
    """
    await asyncio.sleep(3)  # Wait for DB + Redis to be ready
    while True:
        try:
            from app.core.database import async_session
            from app.models.event import Event, EventStatus, SeatTier
            from app.models.order import Order, OrderStatus
            from app.services import inventory_service
            from sqlalchemy import func, select

            async with async_session() as session:
                tiers = (await session.execute(
                    select(SeatTier).join(Event).where(
                        Event.status.in_([EventStatus.BIDDING_OPEN, EventStatus.ALLOCATED, EventStatus.APPROVED])
                    )
                )).scalars().all()

                # #15: count in-flight reservations per tier — PENDING orders
                # have DECR'd the Redis counter but are not yet in sold_count.
                # Reconciling without subtracting these would restore the
                # in-flight holds into the counter and cause over-acceptance.
                tier_ids = [t.id for t in tiers]
                in_flight_map: dict = {}
                if tier_ids:
                    rows = (await session.execute(
                        select(Order.tier_id, func.coalesce(func.sum(Order.quantity), 0))
                        .where(
                            Order.tier_id.in_(tier_ids),
                            Order.status == OrderStatus.PENDING,
                        )
                        .group_by(Order.tier_id)
                    )).all()
                    in_flight_map = {tid: int(qty) for tid, qty in rows}

                for tier in tiers:
                    await inventory_service.reconcile_from_db(
                        tier.id,
                        tier.capacity,
                        tier.sold_count,
                        in_flight=in_flight_map.get(tier.id, 0),
                    )
                logger.info("Inventory counters reconciled for %d active tiers", len(tiers))

            # 캐시 워밍 — 판매 중 이벤트 상세 + 홈 리스트 미리 채움
            try:
                from app.core.redis import cache_get_json, cache_set_json
                from sqlalchemy.orm import selectinload

                async with async_session() as session:
                    # 판매 중 이벤트 상세 캐시 워밍
                    events = (await session.execute(
                        select(Event)
                        .where(Event.status.in_([EventStatus.BIDDING_OPEN, EventStatus.APPROVED]))
                        .options(selectinload(Event.seat_tiers), selectinload(Event.organizer))
                    )).scalars().all()

                    warmed = 0
                    for event in events:
                        cache_key = f"events:detail:{event.id}"
                        if await cache_get_json(cache_key) is None:
                            from app.schemas.event import EventResponse
                            try:
                                data = EventResponse.model_validate(event).model_dump(mode="json")
                                await cache_set_json(cache_key, data, ttl=180)
                                warmed += 1
                            except Exception:
                                logger.debug("cache warmup failed for event %s", event.id, exc_info=True)
                    if warmed:
                        logger.info("Cache warmed for %d active events", warmed)
            except Exception:
                logger.debug("Cache warming failed — non-critical", exc_info=True)
        except Exception:
            logger.warning("Inventory counter sync failed — will use DB fallback", exc_info=True)
        await asyncio.sleep(600)  # Re-sync every 10 minutes


_DEVLIKE_ENVS = {"development", "test"}
_api_docs_enabled = settings.ENVIRONMENT in _DEVLIKE_ENVS or settings.ENABLE_API_DOCS
_metrics_enabled = settings.ENVIRONMENT in _DEVLIKE_ENVS or settings.ENABLE_METRICS_ENDPOINT


@asynccontextmanager
async def lifespan(app: FastAPI):
    if settings.SENTRY_DSN:
        import sentry_sdk
        from sentry_sdk.integrations.fastapi import FastApiIntegration
        from sentry_sdk.integrations.starlette import StarletteIntegration

        def _strip_pii(event, _hint):
            """Strip PII from error events before sending."""
            request_info = event.get("request", {})
            if request_info:
                request_info.pop("cookies", None)
                headers = request_info.get("headers", {})
                if isinstance(headers, dict):
                    for h in ("authorization", "cookie", "set-cookie", "x-forwarded-for"):
                        headers.pop(h, None)
                        headers.pop(h.title(), None)
                if "env" in request_info:
                    request_info["env"].pop("REMOTE_ADDR", None)
            user_info = event.get("user", {})
            if user_info:
                for field in ("email", "ip_address", "username", "phone", "name"):
                    user_info.pop(field, None)
            return event

        def _sentry_before_send(event, hint):
            """PII 제거 + 비즈니스 컨텍스트 태깅 + 반복 에러 핑거프린트."""
            event = _strip_pii(event, hint)
            if event is None:
                return None

            request_info = event.get("request", {})
            url = request_info.get("url", "")
            path = url.split("?")[0] if url else ""

            domain_tags = {
                "/purchase": "payment",
                "/payment": "payment",
                "/portone": "payment",
                "/checkin": "checkin",
                "/auth": "auth",
                "/tickets": "ticket",
                "/transfer": "transfer",
                "/events": "event",
                "/queue": "queue",
                "/resale": "resale",
            }
            matched_domain = None
            for pattern, domain in domain_tags.items():
                if pattern in path:
                    event.setdefault("tags", {})["business_domain"] = domain
                    matched_domain = domain
                    break

            import re
            uuid_match = re.search(
                r"/events/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})",
                path,
            )
            if uuid_match:
                event.setdefault("tags", {})["event_id"] = uuid_match.group(1)

            # §29 P1: Sentry fingerprint — 반복적인 에러 패턴을 그룹핑
            exc_info = hint.get("exc_info") if hint else None
            exc_type_name = exc_info[0].__name__ if exc_info and exc_info[0] else ""

            # 결제/PG 실패 → domain + exc_type 으로 그룹
            if matched_domain == "payment":
                event["fingerprint"] = ["payment-error", exc_type_name or "{{ default }}"]
            # 웹훅 전송 실패
            elif "/webhook" in path or "webhook" in exc_type_name.lower():
                event["fingerprint"] = ["webhook-delivery-error", "{{ default }}"]
            # 레이트 리밋 (429)
            elif event.get("tags", {}).get("status_code") == "429" or (
                request_info.get("method") and "rate" in path.lower()
            ):
                event["fingerprint"] = ["rate-limit-exceeded", path]
            # 외부 서비스 타임아웃/연결 실패
            elif exc_type_name in (
                "TimeoutException", "ConnectError", "ConnectTimeout",
                "ReadTimeout", "ConnectionError",
            ):
                event["fingerprint"] = ["external-service-timeout", matched_domain or path]
            # OAuth 에러
            elif matched_domain == "auth" and exc_type_name:
                event["fingerprint"] = ["auth-error", exc_type_name]

            try:
                level = event.get("level")
                if level in ("error", "fatal"):
                    import time as _t
                    _now = _t.time()
                    _event_id = event.get("event_id", "")

                    async def _record_error_async() -> None:
                        # Use the existing async Redis pool — never block the
                        # Sentry before_send hook on a synchronous Redis round-trip.
                        try:
                            from app.core.redis import get_redis
                            _rc = get_redis()
                            await _rc.zadd("v2:health:errors:24h", {f"{_now}:{_event_id}": _now})
                            await _rc.expire("v2:health:errors:24h", 90000)
                        except Exception:
                            pass

                    # Schedule on the running loop without awaiting. In a Celery
                    # / non-async context there is no running loop → RuntimeError.
                    try:
                        import asyncio as _asyncio
                        _asyncio.get_running_loop().create_task(_record_error_async())
                    except RuntimeError:
                        pass
            except Exception:
                pass

            return event

        sentry_sdk.init(
            dsn=settings.SENTRY_DSN,
            traces_sample_rate=settings.SENTRY_TRACES_SAMPLE_RATE,
            environment=settings.SENTRY_ENVIRONMENT or settings.ENVIRONMENT,
            release=f"pickket-api@{settings.VERSION}",
            send_default_pii=False,
            before_send=_sentry_before_send,
            integrations=[
                FastApiIntegration(transaction_style="endpoint"),
                StarletteIntegration(transaction_style="endpoint"),
            ],
        )
        logger.info("Sentry initialized (env=%s)", settings.SENTRY_ENVIRONMENT or settings.ENVIRONMENT)
    # OpenTelemetry tracing (before logging to capture traces early)
    if settings.OTEL_ENABLED:
        from app.core.telemetry import setup_telemetry

        setup_telemetry()
    setup_logging()
    logger.info("Starting %s v%s", settings.PROJECT_NAME, settings.VERSION)
    try:
        await init_redis()
        asyncio.create_task(_warmup_cache())
        asyncio.create_task(_sync_inventory_counters())
    except Exception:
        logger.warning("Redis not available at startup, continuing without it")

    # EventBus (SNS) — initialize only if any topic ARN is configured
    _sqs_task = None
    try:
        if any([settings.SNS_ORDER_TOPIC_ARN, settings.SNS_PAYMENT_TOPIC_ARN,
                settings.SNS_TICKET_TOPIC_ARN, settings.SNS_SEAT_TOPIC_ARN]):
            await EventBus.initialize()
            logger.info("EventBus initialized")
    except Exception:
        logger.warning("EventBus/SQS initialization skipped (not configured)")

    try:
        queue_urls = [url for url in [
            settings.SQS_ORDER_PROCESSING_URL,
            settings.SQS_PAYMENT_PROCESSING_URL,
            settings.SQS_SEAT_SYNC_URL,
            settings.SQS_TICKET_NOTIFICATIONS_URL,
        ] if url]
        if queue_urls:
            from app.tasks.sqs_consumer import create_consumer
            _sqs_consumer = create_consumer()
            _sqs_task = asyncio.create_task(_sqs_consumer.start(queue_urls))
            logger.info("SQS Consumer started for %d queues", len(queue_urls))
    except Exception:
        logger.warning("SQS consumer initialization skipped (not configured)")

    yield

    # Shutdown
    if _sqs_task and not _sqs_task.done():
        from app.tasks.sqs_consumer import create_consumer
        create_consumer().stop()
        _sqs_task.cancel()
    await EventBus.close()
    await close_redis()
    logger.info("Shutdown complete")


app = FastAPI(
    title=settings.PROJECT_NAME,
    version=settings.VERSION,
    description="AI-powered fair ticket allocation engine with 5 sale modes",
    docs_url="/docs" if _api_docs_enabled else None,
    redoc_url="/redoc" if _api_docs_enabled else None,
    openapi_url="/openapi.json" if _api_docs_enabled else None,
    default_response_class=ORJSONResponse,
    lifespan=lifespan,
)

from app.middleware.error_handler import register_error_handlers
register_error_handlers(app)

# CORS — use comma-separated origins from settings
cors_origins = settings.cors_origins_list  # 콤마구분/JSON배열 모두 지원 (config.cors_origins_list)

app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Request-ID", "X-Idempotency-Key", "X-Behavior-Token", "X-Behavior-Session", "X-Screen-Info", "X-Timezone", "X-Device-Fingerprint", "X-Client-Type", "X-CSRF-Token", "X-Terminal-Key", "sentry-trace", "baggage"],
)
app.add_middleware(CacheControlMiddleware)
app.add_middleware(GZipMiddleware, minimum_size=500)
app.add_middleware(RequestIdMiddleware)
app.add_middleware(PrometheusMiddleware)
app.add_middleware(SLOTrackerMiddleware)
app.add_middleware(TrafficMetricsMiddleware)

# AUDIT §27 P0: Origin/Referer validation middleware for state-changing requests.
# Enforced in production only. Applies to cookie-authenticated paths; Bearer token
# and non-cookie requests are skipped (CORS preflight already guards those).
# Registered as class-based middleware BEFORE the double-submit token check.
app.add_middleware(CSRFMiddleware, allowed_origins=cors_origins)

# CSRF protection — double-submit cookie. Applies to cookie-authenticated
# unsafe-method requests only. Registered before the combined api_middleware
# so that 403s short-circuit rate limiting and security-header work.
app.middleware("http")(csrf_middleware)


@app.middleware("http")
async def request_timeout_middleware(request: Request, call_next):
    """Kill requests that take longer than 30 seconds."""
    # Skip timeout for SSE streaming endpoints and health check
    if "/stream/" in request.url.path or request.url.path.startswith("/health"):
        return await call_next(request)
    try:
        return await asyncio.wait_for(call_next(request), timeout=30.0)
    except asyncio.TimeoutError:
        return JSONResponse(
            status_code=504,
            content={"detail": "Request timeout"},
        )


_SKIP_RATE_LIMIT_PATHS = {
    "/health", "/health/live", "/health/ready",
    "/metrics", "/docs", "/redoc", "/openapi.json",
}


@app.middleware("http")
async def api_middleware(request: Request, call_next):
    """Combined middleware: body size limit, rate limiting, security headers."""
    # 1. Body size check
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            if int(content_length) > 10 * 1024 * 1024:  # 10MB
                return JSONResponse(status_code=413, content={"detail": "Request body too large"})
        except ValueError:
            return JSONResponse(
                status_code=400, content={"detail": "Invalid Content-Length header"}
            )

    # 2. Rate limiting (skip for health/docs/OPTIONS)
    #
    # 🔴 서버간(service-to-service) 호출은 IP 리밋 대상이 아니다.
    #    general_limiter 는 `extract_client_ip` 기준인데, go(organizer)·consumer 컨테이너에서 오는
    #    내부 호출은 **전부 같은 컨테이너 IP** 라 앱 하나가 버킷 전체를 공유한다.
    #    특히 `/auth/verify-token` 은 organizer 가 **매 요청마다** 호출하므로 즉시 소진되고,
    #    그 결과 세션 해석이 실패해 **로그인 직후 자동 로그아웃**이 된다(2026-07-27 prod 실장애).
    #    이 호출들은 `X-Pickket-Service-Token`(INTERNAL_SERVICE_TOKEN) 으로 **이미 인증**되며
    #    소비자 트래픽이 아니다 — 소비자용 IP 리밋을 적용하는 것 자체가 설계 오류다.
    #    토큰 비교는 timing-safe. 토큰이 없거나 틀리면 종전대로 IP 리밋을 받는다.
    _svc_token = request.headers.get("x-pickket-service-token", "")
    _expected_svc = settings.internal_service_token or ""
    is_internal_service_call = bool(
        _svc_token and _expected_svc and hmac.compare_digest(_svc_token, _expected_svc)
    )

    remaining = -1
    skip_rate_limit = (
        request.url.path in _SKIP_RATE_LIMIT_PATHS
        or request.method == "OPTIONS"
        or is_internal_service_call
    )
    if not skip_rate_limit:
        key = extract_client_ip(request)
        allowed, remaining = await general_limiter.check(key)
        if not allowed:
            headers: dict[str, str] = {"Retry-After": str(general_limiter.window)}
            # Ensure CORS headers on 429 so browsers don't mask the real error
            origin = request.headers.get("origin")
            if origin and origin in cors_origins:
                headers["Access-Control-Allow-Origin"] = origin
                headers["Access-Control-Allow-Credentials"] = "true"
            return JSONResponse(
                status_code=429,
                content={"detail": "Too many requests. Please try again later."},
                headers=headers,
            )

    response = await call_next(request)

    # 3. Rate limit header (only if we checked and response is not CDN-cached)
    if not skip_rate_limit and not request.scope.get("_pickket_cdn_cached", False):
        response.headers["X-RateLimit-Remaining"] = str(remaining)

    # 4. Security headers
    if "X-Powered-By" in response.headers:
        del response.headers["X-Powered-By"]
    if "Server" in response.headers:
        del response.headers["Server"]
    if (
        "access-control-allow-credentials" in response.headers
        and "access-control-allow-origin" not in response.headers
    ):
        del response.headers["access-control-allow-credentials"]
    response.headers.setdefault("X-Content-Type-Options", "nosniff")
    response.headers.setdefault("X-Frame-Options", "DENY")
    response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
    response.headers.setdefault("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
    response.headers.setdefault("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
    response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
    response.headers.setdefault("Cross-Origin-Resource-Policy", "cross-origin")
    if request.url.path in {"/docs", "/redoc"}:
        # SwaggerUI/ReDoc 은 HTML 안에 인라인 <script> 로 부트스트랩하므로
        # 'unsafe-inline' 이 없으면 페이지가 빈 화면이 됨.
        # 개발용 문서 페이지에 한정해서 완화.
        response.headers.setdefault(
            "Content-Security-Policy",
            (
                "default-src 'self'; "
                "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
                "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
                "img-src 'self' data: https://fastapi.tiangolo.com; "
                "font-src 'self' data:; "
                "frame-ancestors 'none'"
            ),
        )
    if settings.ENVIRONMENT == "production":
        response.headers.setdefault(
            "Strict-Transport-Security",
            "max-age=63072000; includeSubDomains; preload",
        )
        response.headers.setdefault(
            "Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'"
        )
    return response


@app.exception_handler(429)
async def rate_limit_exception_handler(request: Request, exc):
    """Ensure 429 responses from route dependencies include CORS headers."""
    headers: dict[str, str] = {}
    origin = request.headers.get("origin")
    if origin and origin in cors_origins:
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Credentials"] = "true"
    return JSONResponse(
        status_code=429,
        content={"detail": getattr(exc, "detail", "Too many requests")},
        headers=headers,
    )


app.include_router(api_router, prefix=settings.API_V1_PREFIX)
if _metrics_enabled:
    app.routes.append(Route("/metrics", metrics_endpoint))

# Health check routes (liveness / readiness / legacy)
from app.api.health import health_router  # noqa: E402

app.include_router(health_router)

# 과업 WP6: 현장 단말·주최사 대시보드 실시간 게이트웨이(Socket.IO) — ws(s)://<api>/ws/socket.io/
from app.realtime.gateway import asgi_app as realtime_asgi_app  # noqa: E402

app.mount("/ws", realtime_asgi_app)
