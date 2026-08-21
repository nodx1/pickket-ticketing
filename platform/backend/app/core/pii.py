"""Helpers for encrypting sensitive PII fields at rest."""

from __future__ import annotations

import hashlib
import hmac
from datetime import date, datetime
from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy.types import String, TypeDecorator

from app.core.config import settings

import logging

logger = logging.getLogger(__name__)

_PII_PREFIX = "enc::"
_PHONE_LOOKUP_DOMAIN = b"pickket:buyer-phone-blind-index:v1"


@lru_cache(maxsize=4)
def _build_fernet(key: str) -> Fernet:
    return Fernet(key.encode())


def reset_pii_fernet_cache() -> None:
    _build_fernet.cache_clear()


def normalize_phone_for_lookup(value: str | None) -> str | None:
    """전화번호 조회용 정규형.

    go 공개조회 쿠키와 같은 계약으로 구분자만 제거한다. 국가번호 변환은 하지 않는다.
    구매 때 ``010...`` 을 저장하고 조회 때 ``+82...`` 를 입력한 경우를 같은 번호로
    간주하려면 쿠키 본인확인 계약도 함께 바꿔야 하므로 여기서 권한 범위를 넓히지 않는다.
    """
    if value is None:
        return None
    normalized = "".join(char for char in str(value) if char.isdigit())
    return normalized or None


def _phone_lookup_digest_with_key(normalized: str, key: str) -> str:
    """저엔트로피 전화번호용 keyed blind index.

    원문 SHA-256은 국내 전화번호 공간을 전수대입할 수 있어 사용하지 않는다. Fernet
    master key에서 용도 분리된 HMAC sub-key를 파생한 뒤 다시 HMAC한다. 따라서 DB만
    유출돼서는 전화번호 사전을 검증할 수 없다.
    """
    subkey = hmac.new(key.encode(), _PHONE_LOOKUP_DOMAIN, hashlib.sha256).digest()
    return hmac.new(subkey, normalized.encode(), hashlib.sha256).hexdigest()


def phone_lookup_digest(value: str | None) -> str | None:
    """현재 PII 키로 전화번호 blind index를 계산한다.

    개발환경의 기존 평문 폴백과 호환하기 위해 키가 없으면 ``None``이다. staging/prod는
    Settings 검증이 PII_ENCRYPTION_KEY 미설정 기동을 거부한다.
    """
    normalized = normalize_phone_for_lookup(value)
    key = settings.PII_ENCRYPTION_KEY.strip()
    if normalized is None or not key:
        return None
    return _phone_lookup_digest_with_key(normalized, key)


def phone_lookup_digests(value: str | None) -> tuple[str, ...]:
    """조회 시 허용할 현재·이전 키 blind index.

    Fernet 키 로테이션 중 기존 행은 이전 키 hash를 갖고 있을 수 있다. 기존 ciphertext
    복호화와 동일하게 previous key 유예기간 동안 두 값을 조회해 무중단 전환한다.
    """
    normalized = normalize_phone_for_lookup(value)
    if normalized is None:
        return ()
    digests: list[str] = []
    for key in (
        settings.PII_ENCRYPTION_KEY.strip(),
        settings.PII_ENCRYPTION_KEY_PREVIOUS.strip(),
    ):
        if not key:
            continue
        digest = _phone_lookup_digest_with_key(normalized, key)
        if digest not in digests:
            digests.append(digest)
    return tuple(digests)


def _get_fernet() -> Fernet | None:
    key = settings.PII_ENCRYPTION_KEY.strip()
    if not key:
        return None
    return _build_fernet(key)


def _get_previous_fernet() -> Fernet | None:
    """이전 PII 키 — 키 로테이션 시 복호화 폴백용."""
    prev = getattr(settings, "PII_ENCRYPTION_KEY_PREVIOUS", "").strip()
    if not prev:
        return None
    return _build_fernet(prev)


def encrypt_pii_text(value: str | None) -> str | None:
    if value is None:
        return None

    fernet = _get_fernet()
    if fernet is None:
        return value

    return f"{_PII_PREFIX}{fernet.encrypt(value.encode()).decode()}"


def decrypt_pii_text(value: str | None) -> str | None:
    if value is None or not isinstance(value, str):
        return value
    if not value.startswith(_PII_PREFIX):
        return value

    fernet = _get_fernet()
    if fernet is None:
        raise RuntimeError("PII_ENCRYPTION_KEY is required to decrypt protected values")

    token = value[len(_PII_PREFIX) :]
    try:
        return fernet.decrypt(token.encode()).decode()
    except InvalidToken:
        # 키 로테이션 폴백: 이전 키로 복호화 시도
        prev_fernet = _get_previous_fernet()
        if prev_fernet is not None:
            try:
                return prev_fernet.decrypt(token.encode()).decode()
            except InvalidToken:
                logger.warning("pii decryption failed with both current and previous keys", exc_info=True)
        raise RuntimeError("Failed to decrypt protected PII value — check PII_ENCRYPTION_KEY")


