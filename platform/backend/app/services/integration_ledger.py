"""외부 연동 송수신 원장 (과업 WP7 "선정된 외부 결제 서비스·현장 단말·예매처의 인터페이스 간
데이터 송수신을 위한 감사 로그(append-only)").

- 한 행 = 외부와 주고받은 요청·응답 한 번. 상대(pg·terminal·partner·webhook), 방향, 작업, 결과, 지연.
- 개인정보·비밀값은 저장 전에 가린다(전화번호·이메일·카드번호·키·토큰·서명).
- 해시 체인: hash = SHA-256(prev_hash ‖ canonical(행 내용)). 중간 행을 고치거나 지우면 이후 체인이 깨진다.
  DB 트리거가 UPDATE/DELETE/TRUNCATE 를 막고(gwasup05), verify_chain() 이 체인을 다시 계산해 확인한다.
- 체인 순서는 PostgreSQL advisory lock 으로 직렬화한다(동시 기록 시 prev_hash 경합 방지).
- 기록 실패는 본 업무를 막지 않는다(SAVEPOINT, 오류 로그) — 결제·입장 가용성 우선.
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from datetime import UTC, datetime

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

GENESIS = "0" * 64
_SECRET_KEYS = re.compile(r"(secret|password|token|authorization|api[_-]?key|signature|card[_-]?number|cvc|cvv|key)$", re.IGNORECASE)
_PHONE = re.compile(r"(01[016789])[-\s]?(\d{3,4})[-\s]?(\d{4})")
_EMAIL = re.compile(r"([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+)")
_CARD = re.compile(r"\b(\d{4})[-\s]?\d{4}[-\s]?\d{4}[-\s]?(\d{4})\b")


def mask(value):
    """요청·응답 저장 전 가림."""
    if isinstance(value, dict):
        return {k: ("***" if _SECRET_KEYS.search(str(k)) else mask(v)) for k, v in value.items()}
    if isinstance(value, list):
        return [mask(v) for v in value]
    if isinstance(value, str):
        out = _CARD.sub(r"\1-****-****-\2", value)
        out = _PHONE.sub(r"\1-****-\3", out)
        return _EMAIL.sub(r"\1***@\2", out)
    return value


def _canonical(row: dict) -> str:
    return json.dumps(row, sort_keys=True, separators=(",", ":"), ensure_ascii=False, default=str)


def row_hash(prev_hash: str, row: dict) -> str:
    return hashlib.sha256(f"{prev_hash}|{_canonical(row)}".encode()).hexdigest()


def _json(value):
    """원시 SQL 조회는 JSONB 를 문자열로 돌려줄 수 있다."""
    return json.loads(value) if isinstance(value, str) else value


def _is_postgres(session: AsyncSession) -> bool:
    try:
        return session.get_bind().dialect.name == "postgresql"
    except Exception:  # noqa: BLE001
        return False


async def record_integration(
    session: AsyncSession,
    *,
    counterpart: str,
    direction: str,
    operation: str,
    counterpart_id: str | None = None,
    event_id: uuid.UUID | None = None,
    request: dict | None = None,
    response: dict | None = None,
    status: str = "ok",
    latency_ms: int | None = None,
) -> str | None:
    """원장에 한 행을 추가하고 그 행의 해시를 돌려준다(실패 시 None)."""
    if not _is_postgres(session):
        return None
    at = datetime.now(UTC)
    row = {
        "at": at.isoformat(),
        "counterpart": counterpart,
        "counterpart_id": counterpart_id,
        "direction": direction,
        "operation": operation,
        "event_id": str(event_id) if event_id else None,
        "request": mask(request or {}),
        "response": mask(response or {}),
        "status": status,
        "latency_ms": latency_ms,
    }
    try:
        async with session.begin_nested():
            await session.execute(text("SELECT pg_advisory_xact_lock(hashtext('integration_ledger'))"))
            prev = await session.scalar(text("SELECT hash FROM integration_ledger ORDER BY id DESC LIMIT 1")) or GENESIS
            digest = row_hash(prev, row)
            await session.execute(
                text(
                    "INSERT INTO integration_ledger (at, counterpart, counterpart_id, direction, operation, event_id, "
                    "request, response, status, latency_ms, prev_hash, hash) VALUES (:at, :counterpart, :counterpart_id, "
                    ":direction, :operation, :event_id, CAST(:request AS JSONB), CAST(:response AS JSONB), :status, "
                    ":latency_ms, :prev_hash, :hash)"
                ),
                {
                    **row,
                    "at": at,
                    "event_id": event_id,
                    "request": json.dumps(row["request"], ensure_ascii=False, default=str),
                    "response": json.dumps(row["response"], ensure_ascii=False, default=str),
                    "prev_hash": prev,
                    "hash": digest,
                },
            )
        return digest
    except Exception:
        logger.error("integration ledger write failed (%s/%s)", counterpart, operation, exc_info=True)
        return None


async def verify_chain(session: AsyncSession, limit: int | None = None) -> dict:
    """원장 전체(또는 최근 limit 행)의 해시 체인을 다시 계산한다."""
    if not _is_postgres(session):
        return {"ok": True, "checked": 0, "mode": "unavailable"}
    sql = (
        "SELECT id, at, counterpart, counterpart_id, direction, operation, event_id, request, response, status, "
        "latency_ms, prev_hash, hash FROM integration_ledger ORDER BY id"
    )
    rows = (await session.execute(text(sql))).all()
    if limit:
        rows = rows[-limit:]
    expected_prev = rows[0].prev_hash if rows else GENESIS
    broken: list[int] = []
    for r in rows:
        row = {
            "at": r.at.astimezone(UTC).isoformat(),
            "counterpart": r.counterpart,
            "counterpart_id": r.counterpart_id,
            "direction": r.direction,
            "operation": r.operation,
            "event_id": str(r.event_id) if r.event_id else None,
            "request": _json(r.request),
            "response": _json(r.response),
            "status": r.status,
            "latency_ms": r.latency_ms,
        }
        if r.prev_hash != expected_prev or row_hash(r.prev_hash, row) != r.hash:
            broken.append(int(r.id))
        expected_prev = r.hash
    return {"ok": not broken, "checked": len(rows), "broken_ids": broken[:20], "head": expected_prev}


async def recent(session: AsyncSession, *, event_id: uuid.UUID | None = None, counterpart: str | None = None, limit: int = 100) -> list[dict]:
    if not _is_postgres(session):
        return []
    clauses, params = [], {"limit": min(limit, 500)}
    if event_id:
        clauses.append("event_id = :event_id")
        params["event_id"] = event_id
    if counterpart:
        clauses.append("counterpart = :counterpart")
        params["counterpart"] = counterpart
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    rows = (
        await session.execute(
            text(
                f"SELECT id, at, counterpart, counterpart_id, direction, operation, status, latency_ms, request, response, hash "
                f"FROM integration_ledger {where} ORDER BY id DESC LIMIT :limit"
            ),
            params,
        )
    ).all()
    return [
        {
            "id": int(r.id),
            "at": r.at.isoformat(),
            "counterpart": r.counterpart,
            "counterpart_id": r.counterpart_id,
            "direction": r.direction,
            "operation": r.operation,
            "status": r.status,
            "latency_ms": r.latency_ms,
            "request": _json(r.request),
            "response": _json(r.response),
            "hash": r.hash,
        }
        for r in rows
    ]
