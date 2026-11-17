"""공정성 증명서 · 가중치 추첨 정책 API (과업 WP1·WP4).

공개 (/api/v1/fairness/*) — 인증 없이 누구나:
    GET  /fairness/keys                              서명 공개키
    GET  /fairness/certificates/{cert_no}             증명서 + 서명·루트 실시간 대조 결과
    GET  /fairness/certificates/{cert_no}/pdf         증명서 PDF
    GET  /fairness/pools/{pool_id}/roots              응모·결과 Merkle 루트
    GET  /fairness/pools/{pool_id}/leaves?kind=...    공개 잎 목록(user_id·salt 제외) — 루트 재계산용
    GET  /fairness/events/{event_id}/certificates     이벤트의 발급된 증명서 목록
로그인 사용자:
    GET  /fairness/pools/{pool_id}/my-proof           내 응모 포함 증명(salt·경로)

내부 (/api/v1/internal/*) — 주최사 대시보드(go)가 호출:
    GET  /internal/events/{event_id}/lottery-policy           서비스 토큰
    PUT  /internal/events/{event_id}/lottery-policy           HMAC
    POST /internal/lottery-policy/simulate                    HMAC
    GET  /internal/events/{event_id}/fairness                 서비스 토큰
    GET  /internal/lottery/pools/{pool_id}/results            서비스 토큰 (이름·연락처 가림)
    POST /internal/lottery/pools/{pool_id}/certificate        HMAC (발급, 멱등)
"""

from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from talkfile_engine.weight_policy import WeightPolicy
from talkfile_engine.weight_simulation import DEFAULT_PROFILES, Profile, simulate

from app.api.v1.internal_sync import _require_service_token
from app.core.config import settings
from app.core.database import get_db
from app.core.fairness_signing import SigningKeyUnavailable, public_key_info
from app.core.webhook_verifier import verify_pickket_webhook
from app.middleware.auth import get_current_user
from app.models.fairness import FairnessCertificate, MerkleKind
from app.models.user import User
from app.services.fairness_pdf import render_certificate_pdf
from app.services.fairness_service import FairnessError, FairnessService

public_router = APIRouter()
internal_router = APIRouter()


def _bad_request(exc: Exception) -> HTTPException:
    return HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))


async def _verified_json(request: Request) -> dict:
    raw = await request.body()
    await verify_pickket_webhook(request, raw, settings.GO_WEBHOOK_SECRET, source="go", guard_replay=True)
    try:
        body = json.loads(raw or b"{}")
    except json.JSONDecodeError as exc:
        raise _bad_request(exc) from exc
    if not isinstance(body, dict):
        raise _bad_request(ValueError("JSON object required"))
    return body


# ───────────────────────── 공개 ─────────────────────────


@public_router.get("/keys", summary="공정성 증명서 서명 공개키")
async def fairness_keys():
    try:
        return public_key_info()
    except SigningKeyUnavailable as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc


@public_router.get("/certificates/{cert_no}", summary="공정성 증명서 조회")
async def get_certificate(cert_no: str, db: AsyncSession = Depends(get_db)):
    try:
        return await FairnessService(db).certificate_view(cert_no)
    except FairnessError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    except SigningKeyUnavailable as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc


@public_router.get("/certificates/{cert_no}/pdf", summary="공정성 증명서 PDF")
async def get_certificate_pdf(cert_no: str, db: AsyncSession = Depends(get_db)):
    try:
        view = await FairnessService(db).certificate_view(cert_no)
    except FairnessError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    pdf = render_certificate_pdf(view)
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'inline; filename="{cert_no}.pdf"'},
    )