def mask_email(email: str) -> str:
    """이메일 마스킹: user@example.com → u***@example.com"""
    if not email or "@" not in email:
        return "***"
    local, domain = email.rsplit("@", 1)
    if len(local) <= 1:
        return f"{local}***@{domain}"
    return f"{local[0]}***@{domain}"


def mask_phone(phone: str | None) -> str:
    """전화번호 마스킹: 010-1234-5678 → 010-****-5678"""
    if not phone:
        return ""
    digits = "".join(c for c in phone if c.isdigit())
    if len(digits) < 7:
        return "***"
    return f"{digits[:3]}-****-{digits[-4:]}"


# 결제 PG 전문(나이스/토스/포트원)에 실려오는 PII·민감 필드명(대소문자 무관).
# 로그·감사·payment_metadata 저장 전에 이 키들을 마스킹한다(A5).
#   - 구매자 연락처/이름/이메일, 카드번호·유효기간·할부, 가상계좌 번호, 서명·머천트키.
_PAYMENT_PII_KEYS: frozenset[str] = frozenset(
    k.lower()
    for k in (
        # 나이스 구형(대문자)
        "BuyerTel", "BuyerEmail", "BuyerName", "buyerTel", "buyerEmail", "buyerName",
        "CardNo", "CardNum", "CardQuota", "CardCode", "CardName", "AcctNo", "AccountNo",
        "VbankNum", "VbankNo", "VbankAccountNo", "RefundAcctNo", "RefundAcctNm",
        "MerchantKey", "SignData", "Signature",
        # 토스/포트원/일반
        "customerName", "customerEmail", "customerMobilePhone", "phoneNumber",
        "email", "phone", "tel", "mobile", "card", "cardNumber", "accountNumber",
        "receiptUrl", "virtualAccount",
    )
)


def mask_payment_payload(payload: object, *, _depth: int = 0) -> object:
    """결제 PG 전문에서 PII·민감 필드를 마스킹한 사본을 반환한다(A5).

    로그·감사(audit_logs)·payment_metadata 에 PG 원문(raw)을 남기기 전에 호출한다.
    구매자 연락처/이메일/이름·카드번호·가상계좌번호·서명·MerchantKey 등을 값 유형별로
    마스킹한다(전화=mask_phone, 이메일=mask_email, 그 외=길이 힌트만 남긴 ``***``).

    원본은 변형하지 않는다(shallow copy per level). dict/list 재귀(깊이 상한 6 —
    순환/과도한 중첩 방지). 비-컨테이너·비대상 키는 그대로 통과한다.
    """
    if _depth > 6:
        return "***"
    if isinstance(payload, dict):
        out: dict = {}
        for k, v in payload.items():
            if isinstance(k, str) and k.lower() in _PAYMENT_PII_KEYS:
                out[k] = _mask_scalar(k, v)
            else:
                out[k] = mask_payment_payload(v, _depth=_depth + 1)
        return out
    if isinstance(payload, (list, tuple)):
        return [mask_payment_payload(v, _depth=_depth + 1) for v in payload]
    return payload


def _mask_scalar(key: str, value: object) -> str:
    """PII 스칼라 값 마스킹 — 전화/이메일은 전용 마스커, 그 외는 완전 은폐."""
    if value is None or value == "":
        return ""
    s = str(value)
    kl = key.lower()
    if "email" in kl:
        return mask_email(s)
    if any(t in kl for t in ("tel", "phone", "mobile")):
        return mask_phone(s)
    # 카드번호/계좌/서명/머천트키 등 — 완전 은폐(끝 2자만 힌트, 짧으면 전부).
    if len(s) <= 4:
        return "***"
    return f"***{s[-2:]}"


class EncryptedString(TypeDecorator):
    """String column that transparently encrypts/decrypts values."""

    impl = String
    cache_ok = True

    def __init__(self, length: int = 512, **kwargs):
        super().__init__(length=length, **kwargs)

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        return encrypt_pii_text(str(value))

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        return decrypt_pii_text(value)


class EncryptedDate(TypeDecorator):
    """Date value stored as encrypted ISO-8601 text."""

    impl = String
    cache_ok = True

    def __init__(self, length: int = 512, **kwargs):
        super().__init__(length=length, **kwargs)

    def process_bind_param(self, value, dialect):
        if value is None:
            return None
        if isinstance(value, datetime):
            value = value.date()
        if not isinstance(value, date):
            raise TypeError("EncryptedDate expects a date value")
        return encrypt_pii_text(value.isoformat())

    def process_result_value(self, value, dialect):
        if value is None:
            return None
        if isinstance(value, date) and not isinstance(value, datetime):
            return value
        raw = decrypt_pii_text(value)
        if raw is None:
            return None
        return date.fromisoformat(raw)
