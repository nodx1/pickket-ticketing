"""AP Shop API endpoints (WP09/WP15)."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.core.errors import client_error_detail
from app.middleware.auth import get_current_user
from app.models.point import PointType
from app.models.shop import ShopCategory
from app.models.user import User
from app.services.shop_service import ShopService

router = APIRouter()


class ShopItemResponse(BaseModel):
    id: uuid.UUID
    name: str
    description: str | None = None
    category: str
    ap_price: int
    stock: int | None = None
    image_url: str | None = None
    is_active: bool = True
    model_config = {"from_attributes": True}


class ShopExchangeRequest(BaseModel):
    item_id: uuid.UUID
    shipping_address: str | None = None


class ShopExchangeResponse(BaseModel):
    id: uuid.UUID
    item_id: uuid.UUID
    ap_spent: int
    category: str
    status: str
    model_config = {"from_attributes": True}


class ShopItemListResponse(BaseModel):
    items: list[ShopItemResponse]
    total: int


class ShopExchangeListResponse(BaseModel):
    exchanges: list[ShopExchangeResponse]
    total: int


@router.get("/items", response_model=ShopItemListResponse)
async def list_shop_items(
    category: ShopCategory | None = None,
    limit: int = Query(default=50, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    db: AsyncSession = Depends(get_read_db),
):
    """상품 목록 조회."""
    svc = ShopService(db)
    items = await svc.list_items(category=category, limit=limit, offset=offset)
    total = await svc.count_items(category=category)
    return ShopItemListResponse(items=items, total=total)


@router.post("/exchange", response_model=ShopExchangeResponse, status_code=status.HTTP_201_CREATED)
async def exchange_item(
    body: ShopExchangeRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """AP Shop 상품 교환."""
    svc = ShopService(db)
    try:
        exchange = await svc.exchange(
            user_id=user.id,
            item_id=body.item_id,
            point_type=PointType.FAN,
            shipping_address=body.shipping_address,
            verification_level=getattr(user, "verification_level", 0),
        )
        await db.commit()
        return exchange
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=client_error_detail(e, "교환 처리 중 오류가 발생했습니다"))


@router.get("/my-exchanges", response_model=ShopExchangeListResponse)
async def get_my_exchanges(
    limit: int = Query(default=20, ge=1, le=100),
    offset: int = Query(default=0, ge=0),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """내 교환 이력 조회."""
    svc = ShopService(db)
    exchanges = await svc.get_user_exchanges(user.id, limit=limit, offset=offset)
    total = await svc.count_user_exchanges(user.id)
    return ShopExchangeListResponse(exchanges=exchanges, total=total)


@router.post("/exchanges/{exchange_id}/cancel", response_model=ShopExchangeResponse)
async def cancel_exchange(
    exchange_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """교환 취소."""
    svc = ShopService(db)
    try:
        exchange = await svc.cancel_exchange(exchange_id, user.id)
        await db.commit()
        return exchange
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=client_error_detail(e, "교환 처리 중 오류가 발생했습니다"))