@public_router.get("/pools/{pool_id}/roots", summary="추첨 Merkle 루트")
async def get_pool_roots(pool_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    return {"pool_id": str(pool_id), "roots": await FairnessService(db).pool_roots(pool_id)}


@public_router.get("/pools/{pool_id}/leaves", summary="추첨 Merkle 공개 잎 (루트 재계산용)")
async def get_pool_leaves(
    pool_id: uuid.UUID,
    kind: str = Query(MerkleKind.ENTRIES, pattern="^(entries|results)$"),
    db: AsyncSession = Depends(get_db),
):
    return {"pool_id": str(pool_id), "kind": kind, "leaves": await FairnessService(db).public_leaves(pool_id, kind)}


@public_router.get("/events/{event_id}/certificates", summary="이벤트의 공정성 증명서 목록")
async def list_event_certificates(event_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    rows = (
        await db.execute(
            select(FairnessCertificate.cert_no, FairnessCertificate.pool_id, FairnessCertificate.issued_at, FairnessCertificate.payload)
            .where(FairnessCertificate.event_id == event_id)
            .order_by(FairnessCertificate.issued_at)
        )
    ).all()
    return {
        "event_id": str(event_id),
        "certificates": [
            {
                "cert_no": r.cert_no,
                "pool_id": str(r.pool_id),
                "tier_name": (r.payload or {}).get("tier", {}).get("name", ""),
                "issued_at": r.issued_at.isoformat() if r.issued_at else None,
            }
            for r in rows
        ],
    }


@public_router.get("/pools/{pool_id}/my-proof", summary="내 응모 포함 증명")
async def get_my_proof(
    pool_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    try:
        return await FairnessService(db).get_inclusion_proof(pool_id, user.id)
    except FairnessError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc


# ───────────────────────── 내부 (주최사 대시보드) ─────────────────────────


@internal_router.get("/events/{event_id}/lottery-policy")
async def get_event_policy(event_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    _require_service_token(request)
    return await FairnessService(db).event_policy_view(event_id)


@internal_router.put("/events/{event_id}/lottery-policy")
async def put_event_policy(event_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    body = await _verified_json(request)
    tier_raw = body.get("tierId")
    try:
        tier_id = uuid.UUID(tier_raw) if tier_raw else None
        service = FairnessService(db)
        record = await service.save_policy(
            event_id,
            tier_id,
            body.get("policy") or {},
            preset=str(body.get("preset") or "custom"),
            actor=str(body.get("actor") or "") or None,
        )
    except (FairnessError, ValueError) as exc:
        raise _bad_request(exc) from exc
    return {"ok": True, "policy_hash": record.policy_hash, "view": await service.event_policy_view(event_id)}


class SimulateProfile(BaseModel):
    key: str
    label: str
    count: int = Field(ge=0, le=200_000)
    invested_ap: int = Field(0, ge=0, le=10_000)
    fan_weight: float = Field(1.0, ge=0, le=3)
    pity_bonus: float = Field(1.0, ge=1, le=3)
    tenure_score: float = Field(0.0, ge=0, le=1)


@internal_router.post("/lottery-policy/simulate")
async def simulate_policy(request: Request):
    body = await _verified_json(request)
    try:
        policy = WeightPolicy.from_dict(body.get("policy") or {})
        raw_profiles = body.get("profiles")
        profiles = (
            [Profile(**SimulateProfile(**p).model_dump()) for p in raw_profiles] if raw_profiles else DEFAULT_PROFILES
        )
        seats = int(body.get("seats", 100))
        return simulate(policy, profiles, seats=seats, iterations=int(body.get("iterations", 400)))
    except (TypeError, ValueError) as exc:
        raise _bad_request(exc) from exc


@internal_router.get("/events/{event_id}/fairness")
async def get_event_fairness(event_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    _require_service_token(request)
    return await FairnessService(db).event_fairness_overview(event_id)


@internal_router.get("/lottery/pools/{pool_id}/results")
async def get_pool_results(pool_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    _require_service_token(request)
    service = FairnessService(db)
    return {"pool_id": str(pool_id), "roots": await service.pool_roots(pool_id), "entries": await service.masked_results(pool_id)}


@internal_router.post("/lottery/pools/{pool_id}/certificate")
async def issue_pool_certificate(pool_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    body = await _verified_json(request)
    service = FairnessService(db)
    try:
        cert = await service.issue_certificate(pool_id, issued_by=str(body.get("actor") or "") or None)
        view = await service.certificate_view(cert.cert_no)
    except FairnessError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except SigningKeyUnavailable as exc:
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail=str(exc)) from exc
    return view


# ───────────────────────── 제재(Slash)·시계열 (과업 WP2·WP5) ─────────────────────────


@internal_router.get("/events/{event_id}/sanctions")
async def get_event_sanctions(event_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    _require_service_token(request)
    from app.services.sanction_service import SanctionService

    return await SanctionService(db).monitor(event_id)


@internal_router.post("/events/{event_id}/sanctions")
async def impose_event_sanction(event_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    """주최사 제재 — 이벤트 범위만. 대상은 응모 id(entryId)로 지정해 원 사용자 id 를 화면에 내보내지 않는다."""
    from app.models.lottery import LotteryEntry, LotteryPool
    from app.services.sanction_service import SanctionError, SanctionService

    body = await _verified_json(request)
    try:
        entry_id = uuid.UUID(str(body.get("entryId")))
    except ValueError as exc:
        raise _bad_request(ValueError("entryId 가 필요합니다")) from exc
    row = (
        await db.execute(
            select(LotteryEntry.user_id)
            .join(LotteryPool, LotteryPool.id == LotteryEntry.pool_id)
            .where(LotteryEntry.id == entry_id, LotteryPool.event_id == event_id)
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="이 이벤트의 응모가 아닙니다")
    try:
        sanction = await SanctionService(db).impose(
            row.user_id,
            str(body.get("reasonCode") or "manual"),
            event_id=event_id,
            evidence={"note": str(body.get("note") or ""), "entry_id": str(entry_id)},
            burn_ratio=float(body.get("burnRatio", 1.0)),
            disqualify_days=int(body["disqualifyDays"]) if body.get("disqualifyDays") is not None else None,
            actor=str(body.get("actor") or "") or None,
        )
    except SanctionError as exc:
        raise _bad_request(exc) from exc
    return {"ok": True, "sanction_id": str(sanction.id), "ap_burned": sanction.ap_burned}


@internal_router.post("/sanctions/{sanction_id}/lift")
async def lift_sanction(sanction_id: uuid.UUID, request: Request, db: AsyncSession = Depends(get_db)):
    from app.models.sanction import AccountSanction
    from app.services.sanction_service import SanctionError, SanctionService

    body = await _verified_json(request)
    original = await db.get(AccountSanction, sanction_id)
    expected_event = body.get("eventId")
    if original is None or (expected_event and str(original.event_id) != str(expected_event)):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="제재를 찾을 수 없습니다")
    try:
        row = await SanctionService(db).lift(sanction_id, actor=str(body.get("actor") or "") or None, note=str(body.get("note") or ""))
    except SanctionError as exc:
        raise _bad_request(exc) from exc
    return {"ok": True, "lift_id": str(row.id)}


@internal_router.get("/events/{event_id}/timeseries")
async def get_event_timeseries(
    event_id: uuid.UUID,
    request: Request,
    kind: str = Query("admission", pattern="^(admission|lottery)$"),
    minutes: int = Query(120, ge=1, le=20160),
    db: AsyncSession = Depends(get_db),
):
    _require_service_token(request)
    from app.services.timeseries_log import admission_series, lottery_series

    if kind == "admission":
        return await admission_series(db, event_id, minutes)
    return await lottery_series(db, event_id, minutes)
