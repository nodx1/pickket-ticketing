"""
Dynamic QR Service — Pickket Locked Ticket (P2)
================================================
Multi-mode QR engine for ticket entry verification.

**정식 스펙**: ``docs/architecture/LOCKED_TICKET_SPEC.md`` (v1.0)

Modes:
  1. **TOTPQRService** (primary): HMAC-SHA256 TOTP, 15초 윈도우, 8자리 코드,
     Fernet 암호화 seed, device binding (HTTPOnly cookie).
  2. **Legacy HMAC**: ``ticket_id|timestamp|signature``, 3초 TTL (fallback).
  3. **Device-Bound QR**: device_hash 포함 HMAC 서명.
  4. **Adaptive TTL**: 네트워크/신뢰도 기반 동적 TTL (1~10초).
  5. **Chain of Custody**: SHA-256 해시 체인 감사 추적.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import struct
import time
import uuid
from typing import Optional

from cryptography.fernet import Fernet
from app.core.config import settings


def generate_qr(ticket_id: uuid.UUID, secret_key: str) -> str:
    """Generate a time-limited QR code payload for a ticket.

    The payload format is ``{ticket_id}|{timestamp}|{signature}``
    encoded as URL-safe base64.

    Args:
        ticket_id: The ticket UUID.
        secret_key: The HMAC secret key.

    Returns:
        A base64-encoded QR code string.
    """
    payload = f"{ticket_id}|{int(time.time())}"
    signature = hmac.new(secret_key.encode(), payload.encode(), hashlib.sha256).hexdigest()[:16]
    raw = f"{payload}|{signature}"
    return base64.urlsafe_b64encode(raw.encode()).decode()


def verify_qr(
    qr_data: str,
    secret_key: str,
    max_age_seconds: int = 3,
) -> uuid.UUID | None:
    """Verify a QR code payload and return the ticket ID if valid.

    Checks that the HMAC signature matches and that the timestamp
    is within ``max_age_seconds`` of the current time.

    Args:
        qr_data: The base64-encoded QR payload.
        secret_key: The HMAC secret key (must match generation key).
        max_age_seconds: Maximum age of the QR code in seconds.

    Returns:
        The ticket UUID if the QR code is valid, or ``None`` if
        the code is expired or tampered with.
    """
    try:
        decoded = base64.urlsafe_b64decode(qr_data.encode()).decode()
        parts = decoded.split("|")
        if len(parts) != 3:
            return None

        ticket_id_str, timestamp_str, provided_sig = parts

        # Verify HMAC
        payload = f"{ticket_id_str}|{timestamp_str}"
        expected_sig = hmac.new(secret_key.encode(), payload.encode(), hashlib.sha256).hexdigest()[
            :16
        ]
        if not hmac.compare_digest(provided_sig, expected_sig):
            return None

        # Verify timestamp freshness
        ts = int(timestamp_str)
        if abs(time.time() - ts) > max_age_seconds:
            return None

        return uuid.UUID(ticket_id_str)
    except (ValueError, UnicodeDecodeError, base64.binascii.Error):
        return None


# ---------------------------------------------------------------------------
# Device-Binding QR Generator
# ---------------------------------------------------------------------------


def generate_device_bound_qr(
    ticket_id: str,
    device_fingerprint: str,
    secret_key: str,
    max_age_seconds: int = 3,
) -> dict:
    """Generate a device-bound dynamic QR code.

    Extends standard QR generation with device fingerprint binding,
    creating a signature that is valid only on the originating device.

    The payload includes a truncated device hash, making the QR code
    non-transferable between devices without server authorization.

    Args:
        ticket_id: The ticket identifier.
        device_fingerprint: Client device fingerprint (User-Agent + screen + timezone hash).
        secret_key: HMAC secret key.
        max_age_seconds: QR validity window.

    Returns:
        Dict with 'qr_data' (base64 encoded) and 'device_hash' (for verification).
    """
    ts = int(time.time())
    device_hash = hashlib.sha256(device_fingerprint.encode()).hexdigest()[:8]

    # 4-part payload: ticket_id | timestamp | device_hash | signature
    payload = f"{ticket_id}|{ts}|{device_hash}"
    sig = hmac.new(secret_key.encode(), payload.encode(), hashlib.sha256).hexdigest()[:16]

    raw = f"{payload}|{sig}"
    qr_data = base64.urlsafe_b64encode(raw.encode()).decode()

    return {
        "qr_data": qr_data,
        "device_hash": device_hash,
        "expires_at": ts + max_age_seconds,
    }


def verify_device_bound_qr(
    qr_data: str,
    secret_key: str,
    device_fingerprint: str,
    max_age_seconds: int = 3,
) -> dict:
    """Verify a device-bound QR code.

    Performs 4-step verification:
    1. Base64 decode and parse 4-part payload
    2. HMAC signature verification (timing-safe)
    3. Timestamp freshness check
    4. Device fingerprint match

    Returns:
        Dict with 'valid' bool, 'ticket_id', and 'reason' if invalid.
    """
    try:
        raw = base64.urlsafe_b64decode(qr_data.encode()).decode()
        parts = raw.split("|")
        if len(parts) != 4:
            return {"valid": False, "ticket_id": None, "reason": "invalid_format"}

        ticket_id, ts_str, device_hash, sig = parts
        ts = int(ts_str)

        # Step 1: Signature verification
        payload = f"{ticket_id}|{ts_str}|{device_hash}"
        expected_sig = hmac.new(secret_key.encode(), payload.encode(), hashlib.sha256).hexdigest()[
            :16
        ]

        if not hmac.compare_digest(sig, expected_sig):
            return {"valid": False, "ticket_id": ticket_id, "reason": "invalid_signature"}

        # Step 2: Freshness check
        if abs(time.time() - ts) > max_age_seconds:
            return {"valid": False, "ticket_id": ticket_id, "reason": "expired"}

        # Step 3: Device binding verification
        expected_device_hash = hashlib.sha256(device_fingerprint.encode()).hexdigest()[:8]
        if not hmac.compare_digest(device_hash, expected_device_hash):
            return {"valid": False, "ticket_id": ticket_id, "reason": "device_mismatch"}

        return {"valid": True, "ticket_id": ticket_id, "reason": "ok"}

    except Exception:
        return {"valid": False, "ticket_id": None, "reason": "decode_error"}


# ---------------------------------------------------------------------------
# Adaptive TTL Engine
# ---------------------------------------------------------------------------


class AdaptiveTTLEngine:
    """적응형 TTL 엔진 — 네트워크/신뢰도/위치 기반 동적 유효시간 산출.

    Dynamically adjusts QR code TTL based on:
    - Network latency (high latency → longer TTL)
    - User trust score (low trust → shorter TTL for security)
    - Venue proximity (remote → slightly longer TTL)

    TTL = clip(base + network_adj + trust_adj + venue_adj, 1, 10) seconds
    """

    BASE_TTL = 3  # seconds
    MIN_TTL = 1
    MAX_TTL = 10

    @staticmethod
    def compute_ttl(
        network_latency_ms: float = 100.0,
        trust_score: float = 0.8,
        is_venue_nearby: bool = True,
    ) -> dict:
        """Compute adaptive TTL based on context.

        Args:
            network_latency_ms: Estimated network round-trip time in ms.
            trust_score: User trust score [0, 1] based on history.
            is_venue_nearby: Whether user is geographically near the venue.

        Returns:
            Dict with 'ttl' (seconds) and component breakdown.
        """
        # Network adjustment: high latency needs more time
        network_adj = min(2.0, network_latency_ms / 500.0)

        # Trust adjustment: low trust → shorter TTL (tighter security)
        trust_adj = max(-1.0, (trust_score - 0.5) * -2.0)

        # Venue proximity: remote users get slight extension
        venue_adj = 1.0 if not is_venue_nearby else 0.0

        ttl = max(
            AdaptiveTTLEngine.MIN_TTL,
            min(
                AdaptiveTTLEngine.MAX_TTL,
                AdaptiveTTLEngine.BASE_TTL + network_adj + trust_adj + venue_adj,
            ),
        )

        return {
            "ttl": round(ttl, 1),
            "base": AdaptiveTTLEngine.BASE_TTL,
            "network_adj": round(network_adj, 2),
            "trust_adj": round(trust_adj, 2),
            "venue_adj": round(venue_adj, 2),
        }


# ---------------------------------------------------------------------------
# Chain of Custody Tracker
# ---------------------------------------------------------------------------


class ChainOfCustodyTracker:
    """해시 체인 기반 소유권 추적 — 블록체인 없이 감사 추적.

    Records every ownership event for a ticket as a hash chain:
    new_hash = SHA256(ticket_id | event_type | actor_id | timestamp | prev_hash)

    Event types: ISSUED, TRANSFERRED, QR_GENERATED, QR_VERIFIED, CHECKED_IN

    Tampering detection: If any event in the chain is modified,
    all subsequent hashes become invalid, breaking the chain.
    """

    EVENT_TYPES = ("ISSUED", "TRANSFERRED", "QR_GENERATED", "QR_VERIFIED", "CHECKED_IN")

    @staticmethod
    def compute_event_hash(
        ticket_id: str,
        event_type: str,
        actor_id: str,
        timestamp: int,
        prev_hash: str = "0" * 64,
    ) -> str:
        """Compute hash for a custody event.

        Args:
            ticket_id: Ticket identifier.
            event_type: One of EVENT_TYPES.
            actor_id: User or system that triggered the event.
            timestamp: Unix timestamp of the event.
            prev_hash: Hash of the previous event (genesis = "0" * 64).

        Returns:
            SHA-256 hex digest of the event.
        """
        event_data = f"{ticket_id}|{event_type}|{actor_id}|{timestamp}|{prev_hash}"
        return hashlib.sha256(event_data.encode()).hexdigest()

    @staticmethod
    def verify_chain(events: list[dict]) -> dict:
        """Verify integrity of a custody chain.

        Args:
            events: Ordered list of custody events, each with:
                ticket_id, event_type, actor_id, timestamp, hash, prev_hash

        Returns:
            Dict with 'valid' bool and 'broken_at' index if invalid.
        """
        for i, event in enumerate(events):
            expected_hash = ChainOfCustodyTracker.compute_event_hash(
                event["ticket_id"],
                event["event_type"],
                event["actor_id"],
                event["timestamp"],
                event.get("prev_hash", "0" * 64),
            )
            if expected_hash != event.get("hash"):
                return {"valid": False, "broken_at": i, "expected": expected_hash}

        # Verify chain linkage
        for i in range(1, len(events)):
            if events[i].get("prev_hash") != events[i - 1].get("hash"):
                return {"valid": False, "broken_at": i, "reason": "chain_break"}

        return {"valid": True, "length": len(events)}


# ---------------------------------------------------------------------------
# TOTP QR Service (SafeTix Pattern)
# ---------------------------------------------------------------------------


class TOTPQRService:
    """
    TOTP-based rotating QR code service (SafeTix pattern).
    - 15-second rotation window
    - Device-bound verification
    - Server-side only: seed NEVER leaves the server
    """

    INTERVAL = 15  # seconds
    DIGITS = 8
    SECURE_DEVICE_HASH_PREFIX = "s"

    @staticmethod
    def _get_fernet() -> Optional[Fernet]:
        """Get Fernet instance for seed encryption. Returns None if key not configured."""
        if not settings.TOTP_ENCRYPTION_KEY:
            return None
        return Fernet(settings.TOTP_ENCRYPTION_KEY.encode() if isinstance(settings.TOTP_ENCRYPTION_KEY, str) else settings.TOTP_ENCRYPTION_KEY)

    @staticmethod
    def encrypt_seed(raw_seed: bytes) -> bytes:
        """Encrypt TOTP seed. Returns raw seed if encryption key not configured."""
        fernet = TOTPQRService._get_fernet()
        if fernet is None:
            return raw_seed
        return fernet.encrypt(raw_seed)

    @staticmethod
    def decrypt_seed(encrypted_seed: bytes) -> bytes:
        """Decrypt TOTP seed. Returns as-is if encryption key not configured."""
        fernet = TOTPQRService._get_fernet()
        if fernet is None:
            return encrypted_seed
        try:
            return fernet.decrypt(encrypted_seed)
        except Exception:
            # Fallback: assume seed is not encrypted (migration period)
            return encrypted_seed

    @staticmethod
    def generate_seed() -> bytes:
        """Generate a 32-byte random TOTP seed, encrypted if key is configured."""
        raw_seed = os.urandom(32)
        return TOTPQRService.encrypt_seed(raw_seed)

    @classmethod
    def compute_totp(cls, seed: bytes, timestamp: float | None = None) -> str:
        """Compute TOTP code for current time window."""
        seed = cls.decrypt_seed(seed)
        if timestamp is None:
            timestamp = time.time()
        counter = int(timestamp) // cls.INTERVAL
        counter_bytes = struct.pack(">Q", counter)

        hmac_digest = hmac.new(seed, counter_bytes, hashlib.sha256).digest()
        offset = hmac_digest[-1] & 0x0F
        code = struct.unpack(">I", hmac_digest[offset:offset + 4])[0] & 0x7FFFFFFF
        return str(code % (10 ** cls.DIGITS)).zfill(cls.DIGITS)

    @classmethod
    def generate_qr_payload(cls, ticket_id: str, seed: bytes,
                            device_hash: str, timestamp: float | None = None) -> str:
        """Generate QR payload: ticket_id|totp_code|device_hash"""
        totp_code = cls.compute_totp(seed, timestamp)
        return f"{ticket_id}|{totp_code}|{device_hash}"

    @classmethod
    def verify_qr(cls, payload: str, seed: bytes, expected_device_hash: str,
                  max_window: int = 1) -> tuple[bool, str]:
        """
        Verify QR payload.

        Args:
            payload: "ticket_id|totp_code|device_hash"
            seed: TOTP seed from DB
            expected_device_hash: Device hash from DB
            max_window: Number of previous windows to accept (default 1 = ±15s)

        Returns:
            (is_valid, error_message)
        """
        parts = payload.split("|")
        if len(parts) != 3:
            return False, "invalid_format"

        ticket_id, totp_code, device_hash = parts

        # Verify device binding
        if device_hash != expected_device_hash:
            return False, "device_mismatch"

        # Verify TOTP code (current + previous windows)
        now = time.time()
        for offset in range(-max_window, max_window + 1):
            check_time = now + (offset * cls.INTERVAL)
            expected_code = cls.compute_totp(seed, check_time)
            if hmac.compare_digest(totp_code, expected_code):
                return True, ""

        return False, "totp_expired"

    @staticmethod
    def generate_device_binding_secret() -> str:
        """Generate opaque server-side device binding secret."""
        return secrets.token_urlsafe(32)

    @staticmethod
    def compute_device_hash(user_agent: str, screen_info: str = "",
                           timezone: str = "", binding_secret: str = "",
                           device_id: str = "") -> str:
        """Compute device fingerprint hash.

        AUDIT 2026-04-20 §13 P0:
        ``device_id``는 모바일 SecureStore에 저장된 지속 식별자 (X-Device-Id 헤더).
        User-Agent/Screen-Info/Timezone은 스푸핑이 쉬우므로 device_id를 함께 포함해
        한 번 바인딩된 디바이스가 아니면 같은 해시를 만들 수 없게 한다.
        """
        fingerprint = f"{user_agent}|{screen_info}|{timezone}|{device_id}"
        if binding_secret:
            digest = hashlib.sha256(f"{binding_secret}|{fingerprint}".encode()).hexdigest()
            return f"{TOTPQRService.SECURE_DEVICE_HASH_PREFIX}{digest[:63]}"
        return hashlib.sha256(fingerprint.encode()).hexdigest()

    @classmethod
    def matches_device_hash(
        cls,
        stored_hash: str,
        user_agent: str,
        screen_info: str = "",
        timezone: str = "",
        binding_secret: str = "",
        device_id: str = "",
    ) -> bool:
        """Verify the current request matches the bound device hash.

        Secure-mode hashes require the opaque binding secret.
        Legacy hashes fall back to pure fingerprint matching for compatibility.
        Transition: ``device_id`` 포함 해시와 미포함(legacy) 해시 모두 허용해
        기존 바인딩된 티켓이 깨지지 않도록 한다.
        """
        if not stored_hash:
            return False

        if stored_hash.startswith(cls.SECURE_DEVICE_HASH_PREFIX):
            if not binding_secret:
                return False
            # 새 스키마 (device_id 포함) 우선 시도
            expected_new = cls.compute_device_hash(
                user_agent,
                screen_info,
                timezone,
                binding_secret=binding_secret,
                device_id=device_id,
            )
            if hmac.compare_digest(stored_hash, expected_new):
                return True
            # 레거시 스키마 (device_id 없음) 허용 — 기존 바인딩 보호
            expected_legacy = cls.compute_device_hash(
                user_agent,
                screen_info,
                timezone,
                binding_secret=binding_secret,
            )
            return hmac.compare_digest(stored_hash, expected_legacy)

        legacy = cls.compute_device_hash(user_agent, screen_info, timezone)
        return hmac.compare_digest(stored_hash, legacy)
