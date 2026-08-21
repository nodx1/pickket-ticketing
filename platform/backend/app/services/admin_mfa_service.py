"""관리자 MFA (TOTP) 서비스.

YES24 해킹 대비 — 관리자 계정 탈취 방지를 위한 TOTP 2차 인증.
- 관리자 첫 로그인 시 MFA 설정 강제
- pyotp 기반 TOTP (Google Authenticator / Authy 호환)
- 시크릿은 Fernet 암호화 후 DB 저장
"""

import base64
import json
import logging
import secrets
import uuid

import bcrypt
from cryptography.fernet import Fernet

from app.core.config import settings

logger = logging.getLogger(__name__)

# TOTP parameters
TOTP_DIGITS = 6
TOTP_INTERVAL = 30  # seconds
TOTP_ISSUER = "Pickket Admin"


def _get_fernet() -> Fernet | None:
    """PII 암호화 키로 Fernet 인스턴스 생성."""
    key = settings.PII_ENCRYPTION_KEY
    if not key:
        return None
    return Fernet(key.encode() if isinstance(key, str) else key)


def generate_totp_secret() -> str:
    """새 TOTP 시크릿 생성 (base32, 20바이트)."""
    import pyotp
    return pyotp.random_base32(32)


def encrypt_secret(secret: str) -> str:
    """TOTP 시크릿 암호화."""
    fernet = _get_fernet()
    if fernet is None:
        # 개발 환경: 평문 저장 (프로덕션에서는 PII_ENCRYPTION_KEY 필수)
        return secret
    return fernet.encrypt(secret.encode()).decode()


def decrypt_secret(encrypted: str) -> str:
    """TOTP 시크릿 복호화."""
    fernet = _get_fernet()
    if fernet is None:
        return encrypted
    try:
        return fernet.decrypt(encrypted.encode()).decode()
    except Exception:
        # 이미 평문인 경우 (마이그레이션 전 데이터)
        return encrypted


def get_totp_uri(secret: str, email: str) -> str:
    """Google Authenticator용 otpauth:// URI 생성."""
    import pyotp
    totp = pyotp.TOTP(secret, digits=TOTP_DIGITS, interval=TOTP_INTERVAL)
    return totp.provisioning_uri(name=email, issuer_name=TOTP_ISSUER)


def verify_totp_code(secret: str, code: str) -> bool:
    """TOTP 코드 검증 (현재 ±1 윈도우)."""
    import pyotp
    totp = pyotp.TOTP(secret, digits=TOTP_DIGITS, interval=TOTP_INTERVAL)
    return totp.verify(code, valid_window=1)


def generate_backup_codes(count: int = 8) -> list[str]:
    """1회용 MFA 백업 코드 생성 (8자 영숫자)."""
    return [secrets.token_hex(4).upper() for _ in range(count)]


def hash_backup_codes(codes: list[str]) -> str:
    """백업 코드 bcrypt 해시 → 암호화 JSON 저장."""
    hashed = []
    for code in codes:
        h = bcrypt.hashpw(code.encode(), bcrypt.gensalt(rounds=8)).decode()
        hashed.append(h)
    data = json.dumps(hashed)
    fernet = _get_fernet()
    if fernet:
        return fernet.encrypt(data.encode()).decode()
    return data


def _load_backup_codes(encrypted: str) -> list[str]:
    """저장된 백업 코드 해시 목록 로드."""
    fernet = _get_fernet()
    if fernet:
        try:
            data = fernet.decrypt(encrypted.encode()).decode()
        except Exception:
            data = encrypted
    else:
        data = encrypted
    try:
        return json.loads(data)
    except (json.JSONDecodeError, TypeError):
        return []


async def verify_backup_code(db, user, code: str) -> bool:
    """백업 코드 검증 및 소진. 성공 시 True."""
    if not user.mfa_backup_codes:
        return False

    hashes = _load_backup_codes(user.mfa_backup_codes)
    code_upper = code.upper().strip()

    for i, h in enumerate(hashes):
        try:
            if bcrypt.checkpw(code_upper.encode(), h.encode()):
                # 소진: 해당 코드 제거
                hashes.pop(i)
                fernet = _get_fernet()
                data = json.dumps(hashes)
                if fernet:
                    user.mfa_backup_codes = fernet.encrypt(data.encode()).decode()
                else:
                    user.mfa_backup_codes = data
                await db.flush()
                logger.info("MFA backup code consumed for user %s (%d remaining)", user.id, len(hashes))
                return True
        except Exception:
            continue
    return False


