"""Celery tasks for post-upload image processing and cleanup."""

import json
import logging
import random
import uuid
from datetime import datetime, timedelta, timezone
from io import BytesIO

from celery import shared_task
from sqlalchemy import select

from app.core.config import settings
from app.core.database import SyncSession
from app.services.image_validation import ImageValidationError, strip_exif, validate_image

logger = logging.getLogger(__name__)

VARIANT_SPECS: dict[str, tuple[int, int]] = {
    "thumb_sm": (300, 200),
    "thumb_md": (600, 400),
    "thumb_lg": (1200, 800),
}

WEBP_QUALITY = 85
THUMB_QUALITY = 80


def _build_retry_delay(retries: int) -> float:
    backoff = min(300, 2**retries * 10)
    jitter = random.uniform(0, backoff * 0.1)
    return backoff + jitter


_s3_client = None


def _get_s3_client():
    """Return a lazily-initialised S3-compatible client singleton for R2/S3 uploads."""
    global _s3_client
    if _s3_client is None:
        import boto3

        client_kwargs = {
            "region_name": settings.S3_REGION,
            "aws_access_key_id": settings.S3_ACCESS_KEY,
            "aws_secret_access_key": settings.S3_SECRET_KEY,
        }
        if settings.S3_ENDPOINT_URL:
            client_kwargs["endpoint_url"] = settings.S3_ENDPOINT_URL
        _s3_client = boto3.client("s3", **client_kwargs)
    return _s3_client


def _get_public_url(key: str) -> str:
    """Build the public asset URL for the given storage key."""
    if settings.S3_PUBLIC_URL:
        return f"{settings.S3_PUBLIC_URL.rstrip('/')}/{key}"
    return f"https://{settings.S3_BUCKET}.s3.{settings.S3_REGION}.amazonaws.com/{key}"


def _upload_bytes(s3_client, key: str, data: bytes, content_type: str) -> str:
    """Upload a byte payload and return its public URL."""
    s3_client.put_object(
        Bucket=settings.S3_BUCKET,
        Key=key,
        Body=data,
        ContentType=content_type,
    )
    return _get_public_url(key)


@shared_task(
    name="app.tasks.image_processing.process_uploaded_image",
    bind=True,
    max_retries=3,
    acks_late=True,
    queue="analytics",
)
def process_uploaded_image(self, image_asset_id: str):
    """Generate WebP variants and BlurHash for an uploaded image."""
    from app.models.image_asset import ImageAsset

    _task_name = "process_uploaded_image"
    session = SyncSession()
    try:
        asset = session.get(ImageAsset, uuid.UUID(image_asset_id))
        if asset is None:
            logger.error("[%s] ImageAsset %s not found — aborting", _task_name, image_asset_id)
            raise RuntimeError(f"ImageAsset {image_asset_id} not found")

        if asset.processing_status == "completed":
            logger.info("[%s] ImageAsset %s already completed", _task_name, image_asset_id)
            return {"status": "already_completed"}

        asset.processing_status = "processing"
        session.commit()

        s3_client = _get_s3_client()
        response = s3_client.get_object(Bucket=settings.S3_BUCKET, Key=asset.original_key)
        raw_bytes = response["Body"].read()
        validate_image(raw_bytes, asset.content_type)
        clean_bytes = strip_exif(raw_bytes)
        asset.file_size = len(clean_bytes)

        from PIL import Image

        image = Image.open(BytesIO(clean_bytes))
        if image.mode in ("RGBA", "P"):
            image = image.convert("RGB")

        asset.width = image.width
        asset.height = image.height

        variants: dict[str, dict[str, int | str]] = {}
        for name, (target_width, target_height) in VARIANT_SPECS.items():
            resized = image.copy()
            resized.thumbnail((target_width, target_height), Image.LANCZOS)
            buffer = BytesIO()
            resized.save(buffer, format="WEBP", quality=THUMB_QUALITY)
            variant_bytes = buffer.getvalue()
            variant_key = f"variants/{asset.original_key}/{name}.webp"
            variants[name] = {
                "url": _upload_bytes(s3_client, variant_key, variant_bytes, "image/webp"),
                "width": resized.width,
                "height": resized.height,
                "size": len(variant_bytes),
            }

        original_webp_buffer = BytesIO()
        image.save(original_webp_buffer, format="WEBP", quality=WEBP_QUALITY)
        original_webp_bytes = original_webp_buffer.getvalue()
        original_webp_key = f"variants/{asset.original_key}/webp.webp"
        variants["webp"] = {
            "url": _upload_bytes(s3_client, original_webp_key, original_webp_bytes, "image/webp"),
            "width": image.width,
            "height": image.height,
            "size": len(original_webp_bytes),
        }

        try:
            import blurhash as blurhash_lib

            reduced = image.resize((32, 32), Image.LANCZOS)
            asset.blurhash = blurhash_lib.encode(reduced, x_components=4, y_components=3)
        except Exception as blurhash_exc:  # noqa: BLE001
            logger.warning("[%s] BlurHash generation failed: %s", _task_name, blurhash_exc)

        asset.variants = json.dumps(variants)
        asset.processing_status = "completed"
        session.commit()

        logger.info(
            "[%s] Processed %s: %dx%d, variants=%d, blurhash=%s",
            _task_name,
            image_asset_id,
            asset.width,
            asset.height,
            len(variants),
            bool(asset.blurhash),
        )
        return {
            "status": "completed",
            "width": asset.width,
            "height": asset.height,
            "variants": len(variants),
        }
    except ImageValidationError as exc:
        session.rollback()
        asset = session.get(ImageAsset, uuid.UUID(image_asset_id))
        if asset is not None:
            asset.processing_status = "failed"
            session.commit()
        logger.warning("[%s] Validation failed for %s: %s", _task_name, image_asset_id, exc)
        return {"status": "failed", "error": exc.code}
    except Exception as exc:  # noqa: BLE001
        logger.exception("[%s] Unexpected image processing failure for %s", _task_name, image_asset_id)
        session.rollback()
        try:
            asset = session.get(ImageAsset, uuid.UUID(image_asset_id))
            if asset is not None:
                asset.processing_status = "failed"
                session.commit()
        except Exception:  # noqa: BLE001
            logger.debug("[%s] Failed to persist image processing failure state", _task_name, exc_info=True)
            session.rollback()

        logger.error("[%s] Failed for %s: %s", _task_name, image_asset_id, exc)
        raise self.retry(exc=exc, countdown=_build_retry_delay(self.request.retries))
    finally:
        session.close()


