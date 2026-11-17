"""현장 단말 · 주최사 PG 직결 · 연동 원장 API (과업 WP6·WP7).

현장 단말 (/api/v1/terminals/*) — 헤더 X-Terminal-Key 로 인증. 소켓을 못 쓰는 POS 등을 위한 REST 경로.
    POST /terminals/scan          {payload, manual?, scanned_at?} → 판정
    POST /terminals/heartbeat
    GET  /terminals/blocklist     차단·제재 티켓 목록(오프라인 캐시용)
    GET  /terminals/me

내부 (/api/v1/internal/*) — 주최사 대시보드(go)가 호출. GET=서비스 토큰, 쓰기=HMAC.
    GET   /events/{event_id}/onsite                       현장 현황(단말·게이트·최근 판정·차단 목록)
    POST  /events/{event_id}/terminals                    단말 등록 → 키는 응답에서 한 번만
    PATCH /events/{event_id}/terminals/{terminal_id}      게이트·허용 등급·상태(일시중지·폐기)
    POST  /events/{event_id}/admission-blocks             티켓 입장 차단/해제
    GET   /events/{event_id}/monitor-token                대시보드 실시간 접속 토큰
    GET   /events/{event_id}/settlement                   정산 방식·직결 현황·PG 원장
    PUT   /events/{event_id}/settlement                   정산 방식 변경(platform|direct)
    POST  /organizers/{organizer_id}/pg-accounts          주최사 PG 키 등록
    POST  /pg-accounts/{account_id}/verify                키 확인(토스 호출)
    POST  /orders/{order_id}/pull-status                  Pull 방식 결제 상태 대조
    GET   /integration-ledger                             연동 원장 조회
    GET   /integration-ledger/verify                      해시 체인 검증
"""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.fairness import _bad_request, _verified_json
from app.api.v1.internal_sync import _require_service_token
from app.core.database import get_db
from app.models.onsite import OnsiteTerminal
from app.realtime.gateway import issue_monitor_token
from app.services import integration_ledger
from app.services.direct_settlement import DirectSettlementError, DirectSettlementService
from app.services.onsite_service import OnsiteError, OnsiteService

terminal_router = APIRouter()
internal_router = APIRouter()


async def _terminal(db: AsyncSession, key: str | None) -> OnsiteTerminal:
    terminal = await OnsiteService(db).authenticate(key)
    if terminal is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="등록되지 않았거나 사용이 중지된 단말입니다")
    return terminal


# ───────── 단말 ─────────


@terminal_router.post("/scan", summary="현장 단말 입장 판정")
async def terminal_scan(
    request: Request,
    db: AsyncSession = Depends(get_db),
    x_terminal_key: str | None = Header(None),
):
    terminal = await _terminal(db, x_terminal_key)
    body = await request.json()
    scanned_at = None
    if body.get("scanned_at"):
        try:
            scanned_at = datetime.fromisoformat(str(body["scanned_at"]))
        except ValueError as exc:
            raise _bad_request(ValueError("scanned_at 형식이 올바르지 않습니다")) from exc
    outcome = await OnsiteService(db).scan(
        terminal, str(body.get("payload") or ""), manual=bool(body.get("manual")), scanned_at=scanned_at
    )
    await db.commit()
    return outcome.to_dict()


@terminal_router.post("/heartbeat", summary="현장 단말 생존 신호")
async def terminal_heartbeat(db: AsyncSession = Depends(get_db), x_terminal_key: str | None = Header(None)):
    terminal = await _terminal(db, x_terminal_key)
    await OnsiteService(db).heartbeat(terminal)
    await db.commit()
    return {"ok": True, "terminal_id": str(terminal.id)}


@terminal_router.get("/blocklist", summary="차단·제재 티켓 목록")
async def terminal_blocklist(db: AsyncSession = Depends(get_db), x_terminal_key: str | None = Header(None)):
    terminal = await _terminal(db, x_terminal_key)
    return await OnsiteService(db).blocklist(terminal.event_id)


@terminal_router.get("/me", summary="단말 정보")
async def terminal_me(db: AsyncSession = Depends(get_db), x_terminal_key: str | None = Header(None)):
    t = await _terminal(db, x_terminal_key)
    return {"id": str(t.id), "event_id": str(t.event_id), "name": t.name, "kind": t.kind, "gate": t.gate, "allowed_tier_ids": t.allowed_tier_ids}


# ───────── 내부: 현장 ─────────


