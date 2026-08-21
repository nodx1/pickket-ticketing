"""Tests for image validation helpers."""

from io import BytesIO

import pytest
from PIL import Image

from app.services.image_validation import (
    MAX_FILE_SIZE,
    ImageValidationError,
    strip_exif,
    validate_dimensions,
    validate_file_size,
    validate_image,
    validate_magic_bytes,
)


def _make_jpeg(width: int = 100, height: int = 100) -> bytes:
    image = Image.new("RGB", (width, height), color="red")
    buffer = BytesIO()
    image.save(buffer, format="JPEG")
    return buffer.getvalue()


def _make_png(width: int = 100, height: int = 100) -> bytes:
    image = Image.new("RGB", (width, height), color="blue")
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def test_validate_magic_bytes_jpeg():
    data = _make_jpeg()
    assert validate_magic_bytes(data, "image/jpeg") is True


def test_validate_magic_bytes_png():
    data = _make_png()
    assert validate_magic_bytes(data, "image/png") is True


def test_validate_magic_bytes_mismatch():
    data = _make_png()
    with pytest.raises(ImageValidationError, match="magic_byte_mismatch"):
        validate_magic_bytes(data, "image/jpeg")


def test_validate_magic_bytes_unsupported_type():
    with pytest.raises(ImageValidationError, match="unsupported_type"):
        validate_magic_bytes(b"fake", "application/pdf")


def test_validate_file_size_ok():
    assert validate_file_size(_make_jpeg()) is True


def test_validate_file_size_too_large():
    data = b"\x00" * (MAX_FILE_SIZE + 1)
    with pytest.raises(ImageValidationError, match="file_too_large"):
        validate_file_size(data)


def test_validate_dimensions_ok():
    width, height = validate_dimensions(_make_jpeg(640, 480))
    assert width == 640
    assert height == 480


def test_validate_dimensions_too_large():
    data = _make_png(8193, 1)
    with pytest.raises(ImageValidationError, match="dimensions_too_large"):
        validate_dimensions(data)


def test_validate_dimensions_corrupt():
    with pytest.raises(ImageValidationError, match="corrupt_image"):
        validate_dimensions(b"not an image at all")


def test_validate_image_full_pipeline():
    width, height = validate_image(_make_jpeg(1920, 1080), "image/jpeg")
    assert width == 1920
    assert height == 1080


def test_strip_exif_returns_bytes():
    cleaned = strip_exif(_make_jpeg())
    assert isinstance(cleaned, bytes)
    assert len(cleaned) > 0
    image = Image.open(BytesIO(cleaned))
    assert image.size == (100, 100)
