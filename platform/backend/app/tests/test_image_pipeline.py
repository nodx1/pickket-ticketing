"""Tests for the image processing pipeline and ImageAsset model."""

from __future__ import annotations

import json
import sys
import types
import uuid
from datetime import datetime, timedelta, timezone
from io import BytesIO

import pytest
from sqlalchemy import create_engine
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import *  # noqa: F401,F403


@compiles(PG_UUID, "sqlite")
def _compile_pg_uuid_sqlite(type_, compiler, **kw):
    return "CHAR(32)"


sync_test_engine = create_engine("sqlite://", echo=False)
SyncTestSession = sessionmaker(sync_test_engine)


@pytest.fixture(autouse=True)
def _reset_db(monkeypatch):
    monkeypatch.setattr("app.tasks.image_processing.SyncSession", SyncTestSession)
    Base.metadata.drop_all(sync_test_engine)
    Base.metadata.create_all(sync_test_engine)
    yield
    Base.metadata.drop_all(sync_test_engine)


def _fake_settings():
    return type(
        "FakeSettings",
        (),
        {
            "S3_REGION": "auto",
            "S3_ACCESS_KEY": "fake",
            "S3_SECRET_KEY": "fake",
            "S3_ENDPOINT_URL": "",
            "S3_BUCKET": "test-bucket",
            "S3_PUBLIC_URL": "https://cdn.example.com",
        },
    )()


def _create_user(email: str = "test@example.com"):
    from app.models.user import User

    user = User(
        id=uuid.uuid4(),
        email=email,
        hashed_password="fakehash",
        name="tester",
    )
    return user


def _create_test_jpeg_bytes(width: int = 100, height: int = 100) -> bytes:
    from PIL import Image

    image = Image.new("RGB", (width, height), color=(255, 0, 0))
    buffer = BytesIO()
    image.save(buffer, format="JPEG")
    return buffer.getvalue()


class FakeS3Body:
    def __init__(self, data: bytes):
        self._data = data

    def read(self):
        return self._data


class FakeS3Client:
    """Simple in-memory fake for S3 object operations."""

    def __init__(self):
        self.store: dict[str, bytes] = {}

    def get_object(self, Bucket, Key):
        if Key not in self.store:
            raise Exception(f"NoSuchKey: {Key}")
        return {"Body": FakeS3Body(self.store[Key])}

    def put_object(self, Bucket, Key, Body, ContentType=""):
        self.store[Key] = Body

    def delete_object(self, Bucket, Key):
        self.store.pop(Key, None)


def _install_fake_blurhash(monkeypatch: pytest.MonkeyPatch):
    module = types.ModuleType("blurhash")
    module.encode = lambda image, x_components=4, y_components=3: "LEHV6nWB2yk8pyo0adR*.7kCMdnj"
    monkeypatch.setitem(sys.modules, "blurhash", module)


def test_image_asset_create():
    """ImageAsset creates with expected defaults."""
    from app.models.image_asset import ImageAsset

    session = SyncTestSession()
    user = _create_user()
    session.add(user)
    session.flush()

    asset = ImageAsset(
        id=uuid.uuid4(),
        uploader_id=user.id,
        original_key="uploads/event/test.jpg",
        original_url="https://cdn.example.com/uploads/event/test.jpg",
        content_type="image/jpeg",
        file_size=0,
        upload_type="event",
    )
    session.add(asset)
    session.commit()

    fetched = session.get(ImageAsset, asset.id)
    assert fetched is not None
    assert fetched.processing_status == "pending"
    assert fetched.blurhash is None
    assert fetched.variants is None
    assert fetched.width is None
    session.close()


