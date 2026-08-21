"""Point balance and history endpoints."""

from fastapi import APIRouter, Depends, Query
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_read_db
from app.middleware.auth import get_current_user
from app.models.point import PointType
from app.models.user import User
from app.schemas.point import PointBalanceResponse, PointHistoryResponse, PointTransactionResponse
from app.services.point_service import PointService

router = APIRouter()


@router.get("/balance", response_model=PointBalanceResponse)
async def get_point_balance(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Return the current user's Fan and Social point balances."""
    svc = PointService(db)
    balances = await svc.get_all_balances(user.id)
    return PointBalanceResponse(
        fan=balances.get("fan", 0),
        social=balances.get("social", 0),
    )


@router.get("/history", response_model=PointHistoryResponse)
async def get_point_history(
    point_type: str | None = Query(None, description="Filter by point type: fan or social"),
    limit: int = Query(20, ge=1, le=100),
    offset: int = Query(0, ge=0),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Return the current user's point transaction history with optional type filter."""
    pt = None
    if point_type:
        try:
            pt = PointType(point_type.lower())
        except ValueError:
            pt = None

    svc = PointService(db)
    transactions = await svc.get_history(user.id, point_type=pt, limit=limit, offset=offset)

    return PointHistoryResponse(
        transactions=[
            PointTransactionResponse(
                id=tx.id,
                wallet_id=tx.wallet_id,
                tx_type=tx.tx_type.value,
                amount=tx.amount,
                balance_after=tx.balance_after,
                reference_id=tx.reference_id,
                description=tx.description,
                created_at=tx.created_at,
            )
            for tx in transactions
        ],
        total=len(transactions),
    )
