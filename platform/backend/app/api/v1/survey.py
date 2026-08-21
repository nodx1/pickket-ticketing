"""Survey API endpoints."""
import hashlib
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.models.survey import SurveyResponse

router = APIRouter(prefix="/surveys", tags=["surveys"])


class SurveySubmitRequest(BaseModel):
    answers: dict
    metadata: dict | None = None


class SurveySubmitResponse(BaseModel):
    id: str
    message: str


@router.post("/{survey_id}/responses", status_code=201, response_model=SurveySubmitResponse)
async def submit_survey(
    survey_id: str,
    body: SurveySubmitRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Submit a survey response. No authentication required."""
    # Generate fingerprint from IP + User-Agent for dedup
    client_ip = request.client.host if request.client else "unknown"
    ua = request.headers.get("user-agent", "")
    raw = f"{survey_id}:{client_ip}:{ua}"
    fingerprint = hashlib.sha256(raw.encode()).hexdigest()[:32]

    # Check for duplicate
    existing = await db.execute(
        select(SurveyResponse).where(
            SurveyResponse.survey_id == survey_id,
            SurveyResponse.fingerprint == fingerprint,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="이미 설문에 참여하셨습니다")

    response = SurveyResponse(
        survey_id=survey_id,
        fingerprint=fingerprint,
        answers=body.answers,
        metadata_info=body.metadata,
    )
    db.add(response)
    await db.commit()

    return SurveySubmitResponse(id=str(response.id), message="설문이 제출되었습니다")


class SurveyStatsResponse(BaseModel):
    total_responses: int
    answers_distribution: dict


@router.get("/{survey_id}/stats", response_model=SurveyStatsResponse)
async def get_survey_stats(
    survey_id: str,
    db: AsyncSession = Depends(get_db),
):
    """Get aggregated survey stats. For admin use."""
    total = await db.scalar(
        select(func.count()).where(SurveyResponse.survey_id == survey_id)
    )

    # Get all responses for aggregation
    result = await db.execute(
        select(SurveyResponse.answers).where(SurveyResponse.survey_id == survey_id)
    )
    all_answers = [row[0] for row in result.all()]

    # Aggregate all answer keys dynamically
    distribution: dict = {}
    for ans in all_answers:
        for key, val in ans.items():
            if key not in distribution:
                distribution[key] = {}
            if isinstance(val, list):
                for v in val:
                    distribution[key][v] = distribution[key].get(v, 0) + 1
            elif val is not None:
                str_val = str(val)
                distribution[key][str_val] = distribution[key].get(str_val, 0) + 1

    return SurveyStatsResponse(
        total_responses=total or 0,
        answers_distribution=distribution,
    )
