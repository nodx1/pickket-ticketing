"""Standardized error codes and response factory for the Pickket API."""

from enum import Enum

from fastapi import HTTPException, status

from app.core.config import settings


class ErrorCode(str, Enum):
    """Application-level error codes returned in error responses."""

    # Auth
    INVALID_CREDENTIALS = "INVALID_CREDENTIALS"
    TOKEN_EXPIRED = "TOKEN_EXPIRED"
    TOKEN_REVOKED = "TOKEN_REVOKED"
    TOKEN_INVALID = "TOKEN_INVALID"
    TOKEN_REUSE_DETECTED = "TOKEN_REUSE_DETECTED"
    INSUFFICIENT_PERMISSIONS = "INSUFFICIENT_PERMISSIONS"
    EMAIL_ALREADY_EXISTS = "EMAIL_ALREADY_EXISTS"
    USER_NOT_FOUND = "USER_NOT_FOUND"
    FORBIDDEN = "FORBIDDEN"

    # Events
    EVENT_NOT_FOUND = "EVENT_NOT_FOUND"
    EVENT_NOT_OPEN = "EVENT_NOT_OPEN"
    EVENT_ALREADY_EXISTS = "EVENT_ALREADY_EXISTS"
    EVENT_NOT_MODIFIABLE = "EVENT_NOT_MODIFIABLE"
    EVENT_NOT_DELETABLE = "EVENT_NOT_DELETABLE"

    # Bids
    BID_NOT_FOUND = "BID_NOT_FOUND"
    BID_ALREADY_EXISTS = "BID_ALREADY_EXISTS"
    BID_WINDOW_CLOSED = "BID_WINDOW_CLOSED"
    BID_EXCEEDS_LIMIT = "BID_EXCEEDS_LIMIT"

    # Tickets
    TICKET_NOT_FOUND = "TICKET_NOT_FOUND"
    TICKET_NOT_OWNED = "TICKET_NOT_OWNED"
    TICKET_ALREADY_USED = "TICKET_ALREADY_USED"
    TICKET_NOT_ACTIVE = "TICKET_NOT_ACTIVE"

    # Orders / Payment
    ORDER_NOT_FOUND = "ORDER_NOT_FOUND"
    PAYMENT_FAILED = "PAYMENT_FAILED"
    PAYMENT_EXPIRED = "PAYMENT_EXPIRED"
    PAYMENT_ALREADY_CONFIRMED = "PAYMENT_ALREADY_CONFIRMED"

    # Points
    INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE"

    # Queue
    QUEUE_FULL = "QUEUE_FULL"
    NOT_IN_QUEUE = "NOT_IN_QUEUE"

    # Resale
    LISTING_NOT_FOUND = "LISTING_NOT_FOUND"
    PRICE_EXCEEDS_CAP = "PRICE_EXCEEDS_CAP"

    # Transfer
    TRANSFER_NOT_FOUND = "TRANSFER_NOT_FOUND"
    TRANSFER_ALREADY_COMPLETED = "TRANSFER_ALREADY_COMPLETED"
    TRANSFER_FORBIDDEN = "TRANSFER_FORBIDDEN"

    # Venues
    VENUE_NOT_FOUND = "VENUE_NOT_FOUND"

    # Purchase
    PURCHASE_INVALID = "PURCHASE_INVALID"

    # Partners
    TIER_NOT_FOUND = "TIER_NOT_FOUND"
    INSUFFICIENT_STOCK = "INSUFFICIENT_STOCK"

    # General
    VALIDATION_ERROR = "VALIDATION_ERROR"
    INTERNAL_ERROR = "INTERNAL_ERROR"
    SERVICE_UNAVAILABLE = "SERVICE_UNAVAILABLE"
    # 상세통합 S2b(§2.4): 일반 상태충돌(409) — 게스트 재클레임·입장완료 티켓 claim 방어 등.
    CONFLICT = "CONFLICT"


