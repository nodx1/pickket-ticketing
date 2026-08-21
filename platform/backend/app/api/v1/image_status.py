"""Image processing status API."""

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.middleware.auth import get_current_user
from app.models.image_asset import ImageAsset
from app.models.user import User

router = APIRouter(prefix="/images", tags=["images"])


class ImageStatusResponse(BaseModel):
    id: str
    processing_status: str
    original_url: str
    variants: dict | None = None
    blurhash: str | None = None
    width: int | None = None
    height: int | None = None

    model_config = {"from_attributes": True}


@router.get("/status/{asset_id}", response_model=ImageStatusResponse)
async def get_image_status(
    asset_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """Return the processing state of a single uploaded image."""
    result = await db.execute(
        select(ImageAsset).where(
            ImageAsset.id == asset_id,
            ImageAsset.uploader_id == current_user.id,
        )
    )
    asset = result.scalar_one_or_none()
    if asset is None:
        raise HTTPException(status_code=404, detail="Image not found")

    return ImageStatusResponse(
        id=str(asset.id),
        processing_status=asset.processing_status,
        original_url=asset.original_url,
        variants=json.loads(asset.variants) if asset.variants else None,
        blurhash=asset.blurhash,
        width=asset.width,
        height=asset.height,
    )


@router.get("/my", response_model=list[ImageStatusResponse])
async def list_my_images(
    upload_type: str | None = Query(None, max_length=20),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """List the current user's uploaded images."""
    query = select(ImageAsset).where(ImageAsset.uploader_id == current_user.id)
    if upload_type:
        query = query.where(ImageAsset.upload_type == upload_type)
    query = query.order_by(ImageAsset.created_at.desc()).offset(offset).limit(limit)

    assets = (await db.execute(query)).scalars().all()
    return [
        ImageStatusResponse(
            id=str(asset.id),
            processing_status=asset.processing_status,
            original_url=asset.original_url,
            variants=json.loads(asset.variants) if asset.variants else None,
            blurhash=asset.blurhash,
            width=asset.width,
            height=asset.height,
        )
        for asset in assets
    ]
