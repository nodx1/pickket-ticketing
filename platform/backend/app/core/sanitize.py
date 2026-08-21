"""HTML sanitization for user-generated content."""

import re

# Simple regex-based sanitization (no external deps needed)
# Strips all HTML tags except basic formatting
#
# 보안 TODO: 정규식 기반 HTML 새니타이저는 우회 가능성이 있어 권장되지 않음
#   (예: 중첩/기형 태그, 인코딩 트릭, mutation XSS 등).
#   `nh3`(Rust ammonia 바인딩) 또는 `bleach`로 교체하는 것이 안전하나,
#   현재 둘 다 의존성에 없음 → 새 의존성 추가는 별도 승인 필요.
#   의존성 추가가 가능해지면 sanitize_html/sanitize_plain_text 를
#   nh3.clean() 기반으로 교체할 것.

ALLOWED_TAGS = {"b", "i", "em", "strong", "p", "br", "ul", "ol", "li", "a"}
TAG_RE = re.compile(r"</?(\w+)[^>]*>", re.IGNORECASE)
SCRIPT_RE = re.compile(r"<script[^>]*>.*?</script>", re.IGNORECASE | re.DOTALL)
STYLE_RE = re.compile(r"<style[^>]*>.*?</style>", re.IGNORECASE | re.DOTALL)
EVENT_RE = re.compile(r"\s+on\w+\s*=", re.IGNORECASE)
HREF_RE = re.compile(r'href\s*=\s*["\']([^"\']*)["\']', re.IGNORECASE)
ALLOWED_HREF_PROTOCOLS = {"http", "https", "mailto"}


def sanitize_html(text: str) -> str:
    """Remove dangerous HTML while preserving basic formatting."""
    if not text:
        return text

    # Remove script and style tags entirely
    text = SCRIPT_RE.sub("", text)
    text = STYLE_RE.sub("", text)

    # Remove event handlers
    text = EVENT_RE.sub(" ", text)

    # Strip disallowed tags
    def replace_tag(match: re.Match) -> str:
        tag = match.group(1).lower()
        if tag in ALLOWED_TAGS:
            full = match.group(0)
            # Validate href protocol on <a> tags
            if tag == "a":
                href_match = HREF_RE.search(full)
                if href_match:
                    href_val = href_match.group(1).lstrip(" \t\n\r\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f")
                    # Block protocol-relative URLs (//evil.com)
                    if href_val.startswith("//"):
                        full = HREF_RE.sub("", full)
                    elif ":" in href_val:
                        protocol = href_val.split(":", 1)[0].lower()
                        # Explicitly block dangerous schemes including data: URIs
                        if protocol in ("data", "javascript", "vbscript") or protocol not in ALLOWED_HREF_PROTOCOLS:
                            full = HREF_RE.sub("", full)
            return full
        return ""

    text = TAG_RE.sub(replace_tag, text)

    return text.strip()


def sanitize_plain_text(text: str) -> str:
    """Strip ALL HTML tags (for plain text fields like titles)."""
    if not text:
        return text
    text = SCRIPT_RE.sub("", text)
    text = STYLE_RE.sub("", text)
    text = re.sub(r"<[^>]+>", "", text)
    return text.strip()
