"""레벨2 컷오버 T2-REST — go 전용 원장 2종의 internal API (go DB 제거용).

go 가 자기 DB 에 직접 INSERT/SELECT 하던 두 원장을 v2 정본으로 옮기고, 그 접근 경로를
서비스 간 internal API 로 제공한다. 인증은 `internal_commerce._internal_auth`
(HMAC 서명 + dev/staging 한정 서비스토큰 폴백)를 그대로 재사용한다.

라우트 (실경로에는 `/api/v1/internal` 접두):
  POST /orders/{order_id}/tax-invoice   세금계산서·현금영수증 발행 원장 기록 (멱등)
  GET  /orders/{order_id}/tax-invoices  주문의 발행 이력
  POST /events/{event_id}/seat-funnel   좌석 퍼널 이벤트 수집 (fail-soft, at-least-once)
  GET  /events/{event_id}/seat-funnel   단계별 고유 세션 집계

── 테넌트 경계 ──
두 경로 모두 `organizer_ref`(go account_id 또는 v2 organizer_id)를 필수로 받아
`_resolve_organizer` 로 v2 organizer_id 를 확정하고, 대상(order→event / event)의
`organizer_id` 와 **일치할 때만** 처리한다. 불일치는 404 로 일반화한다(존재 여부 비노출).
단, 퍼널 수집(POST seat-funnel)만은 비로그인 소비자 텔레메트리라 organizer_ref 가 없다 —
event_id 존재 검증만 하고 계정 경계를 요구하지 않는다(쓰기 전용·조회 불가 데이터).

── 멱등성 / 동시성 (설계 증명) ──
· tax-invoice: "동시 2회 실행하면?" → (order_id, receipt_type) 부분 유니크 인덱스
  (status <> 'cancelled') 가 두 번째를 unique violation 으로 튕긴다. 우리는 그것을 잡아
  기존 행을 다시 읽어 `created=false` 로 **같은 응답**을 돌려준다(멱등 재생).
  "외부호출 후 crash 하면?" → 발행 PG 호출은 go 가 먼저 수행하고 그 결과를 meta 로 보내
  이 API 가 **원장 기록만** 담당한다. 기록 전 crash 면 원장에 남지 않으므로 재시도 시
  같은 (order, type) 으로 다시 기록되고 유니크가 중복을 막는다. 기록 후 crash 면
  재시도가 멱등 재생으로 수렴한다. 어느 쪽도 2건이 되지 않는다.
· seat-funnel: 집계가 COUNT(DISTINCT session_id) 라 중복 삽입이 결과를 바꾸지 않는다
  → 멱등키 불필요(at-least-once 로 충분). 이것이 설계상의 멱등성 증명이다.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.internal_commerce import (
    ApiError,
    OrganizerRef,
    _err,
    _internal_auth,
    _ok,
    _resolve_organizer,
)
from app.core.database import get_db
from app.models.event import Event
from app.models.go_ledger import FUNNEL_STEPS, SeatFunnelEvent, TaxInvoice
from app.models.order import Order

logger = logging.getLogger(__name__)

router = APIRouter(dependencies=[Depends(_internal_auth)])

# 퍼널 집계 조회창 상한 — 무제한 스캔 방지.
_FUNNEL_MAX_DAYS = 90
_FUNNEL_DEFAULT_DAYS = 7


# ── Schemas ──────────────────────────────────────────────────────────────────


class TaxInvoiceIn(BaseModel):
    """발행 원장 기록. 실제 발행(PG/팝빌) 호출은 go 가 수행하고 결과만 meta 로 넘긴다."""

    organizer_ref: OrganizerRef
    receipt_type: str = Field(..., pattern="^(tax_invoice|cash_receipt)$")
    amount: int = Field(..., ge=0)
    tax_amount: int = Field(0, ge=0)
    business_number: str | None = Field(None, max_length=40)
    company_name: str | None = Field(None, max_length=200)
    # 현금영수증 식별번호 **원문 금지** — go 가 마스킹한 꼬리 4자리만 보낸다.
    identity_tail: str | None = Field(None, max_length=8)
    provider: str | None = Field(None, max_length=50)
    status: str = Field("requested", pattern="^(requested|issued|cancelled)$")
    meta: dict = Field(default_factory=dict)


class SeatFunnelIn(BaseModel):
    seat_map_id: uuid.UUID | None = None
    session_id: str = Field(..., min_length=1, max_length=100)
    step: str
    seat_count: int | None = Field(None, ge=0)
    meta: dict = Field(default_factory=dict)


# ── Serializers ──────────────────────────────────────────────────────────────


def _serialize_invoice(row: TaxInvoice) -> dict:
    return {
        "id": str(row.id),
        "order_id": str(row.order_id),
        "receipt_type": row.receipt_type,
        "business_number": row.business_number,
        "company_name": row.company_name,
        "identity_tail": row.identity_tail,
        "amount": int(row.amount),
        "tax_amount": int(row.tax_amount),
        "status": row.status,
        "provider": row.provider,
        "issued_at": row.issued_at.isoformat() if row.issued_at else None,
        "meta": row.meta or {},
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


# ── 공통: 주문 소유 검증 ──────────────────────────────────────────────────────


async def _order_owner_guard(
    db: AsyncSession, order_id: uuid.UUID, ref: OrganizerRef
) -> uuid.UUID:
    """order → event.organizer_id 가 organizer_ref 와 일치할 때만 통과. 반환 = organizer_id.

    불일치/미존재는 모두 404 ORDER_NOT_FOUND 로 **일반화**한다(타 테넌트 주문의
    존재 여부가 응답 코드로 새지 않도록).
    """
    organizer_id = await _resolve_organizer(db, ref)
    owner = (
        await db.execute(
            select(Event.organizer_id)
            .join(Order, Order.event_id == Event.id)
            .where(Order.id == order_id)
        )
    ).scalar_one_or_none()
    if owner is None or owner != organizer_id:
        raise ApiError("ORDER_NOT_FOUND", "order not found", 404, "order_id")
    return organizer_id


# ── 세금계산서/현금영수증 원장 ────────────────────────────────────────────────


@router.post("/orders/{order_id}/tax-invoice")
async def record_tax_invoice(
    order_id: uuid.UUID,
    body: TaxInvoiceIn,
    db: AsyncSession = Depends(get_db),
):
    """발행 원장 기록(멱등). 이미 유효 발행이 있으면 기존 행을 `created=false` 로 재생."""
    try:
        organizer_id = await _order_owner_guard(db, order_id, body.organizer_ref)

        async def _existing() -> TaxInvoice | None:
            return (
                await db.execute(
                    select(TaxInvoice).where(
                        TaxInvoice.order_id == order_id,
                        TaxInvoice.receipt_type == body.receipt_type,
                        TaxInvoice.status != "cancelled",
                    )
                )
            ).scalar_one_or_none()

        # 선조회 — 정상 재시도의 대부분을 예외 없이 흡수한다(경합만 아래 IntegrityError 로).
        prior = await _existing()
        if prior is not None:
            return _ok({"invoice": _serialize_invoice(prior), "created": False}, replay=True)

        now = datetime.now(timezone.utc)
        row = TaxInvoice(
            order_id=order_id,
            organizer_id=organizer_id,
            receipt_type=body.receipt_type,
            business_number=body.business_number,
            company_name=body.company_name,
            identity_tail=body.identity_tail,
            amount=body.amount,
            tax_amount=body.tax_amount,
            status=body.status,
            provider=body.provider,
            issued_at=now if body.status == "issued" else None,
            meta=body.meta or {},
            created_at=now,
            updated_at=now,
        )
        db.add(row)
        try:
            await db.commit()
        except IntegrityError:
            # 동시 2회 실행 — 부분 유니크가 두 번째를 튕겼다. 승자 행을 읽어 멱등 재생.
            await db.rollback()
            winner = await _existing()
            if winner is None:
                raise ApiError(
                    "CONFLICT", "tax invoice conflict", 409, "receipt_type"
                ) from None
            return _ok({"invoice": _serialize_invoice(winner), "created": False}, replay=True)

        await db.refresh(row)
        return _ok({"invoice": _serialize_invoice(row), "created": True})
    except ApiError as e:
        return _err(e)


@router.get("/orders/{order_id}/tax-invoices")
async def list_tax_invoices(
    order_id: uuid.UUID,
    organizer_ref: str = Query(..., description="go account_id(uuid) 또는 v2 organizer_id"),
    db: AsyncSession = Depends(get_db),
):
    try:
        try:
            ref = OrganizerRef(organizer_id=uuid.UUID(organizer_ref))
        except ValueError:
            ref = OrganizerRef(go_account_id=organizer_ref)
        await _order_owner_guard(db, order_id, ref)
        rows = (
            (
                await db.execute(
                    select(TaxInvoice)
                    .where(TaxInvoice.order_id == order_id)
                    .order_by(TaxInvoice.created_at.desc())
                )
            )
            .scalars()
            .all()
        )
        return _ok({"invoices": [_serialize_invoice(r) for r in rows]})
    except ApiError as e:
        return _err(e)


# ── 좌석 퍼널 텔레메트리 ──────────────────────────────────────────────────────


@router.post("/events/{event_id}/seat-funnel")
async def collect_seat_funnel(
    event_id: uuid.UUID,
    body: SeatFunnelIn,
    db: AsyncSession = Depends(get_db),
):
    """퍼널 이벤트 1건 수집.

    비로그인 소비자 텔레메트리라 organizer_ref 를 요구하지 않는다(쓰기 전용, 조회 불가).
    알 수 없는 step 이나 미존재 event 는 **에러로 만들지 않고 조용히 버린다** — 분석 수집이
    구매 경로를 막아서는 안 된다(go 쪽도 fail-soft 로 200 을 반환한다).
    """
    if body.step not in FUNNEL_STEPS:
        return _ok({"accepted": False, "reason": "unknown_step"})

    exists = (
        await db.execute(select(Event.id).where(Event.id == event_id))
    ).scalar_one_or_none()
    if exists is None:
        return _ok({"accepted": False, "reason": "unknown_event"})

    db.add(
        SeatFunnelEvent(
            event_id=event_id,
            seat_map_id=body.seat_map_id,
            session_id=body.session_id,
            step=body.step,
            seat_count=body.seat_count,
            meta=body.meta or {},
            created_at=datetime.now(timezone.utc),
        )
    )
    await db.commit()
    return _ok({"accepted": True})


@router.get("/events/{event_id}/seat-funnel")
async def get_seat_funnel(
    event_id: uuid.UUID,
    organizer_ref: str = Query(..., description="go account_id(uuid) 또는 v2 organizer_id"),
    days: int = Query(_FUNNEL_DEFAULT_DAYS, ge=1, le=_FUNNEL_MAX_DAYS),
    db: AsyncSession = Depends(get_db),
):
    """단계별 **고유 세션 수** 집계 + 이탈률. 조회는 이벤트 소유 organizer 로 스코프한다."""
    try:
        try:
            ref = OrganizerRef(organizer_id=uuid.UUID(organizer_ref))
        except ValueError:
            ref = OrganizerRef(go_account_id=organizer_ref)
        organizer_id = await _resolve_organizer(db, ref)

        owner = (
            await db.execute(select(Event.organizer_id).where(Event.id == event_id))
        ).scalar_one_or_none()
        if owner is None or owner != organizer_id:
            raise ApiError("EVENT_NOT_FOUND", "event not found", 404, "event_id")

        since = datetime.now(timezone.utc) - timedelta(days=days)
        rows = (
            await db.execute(
                select(
                    SeatFunnelEvent.step,
                    func.count(func.distinct(SeatFunnelEvent.session_id)),
                )
                .where(
                    SeatFunnelEvent.event_id == event_id,
                    SeatFunnelEvent.created_at > since,
                )
                .group_by(SeatFunnelEvent.step)
            )
        ).all()

        funnel = {step: 0 for step in FUNNEL_STEPS}
        for step, count in rows:
            if step in funnel:
                funnel[step] = int(count)

        def rate(a: int, b: int) -> int:
            return 0 if b == 0 else round(a / b * 100)

        return _ok(
            {
                "funnel": funnel,
                "dropoff_rate": {
                    "view_to_select": rate(funnel["select"], funnel["view"]),
                    "select_to_hold": rate(funnel["hold"], funnel["select"]),
                    "hold_to_checkout": rate(funnel["checkout"], funnel["hold"]),
                    "checkout_to_complete": rate(funnel["complete"], funnel["checkout"]),
                },
                "window_days": days,
            }
        )
    except ApiError as e:
        return _err(e)