@shared_task(
    name="app.tasks.image_processing.cleanup_orphaned_images",
    bind=True,
    max_retries=3,
    acks_late=True,
    queue="analytics",
)
def cleanup_orphaned_images(self):
    """Delete orphaned image assets and their generated variants after 24 hours."""
    from app.models.image_asset import ImageAsset

    _task_name = "cleanup_orphaned_images"
    session = SyncSession()
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        orphaned_assets = (
            session.execute(
                select(ImageAsset)
                .where(ImageAsset.entity_id.is_(None))
                .where(ImageAsset.created_at < cutoff)
                .limit(100)
            )
            .scalars()
            .all()
        )

        if not orphaned_assets:
            logger.info("[%s] No orphaned images found", _task_name)
            return {"deleted": 0}

        s3_client = _get_s3_client()
        deleted_count = 0

        for asset in orphaned_assets:
            try:
                s3_client.delete_object(Bucket=settings.S3_BUCKET, Key=asset.original_key)

                if asset.variants:
                    variant_map = json.loads(asset.variants)
                    for variant_name, info in variant_map.items():
                        variant_url = str(info.get("url", ""))
                        if settings.S3_PUBLIC_URL and variant_url.startswith(
                            settings.S3_PUBLIC_URL.rstrip("/")
                        ):
                            variant_key = variant_url[len(settings.S3_PUBLIC_URL.rstrip("/")) + 1 :]
                        else:
                            variant_key = f"variants/{asset.original_key}/{variant_name}.webp"
                        try:
                            s3_client.delete_object(Bucket=settings.S3_BUCKET, Key=variant_key)
                        except Exception:  # noqa: BLE001
                            logger.debug(
                                "[%s] Failed to delete variant key %s for asset %s",
                                _task_name,
                                variant_key,
                                asset.id,
                            )

                session.delete(asset)
                deleted_count += 1
            except Exception as delete_exc:  # noqa: BLE001
                logger.warning(
                    "[%s] Failed to delete asset %s: %s",
                    _task_name,
                    asset.id,
                    delete_exc,
                )

        session.commit()
        logger.info("[%s] Deleted %d orphaned images", _task_name, deleted_count)
        return {"deleted": deleted_count}
    except Exception as exc:  # noqa: BLE001
        session.rollback()
        logger.error("[%s] Failed: %s", _task_name, exc)
        raise self.retry(exc=exc, countdown=_build_retry_delay(self.request.retries))
    finally:
        session.close()
