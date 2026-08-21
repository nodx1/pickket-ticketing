"""Follow 도메인 Pydantic 스키마(VO) 패키지.

요청 DTO 는 follow_requests.py, 응답 DTO 는 follow_responses.py.

겸 shim: 기존 `from app.schemas.follow import FollowStatus` 같은 패턴 호환.
구 평면 파일(`app/schemas/follow.py`) 은 이 폴더와 이름 충돌하여 제거됨.
Phase 11 에서 호환 re-export 도 제거 예정.
"""
from app.schemas.follow.follow_responses import (  # noqa: F401
    FollowResponse,
    FollowStatus,
    FollowerListItem,
    FollowerListResponse,
)
