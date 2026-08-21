import contextvars
import re
import uuid

request_id_var: contextvars.ContextVar[str] = contextvars.ContextVar("request_id", default="")

UUID_PATTERN = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


class RequestIdMiddleware:
    """Pure ASGI middleware that propagates X-Request-ID headers."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        # Extract X-Request-ID from incoming headers (or generate one).
        rid = ""
        for header_name, header_value in scope.get("headers", []):
            if header_name == b"x-request-id":
                rid = header_value.decode("latin-1")
                break

        if not rid or not UUID_PATTERN.match(rid):
            rid = str(uuid.uuid4())

        request_id_var.set(rid)

        async def send_with_request_id(message):
            if message["type"] == "http.response.start":
                # Read the flag lazily — CacheControlMiddleware (an inner
                # layer) sets it during the request phase, which runs
                # after this middleware's __call__ has already started.
                if not scope.get("_pickket_cdn_cached", False):
                    headers = list(message.get("headers", []))
                    headers.append((b"x-request-id", rid.encode("latin-1")))
                    message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_request_id)
