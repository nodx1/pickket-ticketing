"""S-2(#26): 리프레시 토큰 패밀리 DB 백업 스토어.

Redis 단일 장애점 완화. auth.py 의 Redis Lua 회전이 정본이고, 이 모듈은 영속
백업 + Redis 키 유실(eviction/restart) 시 가용성 폴백을 제공한다.

설계 원칙:
- 보안 동작(재사용 감지 → family revoke)은 Redis Lua 가 결정. DB 는 'Redis 가
  키를 잃었을 때'만 회전을 이어가게 하는 복구 경로다.
- 모든 DB 작업은 best-effort: 실패해도 인증 흐름을 깨지 않는다(로그만). DB 가
  죽어도 Redis 정본은 그대로 동작.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.refresh_token_family import RefreshTokenFamily

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _aware(dt: datetime) -> datetime:
    """DB(특히 SQLite)가 naive 로 돌려주는 datetime 을 UTC aware 로 정규화."""
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


async def persist_family(
    db: AsyncSession,
    *,
    user_id: str,
    family_id: str,
    token_hash: str,
    ttl_seconds: int,
) -> None:
    """로그인/회전 시 family 백업 upsert (best-effort)."""
    try:
        expires_at = _now() + timedelta(seconds=ttl_seconds)
        stmt = pg_insert(RefreshTokenFamily).values(
            user_id=uuid.UUID(user_id),
            family_id=family_id,
            current_token_hash=token_hash,
            revoked=False,
            expires_at=expires_at,
        )
        stmt = stmt.on_conflict_do_update(
            index_elements=["user_id", "family_id"],
            set_={
                "current_token_hash": token_hash,
                "revoked": False,
                "expires_at": expires_at,
                "updated_at": _now(),
            },
        )
        await db.execute(stmt)
        await db.commit()
    except Exception:
        await _safe_rollback(db)
        logger.warning(
            "refresh family DB persist failed (non-fatal) user=%s family=%s",
            user_id, family_id, exc_info=True,
        )


async def revoke_family(db: AsyncSession, *, user_id: str, family_id: str) -> None:
    """로그아웃/재사용 감지 시 family 폐기 (best-effort)."""
    try:
        row = await _get(db, user_id, family_id)
        if row is not None and not row.revoked:
            row.revoked = True
            row.updated_at = _now()
            await db.commit()
    except Exception:
        await _safe_rollback(db)
        logger.warning(
            "refresh family DB revoke failed (non-fatal) user=%s family=%s",
            user_id, family_id, exc_info=True,
        )


async def recover_rotation(
    db: AsyncSession,
    *,
    user_id: str,
    family_id: str,
    provided_hash: str,
    new_token_hash: str,
    ttl_seconds: int,
) -> str:
    """Redis 가 family 키를 잃었을 때(가용성 폴백) DB 기준으로 회전 가능 여부 판정.

    반환:
      - "ok": DB 가 유효 family + 제공 토큰 해시 일치 → 회전 허용(DB 갱신 완료).
        호출측이 Redis 를 재시드해야 한다.
      - "revoked": DB 에서 폐기됨 → fail-closed 유지.
      - "reuse": 제공 토큰이 DB 의 현재 토큰과 불일치 → 재사용/회전 경합. family 폐기.
      - "unknown": DB 에도 흔적 없음(만료/미백업) → 폴백 불가, 기존 fail-closed 유지.
    """
    try:
        row = await _get(db, user_id, family_id)
        if row is None:
            return "unknown"
        if row.revoked:
            return "revoked"
        if _aware(row.expires_at) <= _now():
            return "unknown"
        if row.current_token_hash != provided_hash:
            # 이미 회전된 토큰(또는 탈취 재사용)으로 DB 폴백 시도 → 보수적으로 폐기.
            row.revoked = True
            row.updated_at = _now()
            await db.commit()
            return "reuse"
        # 유효 — DB 에서 회전.
        row.current_token_hash = new_token_hash
        row.expires_at = _now() + timedelta(seconds=ttl_seconds)
        row.updated_at = _now()
        await db.commit()
        return "ok"
    except Exception:
        await _safe_rollback(db)
        logger.warning(
            "refresh family DB recover failed (non-fatal) user=%s family=%s",
            user_id, family_id, exc_info=True,
        )
        return "unknown"


async def purge_expired(db: AsyncSession) -> int:
    """만료된 family row 정리(배치/유지보수용). 삭제 건수 반환."""
    result = await db.execute(
        delete(RefreshTokenFamily).where(RefreshTokenFamily.expires_at <= _now())
    )
    await db.commit()
    return result.rowcount or 0


async def _get(db: AsyncSession, user_id: str, family_id: str) -> RefreshTokenFamily | None:
    res = await db.execute(
        select(RefreshTokenFamily).where(
            RefreshTokenFamily.user_id == uuid.UUID(user_id),
            RefreshTokenFamily.family_id == family_id,
        )
    )
    return res.scalar_one_or_none()


async def _safe_rollback(db: AsyncSession) -> None:
    try:
        await db.rollback()
    except Exception:
        logger.debug("refresh family rollback failed", exc_info=True)
