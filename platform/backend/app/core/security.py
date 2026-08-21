from datetime import datetime, timedelta, timezone
import hashlib
import uuid
from typing import Any

import bcrypt
import jwt
from jwt import InvalidTokenError

from app.core.config import settings

import logging

logger = logging.getLogger(__name__)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(
        password.encode("utf-8"),
        bcrypt.gensalt(rounds=settings.BCRYPT_ROUNDS),
    ).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


def needs_rehash(hashed: str) -> bool:
    """기존 해시가 현재 BCRYPT_ROUNDS보다 낮으면 True (투명 리해시 필요).

    bcrypt 해시 형식: $2b$<rounds>$...
    """
    try:
        prefix = hashed.split("$")
        if len(prefix) >= 3:
            stored_rounds = int(prefix[2])
            return stored_rounds < settings.BCRYPT_ROUNDS
    except (ValueError, IndexError):
        logger.debug("bcrypt hash rounds parsing failed", exc_info=True)
    return False


def _base_claims(
    *,
    subject: str,
    token_type: str,
    expires_delta: timedelta,
    token_id: str | None = None,
    family_id: str | None = None,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": subject,
        "type": token_type,
        "jti": token_id or uuid.uuid4().hex,
        "iss": settings.JWT_ISSUER,
        "aud": settings.JWT_AUDIENCE,
        "iat": now,
        "nbf": now,
        "exp": now + expires_delta,
    }
    if family_id:
        payload["fid"] = family_id
    return payload


def generate_refresh_family_id() -> str:
    return uuid.uuid4().hex


def generate_token_id() -> str:
    return uuid.uuid4().hex


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_access_token(subject: str, expires_delta: timedelta | None = None) -> str:
    payload = _base_claims(
        subject=subject,
        token_type="access",
        expires_delta=(expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)),
    )
    # AUDIT §25 P0: JWT_SECRET 사용 (SECRET_KEY 공유 폭발 반경 축소)
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.ALGORITHM)


def decode_access_token(token: str) -> str | None:
    """Decode an access token and return the subject (``sub``) claim."""
    payload = decode_access_token_payload(token)
    if payload is None:
        return None
    return payload.get("sub")


def decode_access_token_payload(token: str) -> dict[str, Any] | None:
    """Decode an access token and return the full payload dict.

    Returns ``None`` when the token is invalid or is not an access token.
    The returned dict contains at least ``sub``, ``jti``, ``exp``, and ``type``.
    """
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET,  # AUDIT §25 P0: JWT 도메인 전용 시크릿
            algorithms=[settings.ALGORITHM],
            audience=settings.JWT_AUDIENCE,
            issuer=settings.JWT_ISSUER,
            leeway=settings.JWT_LEEWAY_SECONDS,
        )
        if payload.get("type") != "access":
            return None
        return payload
    except InvalidTokenError:
        # SECRET_KEY_PREVIOUS 폴백 (키 로테이션 지원)
        if settings.SECRET_KEY_PREVIOUS:
            try:
                payload = jwt.decode(
                    token,
                    settings.SECRET_KEY_PREVIOUS,
                    algorithms=[settings.ALGORITHM],
                    audience=settings.JWT_AUDIENCE,
                    issuer=settings.JWT_ISSUER,
                    leeway=settings.JWT_LEEWAY_SECONDS,
                )
                if payload.get("type") != "access":
                    return None
                return payload
            except InvalidTokenError:
                logger.debug("jwt validation failed for unknown token type", exc_info=True)
        return None


def create_refresh_token(
    subject: str,
    *,
    family_id: str | None = None,
    token_id: str | None = None,
) -> str:
    """Create a refresh token with token family and id claims."""
    payload = _base_claims(
        subject=subject,
        token_type="refresh",
        expires_delta=timedelta(days=settings.REFRESH_TOKEN_EXPIRE_DAYS),
        token_id=token_id,
        family_id=family_id,
    )
    # AUDIT §25 P0: JWT_SECRET 사용 (SECRET_KEY 공유 폭발 반경 축소)
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.ALGORITHM)


def decode_refresh_token(token: str) -> str | None:
    """Decode refresh token and return subject if valid."""
    payload = decode_refresh_token_payload(token)
    if not payload:
        return None
    return payload.get("sub")


def decode_refresh_token_payload(token: str) -> dict[str, Any] | None:
    """Decode refresh token payload."""
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET,  # AUDIT §25 P0: JWT 도메인 전용 시크릿
            algorithms=[settings.ALGORITHM],
            audience=settings.JWT_AUDIENCE,
            issuer=settings.JWT_ISSUER,
            leeway=settings.JWT_LEEWAY_SECONDS,
        )
        if payload.get("type") != "refresh":
            return None
        if not payload.get("jti") or not payload.get("fid"):
            return None
        return payload
    except InvalidTokenError:
        # SECRET_KEY_PREVIOUS 폴백 (키 로테이션 지원)
        if settings.SECRET_KEY_PREVIOUS:
            try:
                payload = jwt.decode(
                    token,
                    settings.SECRET_KEY_PREVIOUS,
                    algorithms=[settings.ALGORITHM],
                    audience=settings.JWT_AUDIENCE,
                    issuer=settings.JWT_ISSUER,
                    leeway=settings.JWT_LEEWAY_SECONDS,
                )
                if payload.get("type") != "refresh":
                    return None
                if not payload.get("jti") or not payload.get("fid"):
                    return None
                return payload
            except InvalidTokenError:
                logger.debug("refresh token validation failed", exc_info=True)
        return None
