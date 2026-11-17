"""공정성 증명서 Ed25519 서명.

- 운영: `FAIRNESS_SIGNING_KEY` = Ed25519 개인키 32바이트 시드의 base64. 없으면 증명서 발급을
  거부한다(503). 서버 기동은 막지 않는다 — 기존 운영 동작을 바꾸지 않기 위함.
- 개발·테스트: 키가 없으면 SECRET_KEY 에서 HKDF 로 결정적으로 유도한다(경고 로그).
- 공개키는 `/fairness/keys` 로 배포한다. 누구나 증명서 서명을 직접 검증할 수 있다.

key_id = SHA-256(공개키 원본 32바이트) 앞 16자.
"""

from __future__ import annotations

import base64
import hashlib
import logging
from dataclasses import dataclass
from functools import lru_cache

from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey, Ed25519PublicKey
from cryptography.hazmat.primitives.kdf.hkdf import HKDF

from app.core.config import settings

logger = logging.getLogger(__name__)

SIGNATURE_ALGORITHM = "Ed25519"
_DEV_ENVIRONMENTS = {"development", "dev", "local", "test", "testing", "ci"}


class SigningKeyUnavailable(RuntimeError):
    """운영 환경에서 서명 키가 설정되지 않음."""


@dataclass(frozen=True)
class SigningKey:
    private_key: Ed25519PrivateKey
    public_raw: bytes
    key_id: str
    derived: bool


def _public_raw(private_key: Ed25519PrivateKey) -> bytes:
    return private_key.public_key().public_bytes(
        encoding=serialization.Encoding.Raw, format=serialization.PublicFormat.Raw
    )


@lru_cache(maxsize=1)
def get_signing_key() -> SigningKey:
    configured = (getattr(settings, "FAIRNESS_SIGNING_KEY", "") or "").strip()
    derived = False
    if configured:
        seed = base64.b64decode(configured)
        if len(seed) != 32:
            raise SigningKeyUnavailable("FAIRNESS_SIGNING_KEY must be base64 of 32 bytes")
    else:
        env = (settings.ENVIRONMENT or "").lower()
        if env not in _DEV_ENVIRONMENTS:
            raise SigningKeyUnavailable("FAIRNESS_SIGNING_KEY is not configured")
        seed = HKDF(
            algorithm=hashes.SHA256(),
            length=32,
            salt=b"pickket-fairness",
            info=b"ed25519-signing-key-v1",
        ).derive(settings.SECRET_KEY.encode("utf-8"))
        derived = True
        logger.warning("FAIRNESS_SIGNING_KEY 미설정 — 개발용 유도 키로 서명합니다 (env=%s)", env)
    private_key = Ed25519PrivateKey.from_private_bytes(seed)
    public_raw = _public_raw(private_key)
    return SigningKey(
        private_key=private_key,
        public_raw=public_raw,
        key_id=hashlib.sha256(public_raw).hexdigest()[:16],
        derived=derived,
    )


def sign(message: bytes) -> tuple[str, str]:
    """(base64 서명, key_id)"""
    key = get_signing_key()
    return base64.b64encode(key.private_key.sign(message)).decode("ascii"), key.key_id


def verify(message: bytes, signature_b64: str, public_key_b64: str) -> bool:
    try:
        public = Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key_b64))
        public.verify(base64.b64decode(signature_b64), message)
        return True
    except (InvalidSignature, ValueError):
        return False


def public_key_info() -> dict:
    key = get_signing_key()
    return {
        "key_id": key.key_id,
        "algorithm": SIGNATURE_ALGORITHM,
        "public_key": base64.b64encode(key.public_raw).decode("ascii"),
        "encoding": "base64(raw 32 bytes)",
        "development_key": key.derived,
    }
