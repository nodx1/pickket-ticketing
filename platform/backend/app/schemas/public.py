"""Public API schemas (no auth required)."""

import uuid

from pydantic import BaseModel, EmailStr, Field


# ── Contact ──────────────────────────────────────────────────────────────────


class ContactRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    email: EmailStr
    subject: str = Field(..., min_length=1, max_length=200)
    message: str = Field(..., min_length=10, max_length=5000)


class ContactResponse(BaseModel):
    id: uuid.UUID
    message: str = "문의가 접수되었습니다"

    model_config = {"from_attributes": True}


# ── Newsletter Subscribe ─────────────────────────────────────────────────────


class SubscribeRequest(BaseModel):
    email: EmailStr


class SubscribeResponse(BaseModel):
    email: str
    message: str = "구독이 완료되었습니다"


# ── Career Application ───────────────────────────────────────────────────────


class CareerApplyRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=100)
    email: EmailStr
    position: str = Field(..., min_length=1, max_length=200)
    message: str = Field(..., min_length=10, max_length=5000)
    resume_url: str | None = Field(None, max_length=500)
    phone: str | None = Field(None, max_length=30)


class CareerApplyResponse(BaseModel):
    id: uuid.UUID
    message: str = "지원서가 접수되었습니다"

    model_config = {"from_attributes": True}
