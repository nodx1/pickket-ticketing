"""Notification 도메인 응답 DTO.

API 출력 Pydantic 모델 — 형식 검증 외 비즈니스 규칙 금지.
"""
import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class NotificationResponse(BaseModel):
    """알림 단건 응답."""

    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    type: str
    message: str
    data: dict | None = None
    is_read: bool
    created_at: datetime


class NotificationListResponse(BaseModel):
    """알림 목록 응답 + 미읽음 수."""

    notifications: list[NotificationResponse]
    unread_count: int
