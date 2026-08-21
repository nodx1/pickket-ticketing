"""OpenAPI/Swagger 공용 에러 응답 정의.

FastAPI 라우터의 `responses=` 인자에 spread 해서 사용 — Swagger UI 에서
각 엔드포인트가 어떤 에러 상태 코드를 반환할 수 있는지 명시.

사용 예:
    from app.shared.openapi_responses import COMMON_AUTH_RESPONSES

    @router.get("/me", responses={**COMMON_AUTH_RESPONSES})
    async def me(...): ...
"""
from pydantic import BaseModel


class ErrorDetail(BaseModel):
    """공통 에러 응답 바디."""

    detail: str


# 인증 필요한 엔드포인트 표준 에러 케이스
COMMON_AUTH_RESPONSES: dict[int, dict] = {
    401: {
        "description": "인증 실패 — 토큰 누락/만료/취소",
        "model": ErrorDetail,
        "content": {
            "application/json": {
                "examples": {
                    "missing": {
                        "summary": "토큰 누락",
                        "value": {"detail": "Missing authentication token"},
                    },
                    "expired": {
                        "summary": "토큰 만료",
                        "value": {"detail": "Invalid or expired token"},
                    },
                    "revoked": {
                        "summary": "토큰 취소됨",
                        "value": {"detail": "Token has been revoked"},
                    },
                }
            }
        },
    },
    403: {
        "description": "권한 없음",
        "model": ErrorDetail,
    },
}

# 리소스 조회 표준 에러
NOT_FOUND_RESPONSE: dict[int, dict] = {
    404: {
        "description": "리소스를 찾을 수 없음",
        "model": ErrorDetail,
    },
}

# 검증 실패
VALIDATION_RESPONSE: dict[int, dict] = {
    400: {
        "description": "요청 검증 실패",
        "model": ErrorDetail,
    },
}

# 외부 서비스 일시 장애 (Redis 등)
SERVICE_UNAVAILABLE_RESPONSE: dict[int, dict] = {
    503: {
        "description": "서비스 일시 사용 불가 — 잠시 후 재시도",
        "model": ErrorDetail,
    },
}
