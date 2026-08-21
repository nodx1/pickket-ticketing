"""Badge 도메인 응답 DTO.

API 출력 Pydantic 모델 — 형식 검증 외 비즈니스 규칙 금지.
"""
import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class BadgeOut(BaseModel):
    """Badge 정의 응답."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    name: str
    description: str | None = None
    icon_url: str | None = None
    category: str
    condition_type: str
    condition_value: int


class BadgeListOut(BaseModel):
    """Badge 카탈로그 목록."""

    badges: list[BadgeOut]
    total: int


class UserBadgeOut(BaseModel):
    """사용자가 획득한 Badge 응답."""

    id: uuid.UUID
    badge_id: uuid.UUID
    name: str
    description: str | None = None
    icon_url: str | None = None
    category: str
    earned_at: datetime | None = None


class UserBadgeListOut(BaseModel):
    """획득 Badge 목록."""

    badges: list[UserBadgeOut]
    total: int


class BadgeCheckResult(BaseModel):
    """Badge 조건 검사 후 신규 부여 결과."""

    newly_awarded: list[UserBadgeOut]
    total_badges: int
