"""Notification 도메인 Pydantic 스키마(VO) 패키지.

요청 DTO 는 notification_requests.py, 응답 DTO 는 notification_responses.py.

겸 shim: 기존 `from app.schemas.notification import NotificationResponse` 호환.
구 평면 파일은 이 폴더와 이름 충돌하여 제거됨. Phase 11 에서 호환 re-export 도 제거 예정.
"""
from app.schemas.notification.notification_requests import PriceAlertCreate  # noqa: F401
from app.schemas.notification.notification_responses import (  # noqa: F401
    NotificationListResponse,
    NotificationResponse,
)
