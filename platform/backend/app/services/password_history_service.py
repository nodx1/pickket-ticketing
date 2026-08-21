"""비밀번호 히스토리 서비스.

쿠팡 2025 대비: 비밀번호 재사용 방지.
최근 5개 비밀번호와 bcrypt 비교.
"""
import logging
from uuid import UUID

import bcrypt
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.password_history import PasswordHistory

logger = logging.getLogger(__name__)

HISTORY_DEPTH = 5  # 최근 5개 비밀번호


async def check_password_history(
    db: AsyncSession, user_id: UUID, plain_password: str
) -> bool:
    """비밀번호가 최근 HISTORY_DEPTH개와 중복되지 않으면 True.

    히스토리가 없으면 True (통과). DB 오류 시 False (fail-closed).
    """
    try:
        result = await db.execute(
            select(PasswordHistory.hashed_password)
            .where(PasswordHistory.user_id == user_id)
            .order_by(PasswordHistory.created_at.desc())
            .limit(HISTORY_DEPTH)
        )
        hashes = result.scalars().all()

        if not hashes:
            return True  # 히스토리 없으면 통과

        for h in hashes:
            try:
                if bcrypt.checkpw(plain_password.encode(), h.encode()):
                    return False  # 중복
            except Exception:
                continue
        return True
    except Exception:
        logger.warning("Password history check failed for %s — blocking as precaution", user_id, exc_info=True)
        return False  # fail-closed: DB 장애 시 재사용 거부


async def record_password(
    db: AsyncSession, user_id: UUID, hashed_password: str
) -> None:
    """비밀번호 해시를 히스토리에 기록."""
    try:
        entry = PasswordHistory(user_id=user_id, hashed_password=hashed_password)
        db.add(entry)
        await db.flush()

        # 오래된 기록 정리 (HISTORY_DEPTH 초과분 삭제)
        result = await db.execute(
            select(PasswordHistory.id)
            .where(PasswordHistory.user_id == user_id)
            .order_by(PasswordHistory.created_at.desc())
            .offset(HISTORY_DEPTH)
        )
        old_ids = result.scalars().all()
        if old_ids:
            from sqlalchemy import delete
            await db.execute(
                delete(PasswordHistory).where(PasswordHistory.id.in_(old_ids))
            )
    except Exception:
        logger.debug("Password history recording failed for %s", user_id, exc_info=True)
