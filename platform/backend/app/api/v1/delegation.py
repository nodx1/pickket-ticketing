"""P2-1: AI Agent Delegation Token API.

Endpoints for issuing, listing, revoking, and inspecting delegation tokens
that allow AI agents to act on behalf of authenticated users.
"""

import uuid
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.services import delegation_service

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────────────


class IssueTokenRequest(BaseModel):
    agent_name: str = Field(..., min_length=1, max_length=100, description="AI agent name")
    scopes: list[str] = Field(
        ..., min_length=1,
        description='Allowed scopes: ["view","bid","purchase","manage"]',
    )
    max_budget: Decimal | None = Field(None, ge=0, description="Max total spend (KRW)")
    daily_limit: int | None = Field(None, ge=1, description="Max transactions per day")
    expires_in_days: int = Field(7, ge=1, le=30, description="Token lifetime in days")


class IssueTokenResponse(BaseModel):
    id: str
    agent_name: str
    scopes: list[str]
    max_budget: float | None
    daily_limit: int | None
    expires_at: str
    token: str = Field(..., description="JWT delegation token — store securely, shown only once")


class TokenSummary(BaseModel):
    id: str
    agent_name: str
    scopes: list[str]
    max_budget: float | None
    daily_limit: int | None
    total_spent: float
    is_active: bool
    last_used_at: str | None
    expires_at: str
    created_at: str
    revoked_at: str | None


class TokenUsageResponse(BaseModel):
    token_id: str
    agent_name: str
    scopes: list[str]
    total_spent: float
    max_budget: float | None
    remaining_budget: float | None
    daily_limit: int | None
    daily_used: int
    remaining_daily: int | None
    is_active: bool
    last_used_at: str | None
    expires_at: str
    created_at: str
    revoked_at: str | None


class RevokeResponse(BaseModel):
    id: str
    revoked: bool


# ── Endpoints ────────────────────────────────────────────────────────────


@router.post("/tokens", response_model=IssueTokenResponse, status_code=status.HTTP_201_CREATED)
async def issue_delegation_token(
    body: IssueTokenRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Issue a new delegation token for an AI agent."""
    try:
        delegation, jwt_token = await delegation_service.issue_token(
            db,
            user_id=user.id,
            agent_name=body.agent_name,
            scopes=body.scopes,
            max_budget=body.max_budget,
            daily_limit=body.daily_limit,
            expires_in_days=body.expires_in_days,
        )
        await db.commit()
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(e))

    return IssueTokenResponse(
        id=str(delegation.id),
        agent_name=delegation.agent_name,
        scopes=delegation.scopes,
        max_budget=float(delegation.max_budget) if delegation.max_budget else None,
        daily_limit=delegation.daily_limit,
        expires_at=delegation.expires_at.isoformat(),
        token=jwt_token,
    )


@router.get("/tokens", response_model=list[TokenSummary])
async def list_delegation_tokens(
    include_revoked: bool = False,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """List my delegation tokens."""
    tokens = await delegation_service.list_tokens(
        db, user_id=user.id, include_revoked=include_revoked
    )
    return [
        TokenSummary(
            id=str(t.id),
            agent_name=t.agent_name,
            scopes=t.scopes,
            max_budget=float(t.max_budget) if t.max_budget else None,
            daily_limit=t.daily_limit,
            total_spent=float(t.total_spent),
            is_active=t.is_active,
            last_used_at=t.last_used_at.isoformat() if t.last_used_at else None,
            expires_at=t.expires_at.isoformat(),
            created_at=t.created_at.isoformat(),
            revoked_at=t.revoked_at.isoformat() if t.revoked_at else None,
        )
        for t in tokens
    ]


@router.delete("/tokens/{token_id}", response_model=RevokeResponse)
async def revoke_delegation_token(
    token_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Revoke a delegation token."""
    result = await delegation_service.revoke_token(
        db, token_id=token_id, user_id=user.id
    )
    if not result:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Delegation token not found",
        )
    await db.commit()
    return RevokeResponse(id=str(token_id), revoked=True)


@router.get("/tokens/{token_id}/usage", response_model=TokenUsageResponse)
async def get_token_usage(
    token_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get usage statistics for a delegation token."""
    try:
        stats = await delegation_service.get_usage_stats(
            db, token_id=token_id, user_id=user.id
        )
    except RuntimeError:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Daily limit check unavailable — please retry later",
        )
    if not stats:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Delegation token not found",
        )
    return TokenUsageResponse(**stats)