async def setup_mfa(db, user) -> dict:
    """MFA 설정 시작 — 시크릿 생성, 백업 코드 생성 및 QR URI 반환.

    아직 mfa_enabled=False. confirm_mfa()로 확인 후 활성화.
    """
    secret = generate_totp_secret()
    user.mfa_secret = encrypt_secret(secret)

    # 백업 코드 생성
    backup_codes = generate_backup_codes()
    user.mfa_backup_codes = hash_backup_codes(backup_codes)

    await db.flush()

    uri = get_totp_uri(secret, user.email)
    return {
        "secret": secret,  # 사용자가 수동 입력할 수 있도록
        "otpauth_uri": uri,  # QR 코드용
        "backup_codes": backup_codes,  # 1회만 표시 (이후 재표시 불가)
    }


async def confirm_mfa(db, user, code: str) -> bool:
    """MFA 설정 완료 — 코드 검증 후 mfa_enabled=True."""
    if not user.mfa_secret:
        return False

    secret = decrypt_secret(user.mfa_secret)
    if not verify_totp_code(secret, code):
        return False

    user.mfa_enabled = True
    await db.flush()
    return True


async def verify_mfa_login(db, user, code: str) -> bool:
    """로그인 시 MFA 코드 검증 (TOTP 우선, 실패 시 백업 코드 시도)."""
    if not user.mfa_enabled or not user.mfa_secret:
        return False

    secret = decrypt_secret(user.mfa_secret)
    if verify_totp_code(secret, code):
        return True

    # TOTP 실패 → 백업 코드 시도
    return await verify_backup_code(db, user, code)


async def disable_mfa(db, user) -> None:
    """MFA 비활성화 (super_admin만 가능)."""
    user.mfa_enabled = False
    user.mfa_secret = None
    user.mfa_backup_codes = None
    await db.flush()


def is_mfa_required(user) -> bool:
    """이 사용자에게 MFA가 필요한지 확인."""
    if not settings.ADMIN_MFA_REQUIRED:
        return False
    return getattr(user, "is_admin", False)


async def record_admin_activity(user_id: uuid.UUID) -> None:
    """관리자 마지막 활동 시각 기록 (세션 타임아웃용)."""
    try:
        from app.core.redis import get_redis, v2_key
        redis = get_redis()
        if redis is None:
            return
        timeout = settings.ADMIN_SESSION_TIMEOUT_MINUTES * 60
        pipe = redis.pipeline()
        pipe.setex(v2_key(f"admin:last_activity:{user_id}"), timeout, "1")
        pipe.setex(v2_key(f"admin:session_started:{user_id}"), 86400 * 7, "1")
        await pipe.execute()
    except Exception:
        pass


async def check_admin_session_active(user_id: uuid.UUID) -> bool:
    """관리자 세션이 아직 활성 상태인지 확인.

    세션 타임아웃은 로그인 시 키가 생성된 후부터 작동.
    키가 없으면 (로그인 직후 or Redis 미사용) True 반환 + 자동 생성.
    키가 있으면 아직 활성. TTL 만료 시 키 삭제됨 → 다음 체크에서 재생성 + True.

    실제 만료 감지: Redis에 만료 마커를 별도로 추가하여 구분.
    """
    try:
        from app.core.redis import get_redis, v2_key
        redis = get_redis()
        if redis is None:
            return True  # Redis 없으면 통과

        key = v2_key(f"admin:last_activity:{user_id}")
        marker_key = v2_key(f"admin:session_started:{user_id}")

        # 세션 시작 마커가 있는데 활동 키가 없으면 → 타임아웃
        marker_exists = await redis.exists(marker_key)
        activity_exists = await redis.exists(key)

        if marker_exists and not activity_exists:
            return False  # 세션 만료

        # 세션 시작 마커가 없으면 → 첫 접근, 마커+활동 키 생성
        if not marker_exists:
            timeout = settings.ADMIN_SESSION_TIMEOUT_MINUTES * 60
            # 마커는 세션 수명 (refresh token 수명 = 7일)
            await redis.setex(marker_key, 86400 * 7, "1")
            await redis.setex(key, timeout, "1")

        return True
    except Exception:
        return True  # 장애 시 통과