def test_image_asset_unique_key():
    """original_key must be unique."""
    from app.models.image_asset import ImageAsset

    session = SyncTestSession()
    user = _create_user("unique@example.com")
    session.add(user)
    session.flush()

    first = ImageAsset(
        id=uuid.uuid4(),
        uploader_id=user.id,
        original_key="uploads/event/dup.jpg",
        original_url="https://cdn.example.com/uploads/event/dup.jpg",
        content_type="image/jpeg",
        upload_type="event",
    )
    second = ImageAsset(
        id=uuid.uuid4(),
        uploader_id=user.id,
        original_key="uploads/event/dup.jpg",
        original_url="https://cdn.example.com/uploads/event/dup-2.jpg",
        content_type="image/jpeg",
        upload_type="event",
    )

    session.add(first)
    session.commit()
    session.add(second)
    with pytest.raises(IntegrityError):
        session.commit()
    session.close()


def test_process_uploaded_image_success(monkeypatch: pytest.MonkeyPatch):
    """Valid image processing generates variants and blurhash."""
    from app.models.image_asset import ImageAsset
    from app.tasks.image_processing import process_uploaded_image

    _install_fake_blurhash(monkeypatch)
    fake_s3 = FakeS3Client()
    fake_s3.store["uploads/event/test.jpg"] = _create_test_jpeg_bytes(800, 600)
    monkeypatch.setattr("app.tasks.image_processing._get_s3_client", lambda: fake_s3)
    monkeypatch.setattr("app.tasks.image_processing.settings", _fake_settings())

    session = SyncTestSession()
    user = _create_user("img@test.com")
    session.add(user)
    session.flush()
    asset = ImageAsset(
        id=uuid.uuid4(),
        uploader_id=user.id,
        original_key="uploads/event/test.jpg",
        original_url="https://cdn.example.com/uploads/event/test.jpg",
        content_type="image/jpeg",
        upload_type="event",
    )
    session.add(asset)
    session.commit()
    asset_id = str(asset.id)
    session.close()

    result = process_uploaded_image.run(asset_id)
    assert result["status"] == "completed"
    assert result["width"] == 800
    assert result["height"] == 600
    assert result["variants"] == 4

    session = SyncTestSession()
    updated = session.get(ImageAsset, uuid.UUID(asset_id))
    assert updated.processing_status == "completed"
    assert updated.blurhash is not None
    assert updated.variants is not None
    variants = json.loads(updated.variants)
    assert "thumb_sm" in variants
    assert "thumb_md" in variants
    assert "thumb_lg" in variants
    assert "webp" in variants
    assert variants["thumb_sm"]["width"] <= 300
    assert variants["thumb_sm"]["height"] <= 200
    session.close()

    assert len(fake_s3.store) >= 5


def test_process_uploaded_image_not_found():
    """Unknown image asset ids raise RuntimeError."""
    from app.tasks.image_processing import process_uploaded_image

    with pytest.raises(RuntimeError, match="not found"):
        process_uploaded_image.run(str(uuid.uuid4()))


def test_process_uploaded_image_already_completed():
    """Completed assets are skipped."""
    from app.models.image_asset import ImageAsset
    from app.tasks.image_processing import process_uploaded_image

    session = SyncTestSession()
    user = _create_user("done@test.com")
    session.add(user)
    session.flush()
    asset = ImageAsset(
        id=uuid.uuid4(),
        uploader_id=user.id,
        original_key="uploads/event/done.jpg",
        original_url="https://cdn.example.com/uploads/event/done.jpg",
        content_type="image/jpeg",
        upload_type="event",
        processing_status="completed",
    )
    session.add(asset)
    session.commit()
    asset_id = str(asset.id)
    session.close()

    result = process_uploaded_image.run(asset_id)
    assert result["status"] == "already_completed"


