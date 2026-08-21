"""게스트 접근 토큰 서비스 — IDOR 계층방어(§2.3).

설계 정본: docs/plans/DETAIL-UNIFICATION-DB-DESIGN.md §2.3.

게스트(비회원)는 세션이 없으므로 주문 조회/환불/클레임 시 소유증명이 필요하다.
`GuestAccessToken`(token_hash=SHA-256 hex 만 저장, 원문 미저장)으로 URL 파라미터 IDOR를 차단한다.

보안 설계:
  - **원문 생성**: `secrets.token_urlsafe(32)`(CSPRNG, ~43자 base64url) — 원문은 호출자에 1회 반환만,
    발송(이메일/딥링크)은 S2b. DB에는 SHA-256 hex(64자)만 저장.
  - **상수시간 비교**: 해시 조회는 UNIQUE 인덱스 매칭이지만, 명시적 비교는 hmac.compare_digest.
  - **원자 소비(single-use)**: 조건부 UPDATE(`used_at IS NULL AND expires_at>now() AND purpose=:p`)
    로 레이스/재사용을 DB 레벨에서 차단(동시 2회 → 정확히 1개만 rowcount=1).
  - **enumeration 방지**: 실패 사유(만료/소진/불일치/스코프불일치)를 호출자에 세분노출하지 않고
    일반화된 예외(GuestTokenInvalid)로 반환. 내부 로깅만 사유 구분.

purpose별 정책(§2.3):
  - view   : 주문 상세 조회. **소비 안 함**(verify_only) — 주문직후 서명토큰/매직링크로 상세 반복열람 허용.
             단 만료(expires_at)는 항상 검증.
  - refund : 환불 요청. **single-use**(verify_and_consume) — 소유증명 1회, 15분 TTL 권장.
  - claim  : 회원 승격. **single-use**(verify_and_consume) — order 무관(order_id=NULL 허용).
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import secrets
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.guest import GUEST_TOKEN_PURPOSES, GuestAccessToken

logger = logging.getLogger(__name__)

# 원문 엔트로피(bytes). token_urlsafe(32) → 256bit CSPRNG.
_TOKEN_ENTROPY_BYTES = 32
# view 는 소비하지 않으므로 짧은 TTL 권장(주문직후 열람 창). refund/claim 은 발급 시 명시.
DEFAULT_VIEW_TTL = timedelta(hours=24)
DEFAULT_REFUND_TTL = timedelta(minutes=15)
DEFAULT_CLAIM_TTL = timedelta(hours=1)
# 소비하지 않는(재사용 허용) purpose 집합.
_NON_CONSUMING_PURPOSES = frozenset({"view"})
# single-use purpose 집합.
_SINGLE_USE_PURPOSES = frozenset({"refund", "claim"})


class GuestTokenError(Exception):
    """게스트 토큰 오류 기반 클래스."""


class GuestTokenInvalid(GuestTokenError):
    """검증 실패 — enumeration 방지를 위해 사유를 세분노출하지 않는 일반화 예외.

    (내부 로깅에서만 reason 을 구분: expired / consumed / not_found / purpose_mismatch / scope_mismatch)
    """


@dataclass(frozen=True)
class IssuedToken:
    """발급 결과. raw_token 은 이 순간에만 존재(발송은 S2b)."""

    raw_token: str
    token_id: uuid.UUID
    guest_id: uuid.UUID
    purpose: str
    order_id: uuid.UUID | None
    expires_at: datetime


@dataclass(frozen=True)
class VerifiedToken:
    """검증 결과(소비 여부 무관). 호출자는 guest_id/order_id 스코프로 후속 권한판정."""

    token_id: uuid.UUID
    guest_id: uuid.UUID
    purpose: str
    order_id: uuid.UUID | None


def _hash_token(raw_token: str) -> str:
    """원문 → SHA-256 hex(64자). 저장·조회 공통."""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _as_aware_utc(dt: datetime) -> datetime:
    """naive datetime(예: SQLite 저장값) → UTC aware 로 정규화(비교 안전).

    v2 컨벤션은 timestamptz(aware)지만 SQLite 는 tz 를 떨궈 naive 로 돌려준다.
    naive 는 UTC 로 간주(저장 시 UTC aware 였음).
    """
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _default_ttl(purpose: str) -> timedelta:
    if purpose == "refund":
        return DEFAULT_REFUND_TTL
    if purpose == "claim":
        return DEFAULT_CLAIM_TTL
    return DEFAULT_VIEW_TTL


async def issue_token(
    db: AsyncSession,
    *,
    guest_id: uuid.UUID,
    purpose: str,
    order_id: uuid.UUID | None = None,
    ttl: timedelta | None = None,
    ip: str | None = None,
) -> IssuedToken:
    """게스트 접근 토큰 발급.

    원문=CSPRNG token_urlsafe(32) → 저장은 SHA-256 hex 만. 원문은 반환값으로만 전달(발송=S2b).
    row 를 db.add + flush 하지만 **commit 은 호출자 책임**(주문/환불 트랜잭션 경계에 편입).
    """
    if purpose not in GUEST_TOKEN_PURPOSES:
        raise ValueError(f"invalid purpose: {purpose!r} (allowed={GUEST_TOKEN_PURPOSES})")

    raw_token = secrets.token_urlsafe(_TOKEN_ENTROPY_BYTES)
    token_hash = _hash_token(raw_token)
    effective_ttl = ttl if ttl is not None else _default_ttl(purpose)
    expires_at = datetime.now(timezone.utc) + effective_ttl

    row = GuestAccessToken(
        id=uuid.uuid4(),
        guest_id=guest_id,
        token_hash=token_hash,
        purpose=purpose,
        order_id=order_id,
        expires_at=expires_at,
        ip=ip,
    )
    db.add(row)
    await db.flush()

    logger.info(
        "guest token issued: id=%s guest=%s purpose=%s order=%s exp=%s",
        row.id, guest_id, purpose, order_id, expires_at.isoformat(),
    )
    return IssuedToken(
        raw_token=raw_token,
        token_id=row.id,
        guest_id=guest_id,
        purpose=purpose,
        order_id=order_id,
        expires_at=expires_at,
    )


async def verify_only(
    db: AsyncSession,
    *,
    raw_token: str,
    purpose: str,
    expected_order_id: uuid.UUID | None = None,
) -> VerifiedToken:
    """소비 없이 검증(view 조회 핫패스). 만료·purpose·(옵션)스코프 검증하되 used_at 은 건드리지 않음.

    view 는 재사용 허용(주문직후 상세 반복열람) — 그러나 이미 소비된(used_at 세팅) 토큰도
    view 로는 열람 허용할지는 정책. 여기서는 **만료만 게이트**(view 는 single-use 아님).
    single-use purpose(refund/claim)를 verify_only 로 부르면 정책위반 → ValueError.
    """
    if purpose in _SINGLE_USE_PURPOSES:
        raise ValueError(
            f"purpose={purpose!r} is single-use; use verify_and_consume, not verify_only"
        )
    if purpose not in GUEST_TOKEN_PURPOSES:
        raise ValueError(f"invalid purpose: {purpose!r}")

    token_hash = _hash_token(raw_token)
    now = datetime.now(timezone.utc)
    row = (
        await db.execute(
            select(GuestAccessToken).where(GuestAccessToken.token_hash == token_hash)
        )
    ).scalar_one_or_none()

    # enumeration 방지: 존재/불일치/만료/스코프 모두 동일 일반화 예외.
    if row is None:
        # 상수시간: 더미 비교로 타이밍 평탄화(존재여부 누출 완화).
        hmac.compare_digest(token_hash, token_hash)
        logger.info("guest token verify_only fail: reason=not_found purpose=%s", purpose)
        raise GuestTokenInvalid("접근 토큰이 유효하지 않습니다.")
    if not hmac.compare_digest(row.token_hash, token_hash):
        logger.info("guest token verify_only fail: reason=mismatch purpose=%s", purpose)
        raise GuestTokenInvalid("접근 토큰이 유효하지 않습니다.")
    if row.purpose != purpose:
        logger.info("guest token verify_only fail: reason=purpose_mismatch id=%s", row.id)
        raise GuestTokenInvalid("접근 토큰이 유효하지 않습니다.")
    if _as_aware_utc(row.expires_at) <= now:
        logger.info("guest token verify_only fail: reason=expired id=%s", row.id)
        raise GuestTokenInvalid("접근 토큰이 유효하지 않습니다.")
    if expected_order_id is not None and row.order_id != expected_order_id:
        logger.info("guest token verify_only fail: reason=scope_mismatch id=%s", row.id)
        raise GuestTokenInvalid("접근 토큰이 유효하지 않습니다.")

    return VerifiedToken(
        token_id=row.id,
        guest_id=row.guest_id,
        purpose=row.purpose,
        order_id=row.order_id,
    )


async def verify_and_consume(
    db: AsyncSession,
    *,
    raw_token: str,
    purpose: str,
    expected_order_id: uuid.UUID | None = None,
) -> VerifiedToken:
    """single-use 원자 소비(refund/claim). 조건부 UPDATE 로 레이스/재사용 차단.

    `UPDATE ... SET used_at=now() WHERE token_hash=:h AND used_at IS NULL
       AND expires_at>now() AND purpose=:p` — 동시 2회 실행 시 정확히 1건만 rowcount=1.
    rowcount=1 이면 소비 성공 → 재조회로 guest_id/order_id 스코프 반환.
    실패 시 사유 세분화 없이 GuestTokenInvalid(enumeration 방지).

    ⚠️ commit 은 호출자 책임(환불/클레임 트랜잭션 경계에 편입). 이 함수는 flush 만.

    ⚠️ [S3] guest_id 스코프: 현재 claim 은 항상 order 경유(expected_order_id 조건이 스코프를
       고정)라 무해하다. S3 에서 order-less claim(order_id=NULL 토큰)을 도입하면
       expected_order_id 로 좁힐 수 없으므로, 호출자가 반환된 VerifiedToken.guest_id 를
       회원 세션·대상 게스트와 교차검증해야 한다(토큰 유출 시 임의 guest 소비 방지).
    """
    if purpose not in _SINGLE_USE_PURPOSES:
        raise ValueError(
            f"purpose={purpose!r} is not single-use; use verify_only"
        )

    token_hash = _hash_token(raw_token)
    now = datetime.now(timezone.utc)

    # ── 원자 소비(조건부 UPDATE) ──────────────────────────────────────────
    # expected_order_id 스코프도 조건에 포함 — 스코프 불일치면 rowcount=0(소비 안 됨).
    stmt = (
        update(GuestAccessToken)
        .where(
            GuestAccessToken.token_hash == token_hash,
            GuestAccessToken.used_at.is_(None),
            GuestAccessToken.expires_at > now,
            GuestAccessToken.purpose == purpose,
        )
        .values(used_at=func.now())
        .execution_options(synchronize_session=False)
    )
    if expected_order_id is not None:
        stmt = stmt.where(GuestAccessToken.order_id == expected_order_id)

    result = await db.execute(stmt)
    if result.rowcount != 1:
        # 소비 실패 — not_found / consumed / expired / purpose_mismatch / scope_mismatch 모두 일반화.
        # 상수시간: 더미 비교로 타이밍 평탄화.
        hmac.compare_digest(token_hash, token_hash)
        logger.info(
            "guest token consume fail: rowcount=%s purpose=%s (enumeration-safe)",
            result.rowcount, purpose,
        )
        raise GuestTokenInvalid("접근 토큰이 유효하지 않거나 이미 사용되었습니다.")

    await db.flush()

    # 소비 성공한 row 재조회(스코프 반환). 방금 used_at 세팅됐으므로 반드시 존재.
    row = (
        await db.execute(
            select(GuestAccessToken).where(GuestAccessToken.token_hash == token_hash)
        )
    ).scalar_one()

    logger.info(
        "guest token consumed: id=%s guest=%s purpose=%s order=%s",
        row.id, row.guest_id, row.purpose, row.order_id,
    )
    return VerifiedToken(
        token_id=row.id,
        guest_id=row.guest_id,
        purpose=row.purpose,
        order_id=row.order_id,
    )
