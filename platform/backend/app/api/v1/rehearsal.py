from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field

from app.middleware.auth import get_current_organizer
from app.models.user import User
from app.services.rehearsal_service import RehearsalService

router = APIRouter(prefix="/rehearsal", tags=["rehearsal"])


class RehearsalRequest(BaseModel):
    total_seats: int = Field(..., ge=1, le=100000)
    min_price: float = Field(..., gt=0)
    max_price: float = Field(..., gt=0)
    num_bids: int = Field(default=100, ge=10, le=1000)
    category: str = "concert"


class RehearsalResponse(BaseModel):
    total_bids: int
    total_seats: int
    competition_ratio: float
    winners_count: int
    price_stats: dict
    estimated_revenue: float
    fair_vs_face_price_ratio: float
    bids_summary: dict
    top_winners: list[dict]


@router.post("/simulate", response_model=RehearsalResponse)
async def run_rehearsal(
    req: RehearsalRequest,
    _user: User = Depends(get_current_organizer),
):
    svc = RehearsalService()
    return svc.run_simulation(
        total_seats=req.total_seats,
        min_price=req.min_price,
        max_price=req.max_price,
        num_bids=req.num_bids,
        category=req.category,
    )
