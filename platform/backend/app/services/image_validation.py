"""Image validation helpers for secure upload processing."""

from __future__ import annotations

import logging
from io import BytesIO

logger = logging.getLogger(__name__)

MAGIC_SIGNATURES: dict[str, list[bytes]] = {
    "image/jpeg": [b"\xff\xd8\xff"],
    "image/png": [b"\x89PNG\r\n\x1a\n"],
    "image/webp": [b"RIFF"],
    "image/gif": [b"GIF87a", b"GIF89a"],
    "image/avif": [],
}

MAX_WIDTH = 8192
MAX_HEIGHT = 8192
MAX_PIXELS = 50_000_000
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB — must match upload_service.py


class ImageValidationError(Exception):
    """Raised when an uploaded image fails validation."""

    def __init__(self, message: str, code: str = "invalid_image"):
        self.message = message
        self.code = code
        super().__init__(f"{code}: {message}")


def validate_magic_bytes(data: bytes, claimed_content_type: str) -> bool:
    """Validate file signatures against the claimed content type."""
    if claimed_content_type not in MAGIC_SIGNATURES:
        raise ImageValidationError(
            f"Unsupported content type: {claimed_content_type}",
            code="unsupported_type",
        )

    signatures = MAGIC_SIGNATURES[claimed_content_type]
    if not signatures:
        return True

    if claimed_content_type == "image/webp":
        if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
            return True
        raise ImageValidationError(
            "File content does not match claimed type image/webp",
            code="magic_byte_mismatch",
        )

    for signature in signatures:
        if data[: len(signature)] == signature:
            return True

    raise ImageValidationError(
        f"File content does not match claimed type {claimed_content_type}",
        code="magic_byte_mismatch",
    )


def validate_file_size(data: bytes) -> bool:
    """Validate file size against the server-side hard limit."""
    if len(data) > MAX_FILE_SIZE:
        raise ImageValidationError(
            f"File size {len(data)} exceeds maximum {MAX_FILE_SIZE} bytes",
            code="file_too_large",
        )
    return True


def validate_dimensions(data: bytes) -> tuple[int, int]:
    """Validate that the image opens and stays within safe dimension limits."""
    from PIL import Image

    Image.MAX_IMAGE_PIXELS = MAX_PIXELS

    try:
        image = Image.open(BytesIO(data))
        image.verify()
    except Exception as exc:  # noqa: BLE001
        raise ImageValidationError(
            f"Cannot open image: {exc}",
            code="corrupt_image",
        ) from exc

    image = Image.open(BytesIO(data))
    width, height = image.size

    if width > MAX_WIDTH or height > MAX_HEIGHT:
        raise ImageValidationError(
            f"Image dimensions {width}x{height} exceed maximum {MAX_WIDTH}x{MAX_HEIGHT}",
            code="dimensions_too_large",
        )

    if width * height > MAX_PIXELS:
        raise ImageValidationError(
            f"Image pixel count {width * height} exceeds maximum {MAX_PIXELS}",
            code="too_many_pixels",
        )

    return width, height


def strip_exif(data: bytes) -> bytes:
    """Strip EXIF metadata from image bytes and return a clean payload."""
    try:
        from PIL import Image

        image = Image.open(BytesIO(data))
        fmt = (image.format or "JPEG").upper()

        clean = image.copy()

        save_image = clean
        if fmt in {"JPEG", "JPG"} and clean.mode not in ("RGB", "L"):
            save_image = clean.convert("RGB")

        buffer = BytesIO()
        if fmt == "WEBP":
            save_image.save(buffer, format="WEBP", quality=95)
        elif fmt == "PNG":
            save_image.save(buffer, format="PNG")
        else:
            save_image.save(buffer, format="JPEG", quality=95)
        return buffer.getvalue()
    except Exception as exc:  # noqa: BLE001
        logger.warning("EXIF strip failed: %s", exc)
        return data


def validate_image(data: bytes, claimed_content_type: str) -> tuple[int, int]:
    """Run file size, signature, and dimension validation."""
    validate_file_size(data)
    validate_magic_bytes(data, claimed_content_type)
    return validate_dimensions(data)
