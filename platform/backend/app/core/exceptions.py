"""Application-level exception hierarchy for Pickket v2."""


class AppError(Exception):
    """Base application error with structured fields."""

    status_code: int = 500
    code: str = "INTERNAL_ERROR"
    message: str = "서버 오류가 발생했습니다."

    def __init__(
        self,
        message: str | None = None,
        code: str | None = None,
        status_code: int | None = None,
    ):
        self.message = message or self.__class__.message
        self.code = code or self.__class__.code
        self.status_code = status_code or self.__class__.status_code
        super().__init__(self.message)


class NotFoundError(AppError):
    status_code = 404
    code = "NOT_FOUND"
    message = "요청한 리소스를 찾을 수 없습니다."


class ValidationError(AppError):
    status_code = 422
    code = "VALIDATION_ERROR"
    message = "입력값이 올바르지 않습니다."


class ForbiddenError(AppError):
    status_code = 403
    code = "FORBIDDEN"
    message = "접근 권한이 없습니다."


class ConflictError(AppError):
    status_code = 409
    code = "CONFLICT"
    message = "요청이 현재 리소스 상태와 충돌합니다."


class ServiceUnavailableError(AppError):
    status_code = 503
    code = "SERVICE_UNAVAILABLE"
    message = "서비스를 일시적으로 사용할 수 없습니다."