@internal_router.get("/events/{event_id}/onsite")
async def onsite_overview(event_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    _require_service_token(request)
    return await OnsiteService(db).overview(event_id)


@internal_router.post("/events/{event_id}/terminals")
async def register_terminal(event_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    body = await _verified_json(request)
    try:
        terminal, key = await OnsiteService(db).register_terminal(
            event_id,
            name=str(body.get("name") or ""),
            kind=str(body.get("kind") or "gate_scanner"),
            gate=str(body.get("gate") or "main"),
            allowed_tier_ids=list(body.get("allowedTierIds") or []),
            actor=str(body.get("actor") or "") or None,
        )
    except (OnsiteError, ValueError) as exc:
        raise _bad_request(exc) from exc
    return {"id": str(terminal.id), "key": key, "key_prefix": terminal.key_prefix, "notice": "이 키는 다시 볼 수 없습니다. 단말에 바로 입력해 주세요."}


@internal_router.patch("/events/{event_id}/terminals/{terminal_id}")
async def update_terminal(event_id: uuid.UUID, terminal_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    body = await _verified_json(request)
    try:
        t = await OnsiteService(db).update_terminal(
            terminal_id,
            event_id=event_id,
            gate=body.get("gate"),
            allowed_tier_ids=body.get("allowedTierIds"),
            status=body.get("status"),
            actor=str(body.get("actor") or "") or None,
        )
    except (OnsiteError, ValueError) as exc:
        raise _bad_request(exc) from exc
    return {"ok": True, "id": str(t.id), "status": t.status, "gate": t.gate, "allowed_tier_ids": t.allowed_tier_ids}


@internal_router.post("/events/{event_id}/admission-blocks")
async def set_admission_block(event_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    body = await _verified_json(request)
    try:
        row = await OnsiteService(db).set_block(
            event_id,
            str(body.get("ticketNumber") or "").strip().upper(),
            block=bool(body.get("block", True)),
            reason=str(body.get("reason") or ""),
            actor=str(body.get("actor") or "") or None,
        )
    except OnsiteError as exc:
        raise _bad_request(exc) from exc
    return {"ok": True, "id": str(row.id), "action": row.action}


@internal_router.get("/events/{event_id}/monitor-token")
async def monitor_token(event_id: uuid.UUID, request: Request):
    _require_service_token(request)
    return issue_monitor_token(event_id)


# ───────── 내부: 직결 정산 ─────────


@internal_router.get("/events/{event_id}/settlement")
async def settlement_overview(event_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    _require_service_token(request)
    try:
        return await DirectSettlementService(db).event_overview(event_id)
    except DirectSettlementError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@internal_router.put("/events/{event_id}/settlement")
async def set_settlement_mode(event_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    body = await _verified_json(request)
    try:
        account_id = uuid.UUID(body["pgAccountId"]) if body.get("pgAccountId") else None
        row = await DirectSettlementService(db).set_event_mode(
            event_id,
            mode=str(body.get("mode") or "platform"),
            account_id=account_id,
            fee_rate=float(body["feeRate"]) if body.get("feeRate") is not None else None,
            actor=str(body.get("actor") or "") or None,
        )
    except (DirectSettlementError, ValueError) as exc:
        raise _bad_request(exc) from exc
    return {"ok": True, "mode": row.mode, "pg_account_id": str(row.pg_account_id) if row.pg_account_id else None}


@internal_router.post("/organizers/{organizer_id}/pg-accounts")
async def register_pg_account(organizer_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    body = await _verified_json(request)
    try:
        account = await DirectSettlementService(db).register_account(
            organizer_id,
            client_key=str(body.get("clientKey") or ""),
            secret_key=str(body.get("secretKey") or ""),
            label=str(body.get("label") or ""),
            actor=str(body.get("actor") or "") or None,
        )
    except DirectSettlementError as exc:
        raise _bad_request(exc) from exc
    return {"ok": True, "id": str(account.id), "mode": account.mode, "secret_hint": account.secret_hint}


@internal_router.post("/pg-accounts/{account_id}/verify")
async def verify_pg_account(account_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    await _verified_json(request)
    try:
        account = await DirectSettlementService(db).verify_account(account_id)
    except DirectSettlementError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": account.status == "verified", "status": account.status, "last_error": account.last_error}


@internal_router.post("/orders/{order_id}/pull-status")
async def pull_order_status(order_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    await _verified_json(request)
    try:
        return await DirectSettlementService(db).pull_status(order_id)
    except DirectSettlementError as exc:
        raise _bad_request(exc) from exc


# ───────── 내부: 연동 원장 ─────────


@internal_router.get("/integration-ledger")
async def list_ledger(
    request: Request,
    event_id: uuid.UUID | None = None,
    counterpart: str | None = Query(None, pattern="^(pg|terminal|partner|webhook)$"),
    limit: int = Query(100, ge=1, le=500),
    db: AsyncSession = Depends(get_db),
):
    _require_service_token(request)
    return {"items": await integration_ledger.recent(db, event_id=event_id, counterpart=counterpart, limit=limit)}


@internal_router.get("/integration-ledger/verify")
async def verify_ledger(request: Request, db: AsyncSession = Depends(get_db)):
    _require_service_token(request)
    return await integration_ledger.verify_chain(db)
