"""Notification 도메인 요청 DTO.

API 입력 Pydantic 모델 — 형식 검증 외 비즈니스 규칙 금지.
"""
import uuid

from pydantic import BaseModel


class PriceAlertCreate(BaseModel):
    """더치 옥션 가격 알림 구독 요청."""

    event_id: uuid.UUID
    tier_id: uuid.UUID
    target_price: float
