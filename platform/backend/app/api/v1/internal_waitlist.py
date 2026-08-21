"""go 주최자 대기열(Waitlist) write/read 이관 API — 레벨2 컷오버(스코프A).

go `events/[eventId]/waitlist/**` 라우트가 go DB 를 직접 read/write 하던 것을 이 internal
API 로 프록시한다(go DB 완전 제거). v2 = 대기열 정본.

인증/멱등/봉투: internal_commerce 와 동일 규약 재사용.
  - 인증: _internal_auth (HMAC X-Pickket-Signature vs GO_WEBHOOK_SECRET, 전환기 토큰 폴백).
  - 봉투: { ok, data, idempotent_replay } / 에러 { ok:false, error:{code,message,field} }.
  - 멱등: create 는 Idempotency-Key. 상태 전이/claim 은 조건부 UPDATE(CAS)로 원자성·멱등 확보.

멀티테넌트 경계(Critical): 모든 조회/전이/삭제는 account_id 를 WHERE 에 강제한다.
  go 라우트가 세션 accountId + 이벤트 소유권을 검증한 뒤 account_id 를 넘긴다. v2 는
  account_id 를 신뢰 경계로 재확인해 크로스테넌트 항목 접근을 차단한다.

상태머신(go ALLOWED_TRANSITIONS 이관, models.organizer_waitlist.ALLOWED_TRANSITIONS):
  waiting → offered | cancelled
  offered → waiting | cancelled | expired | converted
  expired → offered
  converted / cancelled → (종단)

claim(구매 전환) 트랜잭션 경계:
  go 공개 claim 라우트가 (1) claim-begin(offered→converted CAS, v2), (2) go createOrder,
  (3) claim-commit(converted_order_id 앵커, v2) / claim-abort(보상: converted→offered, v2)
  3-phase 로 나눠 호출한다. "동시 2회"·"createOrder 후 crash" 는 아래 begin/commit/abort 의
  조건부 UPDATE + converted_order_id 재생으로 방어(각 함수 docstring 증명 참조).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Header, Query, Request
from pydantic import BaseModel, EmailStr, Field
from sqlalchemy import and_, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.internal_commerce import (
    ApiError,
    _commit_or_conflict,
    _fingerprint,
    _idempotent,
    _internal_auth,
    _err,
)
from app.core.database import get_db
from app.models.event import Event, SeatTier
from app.models.order import Order
from app.models.organizer import OrganizerProfile
from app.models.organizer_waitlist import ALLOWED_TRANSITIONS, OrganizerWaitlistEntry

router = APIRouter(dependencies=[Depends(_internal_auth)])

# 제안 유효기간(시간). go route OFFER_TTL_MS(24h)와 동일.
_OFFER_TTL = timedelta(hours=24)


async def _assert_event_owned_by_account(
    db: AsyncSession, event_id: uuid.UUID, account_id: uuid.UUID
) -> Event:
    """생성 API 내부호출자 경계(P1 재감사, 코덱스 의심 확정).

    create 는 event/account/product FK·서버검증 없이 go 공개 route 소유권에만 의존했다.
    내부호출자(서비스토큰 보유)가 임의 event_id·account_id 로 타 테넌트 이벤트에 대기열을
    주입하는 것을 차단하기 위해, event 가 실재하고 그 event 의 소유 organizer 가 이 account
    에 매핑되는지 v2 정본으로 재확인한다. 검증 통과 시 정본 Event(product 재검증에
    이어 쓸 canonical id 확보)를 반환한다.

    매핑 계약(internal_commerce 와 동일):
      go event_id == v2 canonical Event.id (external_ref 단일화) — id 또는 external_ref 로 조회.
      go account_id → OrganizerProfile.go_account_id → user_id == Event.organizer_id.
    """
    event = await db.get(Event, event_id)
    if event is None:
        # external_ref(=go event id) 로도 재조회(심사요청 경로가 external_ref 로만 저장했을 수 있음).
        event = (
            await db.execute(select(Event).where(Event.external_ref == str(event_id)))
        ).scalar_one_or_none()
    if event is None:
        raise ApiError("NOT_FOUND", "event not found", 404, "event_id")

    owner_uid = (
        await db.execute(
            select(OrganizerProfile.user_id).where(
                OrganizerProfile.go_account_id == str(account_id)
            )
        )
    ).scalar_one_or_none()
    if owner_uid is None or owner_uid != event.organizer_id:
        # account 가 이 event 를 소유하지 않음 → 크로스테넌트 주입 차단(존재은닉 위해 404).
        raise ApiError("NOT_FOUND", "event not found", 404, "event_id")
    return event


async def _assert_product_in_event(
    db: AsyncSession, event: Event, product_id: uuid.UUID
) -> None:
    """생성 API product 재검증(P1 재감사, 코덱스 의심 확정).

    create 는 product_id 를 검증 없이 스냅샷 저장하고 go 공개 route 소유권 검증에만
    의존했다. 내부호출자(서비스토큰 보유)가 임의 product_id — 특히 **다른 이벤트의
    티어** — 를 주입하면, offer→claim(createOrder)가 그 product 로 주문을 생성해
    크로스이벤트 상품 판매(재고 회계 오염)로 이어질 수 있다. product_id 가 이 event
    의 실제 상품/티어인지 v2 정본으로 재확인한다.

    매핑 계약(SPEC §1.6, internal_commerce 와 동일):
      go product_id ↔ v2 SeatTier — id(v2 canonical) 또는 external_ref(=go product id).
      어느 쪽이든 그 SeatTier.event_id 는 반드시 이 event.id 여야 한다.
    """
    tier_id = (
        await db.execute(
            select(SeatTier.id).where(
                SeatTier.event_id == event.id,
                or_(
                    SeatTier.id == product_id,
                    SeatTier.external_ref == str(product_id),
                ),
            )
        )
    ).scalar_one_or_none()
    if tier_id is None:
        # product 가 이 event 의 티어가 아님(미존재 또는 타 이벤트) → 404(존재은닉).
        raise ApiError("NOT_FOUND", "product not found for event", 404, "product_id")


async def _assert_order_in_scope(
    db: AsyncSession, entry: OrganizerWaitlistEntry, order_id: uuid.UUID
) -> None:
    """claim-commit order 재검증(P1 재감사, 코덱스 의심 확정).

    claim-commit 은 order_id 를 검증 없이 앵커로 기록했다. 내부호출자가 **다른
    이벤트/다른 테넌트의 주문 id** 를 주입하면, 무관한 주문이 대기열 전환 앵커로
    묶여 잘못된 주문 재생(alreadyClaimed)·정산/회계 교차오염이 발생한다. order 가
    이 entry 의 event(=account 소유로 이미 검증됨) 소속 주문인지 v2 정본으로 재확인한다.

    매핑 계약: go order id 는 v2 Order.external_ref 로 저장(internal_commerce
      external_order_id). v2 canonical id 폴백도 허용. 어느 쪽이든 그 Order.event_id
      는 반드시 entry.event_id 여야 한다. entry.event 는 생성 시 account 소유가
      검증됐으므로 event 경계 = account 경계(크로스테넌트 주입 차단).
    """
    order_event_id = (
        await db.execute(
            select(Order.event_id).where(
                or_(
                    Order.id == order_id,
                    Order.external_ref == str(order_id),
                )
            )
        )
    ).scalar_one_or_none()
    if order_event_id is None:
        raise ApiError("NOT_FOUND", "order not found", 404, "order_id")
    if order_event_id != entry.event_id:
        # 다른 이벤트/테넌트의 주문 주입 → 차단(존재은닉 위해 404).
        raise ApiError("NOT_FOUND", "order not found for entry event", 404, "order_id")


def _entry_dict(e: OrganizerWaitlistEntry) -> dict:
    """go 라우트 응답 필드명(camelCase alias)에 맞춘 직렬화."""
    return {
        "id": str(e.id),
        "account_id": str(e.account_id),
        "event_id": str(e.event_id),
        "product_id": str(e.product_id),
        "name": e.name,
        "email": e.email,
        "phone": e.phone,
        "status": e.status,
        "offered_at": e.offered_at.isoformat() if e.offered_at else None,
        "expires_at": e.expires_at.isoformat() if e.expires_at else None,
        "offer_token_version": e.offer_token_version,
        "converted_order_id": str(e.converted_order_id) if e.converted_order_id else None,
        "created_at": e.created_at.isoformat() if e.created_at else None,
        "updated_at": e.updated_at.isoformat() if e.updated_at else None,
    }


# ── create ────────────────────────────────────────────────────────────────
class WaitlistCreateRequest(BaseModel):
    account_id: uuid.UUID
    event_id: uuid.UUID
    product_id: uuid.UUID
    name: str = Field(min_length=1)
    email: EmailStr
    phone: str | None = None


@router.post("/waitlist/entries", summary="go 프록시: 대기열 신청 생성")
async def create_waitlist_entry(
    body: WaitlistCreateRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    async def _producer():
        # 내부호출자 경계(P1): event 실재 + account 가 그 event 를 소유하는지 v2 정본 재확인.
        #   go route 소유권 검증에만 의존하던 것을 서버 측에서 보강(크로스테넌트 주입 차단).
        event = await _assert_event_owned_by_account(db, body.event_id, body.account_id)
        # product 재검증(P1): product_id 가 이 event 의 실제 티어(id 또는 external_ref)인지
        #   v2 정본 재확인. go 검증에 더해 크로스이벤트 상품 주입을 서버측에서 차단.
        await _assert_product_in_event(db, event, body.product_id)
        entry = OrganizerWaitlistEntry(
            account_id=body.account_id,
            event_id=body.event_id,
            product_id=body.product_id,
            name=body.name,
            email=str(body.email),
            phone=body.phone,
            status="waiting",
        )
        db.add(entry)
        # UNIQUE(event_id, product_id, email) 위반 → _commit_or_conflict 가 409 CONFLICT.
        await _commit_or_conflict(db, "waitlist entry")
        await db.refresh(entry)
        return _entry_dict(entry)

    try:
        return await _idempotent(
            idempotency_key, "waitlist.create", _producer, fingerprint=_fingerprint(body)
        )
    except ApiError as e:
        return _err(e)


# ── list ─────────────────────────────────────────────────────────────────
@router.get("/waitlist/entries", summary="go 프록시: 대기열 목록(account 경계)")
async def list_waitlist_entries(
    account_id: uuid.UUID = Query(...),
    event_id: uuid.UUID = Query(...),
    status: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    try:
        conds = [
            OrganizerWaitlistEntry.account_id == account_id,
            OrganizerWaitlistEntry.event_id == event_id,
        ]
        if status:
            conds.append(OrganizerWaitlistEntry.status == status)
        rows = (
            (
                await db.execute(
                    select(OrganizerWaitlistEntry)
                    .where(and_(*conds))
                    .order_by(OrganizerWaitlistEntry.created_at.desc())
                )
            )
            .scalars()
            .all()
        )
        return {"ok": True, "data": {"items": [_entry_dict(r) for r in rows], "total": len(rows)}, "idempotent_replay": False}
    except ApiError as e:
        return _err(e)


# ── status transition (CAS) ────────────────────────────────────────────────
class WaitlistTransitionRequest(BaseModel):
    account_id: uuid.UUID
    # 이벤트 경계(P1 재감사): account_id 만으로는 같은 계정의 **다른 이벤트** entry 를
    #   URL 에 넣어 조작 가능(크로스이벤트 IDOR). event_id 를 WHERE 에 강제해 차단.
    event_id: uuid.UUID
    status: str  # waiting|offered|converted|cancelled|expired


@router.patch("/waitlist/entries/{entry_id}", summary="go 프록시: 대기열 상태 전이(원자 CAS)")
async def transition_waitlist_entry(
    entry_id: uuid.UUID,
    body: WaitlistTransitionRequest,
    db: AsyncSession = Depends(get_db),
):
    """상태 전이를 조건부 UPDATE(WHERE status IN 허용출발집합)로 원자 획득한다.

    - 동시 2회: 조건부 UPDATE 가 한 요청만 rowcount=1 을 얻는다(check-then-update race 제거).
    - 같은 상태 재요청(멱등): 허용출발집합에 목표상태 자신을 포함해 no-op 성공 재생.
    - offered 전이 시에만 offered_at/expires_at 세팅 + offer_token_version++ → 이전 딥링크 무효화.
      토큰 발급/발송은 go(외부호출)가 이 커밋 이후에 수행(외부호출 후 crash 여도 상태 정합).
    - 경계(P1): account_id **및 event_id** 를 WHERE 에 강제 → 크로스이벤트/크로스테넌트 차단.
    """
    try:
        target = body.status
        if target not in ALLOWED_TRANSITIONS:
            raise ApiError("VALIDATION_ERROR", f"unknown status: {target}", 400, "status")

        # 목표상태로 전이 가능한 출발상태 집합 + 목표상태 자신(멱등 no-op).
        from_states = {
            frm for frm, allowed in ALLOWED_TRANSITIONS.items()
            if frm == target or target in allowed
        }
        if not from_states:
            raise ApiError("VALIDATION_ERROR", f"no transition into status: {target}", 400, "status")

        is_offering = target == "offered"
        now = datetime.now(timezone.utc)
        values: dict = {"status": target, "updated_at": now}
        if is_offering:
            values["offered_at"] = now
            values["expires_at"] = now + _OFFER_TTL
            values["offer_token_version"] = OrganizerWaitlistEntry.offer_token_version + 1

        result = await db.execute(
            update(OrganizerWaitlistEntry)
            .where(
                OrganizerWaitlistEntry.id == entry_id,
                OrganizerWaitlistEntry.account_id == body.account_id,
                OrganizerWaitlistEntry.event_id == body.event_id,
                OrganizerWaitlistEntry.status.in_(list(from_states)),
            )
            .values(**values)
            .returning(OrganizerWaitlistEntry.id)
        )
        updated_id = result.scalar_one_or_none()
        if updated_id is None:
            # 행이 없으면 404, (account+event) 경계 안에 존재하나 상태 불일치면 409.
            # 경계 밖(다른 account 또는 다른 event)이면 존재하지 않는 것으로 취급 → 404.
            exists = (
                await db.execute(
                    select(OrganizerWaitlistEntry.id).where(
                        OrganizerWaitlistEntry.id == entry_id,
                        OrganizerWaitlistEntry.account_id == body.account_id,
                        OrganizerWaitlistEntry.event_id == body.event_id,
                    )
                )
            ).scalar_one_or_none()
            await db.rollback()
            if exists is None:
                raise ApiError("NOT_FOUND", "waitlist entry not found", 404)
            raise ApiError("CONFLICT", "waitlist status already changed", 409)

        await db.commit()
        entry = await db.get(OrganizerWaitlistEntry, entry_id)
        return {"ok": True, "data": _entry_dict(entry), "idempotent_replay": False}
    except ApiError as e:
        return _err(e)


# ── delete ─────────────────────────────────────────────────────────────────
@router.delete("/waitlist/entries/{entry_id}", summary="go 프록시: 대기열 항목 삭제(account+event 경계)")
async def delete_waitlist_entry(
    entry_id: uuid.UUID,
    account_id: uuid.UUID = Query(...),
    # 이벤트 경계(P1 재감사): 삭제도 account_id 만으로는 크로스이벤트 삭제 가능 → event_id 강제.
    event_id: uuid.UUID = Query(...),
    db: AsyncSession = Depends(get_db),
):
    try:
        entry = (
            await db.execute(
                select(OrganizerWaitlistEntry).where(
                    OrganizerWaitlistEntry.id == entry_id,
                    OrganizerWaitlistEntry.account_id == account_id,
                    OrganizerWaitlistEntry.event_id == event_id,
                )
            )
        ).scalar_one_or_none()
        if entry is None:
            raise ApiError("NOT_FOUND", "waitlist entry not found", 404)
        await db.delete(entry)
        await db.commit()
        return {"ok": True, "data": {"deleted": True}, "idempotent_replay": False}
    except ApiError as e:
        return _err(e)


# ── public claim 지원(3-phase) ──────────────────────────────────────────────
@router.get("/waitlist/entries/{entry_id}", summary="go claim: 대기열 항목 단건 조회(공개 claim 검증용)")
async def get_waitlist_entry(
    entry_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """공개 claim 라우트가 토큰 검증 전 스냅샷(status/expires_at/token_version/converted)을 읽는다.

    account 경계 없음: 공개 claim 은 딥링크 HMAC 토큰이 접근통제(entry_id 고정). account_id
    를 알 수 없으므로 여기선 id 로만 조회한다(토큰 검증은 go 가 이미 수행).
    """
    try:
        entry = await db.get(OrganizerWaitlistEntry, entry_id)
        if entry is None:
            raise ApiError("NOT_FOUND", "waitlist entry not found", 404)
        return {"ok": True, "data": _entry_dict(entry), "idempotent_replay": False}
    except ApiError as e:
        return _err(e)


@router.post("/waitlist/entries/{entry_id}/claim-begin", summary="go claim: offered→converted 원자 획득")
async def claim_begin(
    entry_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """offered → converted 를 조건부 UPDATE 로 원자 획득(공개 claim 1단계).

    멱등/동시성 증명:
      - 동시 2회: WHERE status='offered' 조건부 UPDATE 로 한쪽만 rowcount=1(획득). 나머지는 0.
      - 획득자(claimed=True): go 가 createOrder 후 claim-commit 으로 order_id 앵커.
      - 경쟁 패자(claimed=False): converted_order_id 있으면 alreadyClaimed 재생, 없으면(승자가
        아직 커밋 전) still_processing → go 가 409 로 응답(재시도 가능).
      - 이미 converted+order_id: alreadyClaimed 재생(멱등).
    """
    try:
        entry = await db.get(OrganizerWaitlistEntry, entry_id)
        if entry is None:
            raise ApiError("NOT_FOUND", "waitlist entry not found", 404)

        # 이미 전환됨(주문 앵커 존재) → 멱등 재생.
        if entry.status == "converted" and entry.converted_order_id is not None:
            return {
                "ok": True,
                "data": {"claimed": False, "already_claimed": True, "converted_order_id": str(entry.converted_order_id), "entry": _entry_dict(entry)},
                "idempotent_replay": True,
            }

        # 원자 획득: offered → converted.
        result = await db.execute(
            update(OrganizerWaitlistEntry)
            .where(
                OrganizerWaitlistEntry.id == entry_id,
                OrganizerWaitlistEntry.status == "offered",
                OrganizerWaitlistEntry.expires_at > func.now(),
            )
            .values(status="converted", updated_at=datetime.now(timezone.utc))
            .returning(OrganizerWaitlistEntry.id)
        )
        won = result.scalar_one_or_none()
        if won is None:
            await db.rollback()
            # 경쟁 패배 또는 offered 아님 — 승자 주문 재생 시도.
            fresh = await db.get(OrganizerWaitlistEntry, entry_id)
            if fresh is not None and fresh.converted_order_id is not None:
                return {
                    "ok": True,
                    "data": {"claimed": False, "already_claimed": True, "converted_order_id": str(fresh.converted_order_id), "entry": _entry_dict(fresh)},
                    "idempotent_replay": True,
                }
            # 승자가 아직 order 앵커 커밋 전이거나 offered 가 아님 — go 가 409.
            return {
                "ok": True,
                "data": {"claimed": False, "already_claimed": False, "converted_order_id": None, "entry": _entry_dict(fresh) if fresh else None},
                "idempotent_replay": False,
            }

        await db.commit()
        entry = await db.get(OrganizerWaitlistEntry, entry_id)
        return {
            "ok": True,
            "data": {"claimed": True, "already_claimed": False, "converted_order_id": None, "entry": _entry_dict(entry)},
            "idempotent_replay": False,
        }
    except ApiError as e:
        return _err(e)


class ClaimCommitRequest(BaseModel):
    order_id: uuid.UUID


@router.post("/waitlist/entries/{entry_id}/claim-commit", summary="go claim: 전환 주문 앵커 기록")
async def claim_commit(
    entry_id: uuid.UUID,
    body: ClaimCommitRequest,
    db: AsyncSession = Depends(get_db),
):
    """converted 항목에 converted_order_id 앵커를 기록(공개 claim 3단계).

    멱등: converted_order_id IS NULL 인 converted 항목만 세팅(WHERE 가드). 재호출 시 이미
    세팅됐으면 no-op 로 기존 order_id 를 재생(같은 order_id 여야 정합).

    order 경계(P1 재감사): 앵커 기록 전, order_id 가 이 entry 의 event(=account 소유로
    이미 검증됨) 소속 주문인지 v2 정본으로 재확인한다(크로스이벤트/크로스테넌트 order 주입
    차단). entry 미존재 시 404.
    """
    try:
        entry = await db.get(OrganizerWaitlistEntry, entry_id)
        if entry is None:
            raise ApiError("NOT_FOUND", "waitlist entry not found", 404)
        # order 재검증(P1): order 가 entry.event 소속인지 확인 후에만 앵커 기록.
        await _assert_order_in_scope(db, entry, body.order_id)

        result = await db.execute(
            update(OrganizerWaitlistEntry)
            .where(
                OrganizerWaitlistEntry.id == entry_id,
                OrganizerWaitlistEntry.status == "converted",
                OrganizerWaitlistEntry.converted_order_id.is_(None),
            )
            .values(converted_order_id=body.order_id, updated_at=datetime.now(timezone.utc))
            .returning(OrganizerWaitlistEntry.id)
        )
        won = result.scalar_one_or_none()
        await db.commit()
        entry = await db.get(OrganizerWaitlistEntry, entry_id)
        if entry is None:
            raise ApiError("NOT_FOUND", "waitlist entry not found", 404)
        return {
            "ok": True,
            "data": {"converted_order_id": str(entry.converted_order_id) if entry.converted_order_id else None, "committed": won is not None},
            "idempotent_replay": won is None,
        }
    except ApiError as e:
        return _err(e)


@router.post("/waitlist/entries/{entry_id}/claim-abort", summary="go claim: 주문 생성 실패 보상(converted→offered)")
async def claim_abort(
    entry_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """createOrder 실패 시 converted → offered 로 되돌려 재시도 가능하게 한다(보상).

    가드: converted_order_id IS NULL 인 converted 만 복구(이미 앵커된 성공건은 불변).
    """
    try:
        await db.execute(
            update(OrganizerWaitlistEntry)
            .where(
                OrganizerWaitlistEntry.id == entry_id,
                OrganizerWaitlistEntry.status == "converted",
                OrganizerWaitlistEntry.converted_order_id.is_(None),
            )
            .values(status="offered", updated_at=datetime.now(timezone.utc))
        )
        await db.commit()
        entry = await db.get(OrganizerWaitlistEntry, entry_id)
        return {"ok": True, "data": _entry_dict(entry) if entry else {"restored": True}, "idempotent_replay": False}
    except ApiError as e:
        return _err(e)
