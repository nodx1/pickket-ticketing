"""Bot detection endpoints — server-side challenge/response model.

The client collects behavior data and POSTs it to /bot/challenge.
The server signs the token — the signing key NEVER leaves the server.
"""

import uuid

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.middleware.rate_limit import extract_client_ip
from app.services.bot_detection_service import BotDetectionService

router = APIRouter()


class ChallengeRequest(BaseModel):
    behaviors: dict


class ChallengeResponse(BaseModel):
    token: str
    session_id: str


@router.post("/bot/challenge", response_model=ChallengeResponse)
async def create_challenge(data: ChallengeRequest, request: Request):
    """Accept client behavior data, validate it, and return a server-signed
    opaque behavior token.  The signing key never leaves the server.

    Rate limited: 3 challenges per IP per 60s window.
    Each session_id is bound to the client IP.
    """
    ip = extract_client_ip(request)
    service = BotDetectionService()

    # Rate limit: max 3 outstanding challenges per IP per minute
    try:
        challenge_count = await service.get_challenge_count(ip)
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Service temporarily unavailable")

    if challenge_count >= 3:
        raise HTTPException(status_code=429, detail="Too many challenge requests")

    session_id = f"{ip}:{uuid.uuid4().hex[:8]}"

    try:
        token = await service.issue_challenge_token(session_id, data.behaviors)
    except RuntimeError:
        raise HTTPException(status_code=503, detail="Service temporarily unavailable")

    return ChallengeResponse(token=token, session_id=session_id)
