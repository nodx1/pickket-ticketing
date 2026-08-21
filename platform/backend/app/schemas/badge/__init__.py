"""Badge 도메인 Pydantic 스키마(VO) 패키지.

겸 shim: 기존 `from app.schemas.badge import BadgeOut` 호환.
구 평면 파일은 이 폴더와 이름 충돌하여 제거됨. Phase 11 에서 호환 re-export 도 제거 예정.
"""
from app.schemas.badge.badge_responses import (  # noqa: F401
    BadgeCheckResult,
    BadgeListOut,
    BadgeOut,
    UserBadgeListOut,
    UserBadgeOut,
)
