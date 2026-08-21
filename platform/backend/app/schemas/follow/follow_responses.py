"""Follow 도메인 응답 DTO.

API 출력 Pydantic 모델 — 형식 검증 외 비즈니스 규칙 금지.
"""
import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class FollowResponse(BaseModel):
    """단건 팔로우 관계 응답."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    follower_id: uuid.UUID
    following_id: uuid.UUID
    created_at: datetime


class FollowStatus(BaseModel):
    """팔로우 상태 + 카운터 응답 (타인 프로필 조회용)."""

    is_following: bool
    follower_count: int
    following_count: int


class FollowerListItem(BaseModel):
    """팔로워/팔로잉 목록의 행 항목."""

    model_config = ConfigDict(from_attributes=True)

    user_id: uuid.UUID
    name: str
    profile_image_url: str | None = None
    is_organizer: bool = False
    followed_at: datetime


class FollowerListResponse(BaseModel):
    """팔로워/팔로잉 목록 페이지 응답."""

    items: list[FollowerListItem]
    total: int
    has_more: bool