# Default HTTP status codes per error code
_DEFAULT_STATUS: dict[ErrorCode, int] = {
    ErrorCode.INVALID_CREDENTIALS: status.HTTP_401_UNAUTHORIZED,
    ErrorCode.TOKEN_EXPIRED: status.HTTP_401_UNAUTHORIZED,
    ErrorCode.TOKEN_REVOKED: status.HTTP_401_UNAUTHORIZED,
    ErrorCode.TOKEN_INVALID: status.HTTP_401_UNAUTHORIZED,
    ErrorCode.TOKEN_REUSE_DETECTED: status.HTTP_401_UNAUTHORIZED,
    ErrorCode.INSUFFICIENT_PERMISSIONS: status.HTTP_403_FORBIDDEN,
    ErrorCode.EMAIL_ALREADY_EXISTS: status.HTTP_400_BAD_REQUEST,
    ErrorCode.USER_NOT_FOUND: status.HTTP_401_UNAUTHORIZED,
    ErrorCode.FORBIDDEN: status.HTTP_403_FORBIDDEN,
    ErrorCode.EVENT_NOT_FOUND: status.HTTP_404_NOT_FOUND,
    ErrorCode.EVENT_NOT_OPEN: status.HTTP_400_BAD_REQUEST,
    ErrorCode.EVENT_NOT_MODIFIABLE: status.HTTP_400_BAD_REQUEST,
    ErrorCode.EVENT_NOT_DELETABLE: status.HTTP_400_BAD_REQUEST,
    ErrorCode.BID_NOT_FOUND: status.HTTP_404_NOT_FOUND,
    ErrorCode.BID_ALREADY_EXISTS: status.HTTP_409_CONFLICT,
    ErrorCode.BID_WINDOW_CLOSED: status.HTTP_400_BAD_REQUEST,
    ErrorCode.BID_EXCEEDS_LIMIT: status.HTTP_400_BAD_REQUEST,
    ErrorCode.TICKET_NOT_FOUND: status.HTTP_404_NOT_FOUND,
    ErrorCode.TICKET_NOT_OWNED: status.HTTP_403_FORBIDDEN,
    ErrorCode.TICKET_ALREADY_USED: status.HTTP_409_CONFLICT,
    ErrorCode.TICKET_NOT_ACTIVE: status.HTTP_400_BAD_REQUEST,
    ErrorCode.ORDER_NOT_FOUND: status.HTTP_404_NOT_FOUND,
    ErrorCode.PAYMENT_FAILED: status.HTTP_400_BAD_REQUEST,
    ErrorCode.PAYMENT_EXPIRED: status.HTTP_400_BAD_REQUEST,
    ErrorCode.PAYMENT_ALREADY_CONFIRMED: status.HTTP_409_CONFLICT,
    ErrorCode.INSUFFICIENT_BALANCE: status.HTTP_400_BAD_REQUEST,
    ErrorCode.QUEUE_FULL: status.HTTP_429_TOO_MANY_REQUESTS,
    ErrorCode.NOT_IN_QUEUE: status.HTTP_404_NOT_FOUND,
    ErrorCode.LISTING_NOT_FOUND: status.HTTP_404_NOT_FOUND,
    ErrorCode.PRICE_EXCEEDS_CAP: status.HTTP_400_BAD_REQUEST,
    ErrorCode.TRANSFER_NOT_FOUND: status.HTTP_404_NOT_FOUND,
    ErrorCode.TRANSFER_ALREADY_COMPLETED: status.HTTP_409_CONFLICT,
    ErrorCode.TRANSFER_FORBIDDEN: status.HTTP_403_FORBIDDEN,
    ErrorCode.VENUE_NOT_FOUND: status.HTTP_404_NOT_FOUND,
    ErrorCode.PURCHASE_INVALID: status.HTTP_400_BAD_REQUEST,
    ErrorCode.TIER_NOT_FOUND: status.HTTP_404_NOT_FOUND,
    ErrorCode.INSUFFICIENT_STOCK: status.HTTP_400_BAD_REQUEST,
    ErrorCode.VALIDATION_ERROR: status.HTTP_422_UNPROCESSABLE_ENTITY,
    ErrorCode.INTERNAL_ERROR: status.HTTP_500_INTERNAL_SERVER_ERROR,
    ErrorCode.SERVICE_UNAVAILABLE: status.HTTP_503_SERVICE_UNAVAILABLE,
    ErrorCode.CONFLICT: status.HTTP_409_CONFLICT,
}


def api_error(
    code: ErrorCode,
    detail: str | None = None,
    status_code: int | None = None,
) -> HTTPException:
    """Create an HTTPException with a standardized error code.

    Args:
        code: The application-level error code.
        detail: Human-readable error message. Defaults to the error code value.
        status_code: Override the HTTP status code. If not provided, uses the
            default status for the error code.
    """
    if settings.ENVIRONMENT == "production" and detail:
        # Don't leak internal error details in production
        error_detail = {"code": code.value}
    else:
        error_detail = {
            "code": code.value,
            "message": detail or code.value.replace("_", " ").title(),
        }
    return HTTPException(
        status_code=status_code or _DEFAULT_STATUS.get(code, 500),
        detail=error_detail,
    )


def client_error_detail(exc: Exception | str | None, fallback: str) -> str:
    """Return a client-facing error string without leaking internals in production."""
    if settings.ENVIRONMENT == "production":
        return fallback
    if exc is None:
        return fallback
    message = str(exc).strip()
    return message or fallback
