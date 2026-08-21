from app.middleware.rate_limit import extract_client_ip
from starlette.requests import Request


def _make_request(
    *,
    client_host: str,
    xff: str | None = None,
    x_real_ip: str | None = None,
    cf_connecting_ip: str | None = None,
) -> Request:
    headers: list[tuple[bytes, bytes]] = []
    if xff is not None:
        headers.append((b"x-forwarded-for", xff.encode("utf-8")))
    if x_real_ip is not None:
        headers.append((b"x-real-ip", x_real_ip.encode("utf-8")))
    if cf_connecting_ip is not None:
        headers.append((b"cf-connecting-ip", cf_connecting_ip.encode("utf-8")))
    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": "GET",
        "path": "/",
        "query_string": b"",
        "headers": headers,
        "client": (client_host, 12345),
        "server": ("testserver", 80),
        "scheme": "http",
    }
    return Request(scope)


def test_extract_client_ip_rejects_prepended_spoofed_xff():
    request = _make_request(
        client_host="127.0.0.1",
        xff="1.2.3.4, 203.0.113.10",
    )
    # Trusted proxy should resolve to the right-most non-trusted hop (203.0.113.10),
    # not the attacker-prepended spoofed IP (1.2.3.4).
    assert extract_client_ip(request) == "203.0.113.10"


def test_extract_client_ip_ignores_xff_from_untrusted_proxy():
    request = _make_request(
        client_host="198.51.100.20",
        xff="8.8.8.8",
    )
    assert extract_client_ip(request) == "198.51.100.20"


def test_extract_client_ip_prefers_cf_connecting_ip_from_trusted_proxy():
    request = _make_request(
        client_host="127.0.0.1",
        cf_connecting_ip="203.0.113.44",
        xff="1.2.3.4, 203.0.113.10",
    )
    assert extract_client_ip(request) == "203.0.113.44"


def test_extract_client_ip_does_not_trust_proxy_ip_without_forward_headers():
    request = _make_request(client_host="127.0.0.1")
    assert extract_client_ip(request) == "unknown"
