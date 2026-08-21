"""Package product management API."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_organizer
from app.models.user import User
from app.models.event import Event
from app.models.package_product import PackageProduct, PackageItem, PackageStatus
from app.schemas.organizer import (
    PackageProductCreate,
    PackageProductResponse,
)

router = APIRouter()


@router.post("/", response_model=PackageProductResponse, status_code=201)
async def create_package(
    data: PackageProductCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Create a package product bundling multiple events."""
    # Validate all events belong to organizer and share the same category
    for item in data.items:
        event = (
            await db.execute(
                select(Event).where(
                    Event.id == item.event_id,
                    Event.organizer_id == user.id,
                )
            )
        ).scalar_one_or_none()
        if not event:
            raise HTTPException(
                status_code=404,
                detail=f"Event {item.event_id} not found or not owned",
            )
        if event.category.lower() != data.category.lower():
            raise HTTPException(
                status_code=400,
                detail=f"Event {item.event_id} category ({event.category}) does not match package category ({data.category})",
            )

    package = PackageProduct(
        organizer_id=user.id,
        name=data.name,
        sub_title=data.sub_title,
        category=data.category,
        desired_open_date=data.desired_open_date,
        status=PackageStatus.DRAFT,
    )
    db.add(package)
    await db.flush()

    for item_data in data.items:
        item = PackageItem(
            package_id=package.id,
            event_id=item_data.event_id,
            seat_tier=item_data.seat_tier,
            regular_price=item_data.regular_price,
            discount_price=item_data.discount_price,
        )
        db.add(item)

    await db.commit()
    await db.refresh(package)

    # Re-fetch with items
    result = await db.execute(
        select(PackageProduct)
        .where(PackageProduct.id == package.id)
        .options(selectinload(PackageProduct.items))
    )
    package = result.scalar_one()
    return PackageProductResponse.model_validate(package)


@router.get("/", response_model=list[PackageProductResponse])
async def list_packages(
    category: str | None = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
):
    """List organizer's package products."""
    conditions = [PackageProduct.organizer_id == user.id]
    if category:
        conditions.append(PackageProduct.category == category)

    result = await db.execute(
        select(PackageProduct)
        .where(*conditions)
        .options(selectinload(PackageProduct.items))
        .order_by(PackageProduct.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    packages = result.scalars().all()
    return [PackageProductResponse.model_validate(p) for p in packages]


@router.get("/{package_id}", response_model=PackageProductResponse)
async def get_package(
    package_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Get package detail."""
    result = await db.execute(
        select(PackageProduct)
        .where(
            PackageProduct.id == package_id,
            PackageProduct.organizer_id == user.id,
        )
        .options(selectinload(PackageProduct.items))
    )
    package = result.scalar_one_or_none()
    if not package:
        raise HTTPException(status_code=404, detail="Package not found")
    return PackageProductResponse.model_validate(package)


@router.delete("/{package_id}", status_code=200)
async def delete_package(
    package_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Delete a draft package."""
    result = await db.execute(
        select(PackageProduct)
        .where(
            PackageProduct.id == package_id,
            PackageProduct.organizer_id == user.id,
        )
        .options(selectinload(PackageProduct.items))
    )
    package = result.scalar_one_or_none()
    if not package:
        raise HTTPException(status_code=404, detail="Package not found")
    if package.status != PackageStatus.DRAFT:
        raise HTTPException(status_code=400, detail="Can only delete draft packages")

    for item in package.items:
        await db.delete(item)
    await db.delete(package)
    await db.commit()
    return {"detail": "Package deleted"}
