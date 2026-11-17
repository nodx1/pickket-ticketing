"""TimescaleDB 시계열 로그 (과업 WP5).

테이블은 마이그레이션 gwasup02_1117 이 만든다(TimescaleDB 면 hypertable, 아니면 일반 테이블).

원칙
- 기록 실패가 본 업무(응모·입장)를 깨뜨리지 않는다: SAVEPOINT 안에서 쓰고, 실패하면 경고만 남긴다.
- 개인 식별자는 그대로 남기지 않는다: actor = HMAC(SECRET_KEY, user_id) 앞 16자(가명).
  같은 사람의 반복 행동(매크로 의심)은 묶어 볼 수 있지만, 로그만으로 누구인지는 알 수 없다.
- SQLite(단위 테스트)에서는 아무것도 하지 않는다.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings

logger = logging.getLogger(__name__)


def pseudonym(user_id: uuid.UUID | str | None) -> str | None:
    if user_id is None:
        return None
    digest = hmac.new(settings.SECRET_KEY.encode(), f"ts-actor|{user_id}".encode(), hashlib.sha256)
    return digest.hexdigest()[:16]


def _is_postgres(session: AsyncSession) -> bool:
    try:
        return session.get_bind().dialect.name == "postgresql"
    except Exception:  # noqa: BLE001 — 목 세션 등
        return False


async def _insert(session: AsyncSession, sql: str, params: dict) -> bool:
    if not _is_postgres(session):
        return False
    try:
        async with session.begin_nested():
            await session.execute(text(sql), params)
        return True
    except Exception:
        logger.warning("timeseries insert failed", exc_info=True)
        return False


async def record_lottery_event(
    session: AsyncSession,
    *,
    event_id: uuid.UUID,
    kind: str,
    pool_id: uuid.UUID | None = None,
    tier_id: uuid.UUID | None = None,
    user_id: uuid.UUID | None = None,
    weight: float | None = None,
    ap: int | None = None,
    meta: dict | None = None,
) -> bool:
    return await _insert(
        session,
        "INSERT INTO ts_lottery_events (event_id, pool_id, tier_id, kind, user_commit, weight, ap, meta) "
        "VALUES (:event_id, :pool_id, :tier_id, :kind, :actor, :weight, :ap, CAST(:meta AS JSONB))",
        {
            "event_id": event_id,
            "pool_id": pool_id,
            "tier_id": tier_id,
            "kind": kind,
            "actor": pseudonym(user_id),
            "weight": weight,
            "ap": ap,
            "meta": json.dumps(meta or {}, ensure_ascii=False, default=str),
        },
    )


async def record_admission_event(
    session: AsyncSession,
    *,
    event_id: uuid.UUID,
    result: str,
    terminal_id: uuid.UUID | None = None,
    gate: str | None = None,
    ticket_ref: str | None = None,
    reason: str | None = None,
    meta: dict | None = None,
) -> bool:
    return await _insert(
        session,
        "INSERT INTO ts_admission_events (event_id, terminal_id, gate, ticket_ref, result, reason, meta) "
        "VALUES (:event_id, :terminal_id, :gate, :ticket_ref, :result, :reason, CAST(:meta AS JSONB))",
        {
            "event_id": event_id,
            "terminal_id": terminal_id,
            "gate": gate,
            "ticket_ref": ticket_ref,
            "result": result,
            "reason": reason,
            "meta": json.dumps(meta or {}, ensure_ascii=False, default=str),
        },
    )


async def record_weight_snapshot(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    tenure_score: float,
    account_days: int | None,
    admissions: int | None,
    meta: dict | None = None,
) -> bool:
    return await _insert(
        session,
        "INSERT INTO ts_weight_snapshots (user_id, tenure_score, account_days, admissions, meta) "
        "VALUES (:user_id, :tenure_score, :account_days, :admissions, CAST(:meta AS JSONB))",
        {
            "user_id": user_id,
            "tenure_score": tenure_score,
            "account_days": account_days,
            "admissions": admissions,
            "meta": json.dumps(meta or {}, ensure_ascii=False, default=str),
        },
    )


async def storage_mode(session: AsyncSession) -> str:
    if not _is_postgres(session):
        return "unavailable"
    try:
        return str(await session.scalar(text("SELECT ts_storage_mode()")))
    except Exception:  # noqa: BLE001
        return "unavailable"


async def admission_series(
    session: AsyncSession, event_id: uuid.UUID, minutes: int = 120
) -> dict:
    """현장 입장 1분 집계 — 대시보드 실시간 차트."""
    if not _is_postgres(session):
        return {"mode": "unavailable", "buckets": []}
    since = datetime.now(UTC) - timedelta(minutes=max(1, min(minutes, 24 * 60)))
    rows = (
        await session.execute(
            text(
                "SELECT bucket, gate, result, n FROM ts_admission_1m "
                "WHERE event_id = :event_id AND bucket >= :since ORDER BY bucket"
            ),
            {"event_id": event_id, "since": since},
        )
    ).all()
    return {
        "mode": await storage_mode(session),
        "buckets": [
            {"bucket": r.bucket.isoformat(), "gate": r.gate, "result": r.result, "n": int(r.n)} for r in rows
        ],
    }


async def lottery_series(session: AsyncSession, event_id: uuid.UUID, minutes: int = 24 * 60) -> dict:
    if not _is_postgres(session):
        return {"mode": "unavailable", "buckets": []}
    since = datetime.now(UTC) - timedelta(minutes=max(1, min(minutes, 14 * 24 * 60)))
    rows = (
        await session.execute(
            text(
                "SELECT bucket, kind, n, ap_sum FROM ts_lottery_1m "
                "WHERE event_id = :event_id AND bucket >= :since ORDER BY bucket"
            ),
            {"event_id": event_id, "since": since},
        )
    ).all()
    return {
        "mode": await storage_mode(session),
        "buckets": [
            {"bucket": r.bucket.isoformat(), "kind": r.kind, "n": int(r.n), "ap_sum": int(r.ap_sum or 0)} for r in rows
        ],
    }