def test_process_uploaded_image_rgba_conversion(monkeypatch: pytest.MonkeyPatch):
    """RGBA source images should still process successfully."""
    from PIL import Image

    from app.models.image_asset import ImageAsset
    from app.tasks.image_processing import process_uploaded_image

    _install_fake_blurhash(monkeypatch)
    image = Image.new("RGBA", (200, 200), color=(255, 0, 0, 128))
    buffer = BytesIO()
    image.save(buffer, format="PNG")

    fake_s3 = FakeS3Client()
    fake_s3.store["uploads/event/rgba.png"] = buffer.getvalue()
    monkeypatch.setattr("app.tasks.image_processing._get_s3_client", lambda: fake_s3)
    monkeypatch.setattr("app.tasks.image_processing.settings", _fake_settings())

    session = SyncTestSession()
    user = _create_user("rgba@test.com")
    session.add(user)
    session.flush()
    asset = ImageAsset(
        id=uuid.uuid4(),
        uploader_id=user.id,
        original_key="uploads/event/rgba.png",
        original_url="https://cdn.example.com/uploads/event/rgba.png",
        content_type="image/png",
        upload_type="event",
    )
    session.add(asset)
    session.commit()
    asset_id = str(asset.id)
    session.close()

    result = process_uploaded_image.run(asset_id)
    assert result["status"] == "completed"


def test_cleanup_orphaned_no_orphans():
    """No orphaned images returns deleted=0."""
    from app.tasks.image_processing import cleanup_orphaned_images

    result = cleanup_orphaned_images.run()
    assert result["deleted"] == 0


def test_cleanup_orphaned_deletes_old_unlinked(monkeypatch: pytest.MonkeyPatch):
    """Old unlinked assets should be deleted from storage and DB."""
    from app.models.image_asset import ImageAsset
    from app.tasks.image_processing import cleanup_orphaned_images

    fake_s3 = FakeS3Client()
    fake_s3.store["uploads/event/orphan.jpg"] = b"fake"
    fake_s3.store["variants/uploads/event/orphan.jpg/thumb_sm.webp"] = b"variant"
    monkeypatch.setattr("app.tasks.image_processing._get_s3_client", lambda: fake_s3)
    monkeypatch.setattr("app.tasks.image_processing.settings", _fake_settings())

    session = SyncTestSession()
    user = _create_user("orphan@test.com")
    session.add(user)
    session.flush()
    asset = ImageAsset(
        id=uuid.uuid4(),
        uploader_id=user.id,
        original_key="uploads/event/orphan.jpg",
        original_url="https://cdn.example.com/uploads/event/orphan.jpg",
        content_type="image/jpeg",
        upload_type="event",
        entity_id=None,
        variants=json.dumps(
            {"thumb_sm": {"url": "https://cdn.example.com/variants/uploads/event/orphan.jpg/thumb_sm.webp"}}
        ),
        created_at=datetime.now(timezone.utc) - timedelta(hours=25),
    )
    session.add(asset)
    session.commit()
    asset_id = asset.id
    session.close()

    result = cleanup_orphaned_images.run()
    assert result["deleted"] == 1
    assert "uploads/event/orphan.jpg" not in fake_s3.store
    assert "variants/uploads/event/orphan.jpg/thumb_sm.webp" not in fake_s3.store

    session = SyncTestSession()
    assert session.get(ImageAsset, asset_id) is None
    session.close()


def test_cleanup_orphaned_keeps_linked(monkeypatch: pytest.MonkeyPatch):
    """Linked assets must not be deleted."""
    from app.models.image_asset import ImageAsset
    from app.tasks.image_processing import cleanup_orphaned_images

    monkeypatch.setattr("app.tasks.image_processing.settings", _fake_settings())

    session = SyncTestSession()
    user = _create_user("linked@test.com")
    session.add(user)
    session.flush()
    asset = ImageAsset(
        id=uuid.uuid4(),
        uploader_id=user.id,
        original_key="uploads/event/linked.jpg",
        original_url="https://cdn.example.com/uploads/event/linked.jpg",
        content_type="image/jpeg",
        upload_type="event",
        entity_id=uuid.uuid4(),
        created_at=datetime.now(timezone.utc) - timedelta(hours=48),
    )
    session.add(asset)
    session.commit()
    session.close()

    result = cleanup_orphaned_images.run()
    assert result["deleted"] == 0


def test_event_schema_blurhash_field():
    """Event summary schema exposes image placeholder metadata fields."""
    from app.schemas.event import EventSummaryResponse

    fields = EventSummaryResponse.model_fields
    assert "blurhash" in fields
    assert "image_variants" in fields
