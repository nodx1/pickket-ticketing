"""File upload endpoints: presigned URLs, upload completion, image management."""

import json
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.middleware.auth import get_current_user
from app.middleware.rate_limit import rate_limit_upload
from app.models.image_asset import ImageAsset
from app.models.user import User
from app.services.upload_service import (
    ALLOWED_IMAGE_TYPES,
    generate_upload_key,
    get_upload_provider,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────────────────


class PresignedUrlRequest(BaseModel):
    upload_type: str = Field(..., pattern="^(event|avatar|fanclub|venue|review)$")
    filename: str = Field(..., min_length=1, max_length=255)
    content_type: str = Field(..., max_length=100)


class PresignedUrlResponse(BaseModel):
    upload_url: str
    key: str
    method: str
    headers: dict
    public_url: str
    asset_id: str | None = None


class BatchPresignedUrlRequest(BaseModel):
    items: list[PresignedUrlRequest] = Field(..., min_length=1, max_length=10)


class BatchPresignedUrlResponse(BaseModel):
    items: list[PresignedUrlResponse]


class UploadCompleteRequest(BaseModel):
    asset_id: str = Field(..., min_length=1)
    key: str = Field(..., min_length=1)


class UploadCompleteResponse(BaseModel):
    status: str
    asset_id: str
    public_url: str


class ImageAssetResponse(BaseModel):
    id: str
    original_url: str
    variants: dict | None = None
    blurhash: str | None = None
    upload_type: str
    processing_status: str
    width: int | None = None
    height: int | None = None
    created_at: str


class MyImagesResponse(BaseModel):
    items: list[ImageAssetResponse]
    total: int


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.post(
    "/presigned-url",
    response_model=PresignedUrlResponse,
    dependencies=[Depends(rate_limit_upload)],
)
async def get_presigned_url(
    data: PresignedUrlRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Generate a presigned URL for direct file upload + create ImageAsset record."""
    if data.content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(
            status_code=400, detail=f"Unsupported content type: {data.content_type}"
        )

    provider = get_upload_provider()
    key = generate_upload_key(data.upload_type, data.filename, str(user.id))
    result = await provider.generate_presigned_url(key, data.content_type)
    public_url = await provider.get_public_url(key)

    asset = ImageAsset(
        id=uuid.uuid4(),
        uploader_id=user.id,
        original_key=key,
        original_url=public_url,
        content_type=data.content_type,
        upload_type=data.upload_type,
        processing_status="pending",
    )
    db.add(asset)
    await db.commit()

    return PresignedUrlResponse(
        upload_url=result["upload_url"],
        key=result["key"],
        method=result["method"],
        headers=result["headers"],
        public_url=public_url,
        asset_id=str(asset.id),
    )


@router.post(
    "/presigned-urls",
    response_model=BatchPresignedUrlResponse,
    dependencies=[Depends(rate_limit_upload)],
)
async def get_batch_presigned_urls(
    data: BatchPresignedUrlRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Generate presigned URLs for multiple files (max 10)."""
    provider = get_upload_provider()
    responses: list[PresignedUrlResponse] = []

    for item in data.items:
        if item.content_type not in ALLOWED_IMAGE_TYPES:
            raise HTTPException(
                status_code=400,
                detail=f"Unsupported content type: {item.content_type}",
            )

        key = generate_upload_key(item.upload_type, item.filename, str(user.id))
        result = await provider.generate_presigned_url(key, item.content_type)
        public_url = await provider.get_public_url(key)

        asset = ImageAsset(
            id=uuid.uuid4(),
            uploader_id=user.id,
            original_key=key,
            original_url=public_url,
            content_type=item.content_type,
            upload_type=item.upload_type,
            processing_status="pending",
        )
        db.add(asset)

        responses.append(
            PresignedUrlResponse(
                upload_url=result["upload_url"],
                key=result["key"],
                method=result["method"],
                headers=result["headers"],
                public_url=public_url,
                asset_id=str(asset.id),
            )
        )

    await db.commit()
    return BatchPresignedUrlResponse(items=responses)


@router.post("/complete", response_model=UploadCompleteResponse)
async def upload_complete(
    data: UploadCompleteRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Callback after client finishes uploading to S3. Verifies and triggers processing."""
    result = await db.execute(
        select(ImageAsset).where(
            ImageAsset.id == uuid.UUID(data.asset_id),
            ImageAsset.uploader_id == user.id,
        )
    )
    asset = result.scalar_one_or_none()
    if not asset:
        raise HTTPException(status_code=404, detail="Image asset not found")

    if asset.processing_status not in ("pending", "failed"):
        return UploadCompleteResponse(
            status=asset.processing_status,
            asset_id=str(asset.id),
            public_url=asset.original_url,
        )

    # Verify file exists in S3
    provider = get_upload_provider()
    head = await provider.head_object(data.key)
    if head is None:
        raise HTTPException(status_code=400, detail="File not found in storage")

    asset.file_size = head.get("ContentLength", 0)
    asset.processing_status = "pending"
    await db.commit()

    # Trigger async image processing
    try:
        from app.tasks.image_processing import process_uploaded_image

        process_uploaded_image.delay(str(asset.id))
    except Exception:
        logger.warning(
            "Failed to enqueue image processing for asset %s", asset.id, exc_info=True
        )

    return UploadCompleteResponse(
        status="processing",
        asset_id=str(asset.id),
        public_url=asset.original_url,
    )


@router.delete("/{asset_id}")
async def delete_image(
    asset_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete an uploaded image (owner only)."""
    result = await db.execute(
        select(ImageAsset).where(
            ImageAsset.id == asset_id,
            ImageAsset.uploader_id == user.id,
        )
    )
    asset = result.scalar_one_or_none()
    if not asset:
        raise HTTPException(status_code=404, detail="Image not found")

    # Delete from S3
    provider = get_upload_provider()
    await provider.delete_object(asset.original_key)

    # Delete variants from S3
    if asset.variants:
        try:
            variants = json.loads(asset.variants)
            for name in variants:
                variant_key = f"variants/{asset.original_key}/{name}.webp"
                await provider.delete_object(variant_key)
        except Exception:
            logger.warning(
                "Failed to delete variants for asset %s", asset_id, exc_info=True
            )

    await db.delete(asset)
    await db.commit()

    return {"status": "deleted", "asset_id": str(asset_id)}


@router.get("/my", response_model=MyImagesResponse)
async def list_my_images(
    upload_type: str | None = Query(None),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List current user's uploaded images with pagination."""
    base_query = select(ImageAsset).where(ImageAsset.uploader_id == user.id)
    if upload_type:
        base_query = base_query.where(ImageAsset.upload_type == upload_type)

    # Count
    count_result = await db.execute(
        select(func.count()).select_from(base_query.subquery())
    )
    total = count_result.scalar() or 0

    # Fetch page
    query = (
        base_query.order_by(ImageAsset.created_at.desc())
        .offset((page - 1) * size)
        .limit(size)
    )
    result = await db.execute(query)
    assets = result.scalars().all()

    items = []
    for a in assets:
        items.append(
            ImageAssetResponse(
                id=str(a.id),
                original_url=a.original_url,
                variants=json.loads(a.variants) if a.variants else None,
                blurhash=a.blurhash,
                upload_type=a.upload_type,
                processing_status=a.processing_status,
                width=a.width,
                height=a.height,
                created_at=a.created_at.isoformat() if a.created_at else "",
            )
        )

    return MyImagesResponse(items=items, total=total)
