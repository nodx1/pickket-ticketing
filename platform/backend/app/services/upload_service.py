"""File upload service with S3-compatible storage."""

import asyncio
import hashlib
import uuid
from abc import ABC, abstractmethod
from datetime import datetime, timezone

from app.core.config import settings


class BaseUploadProvider(ABC):
    @abstractmethod
    async def generate_presigned_url(
        self, key: str, content_type: str, content_length: int | None = None
    ) -> dict:
        """Generate a presigned URL for direct upload."""
        ...

    @abstractmethod
    async def get_public_url(self, key: str) -> str:
        """Get the public URL for an uploaded file."""
        ...

    @abstractmethod
    async def delete_object(self, key: str) -> bool:
        """Delete an object from storage."""
        ...

    @abstractmethod
    async def head_object(self, key: str) -> dict | None:
        """Check if object exists and return metadata (ContentLength, ContentType)."""
        ...

    @abstractmethod
    async def copy_object(self, src_key: str, dst_key: str) -> bool:
        """Server-side copy of an object."""
        ...


class StubUploadProvider(BaseUploadProvider):
    """Stub provider for development — returns mock URLs."""

    async def generate_presigned_url(
        self, key: str, content_type: str, content_length: int | None = None
    ) -> dict:
        return {
            "upload_url": f"https://stub-storage.local/upload/{key}",
            "key": key,
            "method": "PUT",
            "headers": {"Content-Type": content_type},
        }

    async def get_public_url(self, key: str) -> str:
        return f"https://stub-storage.local/public/{key}"

    async def delete_object(self, key: str) -> bool:
        return True

    async def head_object(self, key: str) -> dict | None:
        return {"ContentLength": 0, "ContentType": "application/octet-stream"}

    async def copy_object(self, src_key: str, dst_key: str) -> bool:
        return True


class S3UploadProvider(BaseUploadProvider):
    """S3-compatible provider (AWS S3, Cloudflare R2, MinIO, etc.)."""

    def __init__(self):
        try:
            import boto3

            self.s3 = boto3.client(
                "s3",
                region_name=settings.S3_REGION,
                aws_access_key_id=settings.S3_ACCESS_KEY,
                aws_secret_access_key=settings.S3_SECRET_KEY,
                **({"endpoint_url": settings.S3_ENDPOINT_URL} if settings.S3_ENDPOINT_URL else {}),
            )
        except ImportError:
            raise RuntimeError("boto3 is required for S3 uploads. Install with: pip install boto3")

    async def generate_presigned_url(
        self, key: str, content_type: str, content_length: int | None = None
    ) -> dict:
        # Cap the upload size at MAX_FILE_SIZE so S3 rejects oversized PUTs at the
        # edge. The client must send a matching Content-Length header on PUT.
        limit = MAX_FILE_SIZE if content_length is None else min(content_length, MAX_FILE_SIZE)
        params = {
            "Bucket": settings.S3_BUCKET,
            "Key": key,
            "ContentType": content_type,
            "ContentLength": limit,
        }
        # §28 P1: wrap sync boto3 call with asyncio.to_thread to avoid blocking event loop
        url = await asyncio.to_thread(
            self.s3.generate_presigned_url,
            "put_object",
            Params=params,
            ExpiresIn=300,  # 5 minutes
        )
        return {
            "upload_url": url,
            "key": key,
            "method": "PUT",
            "headers": {"Content-Type": content_type, "Content-Length": str(limit)},
        }

    async def get_public_url(self, key: str) -> str:
        if settings.S3_PUBLIC_URL:
            return f"{settings.S3_PUBLIC_URL.rstrip('/')}/{key}"
        return f"https://{settings.S3_BUCKET}.s3.{settings.S3_REGION}.amazonaws.com/{key}"

    async def delete_object(self, key: str) -> bool:
        try:
            await asyncio.to_thread(
                self.s3.delete_object, Bucket=settings.S3_BUCKET, Key=key
            )
            return True
        except Exception:
            return False

    async def head_object(self, key: str) -> dict | None:
        try:
            resp = await asyncio.to_thread(
                self.s3.head_object, Bucket=settings.S3_BUCKET, Key=key
            )
            return {
                "ContentLength": resp.get("ContentLength", 0),
                "ContentType": resp.get("ContentType", ""),
            }
        except Exception:
            return None

    async def copy_object(self, src_key: str, dst_key: str) -> bool:
        try:
            await asyncio.to_thread(
                self.s3.copy_object,
                Bucket=settings.S3_BUCKET,
                CopySource={"Bucket": settings.S3_BUCKET, "Key": src_key},
                Key=dst_key,
            )
            return True
        except Exception:
            return False


UPLOAD_PROVIDERS = {
    "stub": StubUploadProvider,
    "s3": S3UploadProvider,
}

_provider_instance: BaseUploadProvider | None = None


def get_upload_provider() -> BaseUploadProvider:
    global _provider_instance
    if _provider_instance is None:
        provider_name = getattr(settings, "UPLOAD_PROVIDER", "stub")
        provider_cls = UPLOAD_PROVIDERS.get(provider_name, StubUploadProvider)
        _provider_instance = provider_cls()
    return _provider_instance


_ALLOWED_EXTENSIONS: dict[str, set[str]] = {
    "event": {"jpg", "jpeg", "png", "webp", "avif", "gif"},
    "avatar": {"jpg", "jpeg", "png", "webp", "avif"},
    "fanclub": {"jpg", "jpeg", "png", "webp"},
    "venue": {"jpg", "jpeg", "png", "webp"},
    "review": {"jpg", "jpeg", "png", "webp"},
}
_DEFAULT_ALLOWED = {"jpg", "jpeg", "png", "webp"}


def generate_upload_key(upload_type: str, filename: str, user_id: str) -> str:
    """Generate a unique storage key for an upload."""
    raw_ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    allowed = _ALLOWED_EXTENSIONS.get(upload_type, _DEFAULT_ALLOWED)
    ext = raw_ext if raw_ext in allowed else "jpg"
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    unique = hashlib.md5(f"{user_id}{uuid.uuid4()}".encode(), usedforsecurity=False).hexdigest()[
        :12
    ]
    # STORAGE_STANDARD: v2-owned keys are namespaced under "v2/" (go uses "go/").
    # Only newly generated keys get this prefix; existing keys are read from the
    # value persisted in ImageAsset.original_key, so reads remain backward compatible.
    return f"v2/{upload_type}/{timestamp}/{unique}.{ext}"


ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp", "image/avif", "image/gif"}
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB
