"""CSRF protection via double-submit cookie pattern.

Protects cookie-authenticated state-changing requests. Uses a JS-readable
`pickket_csrf` cookie paired with a matching `X-CSRF-Token` header.

Scope:
  - Enforced on POST / PUT / DELETE / PATCH.
  - Skipped when the request is NOT cookie-authenticated (bearer header or
    non-authenticated public endpoints).
  - Skipped for explicit exemptions (webhooks, OAuth callbacks, CSRF issue).

Token issuance: `GET /api/v1/auth/csrf-token` (in app/api/v1/auth.py).
Client flow: fetch token on app boot → store in `pickket_csrf` cookie (JS-readable)
             → api client reads cookie and sets `X-CSRF-Token` on mutating requests.
"""

from __future__ import annotations

import secrets

from fastapi import Request, Response
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware

from app.core.config import settings

CSRF_COOKIE_NAME = "pickket_csrf"
CSRF_HEADER_NAME = "x-csrf-token"
_CSRF_TOKEN_BYTES = 32
_UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}

# Endpoints that are exempt from CSRF:
# - Webhooks/OAuth callbacks: signed by external systems, no browser involved
# - Auth flow entrypoints: establish/rotate/clear session, need to work without
#   prior CSRF cookie (e.g. first visit, refresh when access cookie gone)
# - Health/metrics: no state change
_EXEMPT_PATH_PREFIXES: tuple[str, ...] = (
    "/api/v1/webhooks/",
    "/api/v1/orders/webhooks/",
    "/api/v1/payments/nice/return",  # 나이스 returnUrl: 크로스사이트 POST(쿠키 없음)
    "/api/v1/auth/oauth/",
    "/api/v1/auth/csrf-token",
    "/api/v1/auth/login",
    "/api/v1/auth/register",
    "/api/v1/auth/refresh",
    "/api/v1/auth/logout",
    "/api/v1/auth/password/",  # reset-request + reset-confirm
    "/api/v1/auth/mfa/verify",
    "/health",
    "/metrics",
    "/api/v1/metrics/",  # web-vitals 등 — RUM 데이터 수집용, 상태 변경 X
)


def generate_csrf_token() -> str:
    """Generate a URL-safe CSRF token."""
    return secrets.token_urlsafe(_CSRF_TOKEN_BYTES)


def set_csrf_cookie(response: Response, token: str) -> None:
    """Write the CSRF token as a JS-readable cookie (double-submit pattern)."""
    response.set_cookie(
        key=CSRF_COOKIE_NAME,
        value=token,
        httponly=False,  # JS must read this to echo as header
        secure=settings.REFRESH_COOKIE_SECURE,
        samesite="strict",
        path="/",
        domain=settings.REFRESH_COOKIE_DOMAIN or None,
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 86400,
    )


def _is_exempt_path(path: str) -> bool:
    return any(path.startswith(prefix) for prefix in _EXEMPT_PATH_PREFIXES)


def _is_cookie_authenticated(request: Request) -> bool:
    """True only if the request carries our access cookie and no Authorization header.

    Bearer-token requests (mobile, SDK, server-to-server) are not subject to CSRF —
    attackers cannot read the token from a browser context.
    """
    has_auth_header = bool(request.headers.get("authorization"))
    if has_auth_header:
        return False
    return bool(request.cookies.get(settings.ACCESS_COOKIE_NAME))


async def csrf_middleware(request: Request, call_next):
    """FastAPI http middleware: verify CSRF on unsafe methods with cookie auth."""
    method = request.method.upper()
    if method not in _UNSAFE_METHODS:
        return await call_next(request)

    path = request.url.path
    if _is_exempt_path(path):
        return await call_next(request)

    if not _is_cookie_authenticated(request):
        return await call_next(request)

    header_token = request.headers.get(CSRF_HEADER_NAME)
    cookie_token = request.cookies.get(CSRF_COOKIE_NAME)

    if not header_token or not cookie_token:
        return JSONResponse(
            status_code=403,
            content={"detail": "CSRF token missing", "code": "CSRF_MISSING"},
        )

    if not secrets.compare_digest(header_token, cookie_token):
        return JSONResponse(
            status_code=403,
            content={"detail": "CSRF token invalid", "code": "CSRF_INVALID"},
        )

    return await call_next(request)


# AUDIT 2026-04-20 §27 P0: Origin/Referer-validating CSRF middleware.
#
# Bearer-token (Authorization header) paths bypass this check — browsers can't
# send cross-origin Authorization without CORS preflight, which CORSMiddleware
# already guards. Cookie paths need Origin/Referer validation.
_STATE_CHANGING = {"POST", "PUT", "PATCH", "DELETE"}


class CSRFMiddleware(BaseHTTPMiddleware):
    """Class-based CSRF middleware that validates Origin/Referer for cookie auth."""

    def __init__(self, app, allowed_origins: list[str]):
        super().__init__(app)
        self.allowed_origins = {o.rstrip("/") for o in allowed_origins}

    async def dispatch(self, request: Request, call_next):
        if request.method not in _STATE_CHANGING:
            return await call_next(request)

        # Exempt paths (webhooks, OAuth callbacks, etc.)
        if _is_exempt_path(request.url.path):
            return await call_next(request)

        # Non-production (dev/test) environments: skip Origin/Referer validation
        # to avoid breaking local dev, test clients (no browser Origin), and CI.
        # The safer surfaces (CSRF token check below + CORS) still apply.
        from app.core.config import settings as _settings
        # 보안: staging도 production과 동일하게 CSRF 보호 적용 (dev/test만 예외)
        if getattr(_settings, "ENVIRONMENT", "development") not in ("production", "staging"):
            return await call_next(request)

        # Bearer token? Skip (CORS preflight already enforced for cross-origin)
        if request.headers.get("authorization", "").startswith("Bearer "):
            return await call_next(request)

        # Cookie auth path? Check actual cookie names from settings.
        has_cookie = any(
            k in request.cookies
            for k in (
                _settings.REFRESH_COOKIE_NAME,
                _settings.ACCESS_COOKIE_NAME,
            )
        )
        if not has_cookie:
            return await call_next(request)

        # Validate Origin (or fallback to Referer)
        origin = request.headers.get("origin")
        if not origin:
            referer = request.headers.get("referer", "")
            if referer:
                origin = "/".join(referer.split("/", 3)[:3])

        if not origin or origin.rstrip("/") not in self.allowed_origins:
            return JSONResponse(
                status_code=403,
                content={"code": "CSRF_ORIGIN_DENIED", "message": "Origin not allowed"},
            )
        return await call_next(request)
