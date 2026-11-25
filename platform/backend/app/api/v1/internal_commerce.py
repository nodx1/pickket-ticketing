"""go write-through 커머스 write API (Slice A) — 이벤트 authoring + fee-plan.

P0 SPEC `2026-06-01-SPEC-v2-commerce-api-P0.md` §2.1/2.2/2.7.
v2 = 커머스 단일 SoT. go 대시보드가 go DB 가 아니라 이 internal API 로 직접
write(write-through, dual-write 금지).

공통 규약(SPEC §1):
- 인증: X-Pickket-Service-Token (HMAC vs GO_WEBHOOK_SECRET) — _require_service_token 재사용.
- 멱등: Idempotency-Key 헤더 필수. 동일 키 재요청 → 최초 응답 재생(side-effect 0).
- organizer_ref 필수: go_account_id → OrganizerProfile → user_id (go-system fallback 폐기).
- 판매창은 go 입력 정본(event_date 추정 안 함).
- 응답 봉투: { ok, data, idempotent_replay } / 에러 { ok:false, error:{code,message,field} }.

Slice 범위: 이 파일은 Slice A(events + fee-plan)만. tiers/seats/content/discount 는
Slice B~D 에서 확장.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import uuid
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from typing import NamedTuple, NoReturn

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr, Field, TypeAdapter, ValidationError, field_validator, model_validator
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.internal_sync import _parse_iso, _require_service_token
from app.core.config import settings
from app.core.database import get_db
from app.core.redis import cache_get_json, cache_set_json
from app.models.affiliate import Affiliate, AffiliateConversion
from app.models.commerce_extras import (
    PRICING_RULE_TYPES,
    EventRefundPolicy,
    GroupBooking,
    TierPriceHistory,
    TierPricingRule,
)
from app.models.discount_code import DiscountCode, DiscountCodeType
from app.models.event import Event, EventStatus, SeatTier
from app.models.event_mirror import EventAnnouncement, EventFacility, EventParticipant
from app.models.event_page import EventPage
from app.models.fee_schedule import FeeSchedule
from app.models.guest import Guest
from app.models.order import (
    VALID_ORDER_TRANSITIONS,
    Order,
    OrderStatus,
    OrderType,
)
from app.models.order_item import OrderItem
from app.models.refund import Refund, RefundItem, RefundStatus, RefundType
from app.models.organizer import OrganizerProfile
from app.models.ownership_transfer import OwnershipTransfer, TransferType
from app.models.seat import Seat, SeatStatus
from app.models.seat_map_template import SeatMapTemplate
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.models.waitlist import WaitlistEntryModel
from app.repositories.ticket_repo import TicketRepository
from app.services.admission_service import (
    AdmissionError,
    admit,
    revoke_admission,
    to_kst_date,
)
from app.services.finance_service import FinanceService
from app.services.nicepay_gateway import (
    PartialCancelUnsupportedError,
    normalize_allowed_pay_methods,
)
from app.services.partial_refund_service import PartialRefundError, PartialRefundService

logger = logging.getLogger(__name__)

async def _internal_auth(request: Request) -> None:
    """/internal 커머스 인증 (추가형 HMAC, P0 보안).

    - X-Pickket-Signature 있으면 → HMAC 검증(verify_pickket_webhook, guard_replay=False:
      멱등은 Idempotency-Key 가 담당). 서명 불일치/만료 timestamp → 400/401.
    - 서명 없으면 → 전환기 토큰 폴백(_require_service_token). 단 INTERNAL_COMMERCE_REQUIRE_HMAC
      =True(컷오버 후 flip)면 서명 필수 → 401.
    go commerce-client 서명 계약: HMAC-SHA256(GO_WEBHOOK_SECRET, f"{ts}." + raw_body),
    헤더 x-pickket-signature + x-pickket-timestamp.
    """
    sig = request.headers.get("x-pickket-signature", "").strip()
    if sig:
        from app.core.webhook_verifier import verify_pickket_webhook
        raw = await request.body()
        # S-1(#25): GO_WEBHOOK_SECRET_PREVIOUS 폴백은 verify_pickket_webhook 내부에서 자동 처리.
        await verify_pickket_webhook(
            request, raw, settings.GO_WEBHOOK_SECRET, source="go", guard_replay=False
        )
        return
    # S-5(#24): production 에서는 토큰 폴백(타임스탬프·논스 없는 인증) 강제 차단.
    # config 검증이 INTERNAL_COMMERCE_REQUIRE_HMAC=True 를 production 에 강제하지만,
    # 런타임에서도 한 번 더 방어(설정 드리프트 대비) — production 은 무조건 서명 필수.
    if getattr(settings, "INTERNAL_COMMERCE_REQUIRE_HMAC", False) or settings.ENVIRONMENT == "production":
        raise HTTPException(status_code=401, detail="HMAC signature required (X-Pickket-Signature)")
    _require_service_token(request)  # 전환기 토큰 폴백 (dev/staging 한정)


router = APIRouter(dependencies=[Depends(_internal_auth)])

_VALID_CATEGORIES = {
    "concert", "musical", "sports", "classical",
    "exhibition", "festival", "esports", "education", "civic",
}
_VALID_FEE_TYPES = {"percentage", "fixed", "percentage_plus_fixed"}
_VALID_STATUSES = {s.value for s in EventStatus}
_VALID_SALE_MODES = {"fanclub_presale", "point_lottery", "queue", "fixed_fcfs"}
_VALID_ADMISSION_MODES = {"single", "daypass", "allpass"}  # F1 입장방식
# 좌석 판매 방식 — assigned(지정석: 배치도로 좌석을 그려 판다) / unassigned(자유입장: 등급 수량만).
# go 운영 콘솔이 이 값으로 배치도 에디터 노출을 가른다. 미전송 시 모델 default("assigned").
_VALID_SEAT_TYPES = {"assigned", "unassigned"}
_IDEM_TTL = 86400  # 24h

# ── Phase 1-S/1-O 상세페이지 갭 필드 경량 검증 (JSONB 크기·원소 스키마) ──────────
# go write-through 로 들어오는 event_schedules/seo_metadata/questions 를 저장 전 경량 검증한다.
# 목적: (1) 원소 형태 오염(문자열/숫자 등 비-dict) 차단, (2) 원소 수·페이로드 크기 상한으로
#       악성/버그성 대용량 JSONB 로 인한 저장·소비자 렌더 부하 방지. 스키마 강제는 아님(가산·관대).
_GAP_MAX_SCHEDULES = 100        # 타임테이블 원소 상한
_GAP_MAX_QUESTIONS = 50         # 예매 설문 원소 상한
_GAP_MAX_JSON_BYTES = 64 * 1024  # 각 JSONB 필드 직렬화 크기 상한(64KB)
# 좌석 배치도 원본(Phase 1-Map)은 좌석 수백~수천 개 canvas + 다층/배경/랜드마크를 담아
# 갭 필드보다 훨씬 클 수 있으므로 별도의 넉넉한 상한(512KB)을 둔다.
_SEATMAP_MAX_JSON_BYTES = 512 * 1024
_SEATMAP_MAX_MAPS = 50          # 다층 맵 원소 상한(1F/2F/... + 형제)
# 레벨2 영역A — go seat_map_versions/seat_groups/seat_map_landmarks 흡수 시 맵별 원소 상한.
# go 는 버전을 30개까지만 보관(오래된 것 정리) → 30. 그룹/랜드마크는 넉넉히.
_SEATMAP_MAX_VERSIONS = 30
_SEATMAP_MAX_GROUPS = 200
_SEATMAP_MAX_LANDMARKS = 200


def _validate_gap_list(value, *, field: str, max_items: int) -> list | None:
    """event_schedules/questions — list[dict] 경량 검증. None/빈 리스트 → None(섹션 없음)."""
    if value is None:
        return None
    if not isinstance(value, list):
        raise ApiError("VALIDATION_ERROR", f"{field} must be a list", 400, field)
    if len(value) > max_items:
        raise ApiError("VALIDATION_ERROR", f"{field} exceeds max items ({max_items})", 400, field)
    for i, item in enumerate(value):
        if not isinstance(item, dict):
            raise ApiError("VALIDATION_ERROR", f"{field}[{i}] must be an object", 400, field)
    if len(json.dumps(value, ensure_ascii=False).encode("utf-8")) > _GAP_MAX_JSON_BYTES:
        raise ApiError("VALIDATION_ERROR", f"{field} payload too large", 400, field)
    return value or None


def _validate_gap_dict(value, *, field: str) -> dict | None:
    """seo_metadata — dict 경량 검증. None/빈 dict → None(섹션 없음)."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ApiError("VALIDATION_ERROR", f"{field} must be an object", 400, field)
    if len(json.dumps(value, ensure_ascii=False).encode("utf-8")) > _GAP_MAX_JSON_BYTES:
        raise ApiError("VALIDATION_ERROR", f"{field} payload too large", 400, field)
    return value or None


def _validate_seat_map_data(value, *, field: str = "seat_map_data") -> dict | None:
    """Phase 1-Map — 좌석 배치도 원본 canvas 경량 검증. None/빈 dict → None(배치도 없음).

    형태(계약): {version, maps:[{id,name,status,floor_index,floor_label,parent_map_id,
      map_data, background:{...}|null, landmarks:[...], versions:[...], groups:[...]}]}.
    스키마 강제는 아님(가산·관대) —
    (1) 최상위 dict, maps 는 list[dict] 형태 오염 차단, (2) maps 원소 수·직렬화 크기(512KB) 상한,
    (3) 레벨2 영역A 흡수: maps[].versions/groups/landmarks 는 list[dict] 형태만 검증(원소 내부는
        go 원본이므로 관여 X — 변환 없이 보관). versions/groups 원소 수 상한으로 JSONB 비대 방지.
    map_data 내부는 go 원본이므로 관여하지 않는다(변환 없이 보관).
    """
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ApiError("VALIDATION_ERROR", f"{field} must be an object", 400, field)
    maps = value.get("maps")
    if maps is not None:
        if not isinstance(maps, list):
            raise ApiError("VALIDATION_ERROR", f"{field}.maps must be a list", 400, field)
        if len(maps) > _SEATMAP_MAX_MAPS:
            raise ApiError("VALIDATION_ERROR", f"{field}.maps exceeds max items ({_SEATMAP_MAX_MAPS})", 400, field)
        for i, item in enumerate(maps):
            if not isinstance(item, dict):
                raise ApiError("VALIDATION_ERROR", f"{field}.maps[{i}] must be an object", 400, field)
            # 흡수된 하위 컬렉션(versions/groups/landmarks) — 형태·개수 상한만(가산·관대).
            for coll_key, coll_max in (
                ("versions", _SEATMAP_MAX_VERSIONS),
                ("groups", _SEATMAP_MAX_GROUPS),
                ("landmarks", _SEATMAP_MAX_LANDMARKS),
            ):
                coll = item.get(coll_key)
                if coll is None:
                    continue
                if not isinstance(coll, list):
                    raise ApiError(
                        "VALIDATION_ERROR", f"{field}.maps[{i}].{coll_key} must be a list", 400, field
                    )
                if len(coll) > coll_max:
                    raise ApiError(
                        "VALIDATION_ERROR",
                        f"{field}.maps[{i}].{coll_key} exceeds max items ({coll_max})",
                        400, field,
                    )
                for j, sub in enumerate(coll):
                    if not isinstance(sub, dict):
                        raise ApiError(
                            "VALIDATION_ERROR",
                            f"{field}.maps[{i}].{coll_key}[{j}] must be an object",
                            400, field,
                        )
    if len(json.dumps(value, ensure_ascii=False).encode("utf-8")) > _SEATMAP_MAX_JSON_BYTES:
        raise ApiError("VALIDATION_ERROR", f"{field} payload too large", 400, field)
    # 빈 dict 또는 maps 가 비었으면 배치도 없음 → NULL 수렴(read-after-write 정합).
    if not value or (maps is not None and len(maps) == 0):
        return None
    return value

# 집계 status·투영은 단일 출처(app/core/commerce_status.py, H1·M4)에서 import.
from app.core.commerce_status import (  # noqa: E402
    REVENUE_STATUSES as _REVENUE_STATUSES,
    SOLD_SEAT_STATUSES as _SOLD_SEAT_STATUSES,
    EVENT_STATUS_V2_TO_GO as _EVENT_STATUS_V2_TO_GO,
    GO_EVENT_STATUSES as _GO_EVENT_STATUSES,
    project_event_status as _project_event_status,
    event_go_to_v2_list as _go_status_to_v2_list,
    resolve_event_status_write as _resolve_event_status_write,
    evaluate_purchase_gate,
    evaluate_tier_sale_window,
)

# 읽기 응답 엣지 캐시(짧은 TTL) — read-projection 폐기, 지연은 HTTP/엣지 캐시로(SPEC §5.1).
_READ_CACHE_CONTROL = "private, max-age=5"


# ── 공통 유틸 ────────────────────────────────────────────────────────────


class ApiError(Exception):
    """봉투 에러 — 표준 코드 + HTTP 상태. 핸들러에서 catch 해 JSONResponse 로 변환."""

    def __init__(self, code: str, message: str, http: int = 400, field: str | None = None,
                 details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.http = http
        self.field = field
        # 기계가 읽을 부가 정보(가산). 사람이 읽는 message 와 분리한다 —
        # 호출자가 문구를 파싱하게 두면 문구를 못 고친다.
        self.details = details


def _ok(data: dict, replay: bool = False) -> dict:
    return {"ok": True, "data": data, "idempotent_replay": replay}


def _err(err: ApiError) -> JSONResponse:
    return JSONResponse(
        status_code=err.http,
        content={"ok": False, "error": {
            "code": err.code, "message": err.message, "field": err.field,
            **({"details": err.details} if err.details else {}),
        }},
    )


def _fingerprint(payload) -> str:
    """요청 본문 정규화 해시(8byte). 같은 Idempotency-Key+다른 body 의 stale 재생 차단."""
    try:
        raw = payload.model_dump_json() if hasattr(payload, "model_dump_json") else json.dumps(payload, sort_keys=True, default=str)
    except Exception:  # noqa: BLE001
        raw = str(payload)
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


def _refund_fingerprint(body: "InternalRefundRequest") -> str:
    """환불 멱등 지문 — **결과를 바꾸는 필드만** 담는다 (지시서 #8 T20).

    🔴 왜 body 전체 해시(_fingerprint)를 쓰면 안 되는가:
       멱등 캐시키는 `idem:{endpoint}:{key}:{fingerprint}` 다. go 의 두 환불 경로는
       **같은 멱등키**(`go-refund:{orderId}:{목표 누적환불액}`)를 쓰지만 body 의 `reason`
       이 다르다:
           refund/route.ts      reason = body.reason ?? "고객 요청 환불"
           orders/[orderId]     reason = body.reason (없을 수 있음)
       ⟹ fingerprint 가 갈려 **양쪽 다 실행**된다. 전액환불은 `remaining <= 0` 으로
          우연히 막히지만 **부분환불은 뚫린다** — 30,000 주문에 10,000 을 두 경로로 넣으면
          둘 다 `refund_amt <= remaining` 을 통과해 20,000 이 나간다.
          지금은 원장 오염이고, PG 취소가 배선되면 **실돈이 두 번** 나간다.

    멱등키가 이미 `(주문, 목표 누적환불액)` 으로 의도를 완전히 표현한다.
    같은 목표 누적액을 두 번 요청하는 것은 사유가 달라도 **정의상 같은 작업**이다.

    ⚠️ `allow_admitted` 는 **남긴다**. 입장객 포함 여부가 달라지면 실제로 다른 작업이라
       (차단 → 예외승인) 재실행되는 것이 맞다. `reason` 처럼 표시용 필드만 뺀다.
    ⚠️ 공용 `_idempotent` 계약은 건드리지 않는다 — 호출측에서 좁은 지문을 넘긴다.
    """
    return _fingerprint({
        "amount": body.amount,
        "full": body.full,
        "cancel_all": body.cancel_all,
        "allow_admitted": body.allow_admitted,
    })


def _order_context_fingerprint(body: "OrderCreateRequest") -> str:
    """주문 **문맥 지문**(구매자 + event_id + 정규화 items + total_amount) — external_ref 멱등 결속키.

    레벨2 재감사3차 P1: external_order_id(호출자 durable 토큰)가 장바구니/이벤트 문맥 변경 후
    재사용되면(상품·수량·이벤트·금액이 달라진 재시도) 옛 주문의 ticket_ids/금액이 재생돼
    **잘못된 event/티켓/금액 조합**이 반환됐다. 최초 주문에 이 지문을 저장하고, 재사용 시
    지문이 다르면 dedup 대신 409 로 차단한다.

    - 결정적·정규화: items 는 (tier_id or external_ref, quantity, unit_price, 정렬된 seat_ids,
      admission_day)만 뽑아 **정렬**(순서 무관 동치)한다. discount 는 v2 가 재계산하므로
      go 가 보낸 코드 식별자(code_id/code)만 포함(amount 는 제외 — SoT 재계산).
    - 구매자 신원은 회원 user_id 또는 정규화된 게스트 email 로 결속한다. 이름·전화번호 같은
      비식별 입력과 source·affiliate·idempotency_key 는 제외해 정당한 오타 수정은 흡수한다.
    """
    items = sorted(
        (
            str(it.tier_id) if it.tier_id is not None else f"ref:{it.external_ref}",
            int(it.quantity),
            f"{Decimal(str(it.unit_price)):.2f}",
            sorted(str(s) for s in it.seat_ids),
            it.admission_day.isoformat() if it.admission_day is not None else None,
        )
        for it in body.items
    )
    disc = None
    if body.discount and (body.discount.code_id or body.discount.code):
        disc = str(body.discount.code_id) if body.discount.code_id else f"code:{body.discount.code}"
    payload = {
        "buyer_identity": _order_buyer_identity(body),
        "event_id": str(body.event_id),
        "items": items,
        "total_amount": f"{Decimal(str(body.total_amount)):.2f}",
        "discount": disc,
    }
    raw = json.dumps(payload, sort_keys=True, default=str)
    return hashlib.sha256(raw.encode()).hexdigest()


async def _idempotent(idem_key: str | None, endpoint: str, producer, *, fingerprint=None):
    """Idempotency-Key 기반 멱등 실행. 성공 응답만 캐시(실패는 재시도 허용).

    - 동시성/중복 write 의 1차 방어는 DB 유니크 제약(external_ref/slug/seat position/
      discount code) + IntegrityError→409(_commit_or_conflict). 멱등 캐시는 정상 재시도
      최적화. Redis 회로 open 시 best-effort 강등(write 는 진행, authoring 저빈도).
    - fingerprint(body 해시)를 키에 포함 → 같은 키+다른 body 가 옛 응답을 재생하지 않음.
    """
    if not idem_key:
        raise ApiError("IDEMPOTENCY_KEY_REQUIRED", "Idempotency-Key header required", 400)
    fp = f":{fingerprint}" if fingerprint else ""
    cache_key = f"idem:{endpoint}:{idem_key}{fp}"
    cached = await cache_get_json(cache_key)
    if cached is not None:
        return _ok(cached, replay=True)
    data = await producer()
    await cache_set_json(cache_key, data, ttl=_IDEM_TTL)
    return _ok(data, replay=False)


class _Conflict(ApiError):
    def __init__(self, message: str):
        super().__init__("CONFLICT", message, 409)


async def _commit_or_conflict(db: AsyncSession, what: str) -> None:
    """commit 하되 **유니크 위반(23505)만** 409 로 변환. NOT NULL/FK/CHECK(23502/23503/
    23514) 등 진짜 무결성 버그는 re-raise(500)해 숨기지 않음(M6)."""
    from sqlalchemy.exc import IntegrityError
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        sqlstate = getattr(getattr(exc, "orig", None), "sqlstate", None) or getattr(
            getattr(exc, "orig", None), "pgcode", None
        )
        if sqlstate == "23505":  # unique_violation
            raise _Conflict(f"{what} conflicts with an existing record") from exc
        # SQLite 테스트(sqlstate 없음): UNIQUE 메시지 휴리스틱으로만 409, 그 외 re-raise.
        if sqlstate is None and "UNIQUE constraint failed" in str(getattr(exc, "orig", "")):
            raise _Conflict(f"{what} conflicts with an existing record") from exc
        raise


class OrganizerRef(BaseModel):
    go_account_id: str | None = None
    organizer_id: uuid.UUID | None = None


async def _resolve_organizer(db: AsyncSession, ref: OrganizerRef) -> uuid.UUID:
    """organizer_ref → v2 user_id. go-system fallback 폐기(매핑 붕괴 차단)."""
    if ref.organizer_id is not None:
        uid = (
            await db.execute(
                select(User.id).where(
                    User.id == ref.organizer_id, User.is_organizer.is_(True)
                )
            )
        ).scalar_one_or_none()
        if uid is not None:
            return uid
        # #4 폴백: go 가 account_id(UUID)를 organizer_id 로 넘긴 경우 → go_account_id 로 재해석.
        uid = (
            await db.execute(
                select(OrganizerProfile.user_id).where(
                    OrganizerProfile.go_account_id == str(ref.organizer_id)
                )
            )
        ).scalar_one_or_none()
        if uid is None:
            raise ApiError(
                "ORGANIZER_REF_UNRESOLVED",
                f"organizer_id not found or not an organizer: {ref.organizer_id}",
                404, "organizer_ref",
            )
        return uid
    if ref.go_account_id:
        uid = (
            await db.execute(
                select(OrganizerProfile.user_id).where(
                    OrganizerProfile.go_account_id == ref.go_account_id
                )
            )
        ).scalar_one_or_none()
        if uid is None:
            raise ApiError(
                "ORGANIZER_REF_UNRESOLVED",
                f"go_account_id not mapped to a v2 organizer: {ref.go_account_id}",
                404, "organizer_ref",
            )
        return uid
    raise ApiError(
        "VALIDATION_ERROR",
        "organizer_ref requires go_account_id or organizer_id",
        400, "organizer_ref",
    )


def _slugify(title: str, suffix: str) -> str:
    base = re.sub(r"[^0-9a-z가-힣]+", "-", (title or "").lower()).strip("-")[:60]
    return f"{base or 'event'}-{suffix}"


def _parse_dt(value: str, field: str) -> datetime:
    try:
        return _parse_iso(value)
    except Exception as exc:  # noqa: BLE001
        raise ApiError("VALIDATION_ERROR", f"invalid datetime: {value}", 400, field) from exc


# ── 스키마 ───────────────────────────────────────────────────────────────


class SaleWindow(BaseModel):
    opens_at: str
    closes_at: str


class EventCreateRequest(BaseModel):
    organizer_ref: OrganizerRef
    external_ref: str | None = None
    title: str = Field(..., min_length=1, max_length=300)
    description: str | None = None
    venue: str | None = None
    # ── 상세페이지 통합 트랙B U1 핵심 상세 필드(전부 optional·가산) ──
    venue_address: str | None = None                 # go venue_address — 공연장 주소
    venue_lat: float | None = None                   # 지도 API 연동 — 「장소 찾기」로 고른 위도
    venue_lng: float | None = None                   # 경도. 둘 다 있거나 둘 다 없음(_venue_coords)
    age_rating: str | None = None                    # go age_rating — 연령 등급(all/12+/15+/18+ 등)
    is_online: bool | None = None                    # go is_online — 온라인 이벤트 여부
    homepage_url: str | None = None                  # go homepage_url — 공식 홈페이지
    category: str
    event_date: str
    sale_window: SaleWindow
    sale_channels: list[str] | None = None
    status: str | None = None
    sales_paused: bool | None = None
    total_seats: int | None = None
    slug: str | None = None
    image_url: str | None = None
    image_variants: dict | None = None
    gallery_images: list | None = None
    cancellation_fee_tiers: list | None = None  # [{days_before, fee_pct}] — go 취소/환불정책
    # F1 입장방식(single|daypass|allpass) — go 편집 UI write-through. 미전송 시 모델 default(single).
    admission_mode: str | None = None
    # F1 다일 종료일(allpass/daypass 창) — go ends_at → v2 event_date_end. ISO8601.
    event_date_end: str | None = None
    # F4 경품/추첨 활성 — go 편집 UI write-through. 미전송 시 모델 default(false).
    raffle_enabled: bool | None = None
    # 좌석 판매 방식(assigned|unassigned) — go 편집 UI write-through. 미전송 시 모델 default(assigned).
    seat_type: str | None = None
    # C1 카드전용 게이팅 — 허용 결제수단 화이트리스트. 미전송(None)=전체 허용(현행).
    # 값은 대문자 정규화(CARD/BANK/VBANK/CELLPHONE/EASYPAY/CARDANDEASYPAY). 서버가
    # normalize_allowed_pay_methods 로 정규화(오염값 제거·빈값→NULL) 후 저장.
    allowed_pay_methods: list[str] | None = None
    # ── Phase 1-S/1-O 상세페이지 갭 필드(전부 optional·가산) ──
    summary: str | None = None                       # go summary — 한 줄 요약
    event_schedules: list | None = None              # go schedules — [{time, title, description}]
    seo_metadata: dict | None = None                 # go seoMetadata — {title, description, keywords, og_image}
    questions: list | None = None                    # go questions — [{label, type, required, options}]
    transport_info: str | None = None                # go transportInfo — 오시는 길
    program_notes: str | None = None                 # go programNotes — 프로그램 자유문구
    stage_info: str | None = None                    # go stageInfo — 무대/좌석 안내 자유문구
    parking_info: str | None = None                  # go parkingInfo — 주차 안내(기존 컬럼 재사용)
    runtime_minutes: int | None = None               # go runtimeMinutes — 공연 러닝타임(분)
    intermission_minutes: int | None = None          # go intermissionMinutes — 인터미션(분)
    # Phase 1-Map — 좌석 배치도 원본 canvas(go seat_maps.map_data + background/floor/landmarks 병합).
    seat_map_data: dict | None = None
    # ── 트랙B U3 공개 랜딩 부속기능 게이트(주최자 opt-in write-through, 전부 optional·가산) ──
    rsvp_enabled: bool | None = None                 # 무료 참석(RSVP) 수신 허용
    group_booking_enabled: bool | None = None        # 단체 예약 문의 수신 허용
    context_banner: str | None = None                # 주최자 수동 상단 배너 문구
    # ── 레벨2 컷오버 T2-EVT: go events 전용 컬럼(마이그 ctevt_0727). 전부 optional·가산 ──
    event_type: str | None = None                    # 🔴 go EventType 원본(category 는 손실 파생)
    # 🔴 주최자 기능 토글 정본. 타입을 list[str] 로 좁히면 pydantic 이 **봉투 밖 422** 를 던져
    # go commerce-client 의 에러 파싱({ok:false,error:{code,message,field}})이 깨진다.
    # 느슨하게 받고 _validate_enabled_features 가 fail-closed 로 400 봉투를 만든다.
    enabled_features: list | None = None
    homepage_design: dict | None = None
    landing_config: dict | None = None
    custom_domain: str | None = None
    domain_metadata: dict | None = None
    queue_enabled: bool | None = None
    queue_config: dict | None = None
    rsvp_config: dict | None = None
    comp_capacity_cap: int | None = None
    timezone: str | None = None                      # go events.timezone → v2 event_timezone


class EventPatchRequest(BaseModel):
    title: str | None = None
    description: str | None = None
    venue: str | None = None
    # ── 상세페이지 통합 트랙B U1 핵심 상세 필드(전부 optional·가산). PATCH 는 model_fields_set 로
    #    "미포함(보존)" vs "명시 null/빈값(삭제)"을 구분한다. ──
    venue_address: str | None = None                 # go venue_address — 공연장 주소
    venue_lat: float | None = None                   # 지도 API 연동 — 「장소 찾기」로 고른 위도
    venue_lng: float | None = None                   # 경도. 둘 다 있거나 둘 다 없음(_venue_coords)
    age_rating: str | None = None                    # go age_rating — 연령 등급
    is_online: bool | None = None                    # go is_online — 온라인 이벤트 여부
    homepage_url: str | None = None                  # go homepage_url — 공식 홈페이지
    category: str | None = None
    event_date: str | None = None
    sale_window: SaleWindow | None = None
    sale_channels: list[str] | None = None
    status: str | None = None
    sales_paused: bool | None = None
    total_seats: int | None = None
    image_url: str | None = None
    image_variants: dict | None = None
    gallery_images: list | None = None
    cancellation_fee_tiers: list | None = None  # [{days_before, fee_pct}] — go 취소/환불정책
    # F1 입장방식(single|daypass|allpass) — go 편집 UI write-through.
    admission_mode: str | None = None
    # F1 다일 종료일(allpass/daypass 창) — go ends_at → v2 event_date_end. ISO8601.
    event_date_end: str | None = None
    # F4 경품/추첨 활성 — go 편집 UI write-through.
    raffle_enabled: bool | None = None
    # 좌석 판매 방식(assigned|unassigned). PATCH 는 model_fields_set 로 미포함=보존.
    seat_type: str | None = None
    # C1 카드전용 게이팅 — 허용 결제수단 화이트리스트. PATCH 는 model_fields_set 로
    # "미포함(보존)" vs "명시 값(반영, null=전체허용으로 리셋)"을 구분한다.
    allowed_pay_methods: list[str] | None = None
    # ── Phase 1-S/1-O 상세페이지 갭 필드(전부 optional·가산). PATCH 는 model_fields_set 로
    #    "필드 부재"(미포함=보존) vs "명시 null/빈값"(삭제) 을 구분한다. ──
    summary: str | None = None
    event_schedules: list | None = None
    seo_metadata: dict | None = None
    questions: list | None = None
    transport_info: str | None = None
    program_notes: str | None = None
    stage_info: str | None = None
    parking_info: str | None = None
    runtime_minutes: int | None = None
    intermission_minutes: int | None = None
    # Phase 1-Map — 좌석 배치도 원본 canvas. PATCH 는 model_fields_set 로 미포함=보존/명시null=삭제.
    seat_map_data: dict | None = None
    # ── 트랙B U3 공개 랜딩 부속기능 게이트(주최자 opt-in write-through). PATCH 는 model_fields_set 로
    #    "미포함(보존)" vs "명시 값(반영)"을 구분한다. ──
    rsvp_enabled: bool | None = None
    group_booking_enabled: bool | None = None
    context_banner: str | None = None
    # ── 레벨2 컷오버 T2-EVT: go events 전용 컬럼(마이그 ctevt_0727) ──
    # PATCH 는 model_fields_set 로 "미포함(보존)" vs "명시 값/null(반영·삭제)"을 구분한다.
    event_type: str | None = None
    # 느슨한 list — 검증·거부는 _validate_enabled_features(400 봉투). 위 create 주석 참조.
    enabled_features: list | None = None
    homepage_design: dict | None = None
    landing_config: dict | None = None
    custom_domain: str | None = None
    domain_metadata: dict | None = None
    queue_enabled: bool | None = None
    queue_config: dict | None = None
    rsvp_config: dict | None = None
    comp_capacity_cap: int | None = None
    timezone: str | None = None
    # 주최자가 slug 를 바꾸는 경로(go 는 UNIQUE(account_id, slug), v2 는 전역 UNIQUE).
    # 충돌 시 _commit_or_conflict 가 409 로 응답한다.
    slug: str | None = None


class FeePlanRequest(BaseModel):
    fee_type: str = "percentage_plus_fixed"
    platform_fee_rate: float = 0.0
    platform_fee_fixed: float = 0.0
    pg_fee_rate: float = 0.025
    pg_fee_fixed: float = 0.0


class OrganizerFeePlanRequest(FeePlanRequest):
    organizer_ref: OrganizerRef


# ── 레벨2 컷오버 T2-EVT: go 전용 이벤트 컬럼 write 헬퍼 ───────────────────────
# go events 에만 있던 컬럼(ctevt_0727)을 create/patch 양쪽에서 동일 규칙으로 적용한다.
# 값 정규화·상한 검증을 한 곳에 모아 두 경로가 갈라지지 않게 한다.

_GO_EVT_MAX_FEATURES = 100      # enabled_features 원소 상한
_GO_EVT_MAX_FEATURE_LEN = 60    # 개별 feature 키 길이 상한
_CUSTOM_DOMAIN_RE = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")


def _venue_coords(lat, lng) -> tuple[float | None, float | None]:
    """장소 좌표 — 둘 다 있거나 둘 다 없어야 하고 범위 안이어야 한다(400 봉투).

    한쪽만 저장되면 지도가 엉뚱한 곳(위도 0 등)을 찍는다. DB CHECK(venuecoords_1120)와 같은 규칙.
    """
    if lat is None and lng is None:
        return None, None
    if lat is None or lng is None:
        raise ApiError("VALIDATION_ERROR", "venue_lat and venue_lng must be sent together", 400, "venue_lat")
    if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
        raise ApiError("VALIDATION_ERROR", "venue coordinates out of range", 400, "venue_lat")
    return float(lat), float(lng)


def _validate_enabled_features(value) -> list[str]:
    """enabled_features — list[str] 정규화. None/비리스트 → [] (fail-closed).

    🔴 이 값이 주최자 콘솔 기능 게이트의 정본이다. 오염된 값을 관대하게 통과시키면
    꺼져 있어야 할 유료 기능이 열린다. 문자열 아닌 원소는 **버리지 않고 거부**한다.
    """
    if value is None:
        return []
    if not isinstance(value, list):
        raise ApiError("VALIDATION_ERROR", "enabled_features must be a list", 400, "enabled_features")
    if len(value) > _GO_EVT_MAX_FEATURES:
        raise ApiError(
            "VALIDATION_ERROR",
            f"enabled_features exceeds {_GO_EVT_MAX_FEATURES} items",
            400, "enabled_features",
        )
    out: list[str] = []
    for item in value:
        if not isinstance(item, str) or not item.strip():
            raise ApiError(
                "VALIDATION_ERROR", "enabled_features items must be non-empty strings", 400, "enabled_features",
            )
        key = item.strip()
        if len(key) > _GO_EVT_MAX_FEATURE_LEN:
            raise ApiError(
                "VALIDATION_ERROR",
                f"enabled_features item too long: {key[:20]}...",
                400, "enabled_features",
            )
        if key not in out:  # 중복 제거(게이트는 집합 의미)
            out.append(key)
    return out


def _validate_custom_domain(value: str | None) -> str | None:
    """custom_domain — 소문자 정규화 + 호스트명 형태 검증. 빈값 → None(도메인 해제)."""
    if value is None:
        return None
    host = value.strip().lower().rstrip(".")
    if not host:
        return None
    if len(host) > 253 or not _CUSTOM_DOMAIN_RE.match(host):
        raise ApiError("VALIDATION_ERROR", f"invalid custom_domain: {value}", 400, "custom_domain")
    return host


def _apply_go_event_columns(event: Event, body, *, partial: bool) -> None:
    """ctevt_0727 컬럼을 event 인스턴스에 반영.

    partial=True(PATCH)  — model_fields_set 에 포함된 키만 반영(미포함=보존).
    partial=False(CREATE) — None 이 아닌 값만 반영(미전송=모델/DB default).
    """
    given = body.model_fields_set if partial else None

    def _has(name: str) -> bool:
        if partial:
            return name in given
        return getattr(body, name, None) is not None

    if _has("event_type"):
        et = (body.event_type or "").strip() or None
        if et is not None and len(et) > 50:
            raise ApiError("VALIDATION_ERROR", f"event_type too long: {et[:20]}...", 400, "event_type")
        event.event_type = et
    if _has("enabled_features"):
        event.enabled_features = _validate_enabled_features(body.enabled_features)
    if _has("homepage_design"):
        event.homepage_design = _validate_gap_dict(body.homepage_design, field="homepage_design")
    if _has("landing_config"):
        event.landing_config = _validate_gap_dict(body.landing_config, field="landing_config")
    if _has("custom_domain"):
        event.custom_domain = _validate_custom_domain(body.custom_domain)
    if _has("domain_metadata"):
        event.domain_metadata = _validate_gap_dict(body.domain_metadata, field="domain_metadata")
    if _has("queue_enabled") and body.queue_enabled is not None:
        event.queue_enabled = body.queue_enabled
    if _has("queue_config"):
        event.queue_config = _validate_gap_dict(body.queue_config, field="queue_config")
    if _has("rsvp_config"):
        event.rsvp_config = _validate_gap_dict(body.rsvp_config, field="rsvp_config")
    if _has("comp_capacity_cap"):
        cap = body.comp_capacity_cap
        if cap is not None and cap < 0:
            raise ApiError("VALIDATION_ERROR", "comp_capacity_cap must be >= 0", 400, "comp_capacity_cap")
        event.comp_capacity_cap = cap
    if _has("timezone"):
        tz = (body.timezone or "").strip()
        if tz:
            if len(tz) > 50:
                raise ApiError("VALIDATION_ERROR", f"invalid timezone: {tz[:20]}...", 400, "timezone")
            event.event_timezone = tz


# ── 이벤트 write (SPEC §2.1 / §2.2) ──────────────────────────────────────


async def _do_create_event(db: AsyncSession, body: EventCreateRequest) -> dict:
    if body.category not in _VALID_CATEGORIES:
        raise ApiError("VALIDATION_ERROR", f"invalid category: {body.category}", 400, "category")

    organizer_id = await _resolve_organizer(db, body.organizer_ref)

    opens_at = _parse_dt(body.sale_window.opens_at, "sale_window.opens_at")
    closes_at = _parse_dt(body.sale_window.closes_at, "sale_window.closes_at")
    if closes_at <= opens_at:
        raise ApiError("VALIDATION_ERROR", "sale_window.closes_at must be after opens_at", 400, "sale_window")
    event_date = _parse_dt(body.event_date, "event_date")

    # go status(4-상태) 또는 v2 status 수용 → v2 status + sales_paused 역매핑(go 발행 P0).
    if body.status:
        try:
            resolved, paused_flag = _resolve_event_status_write(body.status)
        except ValueError:
            raise ApiError("VALIDATION_ERROR", f"invalid status: {body.status}", 400, "status")
    else:
        resolved, paused_flag = EventStatus.DRAFT.value, False
    # paused-on-create → live-투영 status(bidding_open) + 플래그(읽기서 "paused" 라운드트립).
    status_val = resolved or EventStatus.BIDDING_OPEN.value
    if body.sales_paused is not None:
        sales_paused = body.sales_paused
    elif paused_flag is not None:
        sales_paused = paused_flag
    else:
        sales_paused = False

    # 이벤트 정체성 단일화 — GO_V2_COMMERCE_SYNC_AUDIT (B):
    # go event id(=external_ref)를 v2 canonical id 로 사용해, 심사요청 경로
    # (receive_review_request, id=go_id)와 커머스 write-through 가 **항상 동일 v2 이벤트**로
    # 수렴하게 한다(go 이벤트 1개당 v2 이벤트 2개 생기던 이원화 방지).
    canonical_id: uuid.UUID | None = None
    if body.external_ref:
        try:
            canonical_id = uuid.UUID(str(body.external_ref))
        except (ValueError, TypeError):
            canonical_id = None

        # external_ref 로 조회 → 없으면 id(=go_id)로도 조회(심사요청이 먼저 만든 이벤트 재사용).
        existing = (
            await db.execute(select(Event).where(Event.external_ref == body.external_ref))
        ).scalar_one_or_none()
        if existing is None and canonical_id is not None:
            existing = await db.get(Event, canonical_id)
        if existing is not None:
            # 심사요청 경로가 external_ref 없이 만들었으면 보정(이후 멱등 매칭 보장).
            if not existing.external_ref:
                existing.external_ref = body.external_ref
                await db.commit()
            return {
                "event_id": str(existing.id),
                "external_ref": existing.external_ref,
                "slug": existing.slug,
                "status": _project_event_status(existing.status, existing.sales_paused),
                "status_v2": existing.status.value if hasattr(existing.status, "value") else existing.status,
                "sales_paused": existing.sales_paused,
                "created": False,
            }

    # canonical(go_id) 우선, 아니면 랜덤 uuid.
    event_id = canonical_id or uuid.uuid4()
    slug = body.slug or _slugify(body.title, event_id.hex[:8])
    total_seats = body.total_seats if (body.total_seats and body.total_seats > 0) else 1

    # F1 입장방식 검증(화이트리스트). 미전송 시 모델 default(single).
    admission_mode = body.admission_mode
    if admission_mode is not None and admission_mode not in _VALID_ADMISSION_MODES:
        raise ApiError("VALIDATION_ERROR", f"invalid admission_mode: {admission_mode}", 400, "admission_mode")
    # 좌석 판매 방식 검증(화이트리스트). 미전송 시 모델 default(assigned).
    seat_type = body.seat_type
    if seat_type is not None and seat_type not in _VALID_SEAT_TYPES:
        raise ApiError("VALIDATION_ERROR", f"invalid seat_type: {seat_type}", 400, "seat_type")
    # F1 다일 종료일(allpass/daypass 창). event_date_end < event_date 는 거부.
    event_date_end = _parse_dt(body.event_date_end, "event_date_end") if body.event_date_end else None
    if event_date_end is not None and event_date_end < event_date:
        raise ApiError("VALIDATION_ERROR", "event_date_end must be on/after event_date", 400, "event_date_end")

    # ── Phase 1-S/1-O 상세페이지 갭 필드(전부 optional·가산). 경량 검증 후 세팅. ──
    gap_schedules = _validate_gap_list(body.event_schedules, field="event_schedules", max_items=_GAP_MAX_SCHEDULES)
    gap_questions = _validate_gap_list(body.questions, field="questions", max_items=_GAP_MAX_QUESTIONS)
    gap_seo = _validate_gap_dict(body.seo_metadata, field="seo_metadata")
    gap_kwargs: dict = {}
    if body.summary is not None:
        gap_kwargs["summary"] = body.summary
    if gap_schedules is not None:
        gap_kwargs["event_schedules"] = gap_schedules
    if gap_seo is not None:
        gap_kwargs["seo_metadata"] = gap_seo
    if gap_questions is not None:
        gap_kwargs["questions"] = gap_questions
    if body.transport_info is not None:
        gap_kwargs["transport_info"] = body.transport_info
    if body.program_notes is not None:
        gap_kwargs["program_notes"] = body.program_notes
    if body.stage_info is not None:
        gap_kwargs["stage_info"] = body.stage_info
    if body.parking_info is not None:
        gap_kwargs["parking_info"] = body.parking_info
    if body.runtime_minutes is not None:
        gap_kwargs["runtime_minutes"] = body.runtime_minutes
    if body.intermission_minutes is not None:
        gap_kwargs["intermission_minutes"] = body.intermission_minutes
    # Phase 1-Map — 좌석 배치도 원본(있으면 검증 후 세팅, 없으면 미포함=NULL).
    gap_seat_map = _validate_seat_map_data(body.seat_map_data)
    if gap_seat_map is not None:
        gap_kwargs["seat_map_data"] = gap_seat_map

    _coords = _venue_coords(body.venue_lat, body.venue_lng)
    event = Event(
        id=event_id,
        organizer_id=organizer_id,
        external_ref=body.external_ref,
        title=body.title,
        slug=slug,
        description=body.description,
        venue=body.venue or "장소 미정",
        # 트랙B U1 핵심 상세 필드 — 전송된 것만 세팅(is_online 미전송 시 모델/DB default false).
        venue_address=body.venue_address,
        venue_lat=_coords[0],
        venue_lng=_coords[1],
        age_rating=body.age_rating,
        homepage_url=body.homepage_url,
        **({"is_online": body.is_online} if body.is_online is not None else {}),
        event_date=event_date,
        event_date_end=event_date_end,
        bidding_opens_at=opens_at,   # 판매창 = go 입력 정본(추정 안 함)
        bidding_closes_at=closes_at,
        total_seats=total_seats,
        category=body.category,
        image_url=body.image_url,
        image_variants=body.image_variants,
        gallery_images=body.gallery_images,
        cancellation_fee_tiers=body.cancellation_fee_tiers or None,
        status=EventStatus(status_val),
        sales_paused=sales_paused,
        sale_channels=body.sale_channels if body.sale_channels else ["self"],
        **({"admission_mode": admission_mode} if admission_mode is not None else {}),
        **({"raffle_enabled": body.raffle_enabled} if body.raffle_enabled is not None else {}),
        **({"seat_type": seat_type} if seat_type is not None else {}),
        # C1 카드전용 게이팅 — 전송 시 정규화(오염값 제거·빈값→NULL) 후 세팅. 미전송=NULL(전체 허용).
        **(
            {"allowed_pay_methods": normalize_allowed_pay_methods(body.allowed_pay_methods)}
            if body.allowed_pay_methods is not None
            else {}
        ),
        # 트랙B U3 공개 랜딩 부속기능 게이트 — 전송된 것만 세팅(미전송 시 모델/DB default false·NULL).
        **({"rsvp_enabled": body.rsvp_enabled} if body.rsvp_enabled is not None else {}),
        **(
            {"group_booking_enabled": body.group_booking_enabled}
            if body.group_booking_enabled is not None
            else {}
        ),
        **({"context_banner": body.context_banner} if body.context_banner is not None else {}),
        **gap_kwargs,
    )
    # 레벨2 T2-EVT — go 전용 컬럼(event_type/enabled_features/랜딩/도메인/큐/RSVP/초대권 캡).
    # create 는 "전송된 것만" 반영(미전송 = 모델 default). 검증 실패는 ApiError 로 400.
    _apply_go_event_columns(event, body, partial=False)
    db.add(event)
    await _commit_or_conflict(db, "event (slug/external_ref)")

    logger.info(
        "internal/events create: event_id=%s external_ref=%s organizer=%s status=%s",
        event_id, body.external_ref, organizer_id, status_val,
    )
    return {
        "event_id": str(event_id),
        "external_ref": body.external_ref,
        "slug": slug,
        "status": _project_event_status(status_val, sales_paused),  # go 4-상태(read 와 일관)
        "status_v2": status_val,
        "sales_paused": sales_paused,
        "created": True,
    }


async def _do_patch_event(db: AsyncSession, event_id: uuid.UUID, body: EventPatchRequest) -> dict:
    event = await db.get(Event, event_id)
    if event is None:
        raise ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404)

    if body.category is not None:
        if body.category not in _VALID_CATEGORIES:
            raise ApiError("VALIDATION_ERROR", f"invalid category: {body.category}", 400, "category")
        event.category = body.category
    if body.status is not None:
        # go status(4-상태) 또는 v2 status 수용 → 역매핑(go 발행/일시중지 P0).
        try:
            resolved, paused_flag = _resolve_event_status_write(body.status)
        except ValueError:
            raise ApiError("VALIDATION_ERROR", f"invalid status: {body.status}", 400, "status")
        if resolved is not None:  # paused 는 status 유지(None)
            event.status = EventStatus(resolved)
        # status 가 함의한 paused 플래그(예: "paused"→True, "live"→False) — 명시 필드 없을 때만.
        if paused_flag is not None and body.sales_paused is None:
            event.sales_paused = paused_flag
    if body.sales_paused is not None:  # 명시 필드 우선
        event.sales_paused = body.sales_paused
    if body.title is not None:
        event.title = body.title
    # ── 구 필드군 부분 PATCH (2026-08-01 수정) ──
    # 🔴 종전에는 `if body.X is not None:` 이라 **"안 보냄"과 "null 로 보냄"을 구분하지
    #    못했다.** 값 변경은 되는데 **삭제만 안 됐다** — 주최자가 설명을 지우고 저장하면
    #    200 과 성공 토스트를 받지만 다시 열면 옛 설명이 그대로였다(실제 신고).
    #    go 는 빈칸을 null 로 바꿔 보낸다(`[eventId]/route.ts:245`·`settings/route.ts:121`
    #    둘 다 `|| null`)이라 이 경로로 정확히 도달한다.
    #
    #    바로 아래 `_u1_fields` 블록은 이미 올바른 방식이었다 — 같은 함수 안에서 두 방식이
    #    섞여 있었고, 구 필드군만 잔재로 남아 있었다.
    _core_fields = body.model_fields_set
    if "description" in _core_fields:
        # events.description 은 nullable — 빈값은 NULL 로 지운다.
        event.description = body.description or None
    if "venue" in _core_fields:
        # 🔴 events.venue 는 **NOT NULL** 이다(models/event.py:88). None 을 대입하면
        #    IntegrityError 로 500 이 난다. 그리고 빈 문자열도 쓰면 안 된다 —
        #    소비처 상당수가 **nullish 폴백**(`??`)이라 `""` 를 걸러내지 못한다:
        #      · 알림톡 본문   `transactional.ts:91`  `p.venueName ?? "-"`
        #      · 공개 랜딩     `e/[eventSlug]/page.tsx`  `?? "장소 미정"`
        #      · 지도 카드     `venue-map.tsx`          `?? "행사 장소"`
        #    ⟹ `""` 를 저장하면 실고객 알림톡에 "장소: " 공란이 발송된다.
        #    (일부 화면은 `||` 라 빈값을 걸러낸다 — 전부는 아니지만 발송 경로가 걸린다.)
        #    ⟹ 생성 경로(:824 `venue=body.venue or "장소 미정"`)와 **같은 sentinel** 을 쓴다.
        #       "장소 없음"의 표현을 하나로 유지해야 화면·발송이 일관된다.
        event.venue = body.venue or "장소 미정"
    # ── 트랙B U1 핵심 상세 필드 부분 PATCH ──
    # model_fields_set 로 "미포함(보존)" vs "명시 null/빈값(삭제)"을 구분(read-after-write 정합).
    _u1_fields = body.model_fields_set
    if "venue_address" in _u1_fields:
        _prev_address = event.venue_address
        event.venue_address = body.venue_address or None
        # 주소만 바뀌고 좌표가 안 왔으면 옛 좌표는 다른 곳을 가리킨다 → 지운다(지도는 숨김).
        if (
            event.venue_address != _prev_address
            and "venue_lat" not in _u1_fields
            and "venue_lng" not in _u1_fields
        ):
            event.venue_lat = None
            event.venue_lng = None
    if "venue_lat" in _u1_fields or "venue_lng" in _u1_fields:
        event.venue_lat, event.venue_lng = _venue_coords(body.venue_lat, body.venue_lng)
    if "age_rating" in _u1_fields:
        event.age_rating = body.age_rating or None
    if "homepage_url" in _u1_fields:
        event.homepage_url = body.homepage_url or None
    if "is_online" in _u1_fields and body.is_online is not None:
        event.is_online = body.is_online
    if body.event_date is not None:
        new_event_date = _parse_dt(body.event_date, "event_date")
        # 판매 개시 후 일정 '변경' 차단 — 기판매 티켓의 관람 조건 사후 변경 방지.
        # 동일 값 재전송(go resync 멱등 재푸시)은 통과시켜야 하므로 값 변경시에만 검사.
        if new_event_date != event.event_date and event.status in (
            EventStatus.BIDDING_OPEN,
            EventStatus.BIDDING_CLOSED,
            EventStatus.ALLOCATING,
            EventStatus.ALLOCATED,
        ):
            raise ApiError(
                "EVENT_NOT_MODIFIABLE",
                "cannot change event_date after sales started",
                409,
                "event_date",
            )
        event.event_date = new_event_date
    if body.sale_window is not None:
        opens_at = _parse_dt(body.sale_window.opens_at, "sale_window.opens_at")
        closes_at = _parse_dt(body.sale_window.closes_at, "sale_window.closes_at")
        if closes_at <= opens_at:
            raise ApiError("VALIDATION_ERROR", "sale_window.closes_at must be after opens_at", 400, "sale_window")
        event.bidding_opens_at = opens_at
        event.bidding_closes_at = closes_at
    if body.sale_channels is not None:
        event.sale_channels = body.sale_channels
    if body.total_seats is not None:
        if body.total_seats <= 0:
            raise ApiError("VALIDATION_ERROR", "total_seats must be > 0", 400, "total_seats")
        # SPEC §2.2 — 이미 판매/홀드된 좌석보다 작은 capacity 축소 금지(409).
        sold = (
            await db.execute(
                select(func.count()).select_from(Seat).where(
                    Seat.event_id == event_id,
                    Seat.status.in_([SeatStatus.SOLD, SeatStatus.HELD]),
                )
            )
        ).scalar() or 0
        if body.total_seats < sold:
            raise _Conflict(f"cannot shrink total_seats below sold/held ({sold})")
        event.total_seats = body.total_seats
    # 이미지 필드는 "필드 부재"(부분 PATCH 미포함)와 "명시적 null/빈값"(삭제 의도)을 구분해야 한다.
    # is not None 가드는 go 가 히어로 삭제로 보낸 image_url=null 을 버려 v2 에 옛 이미지가 남던
    # 버그의 원인(go 측 삭제 전파는 정상). model_fields_set 로 요청에 실제 포함된 키만 반영한다.
    _fields = body.model_fields_set
    if "image_url" in _fields:
        event.image_url = body.image_url
    if "image_variants" in _fields:
        event.image_variants = body.image_variants or {}
    if "gallery_images" in _fields:
        event.gallery_images = body.gallery_images or []
    if "cancellation_fee_tiers" in _fields:
        # 빈 리스트/None = 정책 없음 → None(소비자·스키마 검증기가 non-empty 요구).
        event.cancellation_fee_tiers = body.cancellation_fee_tiers or None
    # F1 입장방식 변경 — 판매 개시 후 '변경' 차단(기판매 티켓의 입장 조건 사후변경 방지).
    #   동일값 재푸시(go resync 멱등)는 통과. daypass↔single 등 실변경만 검사.
    if "admission_mode" in _fields and body.admission_mode is not None:
        if body.admission_mode not in _VALID_ADMISSION_MODES:
            raise ApiError("VALIDATION_ERROR", f"invalid admission_mode: {body.admission_mode}", 400, "admission_mode")
        if body.admission_mode != (getattr(event, "admission_mode", None) or "single") and event.status in (
            EventStatus.BIDDING_OPEN,
            EventStatus.BIDDING_CLOSED,
            EventStatus.ALLOCATING,
            EventStatus.ALLOCATED,
        ):
            raise ApiError(
                "EVENT_NOT_MODIFIABLE",
                "cannot change admission_mode after sales started",
                409,
                "admission_mode",
            )
        event.admission_mode = body.admission_mode
    # F4 경품 활성 — 발권 전이면 자유 전환(발권 시 raffle_number 부여 여부 결정). 값만 반영.
    if "raffle_enabled" in _fields and body.raffle_enabled is not None:
        event.raffle_enabled = body.raffle_enabled
    # 좌석 판매 방식 전환 — assigned→unassigned 는 **좌석이 배정된 티켓이 있으면** 막는다.
    #   🔴 판매 개시 여부로 막지 않는 이유: 좌석을 쓰지 않는 행사(갤러리 입장권·페스티벌)는
    #   판매 중에도 전환이 필요하고, 실제 위험은 "이미 배정된 좌석이 의미를 잃는 것" 이다.
    #   판매 개시로 막으면 정작 전환이 필요한 행사가 영영 못 바꾸고, 정작 위험한 케이스
    #   (판매 전에 좌석배정 티켓이 존재)는 걸러지지 않는다.
    #   반대 방향(unassigned→assigned)은 배치도를 새로 그리면 되므로 항상 허용.
    if "seat_type" in _fields and body.seat_type is not None:
        if body.seat_type not in _VALID_SEAT_TYPES:
            raise ApiError("VALIDATION_ERROR", f"invalid seat_type: {body.seat_type}", 400, "seat_type")
        current_seat_type = getattr(event, "seat_type", None) or "assigned"
        if body.seat_type == "unassigned" and current_seat_type == "assigned":
            seated = (
                await db.execute(
                    select(Ticket.id)
                    .where(
                        Ticket.event_id == event.id,
                        Ticket.seat_id.is_not(None),
                        Ticket.status.notin_([TicketStatus.CANCELLED, TicketStatus.EXPIRED]),
                    )
                    .limit(1)
                )
            ).scalar_one_or_none()
            if seated is not None:
                raise ApiError(
                    "EVENT_NOT_MODIFIABLE",
                    "cannot switch to unassigned — issued tickets already have assigned seats",
                    409,
                    "seat_type",
                )
        event.seat_type = body.seat_type
    # C1 카드전용 게이팅 — model_fields_set 로 미포함=보존, 명시 시 정규화 반영
    # (명시 null/빈값 → NULL=전체 허용으로 리셋). 이미 결제된 주문은 동결값이라 무영향.
    if "allowed_pay_methods" in _fields:
        event.allowed_pay_methods = normalize_allowed_pay_methods(body.allowed_pay_methods)
    # 트랙B U3 공개 랜딩 부속기능 게이트 — model_fields_set 로 미포함=보존/명시=반영.
    if "rsvp_enabled" in _fields and body.rsvp_enabled is not None:
        event.rsvp_enabled = body.rsvp_enabled
    if "group_booking_enabled" in _fields and body.group_booking_enabled is not None:
        event.group_booking_enabled = body.group_booking_enabled
    if "context_banner" in _fields:
        # 빈 문자열 → NULL(배너 해제). 미포함이면 이 블록 자체 미진입(보존).
        event.context_banner = body.context_banner or None
    # F1 다일 종료일(allpass/daypass 창) — go ends_at → event_date_end. null=단일일 복귀.
    if "event_date_end" in _fields:
        if body.event_date_end:
            new_end = _parse_dt(body.event_date_end, "event_date_end")
            if new_end < event.event_date:
                raise ApiError("VALIDATION_ERROR", "event_date_end must be on/after event_date", 400, "event_date_end")
            event.event_date_end = new_end
        else:
            event.event_date_end = None

    # ── Phase 1-S/1-O 상세페이지 갭 필드 부분 PATCH ──
    # model_fields_set 로 "미포함(보존)" vs "명시 null/빈값(삭제)"을 구분한다.
    # go 편집 UI 가 섹션을 비우면(빈 배열/빈 문자열) v2 도 NULL 로 수렴 → read-after-write 정합.
    if "summary" in _fields:
        event.summary = body.summary or None
    if "event_schedules" in _fields:
        event.event_schedules = _validate_gap_list(
            body.event_schedules, field="event_schedules", max_items=_GAP_MAX_SCHEDULES
        )
    if "seo_metadata" in _fields:
        event.seo_metadata = _validate_gap_dict(body.seo_metadata, field="seo_metadata")
    if "questions" in _fields:
        event.questions = _validate_gap_list(
            body.questions, field="questions", max_items=_GAP_MAX_QUESTIONS
        )
    if "transport_info" in _fields:
        event.transport_info = body.transport_info or None
    if "program_notes" in _fields:
        event.program_notes = body.program_notes or None
    if "stage_info" in _fields:
        event.stage_info = body.stage_info or None
    if "parking_info" in _fields:
        event.parking_info = body.parking_info or None
    if "runtime_minutes" in _fields:
        event.runtime_minutes = body.runtime_minutes
    if "intermission_minutes" in _fields:
        event.intermission_minutes = body.intermission_minutes
    # Phase 1-Map — 좌석 배치도 원본. 미포함=보존, 명시 null/빈값=삭제(NULL 수렴).
    if "seat_map_data" in _fields:
        event.seat_map_data = _validate_seat_map_data(body.seat_map_data)
    # slug 변경(주최자 편집). v2 는 전역 UNIQUE — 충돌 시 _commit_or_conflict 가 409.
    if "slug" in _fields and body.slug:
        event.slug = body.slug
    # 레벨2 T2-EVT — go 전용 컬럼. model_fields_set 기준 미포함=보존/명시=반영.
    _apply_go_event_columns(event, body, partial=True)

    await _commit_or_conflict(db, "event patch")
    # 소비자 노출 캐시 무효화 — category/status/venue/image/event_date 등 이벤트 필드 변경이
    # 공개 API(by-id/by-slug)에 즉시 반영되게 함. 기존엔 PATCH 가 캐시를 안 날려
    # (upsert_tiers 만 무효화) category·이미지 변경이 캐시 TTL 만료까지 반영 안 되던
    # desync 버그 — go→v2 sync 는 성공했는데 소비자엔 옛 값이 남음
    # (GO_V2_COMMERCE_SYNC_AUDIT — 이벤트 PATCH 캐시 무효화 누락).
    from app.api.v1.events import _invalidate_event_caches

    await _invalidate_event_caches(event_id)
    logger.info("internal/events patch: event_id=%s", event_id)
    return {
        "event_id": str(event_id),
        "status": _project_event_status(event.status, event.sales_paused),
        "status_v2": event.status.value if hasattr(event.status, "value") else event.status,
        "sales_paused": event.sales_paused,
    }


# ── fee-plan write (SPEC §2.7) ──────────────────────────────────────────


async def _write_fee_plan(
    db: AsyncSession,
    body: FeePlanRequest,
    *,
    event_id: uuid.UUID | None,
    organizer_id: uuid.UUID | None,
) -> dict:
    if body.fee_type not in _VALID_FEE_TYPES:
        raise ApiError("VALIDATION_ERROR", f"invalid fee_type: {body.fee_type}", 400, "fee_type")

    now = datetime.now(timezone.utc)
    # 동일 scope 의 활성 스케줄 마감(supersede) — effective_until=now.
    scope = [FeeSchedule.effective_until.is_(None)]
    if event_id is not None:
        scope.append(FeeSchedule.event_id == event_id)
    else:
        scope.append(FeeSchedule.organizer_id == organizer_id)
        scope.append(FeeSchedule.event_id.is_(None))
    prior = (await db.execute(select(FeeSchedule).where(*scope))).scalars().all()
    for p in prior:
        p.effective_until = now

    fs = FeeSchedule(
        organizer_id=organizer_id,
        event_id=event_id,
        fee_type=body.fee_type,
        platform_fee_rate=body.platform_fee_rate,
        platform_fee_fixed=body.platform_fee_fixed,
        pg_fee_rate=body.pg_fee_rate,
        pg_fee_fixed=body.pg_fee_fixed,
        effective_from=now,
    )
    db.add(fs)
    await db.commit()
    logger.info(
        "internal fee-plan: scope=%s id=%s type=%s plat=%s+%s pg=%s+%s",
        "event" if event_id else "organizer",
        event_id or organizer_id, body.fee_type,
        body.platform_fee_rate, body.platform_fee_fixed,
        body.pg_fee_rate, body.pg_fee_fixed,
    )
    return {
        "fee_schedule_id": str(fs.id),
        "scope": "event" if event_id else "organizer",
        "event_id": str(event_id) if event_id else None,
        "organizer_id": str(organizer_id) if organizer_id else None,
        "fee_type": body.fee_type,
        "superseded": len(prior),
    }


# ── 엔드포인트 ───────────────────────────────────────────────────────────


@router.post("/events", summary="go write-through: 이벤트 생성")
async def create_event(
    request: Request,
    body: EventCreateRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(idempotency_key, "events.create",
                                 lambda: _do_create_event(db, body), fingerprint=_fingerprint(body))
    except ApiError as e:
        return _err(e)


@router.patch("/events/{event_id}", summary="go write-through: 이벤트 수정")
async def patch_event(
    event_id: uuid.UUID,
    request: Request,
    body: EventPatchRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(
            idempotency_key, f"events.patch.{event_id}",
            lambda: _do_patch_event(db, event_id, body), fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


async def _do_delete_event(
    db: AsyncSession, event_id: uuid.UUID, organizer_ref: str
) -> dict:
    """테스트 이벤트 하드삭제(go '영구삭제' write-through 대상).

    회계·감사 보존 원칙: **주문/티켓이 하나라도 있으면 삭제 거부**(pending 포함, 가장 보수적).
    순수 DB 작업 — PG/결제/알림 등 외부 부작용 0.

    삭제 순서 주의(events.id 자식 FK 는 CASCADE/RESTRICT 혼재):
      - CASCADE 자식(discounts·raffle·photocard·event_mirror·event_admission 등)은
        event 삭제로 자동 정리.
      - **RESTRICT 자식**(seats·waitlist_entries·seat_tiers 의 RESTRICT 손자 등)은
        CASCADE 로 정리되지 않아 삭제를 막는다. 주문 0 이벤트라도 authoring 으로
        생성된 seats/seat_tiers/waitlist 가 있으면 막히므로 **명시적 선삭제**한다.
      - 그래도 남는(예상 못 한) RESTRICT 자식이 있으면 commit 시 23503(FK 위반)을
        409 로 명확히 변환 — 500 스택트레이스로 흘리지 않는다.
    """
    event = await db.get(Event, event_id)
    if event is None:
        # 멱등: 이미 없으면 404 → 호출측 go 가 "이미 삭제됨"으로 처리.
        raise ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404)

    # 소유권 검증(organizer_ref: uuid → organizer_id, 아니면 go_account_id).
    try:
        ref = OrganizerRef(organizer_id=uuid.UUID(organizer_ref))
    except ValueError:
        ref = OrganizerRef(go_account_id=organizer_ref)
    organizer_id = await _resolve_organizer(db, ref)
    if event.organizer_id != organizer_id:
        raise ApiError("FORBIDDEN", "이 이벤트를 삭제할 권한이 없습니다", 403)

    # 주문 가드(핵심) — 상태 불문 1건이라도 있으면 거부.
    order_count = (
        await db.execute(
            select(func.count()).select_from(Order).where(Order.event_id == event_id)
        )
    ).scalar() or 0
    if order_count > 0:
        raise ApiError(
            "EVENT_HAS_ORDERS", "주문이 있는 이벤트는 삭제할 수 없습니다", 409
        )
    # 티켓 원장도 동일 가드(발권된 이벤트 = 회계·감사 대상).
    ticket_count = (
        await db.execute(
            select(func.count()).select_from(Ticket).where(Ticket.event_id == event_id)
        )
    ).scalar() or 0
    if ticket_count > 0:
        raise ApiError(
            "EVENT_HAS_ORDERS", "발권된 이벤트는 삭제할 수 없습니다", 409
        )

    # RESTRICT 자식 선삭제(주문·티켓 0 이므로 authoring 잔재만 남음):
    #   waitlist_entries → seats → seat_tiers 순(손자→자식 FK 안전 순서).
    await db.execute(
        delete(WaitlistEntryModel).where(WaitlistEntryModel.event_id == event_id)
    )
    await db.execute(delete(Seat).where(Seat.event_id == event_id))
    await db.execute(delete(SeatTier).where(SeatTier.event_id == event_id))

    # 나머지 CASCADE 자식은 event 삭제로 정리.
    await db.delete(event)
    # commit — 예상 못 한 RESTRICT 자식은 23503 → 409(500 금지).
    await _commit_or_conflict_delete(db, event_id)

    from app.api.v1.events import _invalidate_event_caches

    await _invalidate_event_caches(event_id)

    logger.info(
        "internal/events hard-delete: event_id=%s organizer=%s (orders=0 tickets=0)",
        event_id, organizer_id,
    )
    return {"deleted": True, "event_id": str(event_id)}


async def _commit_or_conflict_delete(db: AsyncSession, event_id: uuid.UUID) -> None:
    """하드삭제 commit — FK 위반(23503)만 409 로 변환(잔여 RESTRICT 자식 존재).

    _commit_or_conflict 는 23505(unique)만 변환하고 23503 은 re-raise(500)하므로,
    삭제 경로 전용으로 23503 을 사용자에게 명확한 409 로 노출한다."""
    from sqlalchemy.exc import IntegrityError

    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        sqlstate = getattr(getattr(exc, "orig", None), "sqlstate", None) or getattr(
            getattr(exc, "orig", None), "pgcode", None
        )
        # 23503 = foreign_key_violation(예상 못 한 RESTRICT 자식이 남아 삭제 차단).
        if sqlstate == "23503" or (
            sqlstate is None
            and "FOREIGN KEY constraint failed" in str(getattr(exc, "orig", ""))
        ):
            raise ApiError(
                "EVENT_HAS_DEPENDENTS",
                "연관 데이터가 남아 있어 이벤트를 삭제할 수 없습니다",
                409,
            ) from exc
        raise


@router.delete("/events/{event_id}", summary="go write-through: 테스트 이벤트 하드삭제")
async def delete_event(
    event_id: uuid.UUID,
    request: Request,
    organizer_ref: str,
    db: AsyncSession = Depends(get_db),
):
    """주문 0건 테스트 이벤트 영구삭제. go '테스트 이벤트 영구삭제'의 v2(SSOT) 짝.

    - organizer_ref(쿼리, 필수): 소유권 검증(uuid=organizer_id, 아니면 go_account_id).
    - 주문/티켓 1건이라도 있으면 409(회계·감사 보존).
    - 멱등: 이미 없으면 404(go 가 "이미 삭제됨"으로 흡수).
    """
    try:
        return _ok(await _do_delete_event(db, event_id, organizer_ref))
    except ApiError as e:
        return _err(e)


class EventDuplicateRequest(BaseModel):
    organizer_ref: OrganizerRef
    # 새 이벤트의 canonical id. go 가 자기 id 를 정해서 보내면 그대로 사용(ID 승격 계약 유지).
    # 미전송 시 v2 가 발급 — 이 경우 go 는 응답의 event_id 를 자기 id 로 채택해야 한다.
    new_event_id: uuid.UUID | None = None
    title: str | None = None   # 미전송 시 "<원본> (복제본)"
    slug: str | None = None    # 미전송 시 "<원본slug>-copy-<8hex>"
    copy_tiers: bool = True    # 상품/티어(정원·가격) 복제 여부


async def _do_duplicate_event(db: AsyncSession, event_id: uuid.UUID, body: EventDuplicateRequest) -> dict:
    """이벤트 복제 (레벨2 T2-EVT — go `INSERT … SELECT FROM events` 자기복제의 v2 짝).

    복제 대상 = **authoring 데이터만**. 판매 실적(주문·티켓·좌석 점유)은 절대 복제하지 않는다.
      - 복제함: 이벤트 메타 전체(상세/이미지/갭 필드/go 전용 컬럼) + seat_tiers(정원·가격)
      - 복제 안 함: orders·tickets·seats·discount_codes·affiliates·settlements
    새 이벤트는 항상 `draft` + `sales_paused=False` 로 시작한다(복제 직후 판매 개시 사고 방지).

    멱등: new_event_id 가 이미 존재하면 **재생성하지 않고 그 이벤트를 반환**(created=False).
    → 동시 2회 실행돼도 이벤트가 2개 생기지 않는다. 호출측 재시도 안전.
    """
    src = await db.get(Event, event_id)
    if src is None:
        raise ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404)
    # 원본 소유권 검증 — 남의 이벤트를 복제해 가져오는 크로스테넌트 경로 차단.
    ref = body.organizer_ref
    organizer_id = await _resolve_organizer(db, ref)
    if src.organizer_id != organizer_id:
        raise ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404)

    new_id = body.new_event_id or uuid.uuid4()
    # 멱등 가드 — 같은 new_event_id 로 재요청되면 기존 결과를 재생한다(중복 복제 방지).
    existing = await db.get(Event, new_id)
    if existing is not None:
        return {
            "event_id": str(existing.id),
            "slug": existing.slug,
            "status": _project_event_status(existing.status, existing.sales_paused),
            "created": False,
        }

    title = (body.title or f"{src.title} (복제본)")[:300]
    slug = (body.slug or f"{src.slug}-copy-{uuid.uuid4().hex[:8]}")[:80]

    # 복제 제외 목록 — PK/외부키/실적/타임스탬프/유니크 제약 필드.
    _SKIP = {
        "id", "slug", "title", "external_ref", "created_at", "updated_at",
        "status", "sales_paused", "custom_domain",   # 도메인은 전역 유니크 → 복제 금지
        "bid_count", "view_count", "total_seats",
    }
    copied: dict = {}
    for col in Event.__table__.columns.keys():
        if col in _SKIP:
            continue
        copied[col] = getattr(src, col, None)

    new_event = Event(
        id=new_id,
        title=title,
        slug=slug,
        external_ref=str(new_id),  # ID 승격 계약: canonical id == external_ref
        status=EventStatus.DRAFT,
        sales_paused=False,
        total_seats=src.total_seats,
        **copied,
    )
    db.add(new_event)

    tier_count = 0
    if body.copy_tiers:
        tiers = (
            await db.execute(select(SeatTier).where(SeatTier.event_id == event_id))
        ).scalars().all()
        for t in tiers:
            tier_kwargs = {}
            for col in SeatTier.__table__.columns.keys():
                # 실적(sold_count)·매핑키(external_ref)·PK 는 복제하지 않는다.
                if col in {"id", "event_id", "external_ref", "sold_count", "created_at", "updated_at"}:
                    continue
                tier_kwargs[col] = getattr(t, col, None)
            db.add(SeatTier(id=uuid.uuid4(), event_id=new_id, sold_count=0, **tier_kwargs))
            tier_count += 1

    await _commit_or_conflict(db, "event duplicate (slug)")
    logger.info(
        "internal/events duplicate: src=%s new=%s tiers=%s", event_id, new_id, tier_count
    )
    return {
        "event_id": str(new_id),
        "slug": slug,
        "status": _project_event_status(EventStatus.DRAFT.value, False),
        "tier_count": tier_count,
        "created": True,
    }


@router.post("/events/{event_id}/duplicate", summary="go write-through: 이벤트 복제(authoring only)")
async def duplicate_event(
    event_id: uuid.UUID,
    request: Request,
    body: EventDuplicateRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(
            idempotency_key,
            f"POST /internal/events/{event_id}/duplicate",
            lambda: _do_duplicate_event(db, event_id, body),
        )
    except ApiError as e:
        return _err(e)


@router.put("/events/{event_id}/fee-plan", summary="go write-through: 이벤트 fee plan(정률+정액)")
async def put_event_fee_plan(
    event_id: uuid.UUID,
    request: Request,
    body: FeePlanRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):

    async def _producer():
        event = await db.get(Event, event_id)
        if event is None:
            raise ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404)
        return await _write_fee_plan(db, body, event_id=event_id, organizer_id=event.organizer_id)

    try:
        return await _idempotent(idempotency_key, f"feeplan.event.{event_id}", _producer,
                                 fingerprint=_fingerprint(body))
    except ApiError as e:
        return _err(e)


@router.put("/organizers/fee-plan", summary="go write-through: organizer fee plan(정률+정액)")
async def put_organizer_fee_plan(
    request: Request,
    body: OrganizerFeePlanRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        # organizer 를 먼저 해석해 멱등키에 포함(IMPORTANT-1: organizer 미스코프 충돌 방지).
        organizer_id = await _resolve_organizer(db, body.organizer_ref)
        return await _idempotent(
            idempotency_key, f"feeplan.organizer.{organizer_id}",
            lambda: _write_fee_plan(db, body, event_id=None, organizer_id=organizer_id),
            fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


# ── 이벤트 read (SPEC §5 — go live read, 엔티티 단위 cutover) ─────────────
#
# 엔티티 단위(write+read) cutover 의 read 짝. go 가 이벤트 write 를 v2 로 돌리는
# 동시에 read 도 v2 live 로 flip → go.events DROP, dual-write 0(CEO lock).
# 상태는 go 4-상태 투영으로 응답(go 가 v2 11-상태 몰라도 됨).


async def _usable_discount_codes(db: AsyncSession, event_id) -> set[str]:
    """지금 **실제로 쓸 수 있는** 할인코드(대문자)만 모은다.

    🔴 왜 필요한가 — 주문 생성(`_do_create_order` 3단계)은 코드가 없거나 비활성·기간
    경과·소진이면 `PROMO_INVALID`(400)/`PROMO_EXHAUSTED`(409)로 **주문을 거절**한다.
    그런데 이벤트 상세 응답은 `card_discounts` 를 `rate` 가 있는지만 보고 내려보냈다.

    ⟹ 코드가 못 쓰는 상태여도 화면에는 "BC카드 10% 할인" 이 뜨고, 그걸 고른 손님은
       **결제 단계에서 에러**를 맞는다. 할인이 조용히 안 되는 게 아니라 **구매가 막힌다.**
       (max_uses 소진이 특히 위험하다 — 어느 순간부터 BC 손님 전원이 실패한다.)

    광고와 실제를 일치시켜, 못 쓰는 코드는 **애초에 광고하지 않는다.** 그러면 손님은
    정가로 사고, 에러를 보지 않는다.
    """
    now = datetime.now(timezone.utc)
    rows = (
        await db.execute(
            select(DiscountCode).where(
                DiscountCode.event_id == event_id,
                DiscountCode.is_active.is_(True),
            )
        )
    ).scalars().all()
    def _aware(dt):
        # ⚠️ prod(PostgreSQL timestamptz)는 aware 를 주지만 SQLite 는 naive 를 준다.
        #    비교 전에 UTC 로 통일하지 않으면 TypeError 로 상세 조회가 500 이 된다.
        return dt if dt is None or dt.tzinfo else dt.replace(tzinfo=timezone.utc)

    usable: set[str] = set()
    for r in rows:
        valid_from, valid_until = _aware(r.valid_from), _aware(r.valid_until)
        if valid_from and valid_from > now:
            continue
        if valid_until and valid_until < now:
            continue
        if r.max_uses is not None and (r.used_count or 0) >= r.max_uses:
            continue
        # 🔴 비교는 대문자로 통일한다 — v2 는 코드를 대문자로 저장하고
        #    (`create: body.code.upper()`), 설정에 소문자를 써도 성립해야 한다.
        usable.add(str(r.code).strip().upper())
    return usable


def _event_detail_dict(
    event: Event,
    summary: dict,
    *,
    usable_discount_codes: set[str],
    go_account_id: str | None = None,
    organizer_name: str | None = None,
) -> dict:
    return {
        "event_id": str(event.id),
        "external_ref": event.external_ref,
        "title": event.title,
        "slug": event.slug,
        "description": event.description,
        "venue": event.venue,
        # 레벨2 T2-EVT — 소유 테넌트(go accounts.id). go 가 events 테이블 없이
        # account_id 경계를 검증할 수 있게 노출한다. NULL = v2 네이티브 주최자.
        "go_account_id": go_account_id,
        # W2-PUB — 공개 표기용 주최자명(구 go `organizers.name`). 미등록 주최자는 NULL.
        "organizer_name": organizer_name,
        # 트랙B U1 핵심 상세 필드 read-after-write(go resync/검증용).
        "venue_address": event.venue_address,
        "venue_lat": event.venue_lat,
        "venue_lng": event.venue_lng,
        "age_rating": event.age_rating,
        "is_online": event.is_online,
        "homepage_url": event.homepage_url,
        # 트랙B U3 공개 랜딩 부속기능 게이트 read-after-write(go resync/검증용).
        "rsvp_enabled": event.rsvp_enabled,
        "group_booking_enabled": event.group_booking_enabled,
        "context_banner": event.context_banner,
        "category": event.category,
        "status": _project_event_status(event.status, event.sales_paused),  # go 4-상태
        "status_v2": event.status.value if hasattr(event.status, "value") else event.status,
        "sales_paused": event.sales_paused,
        "event_date": event.event_date.isoformat() if event.event_date else None,
        "sale_window": {
            "opens_at": event.bidding_opens_at.isoformat() if event.bidding_opens_at else None,
            "closes_at": event.bidding_closes_at.isoformat() if event.bidding_closes_at else None,
        },
        "sale_channels": list(event.sale_channels or []),
        # 🔴 나이스 카드전용 게이팅(C2) — 응답에 **없어서** organizer 가 읽을 수 없었다.
        #    프론트가 `(event as {...}).allowed_pay_methods` 로 꺼내려 했지만 값이 오지
        #    않아 게이팅이 통째로 죽어 있었다(감사에서 발견). 서버 강제는 살아 있었으므로
        #    보안 구멍은 아니었고, UX(선택지 제한)만 안 걸리던 상태다.
        "allowed_pay_methods": list(event.allowed_pay_methods or []) or None,
        # 카드사 자동할인(T13/T14). 이 엔드포인트는 **internal(서비스토큰)** 이라
        # organizer **서버**만 호출한다 → 할인코드까지 내린다(서버가 주문에 적용해야 하므로).
        # 🔴 organizer 는 이 값을 **브라우저로 넘기기 전에 discount_code 를 벗겨야 한다**
        #    (checkout/page.tsx). 클라가 코드를 알면 임의 적용을 시도할 수 있다.
        # rate 가 없는 오염 설정은 걸러 내린다(UI 가 0% 안내를 띄우지 않게).
        # 🔴 `rate` 만 보고 내리면 **쓸 수 없는 코드를 광고**하게 된다. 주문 생성은 그 코드로
        #    400/409 를 내므로 손님은 할인이 아니라 **결제 실패**를 만난다.
        #    ⟹ 지금 실제로 쓸 수 있는 코드에 매핑된 것만 내린다(`_usable_discount_codes`).
        #    discount_code 가 없는 항목도 제외한다 — 적용할 코드가 없으면 광고할 것도 없다.
        "card_discounts": (
            {
                str(card): {
                    "rate": cfg.get("rate"),
                    "card_code": str(cfg.get("card_code") or "01"),
                    "discount_code": cfg.get("discount_code"),
                }
                for card, cfg in event.card_discounts.items()
                if isinstance(cfg, dict)
                and cfg.get("rate")
                and str(cfg.get("discount_code") or "").strip().upper()
                in usable_discount_codes
            }
            or None
            if isinstance(getattr(event, "card_discounts", None), dict)
            else None
        ),
        "organizer_id": str(event.organizer_id),
        "total_seats": event.total_seats,
        "image_url": event.image_url,
        # 레벨2 T2-EVT — 모델엔 있었으나 응답에 미노출이던 필드(go read-flip 이 소비).
        "image_variants": event.image_variants or None,
        "gallery_images": event.gallery_images or None,
        "admission_mode": getattr(event, "admission_mode", None) or "single",
        "raffle_enabled": bool(getattr(event, "raffle_enabled", False)),
        # 좌석 판매 방식 — go 운영 콘솔이 배치도 에디터 노출을 이 값으로 가른다.
        "seat_type": getattr(event, "seat_type", None) or "assigned",
        "event_date_end": event.event_date_end.isoformat() if event.event_date_end else None,
        "cancellation_fee_tiers": event.cancellation_fee_tiers or None,
        "venue_address": event.venue_address,
        "venue_lat": event.venue_lat,
        "venue_lng": event.venue_lng,
        "sales_paused_at": None,  # go 호환 자리(별도 원장 없음)
        "timezone": event.event_timezone,
        # ── ctevt_0727: go events 전용 컬럼(go DB 제거 후 이 응답이 유일한 출처) ──
        # 🔴 event_type 은 go 원본, category 는 손실 파생. 주최자 편집 UI 는 event_type 을 써야 한다.
        "event_type": event.event_type,
        # 🔴 기능 게이트 정본. 항상 배열(NULL 없음) — 소비측이 fail-closed 로 판정할 수 있게.
        "enabled_features": list(event.enabled_features or []),
        "homepage_design": event.homepage_design,
        "landing_config": event.landing_config,
        "custom_domain": event.custom_domain,
        "domain_metadata": event.domain_metadata,
        "queue_enabled": bool(event.queue_enabled),
        "queue_config": event.queue_config,
        "rsvp_config": event.rsvp_config,
        "comp_capacity_cap": event.comp_capacity_cap,
        "summary": summary,
        # ── Phase 1-S/1-O 상세페이지 갭 필드 read-after-write ──
        # ⚠️ 최상위 "summary" 는 집계 dict(revenue 등) — go 텍스트 요약과 충돌하므로
        #    갭 필드는 별도 "content" 네임스페이스로 노출(계약 비파괴). NULL 시 미노출 폴백.
        "content": {
            "summary": event.summary,
            "event_schedules": event.event_schedules,
            "seo_metadata": event.seo_metadata,
            "questions": event.questions,
            "transport_info": event.transport_info,
            "parking_info": event.parking_info,
            "runtime_minutes": event.runtime_minutes,
            "intermission_minutes": event.intermission_minutes,
            # 🔴 쓰기(EventUpdate)는 받는데 **읽기가 안 내려줬다** (2026-08-02).
            #    그래서 주최자가 프로그램 탭 자유문구를 저장해도 화면이 못 본다 —
            #    이미지로 때우고 있었다. DB 컬럼·모델·쓰기 스키마는 전부 있었고
            #    이 응답에만 빠져 있었다.
            "program_notes": event.program_notes,
            "stage_info": event.stage_info,
            # Phase 1-Map — 좌석 배치도 원본 canvas(소비자 렌더 원본).
            "seat_map_data": event.seat_map_data,
        },
    }


async def _event_summary(db: AsyncSession, event_id: uuid.UUID) -> dict:
    """이벤트 read 집계(READ-AGGREGATE §2). go 가 JOIN 못 하므로 v2 서버사이드 집계."""
    tier_count = (
        await db.execute(
            select(func.count()).select_from(SeatTier).where(SeatTier.event_id == event_id)
        )
    ).scalar() or 0
    seats_total = (
        await db.execute(
            select(func.count()).select_from(Seat).where(Seat.event_id == event_id)
        )
    ).scalar() or 0
    seats_sold = (
        await db.execute(
            select(func.count())
            .select_from(Seat)
            .where(Seat.event_id == event_id, Seat.status.in_(_SOLD_SEAT_STATUSES))
        )
    ).scalar() or 0
    agg = await _event_order_aggregates(db, [event_id])
    a = agg.get(event_id, {"order_count": 0, "attendee_count": 0, "revenue": 0.0, "refund_amount": 0.0})
    return {
        "tier_count": int(tier_count),
        "product_count": int(tier_count),  # go products = v2 seat_tiers
        "seats_total": int(seats_total),
        "seats_sold": int(seats_sold),
        "order_count": a["order_count"],
        "attendee_count": a["attendee_count"],
        "total_revenue": a["revenue"],
        "refund_amount": a["refund_amount"],
    }


async def _event_order_aggregates(
    db: AsyncSession, event_ids: list[uuid.UUID]
) -> dict[uuid.UUID, dict]:
    """이벤트별 order_count / attendee_count / revenue 일괄 집계(N+1 회피)."""
    if not event_ids:
        return {}
    out: dict[uuid.UUID, dict] = {
        eid: {"order_count": 0, "attendee_count": 0, "revenue": 0.0, "refund_amount": 0.0}
        for eid in event_ids
    }
    # revenue = 매출대상 status 의 gross(total_amount) 합. refund_amount = 환불액(total_refunded).
    # go 는 net = revenue - refund_amount 로 표시(BOUNDARY-DECISIONS 계약: gross+환불 분리 노출).
    order_rows = (
        await db.execute(
            select(
                Order.event_id,
                func.count(Order.id),
                func.coalesce(
                    func.sum(Order.total_amount).filter(Order.status.in_(_REVENUE_STATUSES)), 0,
                ),
                func.coalesce(
                    func.sum(Order.total_refunded).filter(Order.status.in_(_REVENUE_STATUSES)), 0,
                ),
            )
            .where(Order.event_id.in_(event_ids))
            .group_by(Order.event_id)
        )
    ).all()
    for eid, cnt, rev, refund in order_rows:
        out[eid]["order_count"] = int(cnt or 0)
        out[eid]["revenue"] = float(rev or 0)
        out[eid]["refund_amount"] = float(refund or 0)
    # attendee = ticket(=go attendee). CANCELLED 제외(go attendees 는 취소 시 제외됨).
    ticket_rows = (
        await db.execute(
            select(Ticket.event_id, func.count(Ticket.id))
            .where(
                Ticket.event_id.in_(event_ids),
                Ticket.status != TicketStatus.CANCELLED,
            )
            .group_by(Ticket.event_id)
        )
    ).all()
    for eid, cnt in ticket_rows:
        out[eid]["attendee_count"] = int(cnt or 0)
    return out


async def _go_account_id_of(db: AsyncSession, organizer_id: uuid.UUID) -> str | None:
    """v2 organizer_id(user_id) → go accounts.id. v2 네이티브 주최자는 None."""
    return (
        await db.execute(
            select(OrganizerProfile.go_account_id).where(
                OrganizerProfile.user_id == organizer_id
            )
        )
    ).scalar_one_or_none()


async def _organizer_ident_of(
    db: AsyncSession, organizer_id: uuid.UUID
) -> tuple[str | None, str | None]:
    """v2 organizer_id → (go accounts.id, 표시용 주최자명).

    W2-PUB: go 가 `SELECT organizers.name` 으로 렌더하던 공개 표기(OG 카드 등)를
    go DB 없이 채우기 위해 `company_name` 을 함께 돌려준다. 두 값이 같은 행에서
    나오므로 왕복 1회로 끝난다(`_go_account_id_of` 를 대체하지 않고 병존 — 기존 호출부 무변).
    """
    row = (
        await db.execute(
            select(OrganizerProfile.go_account_id, OrganizerProfile.company_name).where(
                OrganizerProfile.user_id == organizer_id
            )
        )
    ).first()
    return (row[0], row[1]) if row else (None, None)


async def _assert_event_owner(db: AsyncSession, event: Event, organizer_ref: str) -> None:
    """이벤트 소유 테넌트 검증 (레벨2 T2-EVT).

    go 가 `SELECT ... FROM events WHERE id=$1 AND account_id=$2` 로 하던 테넌트 경계를
    v2 로 이관한 것. **조용한 폴백 금지** — 미해결/불일치는 명시적 403/404 다.
    크로스테넌트 누출은 Critical 이므로 organizer_ref 가 주어지면 반드시 여기를 통과해야 한다.
    """
    try:
        ref = OrganizerRef(organizer_id=uuid.UUID(organizer_ref))
    except ValueError:
        ref = OrganizerRef(go_account_id=organizer_ref)
    organizer_id = await _resolve_organizer(db, ref)  # 미해결 시 404 ApiError
    if event.organizer_id != organizer_id:
        # 존재 사실 노출을 피하려면 404 가 맞지만, go 기존 계약(soft 404)과 맞추기 위해
        # 소유자 불일치는 404 로 투영한다(호출측이 "이벤트를 찾을 수 없습니다"로 표시).
        raise ApiError("EVENT_NOT_FOUND", f"event not found: {event.id}", 404)


@router.get("/events/by-slug/{slug}", summary="go live read: slug → 이벤트 상세")
async def get_event_by_slug(
    slug: str,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    organizer_ref: str | None = None,
):
    """레벨2 T2-EVT — 공개 라우트(`/e/[slug]`, 티켓, 위젯 등)의 slug 진입점.

    go `SELECT ... FROM events WHERE slug=$1` 을 대체한다.
    ⚠️ go 는 UNIQUE(account_id, slug)(테넌트별), v2 는 전역 UNIQUE 다.
       organizer_ref 를 주면 테넌트 경계까지 강제하고, 안 주면 전역 조회(공개 라우트용).
    """
    event = (
        await db.execute(select(Event).where(Event.slug == slug))
    ).scalar_one_or_none()
    if event is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found for slug: {slug}", 404))
    if organizer_ref:
        try:
            await _assert_event_owner(db, event, organizer_ref)
        except ApiError as e:
            return _err(e)
    summary = await _event_summary(db, event.id)
    go_account_id, organizer_name = await _organizer_ident_of(db, event.organizer_id)
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok(_event_detail_dict(
        event, summary,
        usable_discount_codes=await _usable_discount_codes(db, event.id),
        go_account_id=go_account_id, organizer_name=organizer_name,
    ))


@router.get("/events/{event_id}", summary="go live read: 이벤트 상세")
async def get_event(
    event_id: uuid.UUID,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    organizer_ref: str | None = None,
):
    """이벤트 상세.

    organizer_ref(선택) — 주면 테넌트 경계를 v2 가 강제한다(불일치 → 404).
    레벨2 T2-EVT 이후 go 의 `AND account_id = $2` 가 이 파라미터로 이관됐다.
    """
    event = await db.get(Event, event_id)
    if event is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    if organizer_ref:
        try:
            await _assert_event_owner(db, event, organizer_ref)
        except ApiError as e:
            return _err(e)
    summary = await _event_summary(db, event_id)
    go_account_id, organizer_name = await _organizer_ident_of(db, event.organizer_id)
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok(_event_detail_dict(
        event, summary,
        usable_discount_codes=await _usable_discount_codes(db, event.id),
        go_account_id=go_account_id, organizer_name=organizer_name,
    ))


@router.get("/organizers/{organizer_ref}/events", summary="go live read: organizer 이벤트 목록")
async def list_organizer_events(
    organizer_ref: str,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
    search: str | None = None,
    sort: str | None = None,
    event_type: str | None = None,
):
    """organizer 이벤트 목록.

    레벨2 T2-EVT 확장: go 목록 화면이 go events 를 SELECT 하지 않고 이 API 만으로
    렌더될 수 있도록 검색(title ILIKE)·정렬·목록 필드(venue/age_rating/is_online/
    image_url/slug/event_type)를 제공한다.
    """
    # organizer_ref: uuid 면 organizer_id, 아니면 go_account_id 로 해석.
    try:
        ref = OrganizerRef(organizer_id=uuid.UUID(organizer_ref))
    except ValueError:
        ref = OrganizerRef(go_account_id=organizer_ref)
    try:
        organizer_id = await _resolve_organizer(db, ref)
    except ApiError as e:
        return _err(e)

    limit = max(1, min(limit, 200))
    offset = max(0, offset)

    filters = [Event.organizer_id == organizer_id]
    # 검색 — 제목 부분일치. ILIKE 와일드카드 메타문자를 이스케이프해 사용자 입력이
    # 패턴으로 해석되지 않게 한다(전체 스캔 유발·의도치 않은 매치 방지).
    if search and search.strip():
        needle = search.strip()[:100]
        for meta in ("\\", "%", "_"):
            needle = needle.replace(meta, f"\\{meta}")
        filters.append(Event.title.ilike(f"%{needle}%", escape="\\"))
    if event_type:
        filters.append(Event.event_type == event_type)
    if status:
        # 레벨2 T2-EVT — go 목록 탭의 파생 필터 2종(ended/scheduled)을 v2 로 이관.
        # go 는 `ends_at < NOW()` 로 판정했다. v2 대응 컬럼은 event_date_end(다일) 이고
        # 미설정(단일일) 이벤트는 event_date 가 종료 시각이므로 COALESCE 로 통일한다.
        _ends_at = func.coalesce(Event.event_date_end, Event.event_date)
        if status in ("ended", "scheduled"):
            _draftish = [
                EventStatus.DRAFT, EventStatus.PENDING_REVIEW,
                EventStatus.UNDER_REVIEW, EventStatus.REVISION_REQUESTED,
            ]
            if status == "ended":
                # 종료 = 이미 끝났고 draft/archived(=cancelled 투영) 가 아닌 것.
                filters.append(_ends_at < func.now())
                filters.append(Event.status.notin_([*_draftish, EventStatus.CANCELLED]))
            else:
                # 예정 = 작업중(draft/심사/반려)이거나, 아직 끝나지 않은 살아있는 이벤트.
                filters.append(
                    Event.status.notin_([EventStatus.CANCELLED, EventStatus.COMPLETED])
                )
                filters.append(
                    Event.status.in_(_draftish) | (_ends_at >= func.now())
                )
        elif status not in _GO_EVENT_STATUSES:
            return _err(ApiError("VALIDATION_ERROR", f"invalid status filter: {status}", 400, "status"))
        elif status == "paused":
            # paused = status-독립 플래그. go투영 "live" 범위 + sales_paused=True.
            live_v2 = _go_status_to_v2_list("live")
            filters.append(Event.sales_paused.is_(True))
            filters.append(Event.status.in_([EventStatus(s) for s in live_v2]))
        else:
            v2_statuses = _go_status_to_v2_list(status)
            if not v2_statuses:
                response.headers["Cache-Control"] = _READ_CACHE_CONTROL
                return _ok({"events": [], "total": 0, "limit": limit, "offset": offset})
            filters.append(Event.status.in_([EventStatus(s) for s in v2_statuses]))
            # "live" 필터는 일시중지 이벤트 제외(그건 paused로 투영됨).
            if status == "live":
                filters.append(Event.sales_paused.is_(False))

    total = (
        await db.execute(select(func.count()).select_from(Event).where(*filters))
    ).scalar() or 0

    # 정렬 — go sortMap 과 1:1 대응(latest/oldest/created/title).
    # go 는 starts_at 기준, v2 는 event_date 가 같은 값이다. 미지원 값은 기본(latest)으로 폴백.
    _ORDER_BY = {
        "latest": Event.event_date.desc(),
        "oldest": Event.event_date.asc(),
        "created": Event.created_at.desc(),
        "title": Event.title.asc(),
    }
    order_clause = _ORDER_BY.get((sort or "").strip(), Event.created_at.desc())

    rows = (
        await db.execute(
            select(Event)
            .where(*filters)
            # 동률(같은 날짜/제목) 시 페이지 경계에서 행이 중복·누락되지 않도록 id 로 tie-break.
            .order_by(order_clause, Event.id.asc())
            .limit(limit)
            .offset(offset)
        )
    ).scalars().all()

    agg = await _event_order_aggregates(db, [e.id for e in rows])
    events = []
    for e in rows:
        a = agg.get(e.id, {"order_count": 0, "attendee_count": 0, "revenue": 0.0, "refund_amount": 0.0})
        events.append({
            "event_id": str(e.id),
            "external_ref": e.external_ref,
            "title": e.title,
            "status": _project_event_status(e.status, e.sales_paused),
            "sales_paused": e.sales_paused,
            "category": e.category,
            "event_date": e.event_date.isoformat() if e.event_date else None,
            "sale_window": {
                "opens_at": e.bidding_opens_at.isoformat() if e.bidding_opens_at else None,
                "closes_at": e.bidding_closes_at.isoformat() if e.bidding_closes_at else None,
            },
            "total_seats": e.total_seats,
            # ── 레벨2 T2-EVT: go 목록 화면이 go events 없이 렌더되도록 필드 확장 ──
            "slug": e.slug,
            "summary": e.summary,
            "venue": e.venue,
            "age_rating": e.age_rating,
            "is_online": bool(e.is_online),
            "image_url": e.image_url,
            "event_type": e.event_type,
            "event_date_end": e.event_date_end.isoformat() if e.event_date_end else None,
            "enabled_features": list(e.enabled_features or []),
            # READ-AGGREGATE §1 — go 가 JOIN 못 하므로 v2 서버사이드 집계.
            "order_count": a["order_count"],
            "attendee_count": a["attendee_count"],
            "revenue": a["revenue"],
            "refund_amount": a["refund_amount"],
        })
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"events": events, "total": int(total), "limit": limit, "offset": offset})


# ════════════════════════════════════════════════════════════════════════
# Slice B — tiers / seats (write+read)
# ════════════════════════════════════════════════════════════════════════


async def _require_event(db: AsyncSession, event_id: uuid.UUID) -> Event:
    event = await db.get(Event, event_id)
    if event is None:
        raise ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404)
    return event


class TierUpsert(BaseModel):
    external_ref: str | None = None
    name: str = Field(..., min_length=1, max_length=100)
    # ── W2-PS: `ge=0` 로 완화. 근거는 `stock_limit` 주석 참조(재고 0 = 판매불가 표현).
    #   기존 호출자(capacity>0)는 전부 그대로 통과한다 — 완화이지 계약 변경이 아니다.
    capacity: int = Field(..., ge=0)
    base_price: float = 0.0
    sale_mode: str = "fixed_fcfs"
    face_price: float | None = None
    min_price: float | None = None
    max_price_cap: float | None = None
    sale_window: SaleWindow | None = None
    seating_type: str | None = None
    # ── T2-ORD: go products 메타 흡수. 전부 optional — 미전달 시 기존 값 보존(계약 불변). ──
    description: str | None = None
    product_type: str | None = None      # ticket | addon | bundle | donation
    visibility: str | None = None        # public | private | hidden
    tax_rate: int | None = None
    tax_included: bool | None = None
    image_url: str | None = None
    # F4-BAND: 경품번호 대역 시작값(주중권 100001 · 주말권 200001 · 초대권 500001).
    # None = 미전달(기존 값 보존). 0 이하는 거부 — "미사용(NULL)" 과 구분이 안 되고
    # base + 순번이 다른 대역을 침범한다.
    raffle_number_base: int | None = Field(default=None, gt=0)
    sort_order: int | None = None
    min_per_order: int | None = None
    max_per_order: int | None = None
    is_active: bool | None = None
    bundle_items: list[dict] | None = None
    # ── W2-PS: go `products.stock` / `seat_tiers` 빌더 메타 흡수(go DB 제거 선행). ──
    #
    # 🔴 stock_limit 이 왜 필요한가 — capacity 만으로는 **왕복 손실**이 난다.
    #   go 폼은 "무제한 체크박스 + 재고 숫자" 두 값을 갖는데 v2 capacity 는 하나뿐이라
    #   `무제한 → 1,000,000` sentinel 로 뭉갰다. 그러면 재고 1,000,000 을 명시한 상품과
    #   무제한 상품을 되읽을 때 구분할 수 없다. stock_limit 이 **입력 원본**(NULL=무제한, 0=재고없음),
    #   capacity 는 거기서 파생한 **집행값**이다.
    #
    # 🔴 재고 0 — 종전엔 go 가 `stock<=0 → 1,000,000` 으로 바꿔 보냈다. 즉 **재고 0 을 무제한으로
    #   승격**시켜 초과판매를 열어주는 결함이었다. 이제 0 은 0 그대로 집행된다(판매불가).
    #   그래서 위 capacity CHECK/Field 를 `>=0` 로 완화했다(alembic w2ps_0727).
    #
    # 전달 규칙: `model_fields_set` 기반 — **필드를 보냈으면** 반영(명시 null 도 반영),
    #   안 보냈으면 보존. None-보존 규칙(_TIER_META_FIELDS)으로는 "무제한으로 되돌리기"를
    #   표현할 수 없기 때문이다.
    stock_limit: int | None = Field(None, ge=0)
    # go seat_tiers 빌더 메타(v2 미보유분) — alembic w2ps_0727 가산.
    color_hex: str | None = None
    seat_map_id: uuid.UUID | None = None
    tier_metadata: dict | None = None
    # go seat_tiers 뷰/리세일/그룹 메타 — v2 컬럼은 이미 있었으나 upsert 계약에 없어 전파 불가였다.
    section_name: str | None = None
    view_description: str | None = None
    distance_from_stage: int | None = None
    view_rating: int | None = None
    view_image_url: str | None = None
    position_label: str | None = None
    resale_allowed: bool | None = None
    resale_max_price: float | None = None
    allow_group_tickets: bool | None = None
    max_group_size: int | None = None


class TiersRequest(BaseModel):
    # max_length=500 유지. min_length 은 아래 검증기로 조건부 적용:
    #   - replace=false(일반 upsert): 최소 1개 필수(빈 upsert 는 의미 없음).
    #   - replace=true(정리/재동기화): 빈 리스트 허용 — go 마지막 상품 삭제 시 남은 티어가 0개여도
    #     팬텀 티어를 정리해야 하므로(티어 DELETE sync 갭 완결). sold>0·좌석 티어는 v2 가 보호.
    tiers: list[TierUpsert] = Field(..., max_length=500)
    # replace=true: 이 페이로드의 external_ref 집합에 없는 **미판매 GA 팬텀 티어**(sold=0 AND seats=0)를
    # 삭제한다. go 에서 지운 상품/좌석티어가 v2 에 잔존해 min_price 를 오염시키는 갭 해소
    # (GO_V2_COMMERCE_SYNC_AUDIT). resync-commerce·상품삭제 정리 전용 — 일반 upsert 는 false 라 오삭제 불가.
    replace: bool = False

    @model_validator(mode="after")
    def _require_tiers_unless_replace(self) -> "TiersRequest":
        if not self.replace and len(self.tiers) < 1:
            raise ValueError("tiers must contain at least 1 item when replace is false")
        return self


class SeatUpsert(BaseModel):
    external_ref: str | None = None
    tier_ref: str | None = None  # go productId(external) — tier_id 해석용
    tier_id: uuid.UUID | None = None
    section: str
    row_number: int
    seat_number: int
    quality_score: float = 0.5
    x: float = 0.0
    y: float = 0.0
    label: str | None = None
    is_obstructed: bool = False
    status: str | None = None  # reserved(=organizer block) 등 명시 시. SOLD/HELD 보호.


class SeatsRequest(BaseModel):
    # 레벨2 컷오버 T1 — replace=true(빌더 레이아웃 전체교체)면 빈 리스트 허용:
    # 좌석 전부를 지운 배치도(스탠딩 전용 전환 등)도 v2 에서 정리돼야 한다.
    seats: list[SeatUpsert] = Field(..., max_length=10000)
    # 레벨2 컷오버 T1 — 좌석빌더가 go seats 를 더는 스테이징하지 않는다(go DROP 대비).
    # 레이아웃 전체교체(figmaLayout replace)에서 **없어진 좌석**을 v2 에서도 제거해야 하는데
    # upsert 만으로는 유령좌석이 남아 재고/집계가 오염된다 → replace 로 정리.
    #   - 삭제 대상: 이 페이로드의 external_ref 집합에 없는 좌석.
    #   - **SOLD/HELD 는 절대 삭제 안 함**(결제 진행/완료분 보호) — upsert 의 보호정책과 동일.
    #   - scope_prefix 지정 시 external_ref 가 그 prefix 로 시작하는 좌석만 정리 대상
    #     (빌더는 `smseat:{mapId}:` 을 넘겨 **다른 맵/다른 경로(import)의 좌석을 오삭제하지 않는다**).
    #     prefix 없는(레거시 uuid external_ref) 좌석은 scope 밖이라 보존된다.
    replace: bool = False
    scope_prefix: str | None = None

    @model_validator(mode="after")
    def _require_seats_unless_replace(self) -> "SeatsRequest":
        if not self.replace and len(self.seats) < 1:
            raise ValueError("seats must contain at least 1 item when replace is false")
        return self


_VALID_PRODUCT_TYPES = {"ticket", "addon", "bundle", "donation"}
_VALID_TIER_VISIBILITY = {"public", "private", "hidden"}
# T2-ORD: go products 메타 필드 — 미전달(None)이면 **기존 값 보존**.
# 전량 덮어쓰기로 하면 메타를 모르는 옛 호출자(좌석 빌더·resync)가 상품 설명/세금/정렬을
# 조용히 지워버린다. optional-preserve 가 유일하게 안전한 병합 규칙이다.
_TIER_META_FIELDS = (
    "description", "product_type", "visibility", "tax_rate", "tax_included",
    # 🔴 `image_url` 을 여기서 **빼면 안 된다**(2026-08-01 실측).
    #    go 상품 라우트가 `imageUrl: body.imageUrl ?? null` 로 **항상** 싣는데
    #    (`products/[productId]/route.ts:143`) 상품 폼에는 그 입력칸이 **없다**
    #    (`event-products-client.tsx` 참조 0건) ⟹ 저장할 때마다 `image_url: null` 이 온다.
    #    지금은 아래 None-보존 규칙이 그걸 버려서 **데이터를 지켜주고 있다.**
    #    NULLABLE 목록으로 옮기면 **상품을 저장할 때마다 이미지가 삭제된다.**
    #    옮기려면 go 가 폼에 없는 필드의 키를 빼도록 먼저 고쳐야 한다.
    "image_url",
    "sort_order", "min_per_order", "is_active",
    "bundle_items",
)
# W2-PS: **명시 null 을 반영해야 하는** 필드 — `model_fields_set` 로 전달 여부를 판정한다.
# stock_limit=null(무제한 복귀)·color_hex=null(색 해제)처럼 "지우기"가 유효한 값이라
# None-보존 규칙으로는 표현할 수 없다. 안 보낸 필드는 그대로 보존되므로 옛 호출자는 무영향.
_TIER_META_FIELDS_NULLABLE = (
    "stock_limit", "color_hex", "seat_map_id", "section_name",
    "view_description", "distance_from_stage", "view_rating", "view_image_url",
    "position_label", "resale_allowed", "resale_max_price", "allow_group_tickets",
    "max_group_size",
    # 🔴 `max_per_order` 를 여기로 옮겼다 (2026-08-01).
    #    "1인당 최대 구매수량"을 비우는 것 = **제한 해제(무제한)** 이고, 그 표현이 NULL 이다.
    #    종전에는 None-보존 규칙이라 한번 상한을 걸면 **해제할 수 없었다** — 화면에는
    #    "제한 없음"으로 보이는데 구매자는 계속 막히는, 원인을 찾기 어려운 판매 장애다.
    #    go 는 빈칸을 null 로 보낸다(`products/[productId]/route.ts:138`
    #    `maxPerOrder: body.maxPerOrder ? Number(...) : null`)이라 정확히 이 경로로 도달한다.
    #    ⚠️ `min_per_order` 는 NOT NULL 이므로 옮기지 않는다.
    "max_per_order",
)
# 🔴 `tier_metadata` 는 위 목록에서 **뺐다** — 전량 교체가 아니라 **얕은 병합**한다.
#
# 2026-07-28 실측 결함: 이 딕셔너리가 전량 교체 대상이었다. 그런데 go 의 등급/상품 수정
# 경로(`tier-catalog.ts::toSeatTierUpsert`)는 매번 `{go_source: ...}` 만 담은 **새 객체**를
# 보낸다. 그래서 주최자가 등급 이름·가격·정원 중 아무거나 저장하는 순간, 운영이 심어둔
# `admission_days`(등급별 입장 가능일)가 **예외도 로그도 없이 사라졌다**.
# ⟹ 15,000원 주중권으로 결승일 입장이 다시 열린다. 바로 위 주석이 다른 필드에 대해
#    경고한 그 사고가 정작 메타 딕셔너리 전체에서 일어나고 있었다.
#
# 계약: dict 를 보내면 **보낸 키만** 갱신하고 나머지는 보존한다. 키를 지우려면 그 키의
# 값으로 null 을 보낸다. `tier_metadata: null` 자체는 전체 삭제(명시 의도)로 유지한다.
def _merge_tier_metadata(current: dict | None, incoming: dict | None) -> dict | None:
    if incoming is None:
        return None
    merged = dict(current or {})
    for key, value in incoming.items():
        if value is None:
            merged.pop(key, None)
        else:
            merged[key] = value
    return merged or None
# go 무제한 재고 sentinel — go `products.stock IS NULL` 의 v2 집행값.
UNLIMITED_TIER_CAPACITY = 1_000_000


def _effective_capacity(t: TierUpsert) -> int:
    """집행 capacity. `stock_limit` 을 **보냈으면** 그것이 정본(NULL=무제한 sentinel).

    안 보낸 옛 호출자(좌석 빌더·resync·타 트랙)는 `capacity` 그대로 — 계약 불변.
    """
    if "stock_limit" not in t.model_fields_set:
        return t.capacity
    return UNLIMITED_TIER_CAPACITY if t.stock_limit is None else int(t.stock_limit)


def _apply_tier_meta(tier: SeatTier, t: TierUpsert) -> None:
    """go products 메타를 tier 에 병합. None 은 '미전달'이라 기존 값을 유지한다."""
    if t.product_type is not None and t.product_type not in _VALID_PRODUCT_TYPES:
        raise ApiError("VALIDATION_ERROR", f"invalid product_type: {t.product_type}", 400, "product_type")
    if t.visibility is not None and t.visibility not in _VALID_TIER_VISIBILITY:
        raise ApiError("VALIDATION_ERROR", f"invalid visibility: {t.visibility}", 400, "visibility")
    for field in _TIER_META_FIELDS:
        value = getattr(t, field)
        if value is not None:
            setattr(tier, field, value)
    for field in _TIER_META_FIELDS_NULLABLE:
        if field in t.model_fields_set:
            setattr(tier, field, getattr(t, field))
    # tier_metadata 만 병합 규칙(_merge_tier_metadata 주석 참조).
    if "tier_metadata" in t.model_fields_set:
        tier.tier_metadata = _merge_tier_metadata(tier.tier_metadata, t.tier_metadata)


async def _do_upsert_tiers(db: AsyncSession, event_id: uuid.UUID, body: TiersRequest) -> dict:
    await _require_event(db, event_id)
    mapping = []
    for t in body.tiers:
        sm = t.sale_mode.lower()
        if sm not in _VALID_SALE_MODES:
            raise ApiError("INVALID_SALE_MODE", f"invalid sale_mode: {t.sale_mode}", 400, "sale_mode")
        opens_at = closes_at = None
        if t.sale_window:
            opens_at = _parse_dt(t.sale_window.opens_at, "sale_window.opens_at")
            closes_at = _parse_dt(t.sale_window.closes_at, "sale_window.closes_at")
            if closes_at <= opens_at:
                raise ApiError("VALIDATION_ERROR", "tier sale_window invalid", 400, "sale_window")
        existing = None
        if t.external_ref:
            existing = (
                await db.execute(
                    select(SeatTier).where(
                        SeatTier.external_ref == t.external_ref,
                        SeatTier.event_id == event_id,  # 크로스이벤트 tier 오염 차단
                    )
                )
            ).scalar_one_or_none()
        cap = _effective_capacity(t)
        if existing is not None:
            # capacity 축소가 이미 판매된 수보다 작으면 409(SPEC §2.2).
            if cap < await _tier_sold_count(db, existing):
                raise _Conflict(f"tier capacity below sold count (tier={existing.id})")
            # ── W5-COMMERCE: 가격 변경 이력 기록 ──────────────────────────────
            # go `price_history` 는 **writer 가 하나도 없어** 화면이 늘 비어 있던 반쪽
            # 기능이었다. 가격 정본이 이 티어 한 곳이므로 여기서 기록하면 누락 경로가 없다.
            # (신규 티어 생성은 "변경"이 아니라 기록하지 않는다.)
            _old_price = Decimal(str(existing.base_price or 0))
            _new_price = Decimal(str(t.base_price or 0))
            if _old_price != _new_price:
                db.add(
                    TierPriceHistory(
                        tier_id=existing.id,
                        old_price=_old_price,
                        new_price=_new_price,
                        reason="tier_upsert",
                    )
                )
            existing.name = t.name
            existing.capacity = cap
            existing.base_price = t.base_price
            existing.sale_mode = sm
            if t.face_price is not None:
                existing.face_price = t.face_price
            if t.min_price is not None:
                existing.min_price = t.min_price
            if t.max_price_cap is not None:
                existing.max_price_cap = t.max_price_cap
            if t.seating_type is not None:
                existing.seating_type = t.seating_type
            if t.raffle_number_base is not None:
                existing.raffle_number_base = t.raffle_number_base
            existing.bidding_opens_at = opens_at
            existing.bidding_closes_at = closes_at
            _apply_tier_meta(existing, t)
            tier = existing
        else:
            # 판매 계획(공정 추첨 등)을 세운 뒤 새로 추가한 입장권 등급은 그 계획의 첫 주 단계
            # 방식을 따른다. 등급 추가 화면은 판매 방식을 묻지 않아 기본값(fixed_fcfs)이 오므로,
            # 기본값일 때만 계획을 따르고 명시한 방식(추첨·대기열 등)은 그대로 둔다.
            if sm == "fixed_fcfs" and (getattr(t, "product_type", None) or "ticket") == "ticket":
                from app.services.sale_phase_service import plan_tier_sale_mode

                sm = await plan_tier_sale_mode(db, event_id) or sm
            tier = SeatTier(
                event_id=event_id,
                external_ref=t.external_ref,
                name=t.name,
                capacity=cap,
                base_price=t.base_price,
                raffle_number_base=t.raffle_number_base,
                sale_mode=sm,
                face_price=t.face_price or 0.0,
                min_price=t.min_price or 0.0,
                max_price_cap=t.max_price_cap or 0.0,
                seating_type=t.seating_type or "assigned",
                bidding_opens_at=opens_at,
                bidding_closes_at=closes_at,
            )
            _apply_tier_meta(tier, t)
            db.add(tier)
            await db.flush()
        mapping.append({"external_ref": t.external_ref, "tier_id": str(tier.id)})
    # ── replace: 페이로드에 없는 미판매 GA 팬텀 티어 정리(티어 DELETE sync 갭 해소). ──
    deleted = 0
    if body.replace:
        keep = {t.external_ref for t in body.tiers if t.external_ref}
        existing_all = (
            await db.execute(select(SeatTier).where(SeatTier.event_id == event_id))
        ).scalars().all()
        for st in existing_all:
            if st.external_ref is not None and st.external_ref in keep:
                continue  # 이번 페이로드로 유지되는 티어
            # 판매분 보호: sold>0 이면 절대 삭제 안 함.
            if await _tier_sold_count(db, st) > 0:
                continue
            # 좌석맵 있는 지정석 티어(seats>0)는 자동삭제 대상 아님(FK/hold 위험) — GA 팬텀만.
            seat_total = (
                await db.execute(
                    select(func.count()).select_from(Seat).where(Seat.tier_id == st.id)
                )
            ).scalar() or 0
            if seat_total > 0:
                continue
            await db.delete(st)
            deleted += 1
        if deleted:
            await db.flush()
            logger.info("internal tiers replace: event=%s deleted_phantom=%s", event_id, deleted)
    # event.total_seats + min/max_price 를 tier 집계로 동기화(소비자 노출 필드 정합 —
    # GO_V2_COMMERCE_SYNC_AUDIT). 판매 가능(capacity>0) tier 의 base_price 기준.
    agg = (
        await db.execute(
            select(
                func.coalesce(func.sum(SeatTier.capacity), 0),
                func.min(SeatTier.base_price),
                func.max(SeatTier.base_price),
            ).where(SeatTier.event_id == event_id, SeatTier.capacity > 0)
        )
    ).one()
    total_cap = int(agg[0] or 0)
    ev = await db.get(Event, event_id)
    if ev is not None:
        if total_cap > 0:
            ev.total_seats = total_cap
        if agg[1] is not None:
            ev.min_price = agg[1]
        if agg[2] is not None:
            ev.max_price = agg[2]
    await _commit_or_conflict(db, "tier (external_ref)")
    # 소비자 노출 캐시 무효화 — min/max_price·total_seats 변경이 공개 API 에 즉시 반영되게.
    # (순환 import 회피: 함수 내 지역 import)
    from app.api.v1.events import _invalidate_event_caches

    await _invalidate_event_caches(event_id)
    logger.info("internal tiers upsert: event=%s n=%s", event_id, len(body.tiers))
    return {"event_id": str(event_id), "tiers": mapping, "deleted": deleted}


async def _do_upsert_seats(db: AsyncSession, event_id: uuid.UUID, body: SeatsRequest) -> dict:
    await _require_event(db, event_id)
    # tier_ref(external) → tier_id 해석맵
    refs = {s.tier_ref for s in body.seats if s.tier_ref}
    ref_to_id: dict[str, uuid.UUID] = {}
    if refs:
        rows = (
            await db.execute(
                select(SeatTier.external_ref, SeatTier.id).where(
                    SeatTier.external_ref.in_(refs),
                    SeatTier.event_id == event_id,  # 같은 이벤트 tier 만 해석
                )
            )
        ).all()
        ref_to_id = {r: i for r, i in rows}

    created = updated = protected = 0
    protected_refs: list[str] = []
    seat_objs: list[tuple[Seat, str | None]] = []  # (seat, external_ref) — 응답 매핑용
    for s in body.seats:
        tier_id = s.tier_id
        if tier_id is None and s.tier_ref:
            tier_id = ref_to_id.get(s.tier_ref)
        if tier_id is None:
            raise ApiError("TIER_NOT_FOUND", f"tier_ref/tier_id unresolved for seat {s.external_ref}", 404, "tier_ref")

        existing = None
        if s.external_ref:
            existing = (
                await db.execute(
                    select(Seat).where(
                        Seat.external_ref == s.external_ref,
                        Seat.event_id == event_id,  # 크로스이벤트 seat 오염 차단
                    )
                )
            ).scalar_one_or_none()

        # 명시 status 파싱(reserved=organizer block 등). SOLD/HELD 는 보호.
        new_status = None
        if s.status:
            try:
                new_status = SeatStatus(s.status.lower())
            except ValueError:
                raise ApiError("VALIDATION_ERROR", f"invalid seat status: {s.status}", 400, "status")

        if existing is not None:
            # 결제 진행/완료 좌석(SOLD/HELD)은 write-through 가 덮어쓰지 않음.
            if existing.status in (SeatStatus.SOLD, SeatStatus.HELD):
                existing.label = s.label
                existing.quality_score = s.quality_score
                protected += 1
                if s.external_ref:
                    protected_refs.append(s.external_ref)
                seat_objs.append((existing, s.external_ref))  # id 매핑은 반환(좌석 앵커)
                continue
            existing.tier_id = tier_id
            existing.section = s.section
            existing.row_number = s.row_number
            existing.seat_number = s.seat_number
            existing.quality_score = s.quality_score
            existing.x = s.x
            existing.y = s.y
            existing.label = s.label
            existing.is_obstructed = s.is_obstructed
            if new_status is not None:
                existing.status = new_status
            updated += 1
            seat_objs.append((existing, s.external_ref))
        else:
            seat = Seat(
                event_id=event_id,
                tier_id=tier_id,
                external_ref=s.external_ref,
                section=s.section,
                row_number=s.row_number,
                seat_number=s.seat_number,
                quality_score=s.quality_score,
                x=s.x,
                y=s.y,
                label=s.label,
                is_obstructed=s.is_obstructed,
                status=new_status or SeatStatus.AVAILABLE,
            )
            db.add(seat)
            created += 1
            seat_objs.append((seat, s.external_ref))
    # ── replace(레벨2 T1): 페이로드에 없는 좌석 정리 — 빌더 레이아웃 전체교체 대응. ──
    # go seats 스테이징이 사라지면서 "DELETE FROM seats + 재INSERT" 가 v2 upsert 만으로는
    # 축소(좌석 삭제)를 표현하지 못한다 → 여기서 유령좌석을 제거한다.
    # ★ SOLD/HELD 보호: 결제 진행/완료 좌석은 어떤 경우에도 삭제하지 않는다(재고·티켓 정합).
    # ★ scope_prefix: 빌더는 `smseat:{mapId}:` 로 한정 → 다른 맵/import 경로 좌석 오삭제 차단.
    deleted = 0
    if body.replace:
        keep = {s.external_ref for s in body.seats if s.external_ref}
        existing_all = (
            await db.execute(select(Seat).where(Seat.event_id == event_id))
        ).scalars().all()
        for seat in existing_all:
            ref = seat.external_ref
            if ref is not None and ref in keep:
                continue  # 이번 페이로드로 유지되는 좌석
            if body.scope_prefix is not None and not (ref or "").startswith(body.scope_prefix):
                continue  # 정리 범위 밖(다른 맵·레거시 external_ref) — 보존
            if seat.status in (SeatStatus.SOLD, SeatStatus.HELD):
                continue  # 결제 진행/완료분 보호
            await db.delete(seat)
            deleted += 1
        if deleted:
            logger.info(
                "internal seats replace: event=%s deleted=%s scope=%s",
                event_id, deleted, body.scope_prefix,
            )

    await db.flush()  # 신규 좌석 id 생성(매핑 반환용)
    await _commit_or_conflict(db, "seat (position/external_ref)")
    logger.info(
        "internal seats upsert: event=%s created=%s updated=%s protected=%s deleted=%s",
        event_id, created, updated, protected, deleted,
    )
    # 🔴 좌석 앵커: go 가 v2_seat_id 회수 → 좌석 hold/confirm/release 동작.
    seats_mapping = [{
        "external_ref": ext,
        "seat_id": str(seat.id),
        "section": seat.section, "row_number": seat.row_number, "seat_number": seat.seat_number,
    } for seat, ext in seat_objs]
    return {
        "event_id": str(event_id), "created": created, "updated": updated,
        "protected": protected, "protected_refs": protected_refs,
        "deleted": deleted,
        "seats": seats_mapping,  # [{external_ref,(section,row,num),seat_id}]
    }


async def _tier_sold_count(db: AsyncSession, tier: SeatTier) -> int:
    """판매 수. **좌석 존재 여부**로 분기(좌석 0건==미판매 혼동 방지, CRITICAL-2):
    - 지정석(seats 행 존재): COUNT(seats status IN reserved,sold) — go §6 계약.
    - GA(seats 행 없음): tier.sold_count 가 SSOT.
    """
    seat_total = (
        await db.execute(
            select(func.count()).select_from(Seat).where(Seat.tier_id == tier.id)
        )
    ).scalar() or 0
    if seat_total == 0:
        return int(tier.sold_count or 0)  # GA tier
    seat_sold = (
        await db.execute(
            select(func.count())
            .select_from(Seat)
            .where(Seat.tier_id == tier.id, Seat.status.in_(_SOLD_SEAT_STATUSES))
        )
    ).scalar() or 0
    return int(seat_sold)


async def _batch_tier_sold(db: AsyncSession, tiers: list[SeatTier]) -> dict:
    """여러 tier 의 sold 를 2쿼리로 일괄(N+1 제거, H2). _tier_sold_count 와 동일 분기:
    좌석 있는 tier=좌석 sold COUNT, 좌석 없는 GA tier=tier.sold_count.
    """
    if not tiers:
        return {}
    tier_ids = [t.id for t in tiers]
    # tier 별 전체 좌석수 + 판매 좌석수 한 번에.
    rows = (
        await db.execute(
            select(
                Seat.tier_id,
                func.count(),
                func.count().filter(Seat.status.in_(_SOLD_SEAT_STATUSES)),
            )
            .where(Seat.tier_id.in_(tier_ids))
            .group_by(Seat.tier_id)
        )
    ).all()
    seat_map = {tid: (int(total or 0), int(sold or 0)) for tid, total, sold in rows}
    out = {}
    for t in tiers:
        total, sold = seat_map.get(t.id, (0, 0))
        out[t.id] = sold if total > 0 else int(t.sold_count or 0)
    return out


def _tier_dict(tier: SeatTier, sold: int) -> dict:
    cap = int(tier.capacity or 0)
    return {
        "tier_id": str(tier.id),
        "external_ref": tier.external_ref,
        "name": tier.name,
        "capacity": cap,
        "base_price": float(tier.base_price or 0),
        "sale_mode": tier.sale_mode,
        "sale_window": {
            "opens_at": tier.bidding_opens_at.isoformat() if tier.bidding_opens_at else None,
            "closes_at": tier.bidding_closes_at.isoformat() if tier.bidding_closes_at else None,
        },
        "sold_count": sold,
        "fill_rate": round(sold / cap * 100, 2) if cap else 0.0,
        # ── T2-ORD: go products 메타(go 제거 후 상품 표시/판매규칙의 유일한 출처) ──
        "description": tier.description,
        "product_type": tier.product_type,
        "visibility": tier.visibility,
        "tax_rate": tier.tax_rate,
        "tax_included": tier.tax_included,
        "image_url": tier.image_url,
        "sort_order": tier.sort_order,
        "min_per_order": tier.min_per_order,
        "max_per_order": tier.max_per_order,
        "is_active": tier.is_active,
        "bundle_items": tier.bundle_items,
        # ── W2-PS: go products.stock / seat_tiers 빌더·뷰 메타(go 제거 후 유일 출처) ──
        # stock_limit 은 폼 입력 원본(NULL=무제한). capacity 는 파생 집행값이라 둘 다 노출한다.
        "stock_limit": tier.stock_limit,
        "color_hex": tier.color_hex,
        "seat_map_id": str(tier.seat_map_id) if tier.seat_map_id else None,
        "tier_metadata": tier.tier_metadata,
        "face_price": float(tier.face_price or 0),
        "min_price": float(tier.min_price or 0),
        "max_price_cap": float(tier.max_price_cap or 0),
        "section_name": tier.section_name,
        "seating_type": tier.seating_type,
        "view_description": tier.view_description,
        "distance_from_stage": tier.distance_from_stage,
        "view_rating": tier.view_rating,
        "view_image_url": tier.view_image_url,
        "position_label": tier.position_label,
        "resale_allowed": tier.resale_allowed,
        "resale_max_price": float(tier.resale_max_price or 0),
        "allow_group_tickets": tier.allow_group_tickets,
        "max_group_size": tier.max_group_size,
    }


async def _resolve_tier_ref(
    db: AsyncSession, event_id: uuid.UUID, tier_ref: str
) -> SeatTier | None:
    """`tier_ref` 를 external_ref(go product/tier id) **또는** v2 tier_id 로 해석.

    go 는 상품/티어를 external_ref 로 식별하고(주최자 화면 URL 이 그 값), 타 호출자는 canonical
    tier_id 를 쓴다. 어느 쪽이든 **반드시 이 이벤트 소속**이어야 한다(크로스이벤트 조작 차단).
    """
    tier = (
        await db.execute(
            select(SeatTier).where(
                SeatTier.external_ref == tier_ref, SeatTier.event_id == event_id
            )
        )
    ).scalar_one_or_none()
    if tier is not None:
        return tier
    try:
        tier_uuid = uuid.UUID(tier_ref)
    except (ValueError, AttributeError):
        return None
    tier = await db.get(SeatTier, tier_uuid)
    return tier if tier is not None and tier.event_id == event_id else None


async def _do_delete_tier(db: AsyncSession, event_id: uuid.UUID, tier_ref: str) -> dict:
    """티어 1건 삭제(go 상품/좌석티어 DELETE 의 v2 대응).

    ── 왜 replace=true 로 안 하는가 ──
    replace 는 "페이로드에 없는 티어를 지운다"라서 호출측이 **남은 전체 목록**을 정확히 알아야 하고,
    목록 조회가 실패하면 지우면 안 될 것을 지운다. 단건 삭제는 그 위험이 없다.

    ── 보호 규칙(전부 fail-closed) ──
      - 미존재/타 이벤트 → 404. "이미 없음"을 200 으로 흡수하지 않는다(호출측이 멱등 판단).
      - sold_count > 0 → 409. 판매분 있는 티어는 절대 삭제 불가.
      - 좌석(seats) 이 붙어 있으면 409. FK/hold 안전(replace 의 GA-only 정책과 동일).
    """
    await _require_event(db, event_id)
    tier = await _resolve_tier_ref(db, event_id, tier_ref)
    if tier is None:
        raise ApiError("TIER_NOT_FOUND", f"tier not found: {tier_ref}", 404)
    if await _tier_sold_count(db, tier) > 0:
        raise _Conflict(f"tier has sold items (tier={tier.id})")
    seat_total = (
        await db.execute(select(func.count()).select_from(Seat).where(Seat.tier_id == tier.id))
    ).scalar() or 0
    if seat_total > 0:
        raise _Conflict(f"tier has seats (tier={tier.id}, seats={seat_total})")
    tier_id = str(tier.id)
    await db.delete(tier)
    await db.flush()
    # 삭제 후 event 집계 재계산 — 남은 판매가능 티어 기준(upsert 경로와 동일 규칙).
    agg = (
        await db.execute(
            select(
                func.coalesce(func.sum(SeatTier.capacity), 0),
                func.min(SeatTier.base_price),
                func.max(SeatTier.base_price),
            ).where(SeatTier.event_id == event_id, SeatTier.capacity > 0)
        )
    ).one()
    ev = await db.get(Event, event_id)
    if ev is not None:
        # upsert 경로와 **동일 규칙**: 값이 있을 때만 대입한다.
        # total_seats 는 NOT NULL 이라 0/None 을 그대로 쓰면 IntegrityError 가 난다
        # (마지막 티어를 지운 이벤트의 정원은 직전 값을 유지 — 상세 화면이 비지 않게).
        total_cap = int(agg[0] or 0)
        if total_cap > 0:
            ev.total_seats = total_cap
        if agg[1] is not None:
            ev.min_price = agg[1]
        if agg[2] is not None:
            ev.max_price = agg[2]
    await db.commit()
    from app.api.v1.events import _invalidate_event_caches

    await _invalidate_event_caches(event_id)
    logger.info("internal tier delete: event=%s tier=%s", event_id, tier_id)
    return {"event_id": str(event_id), "tier_id": tier_id, "deleted": True}


@router.post("/events/{event_id}/tiers", summary="go write-through: 상품/티어 배치 upsert")
async def upsert_tiers(
    event_id: uuid.UUID,
    request: Request,
    body: TiersRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        # fingerprint(body 해시): go 가 재편집 시 안정 멱등키(product-tier:{id}·tier-create:{id})를
        # 재사용해 값만 바꿔 보낸다 → fingerprint 없으면 옛 응답 replay 로 편집이 v2 에 미반영(1-Sync).
        return await _idempotent(
            idempotency_key, f"tiers.upsert.{event_id}", lambda: _do_upsert_tiers(db, event_id, body),
            fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


@router.post("/events/{event_id}/seats", summary="go write-through: 좌석 인벤토리 배치 upsert")
async def upsert_seats(
    event_id: uuid.UUID,
    request: Request,
    body: SeatsRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(
            idempotency_key, f"seats.upsert.{event_id}", lambda: _do_upsert_seats(db, event_id, body),
            fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


@router.get("/events/{event_id}/tiers", summary="go live read: 티어 목록")
async def list_tiers(
    event_id: uuid.UUID,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    tiers = (
        await db.execute(select(SeatTier).where(SeatTier.event_id == event_id))
    ).scalars().all()
    sold_map = await _batch_tier_sold(db, tiers)  # H2: N+1 제거
    out = [_tier_dict(t, sold_map.get(t.id, 0)) for t in tiers]
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"tiers": out, "total": len(out)})


@router.delete("/events/{event_id}/tiers/{tier_ref}", summary="go write-through: 티어 단건 삭제")
async def delete_tier(
    event_id: uuid.UUID,
    tier_ref: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """W2-PS — go `products`/`seat_tiers` DELETE 의 v2 대응. `tier_ref` = external_ref 또는 tier_id."""
    try:
        return _ok(await _do_delete_tier(db, event_id, tier_ref))
    except ApiError as e:
        return _err(e)


@router.get("/events/{event_id}/tiers/{tier_id}", summary="go live read: 티어 상세")
async def get_tier(
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    tier = await db.get(SeatTier, tier_id)
    if tier is None or tier.event_id != event_id:
        return _err(ApiError("TIER_NOT_FOUND", f"tier not found: {tier_id}", 404))
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok(_tier_dict(tier, await _tier_sold_count(db, tier)))


@router.get("/events/{event_id}/seats", summary="go live read: 좌석 목록 + 상태 집계")
async def list_seats(
    event_id: uuid.UUID,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    limit: int = 2000,
    offset: int = 0,
):
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    limit = max(1, min(limit, 5000))
    offset = max(0, offset)
    # 상태 집계(seat-analytics 입력)
    status_rows = (
        await db.execute(
            select(Seat.status, func.count())
            .where(Seat.event_id == event_id)
            .group_by(Seat.status)
        )
    ).all()
    status_counts = {s.value if hasattr(s, "value") else str(s): int(c) for s, c in status_rows}
    total = sum(status_counts.values())
    rows = (
        await db.execute(
            select(Seat)
            .where(Seat.event_id == event_id)
            .order_by(Seat.section, Seat.row_number, Seat.seat_number)
            .limit(limit)
            .offset(offset)
        )
    ).scalars().all()
    seats = [
        {
            "seat_id": str(s.id),
            "external_ref": s.external_ref,
            "tier_id": str(s.tier_id),
            "section": s.section,
            "row_number": s.row_number,
            "seat_number": s.seat_number,
            "status": s.status.value if hasattr(s.status, "value") else s.status,
            "quality_score": s.quality_score,
            # 레벨2 영역A — 커머스 좌표 이중보관(렌더 원본은 seat_map_data, 커머스는 seats.x/y).
            # go 가 live read 로 x/y/label/is_obstructed 회수 가능하도록 응답에 포함.
            "x": s.x,
            "y": s.y,
            "label": s.label,
            "is_obstructed": s.is_obstructed,
        }
        for s in rows
    ]
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    # total_seats=이벤트 전체 좌석수(status_counts 합), page_count=이번 페이지 반환수(IMPORTANT-4).
    return _ok({
        "seats": seats, "status_counts": status_counts,
        "total_seats": total, "page_count": len(seats),
        "limit": limit, "offset": offset,
    })


# ════════════════════════════════════════════════════════════════════════
# 레벨2 영역A — 좌석맵 템플릿 라이브러리 (go seat_map_templates 흡수)
#   go account_id(organizer) 경계로 격리. 시스템 시드(organizer_id NULL) + 조직 저장 템플릿.
# ════════════════════════════════════════════════════════════════════════

_VALID_TEMPLATE_CATEGORIES = {
    "concert", "theater", "festival", "booth", "convention", "sports", "custom",
}


class SeatMapTemplateCreate(BaseModel):
    # go 는 account_id(UUID) 로 조직을 식별 → organizer_ref 로 전달(go_account_id).
    organizer_ref: OrganizerRef | None = None
    name: str = Field(..., min_length=1, max_length=200)
    description: str | None = None
    category: str
    layout: dict
    thumbnail_url: str | None = None


def _template_dict(row: SeatMapTemplate) -> dict:
    return {
        "id": str(row.id),
        "organizer_id": str(row.organizer_id) if row.organizer_id else None,
        "name": row.name,
        "description": row.description,
        "category": row.category,
        "thumbnail_url": row.thumbnail_url,
        "layout": row.layout,
        "is_system": row.is_system,
        "created_at": row.created_at.isoformat() if row.created_at else None,
    }


def _resolve_go_account_id(ref: OrganizerRef | None) -> uuid.UUID | None:
    """템플릿 소유 경계 — go account_id(UUID) 를 그대로 organizer_id 컬럼에 저장.

    go 의 account_id 는 v2 user_id 와 별개(FK 없음). organizer_ref.go_account_id 우선,
    없으면 organizer_id(값 자체가 go account_id 인 케이스도 수용). None → 시스템 시드만 조회.
    """
    if ref is None:
        return None
    raw = ref.go_account_id or (str(ref.organizer_id) if ref.organizer_id else None)
    if not raw:
        return None
    try:
        return uuid.UUID(str(raw))
    except (ValueError, AttributeError, TypeError):
        raise ApiError("VALIDATION_ERROR", "organizer_ref must be a UUID account id", 400, "organizer_ref")


@router.get("/seat-map-templates", summary="go live read: 좌석맵 템플릿(시스템 + 조직)")
async def list_seat_map_templates(
    request: Request,
    response: Response,
    go_account_id: str | None = None,
    category: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    try:
        account_uuid = _resolve_go_account_id(
            OrganizerRef(go_account_id=go_account_id) if go_account_id else None
        )
    except ApiError as e:
        return _err(e)
    # 시스템 시드(is_system) OR 자기 조직 템플릿만 — 크로스테넌트 격리.
    conds = [SeatMapTemplate.is_system.is_(True)]
    if account_uuid is not None:
        conds.append(SeatMapTemplate.organizer_id == account_uuid)
    from sqlalchemy import or_
    stmt = select(SeatMapTemplate).where(or_(*conds))
    if category:
        stmt = stmt.where(SeatMapTemplate.category == category)
    stmt = stmt.order_by(SeatMapTemplate.is_system.desc(), SeatMapTemplate.created_at.desc())
    rows = (await db.execute(stmt)).scalars().all()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"templates": [_template_dict(r) for r in rows], "total": len(rows)})


async def _do_create_seat_map_template(db: AsyncSession, body: SeatMapTemplateCreate) -> dict:
    if body.category not in _VALID_TEMPLATE_CATEGORIES:
        raise ApiError("VALIDATION_ERROR", f"invalid category: {body.category}", 400, "category")
    if not isinstance(body.layout, dict) or not body.layout:
        raise ApiError("VALIDATION_ERROR", "layout must be a non-empty object", 400, "layout")
    if len(json.dumps(body.layout, ensure_ascii=False).encode("utf-8")) > _SEATMAP_MAX_JSON_BYTES:
        raise ApiError("VALIDATION_ERROR", "layout payload too large", 400, "layout")
    account_uuid = _resolve_go_account_id(body.organizer_ref)
    if account_uuid is None:
        raise ApiError("VALIDATION_ERROR", "organizer_ref required for template save", 400, "organizer_ref")
    tpl = SeatMapTemplate(
        organizer_id=account_uuid,
        name=body.name,
        description=body.description,
        category=body.category,
        layout=body.layout,
        thumbnail_url=body.thumbnail_url,
        is_system=False,
    )
    db.add(tpl)
    await db.flush()
    await db.commit()
    return _template_dict(tpl)


@router.post("/seat-map-templates", summary="go write-through: 조직 좌석맵 템플릿 저장")
async def create_seat_map_template(
    request: Request,
    body: SeatMapTemplateCreate,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(
            idempotency_key, "seat_map_templates.create",
            lambda: _do_create_seat_map_template(db, body),
            fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


@router.delete("/seat-map-templates/{template_id}", summary="go write-through: 조직 좌석맵 템플릿 삭제")
async def delete_seat_map_template(
    template_id: uuid.UUID,
    request: Request,
    go_account_id: str | None = None,
    db: AsyncSession = Depends(get_db),
):
    try:
        account_uuid = _resolve_go_account_id(
            OrganizerRef(go_account_id=go_account_id) if go_account_id else None
        )
    except ApiError as e:
        return _err(e)
    if account_uuid is None:
        return _err(ApiError("VALIDATION_ERROR", "go_account_id required", 400, "go_account_id"))
    tpl = await db.get(SeatMapTemplate, template_id)
    # 크로스테넌트 격리 + 시스템 시드 보호(is_system 은 삭제 불가).
    if tpl is None or tpl.is_system or tpl.organizer_id != account_uuid:
        return _err(ApiError("TEMPLATE_NOT_FOUND", f"template not found: {template_id}", 404))
    await db.delete(tpl)
    await db.commit()
    return _ok({"deleted": True, "id": str(template_id)})


# ════════════════════════════════════════════════════════════════════════
# Slice C — content (participants / notices / facilities) (write+read)
# ════════════════════════════════════════════════════════════════════════


class ParticipantIn(BaseModel):
    name: str
    role: str | None = None
    bio: str | None = None
    image_url: str | None = None
    sort_order: int = 0


class NoticeIn(BaseModel):
    title: str
    notice_type: str | None = None
    content: str | None = None
    published_at: str | None = None


class FacilityIn(BaseModel):
    name: str
    category: str | None = None
    quantity: int | None = None
    status: str | None = None


class ContentRequest(BaseModel):
    participants: list[ParticipantIn] | None = Field(None, max_length=1000)
    notices: list[NoticeIn] | None = Field(None, max_length=1000)
    facilities: list[FacilityIn] | None = Field(None, max_length=1000)


async def _do_put_content(db: AsyncSession, event_id: uuid.UUID, body: ContentRequest) -> dict:
    await _require_event(db, event_id)
    counts = {}
    # 전체 교체(PUT 시맨틱) — 제공된 섹션만 교체, 미제공(None) 섹션은 보존.
    if body.participants is not None:
        await db.execute(EventParticipant.__table__.delete().where(EventParticipant.event_id == event_id))
        for p in body.participants:
            db.add(EventParticipant(
                event_id=event_id, name=p.name, role=p.role, bio=p.bio,
                image_url=p.image_url, sort_order=p.sort_order,
            ))
        counts["participants"] = len(body.participants)
    if body.notices is not None:
        await db.execute(EventAnnouncement.__table__.delete().where(EventAnnouncement.event_id == event_id))
        for n in body.notices:
            db.add(EventAnnouncement(
                event_id=event_id, title=n.title, notice_type=n.notice_type, content=n.content,
                published_at=_parse_dt(n.published_at, "published_at") if n.published_at else None,
            ))
        counts["notices"] = len(body.notices)
    if body.facilities is not None:
        await db.execute(EventFacility.__table__.delete().where(EventFacility.event_id == event_id))
        for f in body.facilities:
            db.add(EventFacility(
                event_id=event_id, name=f.name, category=f.category,
                quantity=f.quantity, status=f.status,
            ))
        counts["facilities"] = len(body.facilities)
    await _commit_or_conflict(db, "content")
    logger.info("internal content put: event=%s %s", event_id, counts)
    return {"event_id": str(event_id), "counts": counts}


@router.put("/events/{event_id}/content", summary="go write-through: 소비자 노출 콘텐츠")
async def put_content(
    event_id: uuid.UUID,
    request: Request,
    body: ContentRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        # fingerprint(body 해시): go 는 출연진/공지/시설 단건 편집마다 안정 멱등키
        # `content.{section}.{eventId}.patch.{itemId}` 로 섹션 전체를 재PUT 한다. fingerprint 없으면
        # 같은 항목을 두 번 편집(같은 키·다른 body)할 때 옛 응답 replay 로 두 번째 편집이 v2 에
        # 미반영(1-Sync). 섹션 재PUT 이 전량 재조회라 값 변경 시 fingerprint 도 바뀜 → 반영 보장.
        return await _idempotent(
            idempotency_key, f"content.put.{event_id}", lambda: _do_put_content(db, event_id, body),
            fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


@router.get("/events/{event_id}/content", summary="go live read: 소비자 노출 콘텐츠")
async def get_content(
    event_id: uuid.UUID,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    participants = (
        await db.execute(
            select(EventParticipant).where(EventParticipant.event_id == event_id)
            .order_by(EventParticipant.sort_order)
        )
    ).scalars().all()
    notices = (
        await db.execute(select(EventAnnouncement).where(EventAnnouncement.event_id == event_id))
    ).scalars().all()
    facilities = (
        await db.execute(select(EventFacility).where(EventFacility.event_id == event_id))
    ).scalars().all()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({
        "participants": [
            {"name": p.name, "role": p.role, "bio": p.bio, "image_url": p.image_url, "sort_order": p.sort_order}
            for p in participants
        ],
        "notices": [
            {"title": n.title, "notice_type": n.notice_type, "content": n.content,
             "published_at": n.published_at.isoformat() if n.published_at else None}
            for n in notices
        ],
        "facilities": [
            {"name": f.name, "category": f.category, "quantity": f.quantity, "status": f.status}
            for f in facilities
        ],
    })


# ════════════════════════════════════════════════════════════════════════
# 트랙B U2 — event_page (랜딩 편집 write-through). go homepage_design(JSON)을
# v2 event_pages(subdomain 랜딩 SoT)로 흘려보낸다. 소비자 화이트라벨 /s/{slug} 가
# page_theme·page_data(Puck)를 소비. event_id 1:1(unique) 멱등 upsert.
# 매핑 정의·손실 항목은 go 측 homepage-design-mapping.ts 참조.
# ════════════════════════════════════════════════════════════════════════


# event_pages.subdomain_slug 검증(event_pages.py 와 동일 규약). 3~60자, 소문자 영숫자+하이픈.
_EP_SLUG_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")
_EP_RESERVED_SLUGS = {
    "www", "api", "admin", "studio", "staging", "cdn",
    "assets", "mail", "status", "app", "auth", "help",
    "support", "blog", "docs", "dev", "test", "demo",
}


def _normalize_ep_slug(raw: str) -> str:
    """이벤트 slug → 유효한 subdomain_slug. 무효문자 제거·길이보정·예약어 회피."""
    v = re.sub(r"[^a-z0-9-]+", "-", (raw or "").lower()).strip("-")
    if len(v) < 3:
        v = f"{v}-page" if v else "event-page"
    v = v[:60].strip("-")
    if v in _EP_RESERVED_SLUGS or len(v) < 3:
        v = f"{v}-e"[:60]
    return v


class EventPageUpsert(BaseModel):
    """go homepage_design 매핑 결과. 전부 optional(부분 patch, 미제공=보존).

    - subdomain_slug 미제공 시 최초 생성에서 event.slug 로 자동 파생(재호출은 기존 유지).
    - page_theme 는 병합(camelCase 키만 갱신). page_data(Puck)/sections/white_label_config 는 전체교체.
    """
    subdomain_slug: str | None = None
    page_template: str | None = None
    page_theme: dict | None = None
    page_data: dict | None = None
    sections: list[dict] | None = None
    white_label: bool | None = None
    white_label_config: dict | None = None
    page_published: bool | None = None

    @field_validator("subdomain_slug")
    @classmethod
    def _validate_slug(cls, v: str | None) -> str | None:
        if v is None:
            return v
        v = v.lower().strip()
        if len(v) < 3 or len(v) > 60 or not _EP_SLUG_PATTERN.match(v) or v in _EP_RESERVED_SLUGS:
            raise ValueError("invalid subdomain_slug")
        return v


async def _do_upsert_event_page(db: AsyncSession, event_id: uuid.UUID, body: EventPageUpsert) -> dict:
    event = await _require_event(db, event_id)
    page = (
        await db.execute(select(EventPage).where(EventPage.event_id == event_id))
    ).scalar_one_or_none()

    created = page is None
    if page is None:
        # 최초 생성: subdomain_slug 확정(명시값 우선, 없으면 event.slug 파생).
        slug = body.subdomain_slug or _normalize_ep_slug(event.slug or event_id.hex[:12])
        page = EventPage(event_id=event_id, subdomain_slug=slug)
        db.add(page)
    elif body.subdomain_slug is not None:
        # 재호출: 명시적으로 슬러그를 바꿀 때만 갱신(미제공=기존 유지, URL 안정).
        page.subdomain_slug = body.subdomain_slug

    if body.page_template is not None:
        page.page_template = body.page_template
    if body.page_theme is not None:
        # 병합: 기존 테마 키 보존 + 신규 키 덮어쓰기(부분 patch, 미전달 색토큰 유실 방지).
        merged = dict(page.page_theme or {})
        merged.update(body.page_theme)
        page.page_theme = merged
    if body.page_data is not None:
        page.page_data = body.page_data  # Puck JSON 전체교체
    if body.sections is not None:
        page.sections = body.sections  # 섹션 전체교체
    if body.white_label is not None:
        page.white_label = body.white_label
    if body.white_label_config is not None:
        page.white_label_config = body.white_label_config
    if body.page_published is not None:
        page.page_published = body.page_published
        if body.page_published and page.published_at is None:
            page.published_at = datetime.now(timezone.utc)

    await _commit_or_conflict(db, "event_page (event_id/subdomain_slug)")
    await db.refresh(page)
    logger.info(
        "internal event_page upsert: event=%s slug=%s created=%s published=%s",
        event_id, page.subdomain_slug, created, page.page_published,
    )
    return {
        "event_id": str(event_id),
        "page_id": str(page.id),
        "subdomain_slug": page.subdomain_slug,
        "page_published": page.page_published,
        "created": created,
    }


@router.put("/events/{event_id}/event-page", summary="go write-through: 랜딩(event_page) 설정")
async def put_event_page(
    event_id: uuid.UUID,
    request: Request,
    body: EventPageUpsert,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        # fingerprint(body 해시): go 는 랜딩 저장마다 안정 멱등키(event-page.{eventId})를 쓴다.
        # 같은 키+다른 body(디자인 재편집) 는 fingerprint 로 옛 응답 replay 를 차단해 반영 보장.
        return await _idempotent(
            idempotency_key, f"event-page.put.{event_id}",
            lambda: _do_upsert_event_page(db, event_id, body),
            fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


# ════════════════════════════════════════════════════════════════════════
# Slice D — discount codes (write+read).  affiliate 는 Wave3(모델 신설)에서.
# ════════════════════════════════════════════════════════════════════════


class DiscountCodeUpsert(BaseModel):
    code: str = Field(..., min_length=1, max_length=50)
    discount_type: str  # percentage | fixed (DiscountCodeType)
    rate: float | None = None
    amount: float | None = None
    max_uses: int | None = None
    valid_from: str | None = None
    valid_until: str | None = None
    applicable_tiers: str | None = None
    min_order_amount: float | None = None
    max_discount_amount: float | None = None
    description: str | None = None
    is_active: bool = True


class DiscountCodesRequest(BaseModel):
    codes: list[DiscountCodeUpsert] = Field(..., min_length=1, max_length=1000)


_VALID_DISCOUNT_TYPES = {t.value for t in DiscountCodeType}


async def _do_upsert_discount_codes(db: AsyncSession, event_id: uuid.UUID, body: DiscountCodesRequest) -> dict:
    await _require_event(db, event_id)
    out = []
    for c in body.codes:
        dt = c.discount_type.lower()
        if dt not in _VALID_DISCOUNT_TYPES:
            raise ApiError("VALIDATION_ERROR", f"invalid discount_type: {c.discount_type}", 400, "discount_type")
        existing = (
            await db.execute(
                select(DiscountCode).where(
                    DiscountCode.event_id == event_id, DiscountCode.code == c.code
                )
            )
        ).scalar_one_or_none()
        vf = _parse_dt(c.valid_from, "valid_from") if c.valid_from else None
        vu = _parse_dt(c.valid_until, "valid_until") if c.valid_until else None
        if existing is not None:
            # used_count 는 v2 가 주문 시 차감(go 가 보내지 않음) → 보존.
            existing.discount_type = DiscountCodeType(dt)
            existing.rate = c.rate
            existing.amount = c.amount
            existing.max_uses = c.max_uses
            existing.valid_from = vf
            existing.valid_until = vu
            existing.applicable_tiers = c.applicable_tiers
            existing.min_order_amount = c.min_order_amount
            existing.max_discount_amount = c.max_discount_amount
            existing.description = c.description
            existing.is_active = c.is_active
            code = existing
        else:
            code = DiscountCode(
                event_id=event_id, code=c.code, discount_type=DiscountCodeType(dt),
                rate=c.rate, amount=c.amount, max_uses=c.max_uses,
                valid_from=vf, valid_until=vu, applicable_tiers=c.applicable_tiers,
                min_order_amount=c.min_order_amount, max_discount_amount=c.max_discount_amount,
                description=c.description, is_active=c.is_active,
            )
            db.add(code)
            await db.flush()
        out.append({"code": code.code, "discount_code_id": str(code.id)})
    await _commit_or_conflict(db, "discount code (event_id, code)")
    logger.info("internal discount-codes upsert: event=%s n=%s", event_id, len(body.codes))
    return {"event_id": str(event_id), "codes": out}


@router.post("/events/{event_id}/discount-codes", summary="go write-through: 할인코드 배치 upsert")
async def upsert_discount_codes(
    event_id: uuid.UUID,
    request: Request,
    body: DiscountCodesRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        # fingerprint(body 해시): go syncDiscountCode 는 안정 멱등키 `promo-code:{id}` 를 생성/편집
        # 양쪽에서 재사용한다 → fingerprint 없으면 편집(값 변경)이 옛 응답 replay 로 무시돼 v2 미반영.
        # (1-Sync) 값이 같은 정상 재시도는 fingerprint 동일 → 여전히 replay(멱등 보존).
        return await _idempotent(
            idempotency_key, f"discount.upsert.{event_id}", lambda: _do_upsert_discount_codes(db, event_id, body),
            fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


@router.get("/events/{event_id}/discount-codes", summary="go live read: 할인코드 목록")
async def list_discount_codes(
    event_id: uuid.UUID,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    codes = (
        await db.execute(select(DiscountCode).where(DiscountCode.event_id == event_id))
    ).scalars().all()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({
        "codes": [
            {
                "discount_code_id": str(c.id),
                "code": c.code,
                "discount_type": c.discount_type.value if hasattr(c.discount_type, "value") else c.discount_type,
                "rate": c.rate,
                "amount": float(c.amount) if c.amount is not None else None,
                "max_uses": c.max_uses,
                "used_count": c.used_count,
                "is_active": c.is_active,
            }
            for c in codes
        ],
        "total": len(codes),
    })


# ════════════════════════════════════════════════════════════════════════
# Wave3 W3.1 — affiliates (write+read) + 티켓 체크인 상태
# ════════════════════════════════════════════════════════════════════════


class AffiliateUpsert(BaseModel):
    external_ref: str | None = None
    account_id: str | None = None
    name: str = Field(..., min_length=1, max_length=200)
    code: str = Field(..., min_length=1, max_length=50)
    commission_rate: float = 0.0  # percent, e.g. 10.0
    status: str = "active"


class AffiliatesRequest(BaseModel):
    affiliates: list[AffiliateUpsert] = Field(..., min_length=1, max_length=1000)


async def _do_upsert_affiliates(db: AsyncSession, event_id: uuid.UUID, body: AffiliatesRequest) -> dict:
    await _require_event(db, event_id)
    out = []
    for a in body.affiliates:
        if a.commission_rate < 0 or a.commission_rate > 100:
            raise ApiError("VALIDATION_ERROR", f"commission_rate out of range: {a.commission_rate}", 400, "commission_rate")
        existing = (
            await db.execute(
                select(Affiliate).where(
                    Affiliate.event_id == event_id, Affiliate.code == a.code
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            existing.external_ref = a.external_ref or existing.external_ref
            existing.account_id = a.account_id
            existing.name = a.name
            existing.commission_rate = a.commission_rate
            existing.status = a.status
            aff = existing
        else:
            aff = Affiliate(
                event_id=event_id, external_ref=a.external_ref, account_id=a.account_id,
                name=a.name, code=a.code, commission_rate=a.commission_rate, status=a.status,
            )
            db.add(aff)
            await db.flush()
        out.append({"external_ref": a.external_ref, "affiliate_id": str(aff.id), "code": aff.code})
    await _commit_or_conflict(db, "affiliate (event_id, code)")
    logger.info("internal affiliates upsert: event=%s n=%s", event_id, len(body.affiliates))
    return {"event_id": str(event_id), "affiliates": out}


@router.put("/events/{event_id}/affiliates", summary="go write-through: 제휴 정의 배치 upsert")
async def upsert_affiliates(
    event_id: uuid.UUID,
    request: Request,
    body: AffiliatesRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(
            idempotency_key, f"affiliates.upsert.{event_id}",
            lambda: _do_upsert_affiliates(db, event_id, body), fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


@router.get("/events/{event_id}/affiliates", summary="go live read: 제휴 목록")
async def list_affiliates(
    event_id: uuid.UUID,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    affs = (
        await db.execute(
            select(Affiliate)
            .where(Affiliate.event_id == event_id)
            .order_by(Affiliate.created_at.asc())
        )
    ).scalars().all()
    # 전환 집계(count·수수료합계) — go 대시보드 read-flip 대상. affiliate_conversions 를
    # affiliate_id 로 group by. 빈 목록이면 조회 skip(in_([]) 회피).
    agg: dict[uuid.UUID, tuple[int, int]] = {}
    if affs:
        conv_rows = (
            await db.execute(
                select(
                    AffiliateConversion.affiliate_id,
                    func.count(AffiliateConversion.id),
                    func.coalesce(func.sum(AffiliateConversion.commission_amount), 0),
                )
                .where(AffiliateConversion.affiliate_id.in_([a.id for a in affs]))
                .group_by(AffiliateConversion.affiliate_id)
            )
        ).all()
        agg = {row[0]: (int(row[1]), int(row[2])) for row in conv_rows}
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({
        "affiliates": [
            {
                "affiliate_id": str(a.id), "external_ref": a.external_ref,
                "account_id": a.account_id, "name": a.name, "code": a.code,
                "commission_rate": float(a.commission_rate), "status": a.status,
                "conversion_count": agg.get(a.id, (0, 0))[0],
                "commission_total": agg.get(a.id, (0, 0))[1],
            }
            for a in affs
        ],
        "total": len(affs),
    })


@router.get(
    "/events/{event_id}/affiliates/{affiliate_ref}",
    summary="go live read: 제휴 상세 + 전환 목록",
)
async def get_affiliate_detail(
    event_id: uuid.UUID,
    affiliate_ref: str,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """affiliate_ref = go affiliate id(external_ref). go 상세 대시보드 read-flip 대상.
    conversion 은 order external_ref(go order id)를 함께 반환 → go 는 표시용 주문번호만
    orders 앵커에서 배치 조회(affiliate/conversion 자체는 v2 정본)."""
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    try:
        affiliate_uuid = uuid.UUID(affiliate_ref)
    except ValueError:
        affiliate_uuid = None
    ref_predicate = Affiliate.external_ref == affiliate_ref
    if affiliate_uuid is not None:
        ref_predicate = ref_predicate | (Affiliate.id == affiliate_uuid)
    aff = (
        await db.execute(
            select(Affiliate).where(
                Affiliate.event_id == event_id,
                ref_predicate,
            )
        )
    ).scalar_one_or_none()
    if aff is None:
        return _err(ApiError("AFFILIATE_NOT_FOUND", f"affiliate not found: {affiliate_ref}", 404))
    conv_rows = (
        await db.execute(
            select(AffiliateConversion, Order.external_ref)
            .join(Order, Order.id == AffiliateConversion.order_id)
            .where(AffiliateConversion.affiliate_id == aff.id)
            .order_by(AffiliateConversion.created_at.desc())
        )
    ).all()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({
        "affiliate": {
            "affiliate_id": str(aff.id), "external_ref": aff.external_ref,
            "account_id": aff.account_id, "name": aff.name, "code": aff.code,
            "commission_rate": float(aff.commission_rate), "status": aff.status,
            "created_at": aff.created_at.isoformat() if aff.created_at else None,
        },
        "conversions": [
            {
                "id": str(c.id),
                "order_ref": order_ref,  # go order id(external_ref) — 표시 주문번호 매핑용
                "order_amount": int(c.order_amount),
                "commission_amount": int(c.commission_amount),
                "created_at": c.created_at.isoformat() if c.created_at else None,
            }
            for c, order_ref in conv_rows
        ],
    })


class AffiliatePatchRequest(BaseModel):
    name: str | None = None
    commission_rate: float | None = None
    status: str | None = None


@router.patch(
    "/events/{event_id}/affiliates/{affiliate_ref}",
    summary="go write-through: 제휴 부분수정",
)
async def patch_affiliate(
    event_id: uuid.UUID,
    affiliate_ref: str,
    body: AffiliatePatchRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """affiliate_ref = go affiliate id(external_ref). name/commission_rate/status 부분수정.
    code 는 불변(멱등 upsert 키). go dual-write cutover 대상."""
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    try:
        affiliate_uuid = uuid.UUID(affiliate_ref)
    except ValueError:
        affiliate_uuid = None
    ref_predicate = Affiliate.external_ref == affiliate_ref
    if affiliate_uuid is not None:
        ref_predicate = ref_predicate | (Affiliate.id == affiliate_uuid)
    aff = (
        await db.execute(
            select(Affiliate).where(
                Affiliate.event_id == event_id,
                ref_predicate,
            )
        )
    ).scalar_one_or_none()
    if aff is None:
        return _err(ApiError("AFFILIATE_NOT_FOUND", f"affiliate not found: {affiliate_ref}", 404))
    if body.name is not None:
        aff.name = body.name
    if body.commission_rate is not None:
        aff.commission_rate = body.commission_rate
    if body.status is not None:
        aff.status = body.status
    await db.commit()
    return _ok({"affiliate_id": str(aff.id), "external_ref": aff.external_ref, "updated": True})


@router.delete(
    "/events/{event_id}/affiliates/{affiliate_ref}",
    summary="go write-through: 제휴 삭제(전환기록 CASCADE)",
)
async def delete_affiliate(
    event_id: uuid.UUID,
    affiliate_ref: str,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Soft-delete an affiliate while preserving commission evidence."""
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    try:
        affiliate_uuid = uuid.UUID(affiliate_ref)
    except ValueError:
        affiliate_uuid = None
    ref_predicate = Affiliate.external_ref == affiliate_ref
    if affiliate_uuid is not None:
        ref_predicate = ref_predicate | (Affiliate.id == affiliate_uuid)
    aff = (
        await db.execute(
            select(Affiliate).where(
                Affiliate.event_id == event_id,
                ref_predicate,
            )
        )
    ).scalar_one_or_none()
    if aff is None:
        return _ok({"deleted": True, "already_absent": True})
    aff.status = "inactive"
    await db.commit()
    return _ok({"deleted": True, "soft_deleted": True})


# 체크인 `at` 의 미래 허용 오차. 기기 시계 드리프트만 흡수하고, **입장일(KST)을 바꿀 만큼은
# 아니게** 작게 둔다. 자정 직전 몇 분은 이 오차로도 날짜가 넘어갈 수 있으나, 하루를 통째로
# 건너뛰는 조작(주중권으로 이틀 입장)은 차단된다.
_CHECKIN_FUTURE_SKEW = timedelta(minutes=5)


class CheckInRequest(BaseModel):
    at: str | None = None  # ISO 시각(미제공 시 서버 now)


async def _do_check_in(db: AsyncSession, ticket_id: uuid.UUID, body: CheckInRequest) -> dict:
    """F1: 게이트 정본 체크인 경로. 멱등·부작용 SoT = admit()/event_admissions.

    - checked_in_at≠null 스칼라 멱등 제거 → admit() 이 오늘 원장(event_admissions)으로 멱등 판정.
      (다일 붕괴 P0 해소: allpass 2일차 스캔이 스칼라 때문에 already 로 오판되지 않음.)
    - 응답에 admission_mode·attended_date 추가(cross-request: go/app 계약 확장 §4).
    """
    ticket = await db.get(Ticket, ticket_id)
    if ticket is None:
        raise ApiError("TICKET_NOT_FOUND", f"ticket not found: {ticket_id}", 404)
    event = await db.get(Event, ticket.event_id)
    if event is None:
        raise ApiError("EVENT_NOT_FOUND", f"event not found: {ticket.event_id}", 404)

    # 🔴 `at` 은 **클라이언트가 준 값**이다(go 오프라인 동기화가 현장 실입장 시각을 싣는다).
    #    미래 시각을 허용하면 입장일을 **원하는 날로 지정**할 수 있다:
    #      목요일에 `at=금요일` 로 스캔 → daypass 가 금요일로 확정 → 목요일 실입장은 원장 무흔적
    #      → 금요일에 정상 스캔하면 reentry_ok → **주중권 1장으로 목+금 이틀 입장**(원장은 깨끗).
    #    admit() 은 입장'일' 규칙만 보고 "그 시각이 실재하는가"는 판정하지 않는다 —
    #    미래 검사는 여기(신뢰 경계)가 유일한 자리다.
    #
    #    과거 방향은 막지 않는다: 오프라인 큐가 몇 시간 뒤에 올라오는 것이 정상 동작이고,
    #    single 모드는 의도적으로 이벤트 기간을 강제하지 않는다(사전/현장 사정).
    #    허용 오차는 기기 시계 드리프트 흡수용으로만 둔다 — 하루를 건너뛸 수 없는 크기다.
    now = datetime.now(timezone.utc)
    at = _parse_dt(body.at, "at") if body.at else now
    if at > now + _CHECKIN_FUTURE_SKEW:
        raise ApiError(
            "VALIDATION_ERROR",
            "입장 시각이 미래일 수 없습니다",
            400, "at",
        )
    try:
        result = await admit(db, ticket, event, at, method="qr_scan")
    except AdmissionError as e:
        # CANCELLED/EXPIRED → 422(기존 계약 유지). 입장일 아님 → 422 STATE.
        #
        # 🔴 `AdmissionError.code` 를 **버리지 않는다** (2026-08-10).
        #    종전엔 code(NOT_ADMITTABLE / NOT_ADMISSION_DAY)를 갖고 있으면서 응답에서
        #    전부 STATE_TRANSITION_FORBIDDEN 하나로 뭉쳐 보냈다. 그래서 go 가 **한국어
        #    문구를 파싱해** 사유를 갈랐고, 문구를 고치는 순간 조용히 오분류된다.
        #    ⟹ details 로 실어 보낸다. code·http(422)는 **그대로** 둔다(기존 계약 무변).
        raise ApiError(
            "STATE_TRANSITION_FORBIDDEN", e.message, 422,
            details={"admission_code": e.code},
        )

    await db.commit()
    if not result.already:
        logger.info("internal ticket check-in: ticket=%s date=%s", ticket_id, result.attended_date)

    status_value = ticket.status.value if hasattr(ticket.status, "value") else ticket.status
    return {
        "ticket_id": str(ticket_id),
        "checked_in_at": result.admission.checked_in_at.isoformat(),
        "status": status_value,
        "already": result.already,
        # §13 당일 재입장: outcome 으로 게이트 UI 가 '재입장 OK(초록)' vs '차단(빨강)' 을 구분.
        # admitted=최초입장 · reentry_ok=당일 재스캔(정상). 실제 차단은 아래 except 로 STATE 422.
        "outcome": result.outcome,
        "admission_mode": (getattr(event, "admission_mode", None) or "single"),
        "attended_date": result.attended_date.isoformat(),
    }


@router.post("/tickets/{ticket_id}/check-in", summary="go write-through: 티켓 체크인(상태=v2 SoT)")
async def check_in_ticket(
    ticket_id: uuid.UUID,
    request: Request,
    body: CheckInRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(
            idempotency_key, f"ticket.checkin.{ticket_id}",
            lambda: _do_check_in(db, ticket_id, body), fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


class RevokeAdmissionRequest(BaseModel):
    # 취소 대상 입장일(KST, YYYY-MM-DD). 미제공 시 서버 today(KST) 기준.
    attended_date: str | None = None
    reason: str | None = None  # 스태프 사유(감사)


async def _do_revoke_admission(
    db: AsyncSession, ticket_id: uuid.UUID, body: RevokeAdmissionRequest
) -> dict:
    """§13 체크인 undo/취소 — 오스캔 복구. 특정 (ticket, date) 입장 원장을 삭제하고 부작용 되돌림.

    멱등: 원장 없으면 revoked=False (200). 동시성: revoke_admission 이 티켓 FOR UPDATE.
    """
    ticket = await db.get(Ticket, ticket_id)
    if ticket is None:
        raise ApiError("TICKET_NOT_FOUND", f"ticket not found: {ticket_id}", 404)
    event = await db.get(Event, ticket.event_id)
    if event is None:
        raise ApiError("EVENT_NOT_FOUND", f"event not found: {ticket.event_id}", 404)

    if body.attended_date:
        try:
            target_date = date.fromisoformat(body.attended_date)
        except ValueError:
            raise ApiError("VALIDATION", f"invalid attended_date: {body.attended_date}", 422, "attended_date")
    else:
        target_date = to_kst_date(datetime.now(timezone.utc))

    result = await revoke_admission(db, ticket, event, target_date)
    await db.commit()

    if result.revoked:
        logger.info(
            "internal admission revoke: ticket=%s date=%s last=%s reason=%s",
            ticket_id, target_date, result.was_last_admission, (body.reason or "")[:80],
        )

    status_value = ticket.status.value if hasattr(ticket.status, "value") else ticket.status
    return {
        "ticket_id": str(ticket_id),
        "revoked": result.revoked,
        "attended_date": result.attended_date.isoformat(),
        "was_last_admission": result.was_last_admission,
        "status_reverted": result.status_reverted,
        "first_checked_in_reset": result.first_checked_in_reset,
        "status": status_value,
    }


@router.post(
    "/tickets/{ticket_id}/revoke-admission",
    summary="go write-through: 입장 취소(오스캔 복구)",
)
async def revoke_admission_endpoint(
    ticket_id: uuid.UUID,
    request: Request,
    body: RevokeAdmissionRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(
            idempotency_key, f"ticket.revoke.{ticket_id}.{body.attended_date or 'today'}",
            lambda: _do_revoke_admission(db, ticket_id, body), fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


# ════════════════════════════════════════════════════════════════════════
# F4 — 경품 추첨 실행/조회 (감사가능·재현가능)
#
# go(주최자 SaaS)가 서비스토큰으로 호출. 추첨 풀 = 체크인 완료자(event_admissions
# 있는 티켓)의 raffle_number. 공개 seed → 결정적 RNG → 당첨번호. 실행 기록은
# raffle_draws 에 저장(seed·당첨·시각·실행자·풀크기). 라이브 발표화면은 후속(범위 밖).
# ════════════════════════════════════════════════════════════════════════


class RaffleDrawRequest(BaseModel):
    winner_count: int = Field(..., ge=1, le=100000)
    seed: str = Field(..., min_length=1, max_length=256)
    executed_by: uuid.UUID | None = None
    draw_key: str | None = Field(None, max_length=128)


def _raffle_draw_response(draw) -> dict:
    return {
        "draw_id": str(draw.id),
        "event_id": str(draw.event_id),
        "draw_key": draw.draw_key,
        "seed": draw.seed,
        "winner_count": draw.winner_count,
        "pool_size": draw.pool_size,
        "winning_numbers": list(draw.winning_numbers or []),
        "executed_by": str(draw.executed_by) if draw.executed_by else None,
        "executed_at": draw.executed_at.isoformat() if draw.executed_at else None,
    }


async def _do_run_raffle(db: AsyncSession, event_id: uuid.UUID, body: RaffleDrawRequest) -> dict:
    from app.services.raffle_service import RaffleError, run_draw

    event = await _require_event(db, event_id)
    if not getattr(event, "raffle_enabled", False):
        raise ApiError("RAFFLE_DISABLED", "이 이벤트는 경품 추첨이 활성화되지 않았습니다", 409, "raffle_enabled")
    try:
        draw = await run_draw(
            db,
            event_id=event_id,
            winner_count=body.winner_count,
            seed=body.seed,
            executed_by=body.executed_by,
            draw_key=body.draw_key,
        )
    except RaffleError as e:
        http = 409 if e.code in ("POOL_EMPTY",) else 400
        raise ApiError(e.code, e.message, http, "raffle")
    await db.commit()
    return _raffle_draw_response(draw)


@router.post("/events/{event_id}/raffle/draw", summary="F4 추첨 실행(체크인자 풀·재현가능 seed)")
async def run_raffle_draw(
    event_id: uuid.UUID,
    request: Request,
    body: RaffleDrawRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(
            idempotency_key, f"raffle.draw.{event_id}",
            lambda: _do_run_raffle(db, event_id, body), fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


@router.get("/events/{event_id}/raffle/draws", summary="F4 추첨 실행 기록 조회")
async def list_raffle_draws(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    from app.models.raffle import RaffleDraw

    try:
        rows = (
            await db.execute(
                select(RaffleDraw)
                .where(RaffleDraw.event_id == event_id)
                .order_by(RaffleDraw.executed_at.desc())
            )
        ).scalars().all()
        return _ok({"draws": [_raffle_draw_response(d) for d in rows]})
    except ApiError as e:
        return _err(e)


# ════════════════════════════════════════════════════════════════════════
# Wave3 W3.2 — 원자 주문생성 (POST /internal/orders)
#
# 단일 트랜잭션(중간 commit 0)으로 orders + order_items + tickets +
# ownership_transfers + discount used_count차감 + seat_tiers.sold_count(트리거) +
# seats hold→sold + affiliate_conversions 를 원자 기록. 하나 실패 → 전체 롤백.
# 경로 일원화: 이 동기 API 가 빅뱅 후 단일 canonical 주문경로(SQS persist 는 retire).
# ════════════════════════════════════════════════════════════════════════


class BuyerBlock(BaseModel):
    name: str | None = None
    email: str | None = None
    phone: str | None = None


class OrderItemIn(BaseModel):
    tier_id: uuid.UUID | None = None
    external_ref: str | None = None  # go productId — tier 해석
    quantity: int = Field(..., gt=0)
    unit_price: float = Field(..., ge=0)
    seat_ids: list[uuid.UUID] = Field(default_factory=list)
    hold_id: uuid.UUID | None = None  # 좌석 hold 소유권 bearer(익명 hold→주문 시 claim)
    # F2/F1: daypass 지정일 초대권 발권 — 이 라인의 티켓에 admission_day 를 부여한다.
    # go 대량 초대(invitations/bulk)가 수신자별 지정일을 전달. None 이면 미지정(allpass/single/
    # 선택형 daypass = 첫 입장일 확정). 하위호환: 미전달 시 기존 동작 불변.
    admission_day: date | None = None


class OrderDiscountIn(BaseModel):
    code_id: uuid.UUID | None = None
    code: str | None = None
    amount: float = 0.0


class OrderCreateRequest(BaseModel):
    external_order_id: str | None = None
    user_id: uuid.UUID | None = None
    buyer: BuyerBlock | None = None
    event_id: uuid.UUID
    source: str | None = None
    affiliate_ref: str | None = None
    items: list[OrderItemIn] = Field(..., min_length=1, max_length=100)
    discount: OrderDiscountIn | None = None
    total_amount: float = Field(..., ge=0)
    payment_deadline: str | None = None
    # T2-ORD: 예매 설문 응답(go attendees.answers 흡수). 주문 단위 입력 → 발권된 전 티켓에 부여.
    answers: dict | None = None
    # T2-ORD: 주문 워크플로 메모(go orders.memo 흡수).
    memo: str | None = None
    terms_agreed_at: str | None = None


class _ResolvedBuyer(NamedTuple):
    """주문 구매자 해석 결과 — 회원(user_id) XOR 게스트(guest_id). 정확히 하나만 세팅됨.

    orders.ck_orders_buyer_exactly_one(user XOR guest) 와 정합. 호출부는 이 값으로
    Order(user_id=..., guest_id=...) 를 배선한다.
    """

    user_id: uuid.UUID | None
    guest_id: uuid.UUID | None


# W1(게스트 buyer 입력 검증): BuyerBlock.email 은 회원/게스트 공용 str 이므로 모델 레벨
# EmailStr 강제는 하지 않는다(회원 주문이 buyer 를 부가정보로 실어보내도 계약 불변 보장).
# 대신 **게스트 경로에서만** email/phone 형식을 강제해, 임의 문자열이 guests 에 저장되어
# 오염·저장형 XSS 소스가 되는 것을 차단한다. invalid → 400.
_EMAIL_ADAPTER = TypeAdapter(EmailStr)  # 기존 v2 스키마와 동일한 EmailStr 검증 재사용.
# 게스트 phone: E.164/한국형/구분자 허용의 관대한 형식검증. 저장 전 오염만 거른다(정규화는 S2).
#   - 선택적 '+', 숫자/공백/하이픈/괄호/점 허용, 정규화 숫자 8~15자리(ITU E.164 상한).
_GUEST_PHONE_RE = re.compile(r"^\+?[0-9][0-9\s\-().]{6,19}$")


def _validate_guest_email(email: str) -> str:
    """게스트 email 형식검증(EmailStr 재사용) — invalid 면 400. 정규화된 값 반환."""
    try:
        return _EMAIL_ADAPTER.validate_python(email)
    except ValidationError as exc:
        raise ApiError("VALIDATION_ERROR", "buyer.email is not a valid email address", 400, "buyer.email") from exc


def _normalized_guest_identity_email(email: str) -> str:
    """게스트 주문 소유경계용 email 정규화.

    기존 게스트 정책은 plus-address를 별도 계정으로 보존한다. 공백·대소문자 차이만 제거하고
    형식검증은 저장 경로와 동일한 EmailStr 어댑터를 사용한다.
    """
    return str(_validate_guest_email(email.strip())).strip().lower()


def _order_buyer_identity(body: "OrderCreateRequest") -> str:
    """멱등 지문에 넣을 안정적인 구매자 신원. 회원/게스트 namespace도 분리한다."""
    if body.user_id is not None:
        return f"user:{body.user_id}"
    if not body.buyer or not body.buyer.email:
        raise ApiError("VALIDATION_ERROR", "buyer.email required for guest order", 400, "buyer")
    return f"guest:{_normalized_guest_identity_email(body.buyer.email)}"


def _validate_guest_phone(phone: str | None) -> str | None:
    """게스트 phone 경량 형식검증 — 값이 있고 형식 위반이면 400. None/빈문자열은 통과(선택 필드)."""
    if phone is None:
        return None
    stripped = phone.strip()
    if not stripped:
        return None
    digits = re.sub(r"\D", "", stripped)
    if not (_GUEST_PHONE_RE.match(stripped) and 8 <= len(digits) <= 15):
        raise ApiError("VALIDATION_ERROR", "buyer.phone is not a valid phone number", 400, "buyer.phone")
    return stripped


# 상세통합 S2b(§6.3): 게스트에게 절대 허용되지 않는 회원전용 판매모드.
# point_lottery(포인트/팬 가중치 추첨)·fanclub_presale(팬클럽 선예매)·queue(대기열)는
# 회원 신원/로열티/자격 로직을 전제하므로 게스트 배제. 게스트 허용 후보는 fixed_fcfs·무료.
_MEMBER_ONLY_SALE_MODES = frozenset({"point_lottery", "fanclub_presale", "queue"})
# guest_checkout_channels 미설정 시 안전 기본(게스트 허용 sale_mode 화이트리스트).
_GUEST_DEFAULT_SALE_MODES = frozenset({"fixed_fcfs", "free"})


def _assert_guest_checkout_allowed(event) -> None:
    """게스트 opt-in 게이트(§2.2). 이벤트가 guest_checkout_enabled=True 가 아니면 차단.

    미허용 이벤트에 대한 게스트 주문은 4xx(GUEST_CHECKOUT_DISABLED) — 재고/좌석 잠금 전에 거른다.
    """
    if getattr(event, "guest_checkout_enabled", False) is not True:
        raise ApiError(
            "GUEST_CHECKOUT_DISABLED",
            "게스트(비회원) 구매가 허용되지 않은 행사입니다. 로그인 후 구매해 주세요.",
            403, "guest_checkout",
        )


def _assert_guest_sale_mode_allowed(event, sale_mode: str | None) -> None:
    """게스트 판매모드 화이트리스트 검증(§6.3).

    1) 회원전용 sale_mode(point_lottery/fanclub_presale/queue)는 무조건 거부.
    2) guest_checkout_channels(JSONB) 화이트리스트가 있으면 그 목록으로만 허용.
    3) 화이트리스트 미설정이면 안전 기본(fixed_fcfs·free)만 허용.
    """
    sm = (sale_mode or "fixed_fcfs").strip().lower()
    if sm in _MEMBER_ONLY_SALE_MODES:
        raise ApiError(
            "GUEST_SALE_MODE_FORBIDDEN",
            f"게스트(비회원)는 해당 판매 방식({sm})으로 구매할 수 없습니다. 로그인 후 구매해 주세요.",
            403, "sale_mode",
        )
    channels = getattr(event, "guest_checkout_channels", None)
    allowed = (
        {str(c).strip().lower() for c in channels}
        if isinstance(channels, (list, tuple)) and channels
        else set(_GUEST_DEFAULT_SALE_MODES)
    )
    if sm not in allowed:
        raise ApiError(
            "GUEST_SALE_MODE_FORBIDDEN",
            f"게스트(비회원)에게 허용되지 않은 판매 방식({sm})입니다.",
            403, "sale_mode",
        )


async def _resolve_buyer_user(
    db: AsyncSession, user_id: uuid.UUID | None, buyer: BuyerBlock | None
) -> _ResolvedBuyer:
    """주문 구매자 해석.

    회원(user_id 있음)은 검증 후 그대로. 게스트(user_id 없음)는 **별도 guests 엔티티**
    (상세통합 §2.1 C안)로 upsert — 기존 "게스트=진짜 User 생성" 안티패턴 폐기
    (users.email UNIQUE 오염·유령계정·PIPA 제거).

    ⚠️ S1 범위: guests upsert(email+name+phone) → orders.guest_id 세팅 경로까지.
       결제 confirm 연동(서명토큰·금액 재검증·게스트=회원 동일 confirm 경로)은 S2.
    """
    # ── 회원 경로(무변경) ──
    if user_id is not None:
        uid = (await db.execute(select(User.id).where(User.id == user_id))).scalar_one_or_none()
        if uid is None:
            raise ApiError("VALIDATION_ERROR", f"user_id not found: {user_id}", 400, "user_id")
        return _ResolvedBuyer(user_id=uid, guest_id=None)

    # ── 게스트 경로(C안 — guests 테이블) ──
    if not buyer or not buyer.email:
        raise ApiError("VALIDATION_ERROR", "buyer.email required for guest order", 400, "buyer")

    # W1: 게스트 email/phone 형식검증(오염·저장형 XSS 소스 차단). invalid → 400.
    guest_email = _validate_guest_email(buyer.email)
    guest_phone = _validate_guest_phone(buyer.phone)

    # guests.email 은 UNIQUE 아님(스냅샷) → 매 게스트 주문마다 신규 Guest 행 생성이 기본.
    # (동일 email 여러 주문 disambiguation 은 매직링크 조회에서 처리 — §6.3.)
    # phone 은 EncryptedString TypeDecorator 가 저장 시 자동 암호화(PII_ENCRYPTION_KEY).
    guest = Guest(
        email=guest_email,
        name=buyer.name,
        phone_enc=guest_phone,
        # marketing_opt_in 은 opt-in 채널/동의 배선 시 buyer 확장으로 전달(S2/S3). 기본 False.
    )
    db.add(guest)
    await db.flush()
    return _ResolvedBuyer(user_id=None, guest_id=guest.id)


def _raise_order_identity_mismatch() -> NoReturn:
    """외부 주문 식별자를 다른 구매자가 bearer token처럼 재사용하지 못하게 fail-closed."""
    raise ApiError(
        "IDEMPOTENCY_KEY_MISMATCH",
        "동일한 주문 식별자가 다른 구매자 또는 주문 정보로 재사용되었습니다. "
        "구매 정보를 다시 확인한 뒤 새 주문을 시작해 주세요.",
        409,
        "external_order_id",
    )


# 🔴 **되살릴 길이 없는** 주문 상태 — 결제를 걸 수도 없고 결제되지도 않았다.
#    여기 없는 상태는 전부 재생한다(이중과금 방지 우선).
_NON_REPLAYABLE_ORDER_STATUSES: tuple[OrderStatus, ...] = (
    OrderStatus.EXPIRED,
    OrderStatus.CANCELLED,
)


def _assert_order_replayable(existing: Order) -> None:
    """멱등 재생이 **의미 있는** 주문인가.

    재생한다      결제 완료(PAID·CONFIRMED 등) — 이중과금 방지의 본체. 반드시 유지한다
    재생 안 한다  EXPIRED·CANCELLED 등 **결제를 걸 수 없는 터미널** → 409

    🔴 판정 목록을 여기 적지 않는다. `payment_service.PAYABLE_ORDER_STATUSES` 와 **같은
       출처**를 쓴다 — 두 곳에 따로 적으면 다음에 한쪽만 바뀌고, 이 결함이 정확히
       그렇게 생겼다(dedup 은 "줄게", prepare 는 "못 걸어").

    ⚠️ "결제 못 거는 상태" 전부를 막는 게 아니다. **이미 결제된** 주문은 결제를 새로 걸
       수 없지만 재생해야 한다 — 그게 이중과금을 막는 방법이다. 막는 것은 결제를 걸 수도
       없고 결제되지도 않은, **되살릴 길이 없는** 주문뿐이다.
    """
    from app.services.payment_service import PAYABLE_ORDER_STATUSES

    status = existing.status
    if status in PAYABLE_ORDER_STATUSES:
        return  # 아직 결제를 걸 수 있다 — 재생이 정상 동작이다
    # 🔴 **돈이 실제로 걸린 주문**만 무조건 재생한다(숨기면 이중과금이 된다).
    #
    #    ⚠️ 판정 필드를 `payment_id` 로 두면 안 된다 — 그것은 **결제창을 열었다**는 표시일
    #       뿐이다(`payment_service.py:306`, prepare 시점에 박힌다). 승인과 무관하다.
    #       2026-08-09 실장애: 아침에 결제창만 열고 이탈한 주문이 만료된 뒤, 같은
    #       브라우저로 오면 이 줄에서 통과해 **만료 주문이 계속 재생**됐다. 손님은
    #       "결제 서버가 응답하지 않습니다" 를 보며 영영 못 샀다.
    #
    #    승인이 성립했다는 증거는 `pg_transaction_id`(PG 거래번호)다 — 승인 검증을
    #    통과한 뒤에만 박힌다(`payment_service.py:985` CONFIRMED · `:1458` AUTHORIZED
    #    · `:839` vbank 채번).
    if existing.pg_transaction_id:
        return
    if status not in _NON_REPLAYABLE_ORDER_STATUSES:
        # 🔴 기본은 **재생**이다. 새 상태가 생겨도 이중과금 방지가 먼저 깨지지 않게
        #    허용 쪽으로 넘어간다 — 과하게 막는 실수가 이 결함보다 훨씬 비싸다.
        return

    raise ApiError(
        "ORDER_NOT_REPLAYABLE",
        "이전 주문이 만료되었습니다. 새로 주문해 주세요.",
        409,
        "external_order_id",
        details={"order_status": status.value if hasattr(status, "value") else str(status)},
    )


async def _assert_order_replay_owner(
    db: AsyncSession,
    existing: Order,
    body: OrderCreateRequest,
) -> None:
    """external_ref dedup 재생 전 기존 주문과 요청 구매자 신원을 명시 비교한다.

    external_ref_fingerprint가 NULL인 레거시 주문도 이 검사는 건너뛰지 않는다. 회원은 user_id,
    게스트는 기존 Guest.email을 동일 규칙으로 정규화해 비교한다. Guest 행 유실도 안전하게 거부한다.
    """
    if body.user_id is not None:
        if existing.user_id != body.user_id or existing.guest_id is not None:
            _raise_order_identity_mismatch()
        return

    if existing.user_id is not None or existing.guest_id is None:
        _raise_order_identity_mismatch()
    requested_email = _order_buyer_identity(body)
    existing_email = (
        await db.execute(select(Guest.email).where(Guest.id == existing.guest_id))
    ).scalar_one_or_none()
    if existing_email is None:
        _raise_order_identity_mismatch()
    if requested_email != f"guest:{_normalized_guest_identity_email(existing_email)}":
        _raise_order_identity_mismatch()


def _compute_discount_amount(code: DiscountCode, gross: Decimal) -> Decimal:
    """할인액을 **코드 rule 로 v2 가 재계산**(SoT, 🔴1). go 가 보낸 amount 는 무시.

    percentage → gross×rate%, fixed → amount. min_order_amount 미달 시 PROMO_INVALID,
    max_discount_amount 로 상한. 음수/초과 방지.
    """
    if code.min_order_amount and gross < Decimal(str(code.min_order_amount)):
        raise ApiError("PROMO_INVALID", "order below discount min_order_amount", 400, "discount")
    dtype = code.discount_type.value if hasattr(code.discount_type, "value") else code.discount_type
    if dtype == DiscountCodeType.PERCENTAGE.value:
        amt = gross * Decimal(str(code.rate or 0)) / Decimal(100)
    else:  # fixed
        amt = Decimal(str(code.amount or 0))
    if code.max_discount_amount:
        amt = min(amt, Decimal(str(code.max_discount_amount)))
    if amt < 0:
        amt = Decimal(0)
    return amt.quantize(Decimal("0.01"))


def _order_response(
    order: Order,
    ticket_ids: list[str],
    lines: list[dict],
    created: bool,
    tickets: list[Ticket] | None = None,
) -> dict:
    resp = {
        "order_id": str(order.id),
        "external_order_id": order.external_ref,
        "status": order.status.value if hasattr(order.status, "value") else order.status,
        "ticket_ids": ticket_ids,
        "lines": lines,
        "created": created,
    }
    # F4: raffle_number 노출(go 초대권 표시용). 부여된 티켓만 포함(하위호환: 없으면 미노출).
    if tickets:
        raffle_map = {
            str(t.id): t.raffle_number for t in tickets if t.raffle_number is not None
        }
        if raffle_map:
            resp["raffle_numbers"] = raffle_map
    return resp


# 🔴 등급 판매창을 적용할 **손님 구매** 경로 (2026-08-20).
#    주최자 발권·초대권·보정은 제외한다 — 마감 뒤에도 발권은 되어야 한다.
_TIER_WINDOW_SOURCES = frozenset({"guest_public", "guest", "go"})


async def _do_create_order(db: AsyncSession, body: OrderCreateRequest) -> dict:
    # 레벨2 재감사3차 P1 — external_ref(멱등키)를 이 요청의 event/items/amount 문맥에 결속.
    ctx_fp = _order_context_fingerprint(body)
    # 1) 멱등 dedup — external_order_id 로 기존 주문 재생(이중과금 방지).
    if body.external_order_id:
        existing = (
            await db.execute(select(Order).where(Order.external_ref == body.external_order_id))
        ).scalar_one_or_none()
        if existing is not None:
            # fingerprint 유무와 무관한 명시적 소유경계. 특히 공개 guest endpoint는 재생 후
            # view token을 새로 발급하므로 external_ref만으로 기존 주문을 재생하면 안 된다.
            await _assert_order_replay_owner(db, existing, body)
            # 문맥 결속 검증(P1): 같은 external_order_id 재사용이 **다른** event/상품/수량/금액이면
            # (호출자 토큰이 장바구니/이벤트 변경 후 재사용) 옛 주문을 재생하지 않고 409 로 차단한다.
            # 잘못된 event/티켓/금액 조합 반환 = 실돈·오결제. 최초 지문이 있으면 대조(엄격),
            # 레거시(지문 NULL — 백필 전 주문)는 대조 생략(하위호환, 새 주문부터 결속).
            if existing.external_ref_fingerprint is not None and existing.external_ref_fingerprint != ctx_fp:
                _raise_order_identity_mismatch()
            # 🔴 되살릴 수 없는 주문은 재생하지 않는다 (2026-08-08 실장애).
            #
            #    체크아웃 토큰은 localStorage 에 **영구** 저장된다. 결제창을 열기 전에 주문이
            #    만들어지고, 이탈하면 PENDING 으로 남았다가 30분 뒤 EXPIRED(터미널)가 된다.
            #    같은 브라우저로 다시 오면 같은 토큰 → 여기서 그 만료 주문을 그대로 돌려줬다
            #    → prepare 가 거절 → 502 → **손님이 영구히 결제 불가**.
            #
            #    ⚠️ dedup 자체는 옳다. 이중과금 방지의 본체이고 **결제된 주문은 반드시
            #       재생해야 한다**. 문제는 되살릴 수 없는 상태까지 재생한 것뿐이다.
            #
            #    🔴 여기서 새 주문을 만들지 않는다. external_ref 가 UNIQUE 라 같은 토큰으로는
            #       애초에 못 만들고, "토큰을 버릴지" 는 **클라가 결정할 일**이다. 서버가
            #       대신 정하면 이중과금 방지의 경계가 흐려진다.
            _assert_order_replayable(existing)
            tks = (
                await db.execute(
                    select(Ticket).where(Ticket.purchase_order_id == existing.id)
                )
            ).scalars().all()
            return _order_response(
                existing, [str(t.id) for t in tks], [], created=False, tickets=list(tks)
            )

    event = await _require_event(db, body.event_id)
    # ── U4(F4): 채널-무관 판매게이트 SSOT ────────────────────────────────────
    # 원자주문은 go 의 canonical 경로이자, go 랜딩 폐기(U6) 후엔 consumer 게스트/self
    # 구매의 유일 서버경로가 된다. 과거엔 CANCELLED+sales_paused 만 확인해
    # draft/판매창밖 이벤트에도 주문이 뚫렸다(split-brain·조기/만료판매). 이제
    # commerce_status.evaluate_purchase_gate(순수·채널-무관)로 status·window·paused 를
    # v2 가 단독 판정 → purchase_service(marketplace 경로)와 동일 집합/순서(SSOT).
    # 채널판정(marketplace vs self)은 이 게이트 밖 별도(여기선 채널 무관하게 통과).
    _gate = evaluate_purchase_gate(
        status=event.status,
        sales_paused=bool(getattr(event, "sales_paused", False)),
        bidding_opens_at=event.bidding_opens_at,
        bidding_closes_at=event.bidding_closes_at,
    )
    if not _gate.ok:
        raise ApiError(_gate.code, _gate.message_ko, _gate.http_status, "status")

    # ── 🔴 공개 진입점 채널 게이트 (2026-08-02) ──────────────────────────────
    #
    # 위 게이트는 **채널 무관**이다(바로 위 주석대로). 그런데 이 함수는 두 곳이 쓴다:
    #
    #     guests.py:350            공개 게스트 엔드포인트 — 인증 없음 · source="guest_public"
    #     internal_commerce:4395   go self-checkout      — 서비스토큰 필수 · source="go"
    #
    # 채널 판정이 "게이트 밖 별도" 인데, **공개 진입점에는 그 별도 판정이 아예 없었다.**
    # `purchase_service._validate_event_purchasable`(회원 marketplace 경로)에만 있다.
    # 결과: `{self}` 전용 행사의 티어 ID 를 알면 누구나 공개 API 로 주문을 만들 수 있었다.
    # 0원 티어(숨김 초대권)면 아래 `net_total <= 0` 분기가 **즉시 CONFIRMED + 티켓 ACTIVE**
    # 로 확정한다 — 무인증 무료 발권이다.
    #
    # ⚠️ 게이트를 `_do_create_order` 전체에 걸면 안 된다. go 의 `{self}` 주문이 죽는다
    #    (KLPGA 가 정확히 그 경우다 — 실판매가 멈춘다). **공개 진입점일 때만** 건다.
    #
    # 🔴 `source` 는 위조할 수 없다: `GuestOrderCreateRequest` 에 그 필드가 없고
    #    `guests.py:332` 가 하드코딩한다. 내부 라우터는 `Depends(_internal_auth)` 뒤에 있다.
    if (body.source or "") == "guest_public":
        _channels = {str(c).lower() for c in (getattr(event, "sale_channels", None) or [])}
        # ⚠️ **`self` 만 배제한다.** 처음엔 `"marketplace" in _channels` 를 요구했는데,
        #    실 데이터에 `online` 같은 다른 채널값이 있고(dev 9건) 그 행사들까지 막힌다.
        #    이 게이트의 목적은 "주최자 전용(`self`) 행사를 공개 장터에서 못 사게" 이지
        #    "marketplace 라고 정확히 적힌 것만 허용" 이 아니다.
        #    ⚠️ 빈 배열/NULL 도 막는다 — 모델 기본값이 `{self,marketplace}` 라 비어 있는 것은
        #       비정상이고, 돈이 걸린 자리에서는 fail-closed 가 맞다.
        if not _channels or _channels == {"self"}:
            raise ApiError(
                "EVENT_NOT_PUBLICLY_SALEABLE",
                "이 행사는 공개 판매 대상이 아닙니다.",
                403,
                "event_id",
            )

    # ── 상세통합 S2b(§2.2·§6.3): 게스트(비회원) opt-in 게이트 ─────────────────
    # 게스트 주문(user_id 없음)은 이벤트가 명시적으로 게스트 체크아웃을 켠 경우에만 허용한다.
    # sales_paused 직후에 배치(미허용 이벤트는 게스트 주문을 여기서 차단 — 재고/좌석 잠금 전).
    is_guest_order = body.user_id is None
    if is_guest_order:
        _assert_guest_checkout_allowed(event)

    buyer = await _resolve_buyer_user(db, body.user_id, body.buyer)
    # 회원 owner id — 게스트 주문은 None. 게스트 티켓은 guest_owner_id(§2.1)로 소유,
    # ownership_transfer(PRIMARY_SALE, to_user_id NOT NULL)는 미기록(claim 시 GUEST_CLAIM 원장 — §2.4).
    buyer_user_id = buyer.user_id
    buyer_guest_id = buyer.guest_id

    # 2) tier 해석(무잠금) + 지정석 seat_ids==quantity 검증(🟠3).
    item_tier_ids: list[uuid.UUID] = []
    for it in body.items:
        if it.seat_ids and len(it.seat_ids) != it.quantity:
            raise ApiError(
                "VALIDATION_ERROR",
                f"seat_ids count ({len(it.seat_ids)}) must equal quantity ({it.quantity})",
                400, "seat_ids",
            )
        tid = it.tier_id
        if tid is None:
            if not it.external_ref:
                raise ApiError("TIER_NOT_FOUND", "item requires tier_id or external_ref", 404, "tier")
            tid = (
                await db.execute(
                    select(SeatTier.id).where(
                        SeatTier.event_id == body.event_id, SeatTier.external_ref == it.external_ref
                    )
                )
            ).scalar_one_or_none()
            if tid is None:
                raise ApiError("TIER_NOT_FOUND", f"tier not found: {it.external_ref}", 404, "tier")
        item_tier_ids.append(tid)

    # distinct tier 를 **id 정렬순**으로 잠금(🟠4 데드락 방지). lock-first(§26).
    locked: dict[uuid.UUID, SeatTier] = {}
    for tid in sorted(set(item_tier_ids), key=str):
        tier = (
            await db.execute(
                select(SeatTier).where(
                    SeatTier.id == tid, SeatTier.event_id == body.event_id
                ).with_for_update()
            )
        ).scalar_one_or_none()
        if tier is None:
            raise ApiError("TIER_NOT_FOUND", f"tier not found: {tid}", 404, "tier")
        # 🔴 등급별 판매창 (2026-08-20). 행사 창과 **함께** 본다 — 둘 중 하나라도
        #    닫혀 있으면 못 산다. KLPGA 는 주중권 8/21 12시·주말권 8/23 12시로 다르다.
        #    ⚠️ 창이 없으면(None) 제한 없음 — 종전 동작 그대로다.
        #
        # 🔴 **손님 구매 경로에만** 건다. 위 :4270 이 남긴 교훈과 같은 결이다 —
        #    게이트를 전체에 걸면 주최자 발권까지 죽는다. 마감 뒤에 분실 재발권·
        #    현장 보정을 못 하면 그건 게이트가 아니라 사고다.
        #    ⚠️ `source` 는 위조 불가(내부 라우터는 서비스토큰 뒤, guests.py 가 하드코딩).
        if (body.source or "") in _TIER_WINDOW_SOURCES:
            _tier_gate = evaluate_tier_sale_window(
            tier_name=str(getattr(tier, "name", "") or "이 등급"),
            bidding_opens_at=getattr(tier, "bidding_opens_at", None),
            bidding_closes_at=getattr(tier, "bidding_closes_at", None),
        )
            if not _tier_gate.ok:
                raise ApiError(
                    _tier_gate.code, _tier_gate.message_ko, _tier_gate.http_status, "tier"
                )
        # 🔴 공개 진입점은 숨김·비활성 티어를 살 수 없다 (2026-08-02).
        #    티어 잠금 **직후**에 둔다 — 재고 차감·가격 계산 전이라 부작용이 없다.
        #    ⚠️ 사유를 나누어 알려주지 않는다: "숨김 상품이 있다" 는 것 자체가 탐색 단서다.
        #       TIER_NOT_FOUND 로 통일해 존재 여부를 흘리지 않는다.
        if (body.source or "") == "guest_public":
            if str(getattr(tier, "visibility", "public")).lower() != "public" or not bool(
                getattr(tier, "is_active", True)
            ):
                logger.warning(
                    "공개 진입점에서 비공개 티어 요청 차단: event=%s tier=%s visibility=%s active=%s",
                    body.event_id, tid,
                    getattr(tier, "visibility", None), getattr(tier, "is_active", None),
                )
                raise ApiError("TIER_NOT_FOUND", f"tier not found: {tid}", 404, "tier")
        locked[tid] = tier

    # 가격 검증(🔴1): unit_price 를 tier 카탈로그 하한(min_price)·상한(max_price_cap)으로 검증.
    #   동적가격은 [min_price, max_price_cap] 범위 내 — go 가 unit_price=0 보내도 floor 가 차단.
    qty_by_tier: dict[uuid.UUID, int] = {}
    tier_by_item: list[tuple[OrderItemIn, SeatTier, Decimal, Decimal]] = []
    for it, tid in zip(body.items, item_tier_ids):
        tier = locked[tid]
        unit = Decimal(str(it.unit_price))
        floor = Decimal(str(tier.min_price or 0))
        if unit < floor:
            raise ApiError("PRICE_BELOW_FLOOR", f"unit_price {unit} below tier floor {floor}", 400, "unit_price")
        cap = Decimal(str(tier.max_price_cap or 0))
        if cap > 0 and unit > cap:
            raise ApiError("PRICE_ABOVE_CAP", f"unit_price {unit} above tier cap {cap}", 400, "unit_price")
        qty_by_tier[tid] = qty_by_tier.get(tid, 0) + it.quantity
        tier_by_item.append((it, tier, unit, unit * it.quantity))
    for tid, need in qty_by_tier.items():
        tier = locked[tid]
        remaining = int(tier.capacity or 0) - int(tier.sold_count or 0)
        if remaining < need:
            raise ApiError("SOLD_OUT", f"tier {tid} insufficient stock ({remaining} < {need})", 409)

    # ── 상세통합 S2b(§6.3): 게스트는 회원전용 판매모드(point_lottery·fanclub_presale·queue)
    #    배제. 게스트 허용은 fixed_fcfs·무료(가격 0) 위주. sale_mode 가 tier 에 있으므로
    #    tier 잠금 후 검증한다. guest_checkout_channels 화이트리스트가 있으면 그것으로 게이트,
    #    없으면 안전 기본(fixed_fcfs 만 허용).
    if is_guest_order:
        for tid in qty_by_tier:
            _assert_guest_sale_mode_allowed(event, locked[tid].sale_mode)

    # 3) discount — **v2 가 코드 rule 로 재계산(SoT, 🔴1)**. go 의 discount.amount 는 신뢰 안 함.
    gross = sum((la for _i, _t, _u, la in tier_by_item), Decimal(0))
    discount_amount = Decimal(0)
    discount_row = None
    if body.discount and (body.discount.code_id or body.discount.code):
        dq = select(DiscountCode).where(DiscountCode.event_id == body.event_id).with_for_update()
        if body.discount.code_id:
            dq = dq.where(DiscountCode.id == body.discount.code_id)
        else:
            dq = dq.where(DiscountCode.code == body.discount.code)
        discount_row = (await db.execute(dq)).scalar_one_or_none()
        if discount_row is None or not discount_row.is_active:
            raise ApiError("PROMO_INVALID", "discount code invalid or inactive", 400, "discount")
        now = datetime.now(timezone.utc)
        if discount_row.valid_from and discount_row.valid_from > now:
            raise ApiError("PROMO_INVALID", "discount not yet valid", 400, "discount")
        if discount_row.valid_until and discount_row.valid_until < now:
            raise ApiError("PROMO_INVALID", "discount expired", 400, "discount")
        if discount_row.max_uses is not None and discount_row.used_count >= discount_row.max_uses:
            raise ApiError("PROMO_EXHAUSTED", "discount usage limit reached", 409, "discount")
        discount_amount = _compute_discount_amount(discount_row, gross)  # v2 권위 재계산
        discount_row.used_count = (discount_row.used_count or 0) + 1

    # 4) 서버 재계산 검증(v2 가격 = SoT).
    net_total = gross - discount_amount
    if net_total < 0:
        net_total = Decimal(0)
    if abs(net_total - Decimal(str(body.total_amount))) > Decimal("0.01"):
        raise ApiError("AMOUNT_MISMATCH", f"expected {net_total} (v2 recomputed), got {body.total_amount}", 400, "total_amount")

    # 5) fee 동결(주문시점 절대금액, 정액 포함 §2.7).
    fin = FinanceService(db)
    comp = await fin.get_fee_components(event_id=body.event_id)
    plat_fee, pg_fee = fin.compute_fees(net_total, comp)

    total_qty = sum(it.quantity for it in body.items)
    deadline = (
        _parse_dt(body.payment_deadline, "payment_deadline") if body.payment_deadline
        else datetime.now(timezone.utc) + timedelta(minutes=settings.PAYMENT_EXPIRY_MINUTES)
    )
    order = Order(
        external_ref=body.external_order_id,
        # 레벨2 재감사3차 P1: 이 주문의 문맥 지문 저장 → 같은 external_ref 재사용이
        # 다른 event/상품/금액이면 위 dedup 경로에서 409 로 차단(잘못된 조합 재생 방지).
        external_ref_fingerprint=ctx_fp,
        # 상세통합 §2.1: 회원(user_id) XOR 게스트(guest_id) — 정확히 하나(ck_orders_buyer_exactly_one).
        user_id=buyer.user_id,
        guest_id=buyer.guest_id,
        event_id=body.event_id,
        order_type=OrderType.PURCHASE,
        status=OrderStatus.PAYMENT_REQUIRED,
        quantity=total_qty,
        unit_price=(net_total / total_qty) if total_qty else net_total,
        total_amount=net_total,
        payment_deadline=deadline,
        terms_agreed_at=_parse_dt(body.terms_agreed_at, "terms_agreed_at") if body.terms_agreed_at else None,
        affiliate_code=body.affiliate_ref,
        buyer_name=body.buyer.name if body.buyer else None,
        buyer_email=body.buyer.email if body.buyer else None,
        buyer_phone=body.buyer.phone if body.buyer else None,
        platform_fee_rate=Decimal(str(comp["platform_fee_rate"])),
        platform_fee=plat_fee,
        pg_fee_rate=Decimal(str(comp["pg_fee_rate"])),
        pg_fee=pg_fee,
        net_amount=net_total - plat_fee - pg_fee,
        payment_metadata={"source": body.source or "go_internal", "external_order_id": body.external_order_id},
        # T2-ORD: go orders.source/memo 흡수 — payment_metadata 안에만 있던 유입경로를
        # 조회·집계 가능한 1급 컬럼으로 승격(go 제거 후 주문 출처 리포팅 유지).
        source=(body.source or "direct"),
        memo=body.memo,
    )
    db.add(order)
    await db.flush()

    # 6) order_items + seats(hold→sold) + tickets + ownership_transfers.
    ticket_repo = TicketRepository(db)
    all_ticket_ids: list[str] = []
    all_tickets: list[Ticket] = []  # F4: 경품번호 부여용(raffle_enabled 이벤트).
    lines: list[dict] = []
    is_pytest = bool(os.environ.get("PYTEST_CURRENT_TEST"))
    for (it, tier, unit, line_amount) in tier_by_item:
        oi = OrderItem(
            order_id=order.id, tier_id=tier.id,
            seat_id=(it.seat_ids[0] if len(it.seat_ids) == 1 else None),
            quantity=it.quantity, unit_price=unit, line_amount=line_amount,
            discount_code_id=discount_row.id if discount_row else None,
        )
        db.add(oi)
        await db.flush()

        # 좌석 claim: AVAILABLE / 소유증명된 HELD → SOLD. get_for_update.
        # 소유증명: hold_id bearer 일치(익명·회원 공통) 또는 held_by==buyer(회원 자기 hold).
        for sid in it.seat_ids:
            seat = (
                await db.execute(select(Seat).where(Seat.id == sid).with_for_update())
            ).scalar_one_or_none()
            if seat is None or seat.event_id != body.event_id:
                raise ApiError("VALIDATION_ERROR", f"seat not found in event: {sid}", 400, "seat_ids")
            if seat.status == SeatStatus.SOLD:
                raise ApiError("SOLD_OUT", f"seat already sold: {sid}", 409)
            if seat.status == SeatStatus.RESERVED:
                raise ApiError("SOLD_OUT", f"seat blocked (reserved): {sid}", 409)
            if seat.status == SeatStatus.HELD:
                bearer_ok = it.hold_id is not None and seat.hold_id == it.hold_id
                owner_ok = seat.held_by is not None and seat.held_by == buyer_user_id
                expired = (
                    seat.held_until is not None
                    and seat.held_until.replace(tzinfo=timezone.utc) < datetime.now(timezone.utc)
                )
                if not (bearer_ok or owner_ok or expired):
                    # 익명 hold 는 hold_id 미제시 시 claim 불가(탈취 방지).
                    raise ApiError("SEAT_HELD_BY_OTHER", f"seat held by another buyer: {sid}", 409)
            seat.status = SeatStatus.SOLD
            seat.held_by = None
            seat.held_until = None
            seat.hold_id = None

        tickets_data = []
        for index in range(it.quantity):
            data = {
                "event_id": body.event_id, "tier_id": tier.id,
                # 상세통합 S2b(§2.1): 회원=current_owner_id / 게스트=guest_owner_id (XOR,
                # ck_tickets_owner_not_both). 게스트는 users FK 소유 불가 → guest_owner_id 로 소유.
                "original_owner_id": buyer_user_id, "current_owner_id": buyer_user_id,
                "guest_owner_id": buyer_guest_id,
                "purchase_price": unit, "sale_mode": tier.sale_mode or "fixed_fcfs",
                "purchase_order_id": order.id, "order_item_id": oi.id,
                "status": TicketStatus.PENDING,
                "is_resalable": tier.resale_allowed, "resale_max_price": tier.resale_max_price,
                # T2-ORD: 예매 설문 응답은 주문 단위 입력 → 발권된 전 티켓에 동일 부여
                # (go attendees.answers 와 동일 의미론).
                "answers": body.answers,
            }
            if it.seat_ids and index < len(it.seat_ids):
                data["seat_id"] = it.seat_ids[index]
            # F2/F1: daypass 지정일 초대권 — 라인에 admission_day 있으면 티켓에 부여.
            if it.admission_day is not None:
                data["admission_day"] = it.admission_day
            tickets_data.append(data)
        tickets = await ticket_repo.create_batch(tickets_data)
        # ownership_transfers.to_user_id 는 users FK(NOT NULL) — 게스트 주문은 PRIMARY_SALE 원장
        # 미기록(guest_owner_id·GUEST_CLAIM 이관은 S2/§2.4). 회원 주문은 종전과 동일.
        if buyer_user_id is not None:
            for t in tickets:
                db.add(OwnershipTransfer(
                    ticket_id=t.id, from_user_id=None, to_user_id=buyer_user_id,
                    transfer_type=TransferType.PRIMARY_SALE, price=unit,
                    seller_amount=0.0, platform_fee=0.0, artist_royalty=0.0,
                ))
        ids = [str(t.id) for t in tickets]
        all_ticket_ids.extend(ids)
        all_tickets.extend(tickets)
        lines.append({"external_ref": it.external_ref, "tier_id": str(tier.id), "ticket_ids": ids})
        # sold_count: PG 는 trg_sync_sold_count 가 ticket INSERT 시 자동증가. SQLite(test)만 수동.
        if is_pytest:
            tier.sold_count = (tier.sold_count or 0) + it.quantity

    # 7) affiliate conversion(원자기록) — affiliate_ref 있으면.
    if body.affiliate_ref:
        aff = (
            await db.execute(
                select(Affiliate).where(
                    Affiliate.event_id == body.event_id,
                    (Affiliate.code == body.affiliate_ref) | (Affiliate.external_ref == body.affiliate_ref),
                    Affiliate.status == "active",
                )
            )
        ).scalars().first()
        if aff is not None:
            commission = (net_total * Decimal(str(aff.commission_rate)) / Decimal(100)).quantize(Decimal("0.01"))
            db.add(AffiliateConversion(
                affiliate_id=aff.id, order_id=order.id,
                order_amount=net_total, commission_amount=commission,
            ))

    # F4: raffle_enabled 이벤트는 발권 시 경품번호 부여(동시성 안전 시퀀스).
    #     같은 발권 트랜잭션 내 write → COMMIT 전 crash 시 번호·티켓 함께 롤백.
    if getattr(event, "raffle_enabled", False) and all_tickets:
        from app.services.raffle_service import assign_raffle_numbers
        await assign_raffle_numbers(db, event.id, all_tickets)

    # ── 상세통합 S2b(§2.5): 0원(무료) 주문 자동확정 — PG 미경유 ────────────────
    # 회원/게스트 공통. total_amount==0 이면 결제할 것이 없으므로 PAYMENT_REQUIRED 로
    # 두지 않고 즉시 CONFIRMED + 티켓 ACTIVE + payment_method='free'. fee 동결값은
    # 이미 위 5)에서 order 에 기록됨(0원이라 platform/pg fee 도 0). 같은 트랜잭션 내에서
    # 확정하므로 crash 시 주문·티켓 함께 롤백(멱등: external_ref dedup 이 재실행 재생).
    if net_total <= 0:
        _validate_order_transition(order.status, OrderStatus.CONFIRMED.value)
        order.status = OrderStatus.CONFIRMED
        order.payment_method = "free"
        order.captured_at = datetime.now(timezone.utc)
        order.pg_approved_at = order.captured_at
        for t in all_tickets:
            if t.status == TicketStatus.PENDING:
                t.status = TicketStatus.ACTIVE

    await _commit_or_conflict(db, "order (external_ref)")
    logger.info(
        "internal order create: order=%s external=%s event=%s qty=%s total=%s tickets=%s",
        order.id, body.external_order_id, body.event_id, total_qty, net_total, len(all_ticket_ids),
    )
    # 레벨2 영역C: 0원 자동확정(CONFIRMED) 주문은 여기서 구매완료. 커밋 후 트리거(멱등·best-effort).
    if order.status == OrderStatus.CONFIRMED:
        from app.services.messaging import triggers

        await triggers.on_order_confirmed(db, order)
    return _order_response(order, all_ticket_ids, lines, created=True, tickets=all_tickets)


@router.post("/orders", summary="go write-through: 원자 주문생성(6+테이블 1트랜잭션)")
async def create_order(
    request: Request,
    body: OrderCreateRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(
            idempotency_key, "orders.create",
            lambda: _do_create_order(db, body), fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


# ════════════════════════════════════════════════════════════════════════
# Wave3 W3.3 — 재고 hold/confirm/release + block/unblock + reaper
#
# 좌석 전용(GA 는 hold 없이 주문 시 sold_count 차감 — go §3.2). 멱등·저지연.
# W3.2 가 주문 시 좌석 SOLD 확정하므로, reaper 의 만료-미결제 release 가 핵심(🟡7).
# ════════════════════════════════════════════════════════════════════════

_DEFAULT_HOLD_TTL = 600  # 10분
# 상한: 추첨 당첨좌석 hold 는 결제기한(기본 72h, 이벤트별 연장 가능)만큼 유지되어야 한다.
# 이를 1h 로 클램프하면 결제기한 중 당첨좌석이 reaper 로 회수돼 일반 구매자에게 탈취/이중판매
# 된다(감사 P0-E). 일반 좌석 hold 는 요청값(_DEFAULT_HOLD_TTL)을 그대로 쓰므로 영향 없고,
# 상한은 오설정으로 인한 무한 hold 만 방지한다(결제기한 여유 포함 14일).
_MAX_HOLD_TTL = 14 * 24 * 3600  # 14일


class HoldRequest(BaseModel):
    event_id: uuid.UUID
    seat_ids: list[uuid.UUID] = Field(..., min_length=1, max_length=50)
    user_id: uuid.UUID | None = None  # 익명(로그인 전) 좌석 hold 허용 — 소유권은 hold_id bearer
    ttl_seconds: int = _DEFAULT_HOLD_TTL


class ConfirmRequest(BaseModel):
    hold_id: uuid.UUID


class ReleaseRequest(BaseModel):
    hold_id: uuid.UUID | None = None
    seat_ids: list[uuid.UUID] = Field(default_factory=list)
    reason: str | None = None  # "refund" → SOLD→AVAILABLE
    event_id: uuid.UUID | None = None  # 🟡3 환불 release 스코프(좌석 소속 검증)


class BlockRequest(BaseModel):
    event_id: uuid.UUID
    seat_ids: list[uuid.UUID] = Field(..., min_length=1, max_length=5000)


async def _do_hold(db: AsyncSession, body: HoldRequest) -> dict:
    # 익명/회원 공통: 소유권은 hold_id bearer(반환값). held_by 는 회원이면 user_id, 익명이면 NULL.
    # 활성 HELD 좌석은 누구도 재hold 불가(익명-간 탈취 방지). 만료 HELD 는 takeover 허용.
    ttl = max(10, min(body.ttl_seconds, _MAX_HOLD_TTL))
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(seconds=ttl)
    hold_id = uuid.uuid4()
    held: list[str] = []
    for sid in body.seat_ids:
        seat = (
            await db.execute(select(Seat).where(Seat.id == sid).with_for_update())
        ).scalar_one_or_none()
        if seat is None or seat.event_id != body.event_id:
            raise ApiError("VALIDATION_ERROR", f"seat not found in event: {sid}", 400, "seat_ids")
        if seat.status == SeatStatus.SOLD:
            raise ApiError("SOLD_OUT", f"seat already sold: {sid}", 409)
        if seat.status == SeatStatus.RESERVED:
            raise ApiError("SOLD_OUT", f"seat blocked (reserved): {sid}", 409)
        if seat.status == SeatStatus.HELD:
            active = seat.held_until and seat.held_until.replace(tzinfo=timezone.utc) > now
            if active:  # 활성 hold → 점유 중(소유자 불문 거부, 만료분만 takeover)
                raise ApiError("SOLD_OUT", f"seat currently held: {sid}", 409)
        seat.status = SeatStatus.HELD
        seat.held_by = body.user_id  # 익명이면 None
        seat.held_until = expires_at
        seat.hold_id = hold_id
        held.append(str(sid))
    await _commit_or_conflict(db, "seat hold")
    logger.info("internal inventory hold: hold_id=%s seats=%s anon=%s",
                hold_id, len(held), body.user_id is None)
    return {"hold_id": str(hold_id), "expires_at": expires_at.isoformat(), "held": held}


async def _do_confirm(db: AsyncSession, hold_id: uuid.UUID) -> dict:
    seats = (
        await db.execute(select(Seat).where(Seat.hold_id == hold_id).with_for_update())
    ).scalars().all()
    if not seats:
        # 이미 confirm 되어 hold_id 가 클리어됐을 수 있음(멱등) — SOLD 좌석 존재 여부로 판단 불가하므로 404.
        raise ApiError("HOLD_NOT_FOUND", f"hold not found: {hold_id}", 404)
    now = datetime.now(timezone.utc)
    confirmed = []
    for seat in seats:
        if seat.status == SeatStatus.SOLD:
            confirmed.append(str(seat.id))
            continue
        if seat.held_until and seat.held_until.replace(tzinfo=timezone.utc) < now:
            raise ApiError("HOLD_EXPIRED", f"hold expired: {hold_id}", 409)
        seat.status = SeatStatus.SOLD
        seat.held_by = None
        seat.held_until = None
        seat.hold_id = None
        confirmed.append(str(seat.id))
    await _commit_or_conflict(db, "seat confirm")
    logger.info("internal inventory confirm: hold_id=%s seats=%s", hold_id, len(confirmed))
    return {"hold_id": str(hold_id), "confirmed": confirmed}


async def _do_release(db: AsyncSession, body: ReleaseRequest) -> dict:
    released = 0
    if body.hold_id is not None:
        # 만료/취소 hold 해제: HELD→AVAILABLE (멱등 — 이미 풀렸으면 0건).
        result = await db.execute(
            update(Seat)
            .where(Seat.hold_id == body.hold_id, Seat.status == SeatStatus.HELD)
            .values(status=SeatStatus.AVAILABLE, held_by=None, held_until=None, hold_id=None)
        )
        released = result.rowcount or 0
    elif body.seat_ids and body.reason == "refund":
        # 환불 좌석해제: SOLD→AVAILABLE (repo.ts:239) + **해당 좌석 티켓 CANCELLED**.
        # 🟠1: 좌석만 풀면 trg_sync_sold_count 가 안 돌아 sold_count 누수(phantom-sold).
        #      티켓을 CANCELLED 로 바꿔야 트리거 −1(PG)/수동(SQLite)로 재고 정합.
        # 🟡3: event_id 제공 시 좌석 소속 검증(스코프).
        seat_filter = [Seat.id.in_(body.seat_ids), Seat.status == SeatStatus.SOLD]
        if body.event_id is not None:
            seat_filter.append(Seat.event_id == body.event_id)
        seats = (await db.execute(select(Seat).where(*seat_filter).with_for_update())).scalars().all()
        await _cancel_tickets_for_seats(db, [s.id for s in seats])
        for seat in seats:
            seat.status = SeatStatus.AVAILABLE
            seat.held_by = None
            seat.held_until = None
            seat.hold_id = None
            released += 1
    else:
        raise ApiError("VALIDATION_ERROR", "release requires hold_id or (seat_ids + reason=refund)", 400)
    await db.commit()
    logger.info("internal inventory release: released=%s reason=%s", released, body.reason)
    return {"released": released}


async def _cancel_tickets_for_seats(db: AsyncSession, seat_ids: list[uuid.UUID]) -> None:
    """좌석에 묶인 활성 티켓을 CANCELLED 로(트리거 sold_count −1). SQLite 수동 보정."""
    if not seat_ids:
        return
    # P1: USED(체크인) 티켓도 취소 대상 — 환불 시 유효 입장권 잔존 + sold_count 부풀림 방지.
    # (트리거는 USED 를 점유로 보므로 USED→CANCELLED 시 sold_count −1; SQLite 는 아래 수동.)
    tickets = (
        await db.execute(
            select(Ticket).where(
                Ticket.seat_id.in_(seat_ids),
                Ticket.status.in_([TicketStatus.PENDING, TicketStatus.ACTIVE, TicketStatus.USED]),
            )
        )
    ).scalars().all()
    qty_by_tier: dict[uuid.UUID, int] = {}
    for t in tickets:
        qty_by_tier[t.tier_id] = qty_by_tier.get(t.tier_id, 0) + 1
        t.status = TicketStatus.CANCELLED
    if os.environ.get("PYTEST_CURRENT_TEST"):
        for tid, n in qty_by_tier.items():
            tier = await db.get(SeatTier, tid)
            if tier is not None:
                tier.sold_count = max(0, (tier.sold_count or 0) - n)


async def _do_block(db: AsyncSession, body: BlockRequest, *, block: bool) -> dict:
    affected = 0
    for sid in body.seat_ids:
        seat = (
            await db.execute(select(Seat).where(Seat.id == sid).with_for_update())
        ).scalar_one_or_none()
        if seat is None or seat.event_id != body.event_id:
            raise ApiError("VALIDATION_ERROR", f"seat not found in event: {sid}", 400, "seat_ids")
        if block:
            if seat.status in (SeatStatus.SOLD, SeatStatus.HELD):
                raise ApiError("SOLD_OUT", f"cannot block sold/held seat: {sid}", 409)
            if seat.status != SeatStatus.RESERVED:
                seat.status = SeatStatus.RESERVED
                affected += 1
        else:  # unblock
            if seat.status == SeatStatus.RESERVED:
                seat.status = SeatStatus.AVAILABLE
                affected += 1
    await db.commit()
    logger.info("internal inventory %s: event=%s affected=%s", "block" if block else "unblock", body.event_id, affected)
    return {"affected": affected}


async def _do_reap(db: AsyncSession, event_id: uuid.UUID | None, limit: int) -> dict:
    """만료 정리(go reaper 이관). 🟡7 핵심: 미결제 만료 주문의 SOLD 좌석을 release.

    1) 만료 좌석 hold(HELD·held_until<now) → AVAILABLE.
    2) 만료 미결제 주문(PAYMENT_REQUIRED·payment_deadline<now) → EXPIRED:
       tickets PENDING/ACTIVE→EXPIRED(PG 트리거가 sold_count 자동감소; SQLite 수동),
       seats SOLD→AVAILABLE.
    """
    now = datetime.now(timezone.utc)
    # 1) 만료 hold 회수
    hold_filter = [Seat.status == SeatStatus.HELD, Seat.held_until < now]
    if event_id is not None:
        hold_filter.append(Seat.event_id == event_id)
    holds_res = await db.execute(
        update(Seat).where(*hold_filter).values(
            status=SeatStatus.AVAILABLE, held_by=None, held_until=None, hold_id=None
        )
    )
    holds_reaped = holds_res.rowcount or 0

    # 2) 만료 미결제 주문
    order_filter = [Order.status == OrderStatus.PAYMENT_REQUIRED, Order.payment_deadline < now]
    if event_id is not None:
        order_filter.append(Order.event_id == event_id)
    expired_orders = (
        await db.execute(select(Order).where(*order_filter).limit(limit).with_for_update())
    ).scalars().all()
    is_pytest = bool(os.environ.get("PYTEST_CURRENT_TEST"))
    orders_expired = 0
    seats_released = 0
    for order in expired_orders:
        tickets = (
            await db.execute(select(Ticket).where(Ticket.purchase_order_id == order.id))
        ).scalars().all()
        seat_ids = [t.seat_id for t in tickets if t.seat_id]
        if seat_ids:
            sres = await db.execute(
                update(Seat).where(Seat.id.in_(seat_ids), Seat.status == SeatStatus.SOLD).values(
                    status=SeatStatus.AVAILABLE, held_by=None, held_until=None, hold_id=None
                )
            )
            seats_released += sres.rowcount or 0
        # 티켓 만료 → PG 트리거가 sold_count 감소. SQLite 는 수동 보정.
        qty_by_tier: dict[uuid.UUID, int] = {}
        for t in tickets:
            if t.status in (TicketStatus.PENDING, TicketStatus.ACTIVE):
                qty_by_tier[t.tier_id] = qty_by_tier.get(t.tier_id, 0) + 1
                t.status = TicketStatus.EXPIRED
        if is_pytest:
            for tid, n in qty_by_tier.items():
                tier = await db.get(SeatTier, tid)
                if tier is not None:
                    tier.sold_count = max(0, (tier.sold_count or 0) - n)
        order.status = OrderStatus.EXPIRED
        orders_expired += 1
    await db.commit()
    logger.info(
        "internal inventory reap: holds=%s orders_expired=%s seats_released=%s",
        holds_reaped, orders_expired, seats_released,
    )
    return {
        "holds_reaped": holds_reaped,
        "orders_expired": orders_expired,
        "seats_released": seats_released,
    }


@router.post("/inventory/hold", summary="go write-through: 좌석 hold(멱등)")
async def inventory_hold(
    request: Request,
    body: HoldRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(idempotency_key, "inventory.hold",
                                 lambda: _do_hold(db, body), fingerprint=_fingerprint(body))
    except ApiError as e:
        return _err(e)


@router.post("/inventory/confirm", summary="go write-through: hold 확정(HELD→SOLD)")
async def inventory_confirm(
    request: Request,
    body: ConfirmRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        return _ok(await _do_confirm(db, body.hold_id))
    except ApiError as e:
        return _err(e)


@router.post("/inventory/release", summary="go write-through: hold/환불 좌석 release")
async def inventory_release(
    request: Request,
    body: ReleaseRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        return _ok(await _do_release(db, body))
    except ApiError as e:
        return _err(e)


@router.post("/inventory/block", summary="go write-through: 좌석 판매중지(→RESERVED)")
async def inventory_block(
    request: Request,
    body: BlockRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        return _ok(await _do_block(db, body, block=True))
    except ApiError as e:
        return _err(e)


@router.post("/inventory/unblock", summary="go write-through: 좌석 판매재개(RESERVED→AVAILABLE)")
async def inventory_unblock(
    request: Request,
    body: BlockRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        return _ok(await _do_block(db, body, block=False))
    except ApiError as e:
        return _err(e)


@router.post("/inventory/reap", summary="go reaper → v2: 만료 hold/미결제주문 정리")
async def inventory_reap(
    request: Request,
    db: AsyncSession = Depends(get_db),
    event_id: uuid.UUID | None = None,
    limit: int = 500,
):
    try:
        return _ok(await _do_reap(db, event_id, max(1, min(limit, 2000))))
    except ApiError as e:
        return _err(e)


# ════════════════════════════════════════════════════════════════════════
# Wave3 W3.4 — 상태머신(전이검증 422) + 환불/취소 + state-changed 투영
#
# order 상태머신 = v2 소유·검증(SPEC §3.3). go 는 transition 요청 → v2 가 검증·적용·투영.
# 결제완료 가드(H2)/reaper↔confirm race(🟠2)는 payment_service.confirm_payment 가
# 이미 처리(order FOR UPDATE + EXPIRED/CANCELLED/REFUNDED 거부 + deadline 검증).
# ════════════════════════════════════════════════════════════════════════

# §2.6 SSOT 단일화: 주문 상태전이는 order.py:VALID_ORDER_TRANSITIONS 가 단일 정본.
# 기존 로컬 복제(_ORDER_TRANSITIONS)는 order.py 와 2벌·불일치(CONFIRMED/PAID→CANCELLED
# 사문·PARTIALLY_REFUNDED 자기전이 누락)였음 → 제거하고 import 로 통일.
# (CONFIRMED/PAID→CANCELLED 는 여기서 사문이었고 — _do_cancel_order 는 _CANCELABLE_UNPAID
#  로만 진입 — order.py 정본에도 없음. PARTIALLY_REFUNDED 자기전이는 order.py 로 흡수.)
_REFUNDABLE = {OrderStatus.CONFIRMED, OrderStatus.PAID, OrderStatus.PARTIALLY_REFUNDED}
_CANCELABLE_UNPAID = {OrderStatus.PENDING, OrderStatus.PAYMENT_REQUIRED, OrderStatus.AUTHORIZED}


def _validate_order_transition(current, to_value: str) -> None:
    """order.py:VALID_ORDER_TRANSITIONS(SSOT) 기준 전이 검증. 위반 시 ApiError(422).

    키/값은 OrderStatus enum(문자열 Enum) — to_value(str)·current(enum|str) 양쪽 정규화.
    """
    cur = current if isinstance(current, OrderStatus) else OrderStatus(
        current.value if hasattr(current, "value") else str(current)
    )
    try:
        target = OrderStatus(to_value)
    except ValueError:
        raise ApiError(
            "STATE_TRANSITION_FORBIDDEN",
            f"order transition {cur.value}→{to_value} not allowed",
            422, "status",
        )
    if target not in VALID_ORDER_TRANSITIONS.get(cur, set()):
        raise ApiError(
            "STATE_TRANSITION_FORBIDDEN",
            f"order transition {cur.value}→{to_value} not allowed",
            422, "status",
        )


def _drain_go_refund_propagation(hint: dict) -> None:
    """환불 전파를 celery 로 큐잉한다. **commit 이후에만** 부른다.

    `orders.py::_drain_propagations` 와 같은 계약이다(env 미설정 시 no-op, 실패는
    non-fatal). 여기 별도로 두는 이유는 이 모듈이 그 함수를 쓰지 않기 때문이다 —
    `internal_commerce.py` 는 전파 드레인이 **한 건도 없던** 유일한 라우터였다.
    """
    try:
        from app.api.v1.orders import _drain_propagations

        _drain_propagations([hint])
    except Exception:
        # 🔴 전파 실패가 이미 성립한 환불을 되돌리지 않는다. 대사(reconcile)가 백업이다.
        logger.exception("go 환불 전파 큐잉 실패(non-fatal): order=%s", hint.get("order_id"))


def _build_go_refund_hint(order, refund, *, is_full: bool, reason: str | None) -> dict:
    """go 로 보낼 환불 전파 hint (2026-08-01 신설).

    🔴 왜 여기에 새로 만드나 — go 가 부르는 환불 경로(`_do_refund_order`)는
       `RefundService` 를 **쓰지 않는다.** 그쪽의 hint 생성 코드
       (`refund_service.py:775`)를 지나가지 않으므로, 이 경로는 전파 hint 가
       **아예 만들어지지 않았다.** 그래서 구매자가 환불완료 알림톡을 못 받았고
       go `attendees` 도 취소로 투영되지 않았다(2026-08-01 실측: 카드 취소는 성공,
       통지·투영만 누락).

    ⚠️ `_emit_state_changed` 안에 넣으면 안 된다 — 취소 경로(:5136)는 `db` 없이
       불려서 분기가 다르다. 각 호출부에서 명시적으로 만든다.

    ⚠️ `order_id` 는 **반드시 str** — UUID 객체를 실으면 워커의 `json.dumps` 가
       터진다(2026-08-01 실사고, 발권이 15분 늦던 원인).

    ⚠️ `refund_amount` 는 **이번 건**, `total_refunded` 는 **누계**다. go 원장은
       누계를 SET 해야 한다 — 건별을 쓰면 부분환불 2회째에 누계가 줄어든다.
    """
    return {
        "event": "order.refunded",
        "order_id": str(order.id),
        "data": {
            "refund_id": str(refund.id),
            "refund_amount": float(refund.amount),
            # 두 서비스가 str/float 로 갈려 있어 go 가 Number() 로 읽는다. 여기선 float 로 통일.
            "total_refunded": float(order.total_refunded),
            "original_amount": float(order.total_amount),
            "is_full_refund": is_full,
            "reason": (reason or "")[:200],
            "pg_refund_id": refund.pg_refund_id,
            "refunded_at": refund.processed_at.isoformat() if refund.processed_at else None,
            "source_product": "go",
        },
    }


async def _emit_state_changed(
    order: Order, reason: str | None = None, db: AsyncSession | None = None
) -> None:
    """order state-changed 투영(SPEC §3.3) — go 워크플로/알림 동기화용 + v2 트리거 직결.

    빅뱅 후 go 는 read 를 live 로 보므로 이 투영은 go 워크플로/알림용. 레벨2 영역C:
    ORGANIZER_MESSAGING_V2_ENABLED 시 여기서 트랜잭션 알림(환불완료)을 v2 dispatch 로 직접
    발화한다(go 왕복 제거). db 는 커밋 완료된 세션(state-changed 는 항상 commit 후 호출).
    best-effort — 트리거 실패가 이미 커밋된 주문상태를 되돌리지 않는다.
    """
    logger.info(
        "state-changed: order=%s status=%s reason=%s (project to go)",
        order.id, order.status.value if hasattr(order.status, "value") else order.status, reason,
    )
    if db is None:
        return
    status = order.status.value if hasattr(order.status, "value") else str(order.status)
    if status in (OrderStatus.REFUNDED.value, OrderStatus.PARTIALLY_REFUNDED.value):
        from app.services.messaging import triggers

        await triggers.on_order_refunded(db, order)


async def _release_order_seats_and_tickets(db: AsyncSession, order: Order) -> int:
    """주문 활성 티켓 CANCELLED(트리거 −1) + 점유 좌석 SOLD→AVAILABLE. 반환=해제 좌석수."""
    tickets = (
        await db.execute(select(Ticket).where(Ticket.purchase_order_id == order.id))
    ).scalars().all()
    seat_ids = [t.seat_id for t in tickets if t.seat_id]
    released = 0
    if seat_ids:
        res = await db.execute(
            update(Seat).where(Seat.id.in_(seat_ids), Seat.status == SeatStatus.SOLD).values(
                status=SeatStatus.AVAILABLE, held_by=None, held_until=None, hold_id=None
            )
        )
        released = res.rowcount or 0
    qty_by_tier: dict[uuid.UUID, int] = {}
    for t in tickets:
        # P1: USED(체크인) 포함 — 전액환불/취소 시 체크인 티켓도 무효화 + 재고환원.
        if t.status in (TicketStatus.PENDING, TicketStatus.ACTIVE, TicketStatus.USED):
            qty_by_tier[t.tier_id] = qty_by_tier.get(t.tier_id, 0) + 1
            t.status = TicketStatus.CANCELLED
    if os.environ.get("PYTEST_CURRENT_TEST"):
        for tid, n in qty_by_tier.items():
            tier = await db.get(SeatTier, tid)
            if tier is not None:
                tier.sold_count = max(0, (tier.sold_count or 0) - n)
    return released


class InternalRefundRequest(BaseModel):
    amount: float | None = None
    full: bool = False
    # 지급액과 취소 범위를 분리한다. 취소 수수료가 있으면 amount < 잔액이어도
    # 구매계약 전체가 끝나므로 모든 티켓·좌석을 해제해야 한다.
    cancel_all: bool = False
    reason: str | None = None
    # 입장 완료 티켓의 환불을 명시적으로 허용 — 우천 취소·대회 중단처럼 주최자가
    # 입장객까지 환불하기로 **결정한 경우**에만 호출측이 켠다. 기본은 차단.
    # 소비자 환불(refund_service)은 이 우회가 없다(그쪽은 언제나 차단).
    allow_admitted: bool = False
    # 🔴 T16: 호출측이 **이미 provider 승인취소를 마쳤을 때만** 켠다. 켜면 PG 를 다시 부르지 않는다.
    #    켜야 하는 곳: go compensation.ts 의 Toss 경로(tossProvider.cancel 선행),
    #                  운영자 confirm_completed(운영자가 "provider 에서 이미 나갔다" 고 확정).
    #    켜면 안 되는 곳: 주최자 환불 라우트 — 그쪽은 아무도 PG 를 부르지 않는다.
    #    ⚠️ 기본값 False 가 안전하다. 잘못 켜면 돈이 안 나가고(조용함),
    #       잘못 끄면 두 번 나간다(시끄러움). 지금까지의 결함은 전자였다.
    pg_already_voided: bool = False


class InternalRefundItem(BaseModel):
    ticket_id: uuid.UUID
    # go 참석자 라인취소는 금액을 모른다. 생략 시 v2 티켓 purchase_price를 사용한다.
    amount: float | None = Field(default=None, gt=0)


class InternalRefundItemsRequest(BaseModel):
    items: list[InternalRefundItem] = Field(min_length=1, max_length=100)
    reason: str = Field(default="organizer_line_cancel", min_length=1, max_length=300)

    @field_validator("items")
    @classmethod
    def reject_duplicate_tickets(cls, items: list[InternalRefundItem]):
        ids = [item.ticket_id for item in items]
        if len(ids) != len(set(ids)):
            raise ValueError("duplicate ticket_id is not allowed")
        return items


class CancelRequest(BaseModel):
    reason: str | None = None


async def _do_refund_order(db: AsyncSession, order_id: uuid.UUID, body: InternalRefundRequest) -> dict:
    # 🔴 T20b: "금액을 안 보냈다" 가 "전액 환불하라" 로 해석되던 것을 막는다.
    #    아래 분기가 `if body.full or body.amount is None: → 전액` 이라,
    #    호출측이 부분환불 의도로 amount 를 빠뜨리면 **주문 전액이 환불**됐다.
    #    실제로 go 주문 PATCH 가 `{amount: undefined}` 를 보내면 JSON 직렬화에서 키가
    #    통째로 사라져 "둘 다 없음" 이 되고, `partially_refunded` 요청이 전액환불로 실행됐다.
    #
    #    누락이 곧 **최대 파괴적 동작**으로 해석되는 구조라 뒤집는다 —
    #    전액 환불은 `full: true` 로 **명시**해야 한다.
    #    호출자 실측(도달 경로 1개 · 호출자 5곳)은 전부 full 또는 amount 를 명시하므로
    #    이 가드로 깨지는 기존 호출자는 없다.
    if not body.full and body.amount is None:
        raise ApiError(
            "VALIDATION_ERROR",
            "전액 환불은 full=true 로 명시하거나 amount 를 지정해야 합니다"
            " (둘 다 없으면 의도를 알 수 없어 거부합니다)",
            400, "amount",
        )
    order = (
        await db.execute(select(Order).where(Order.id == order_id).with_for_update())
    ).scalar_one_or_none()
    if order is None:
        raise ApiError("ORDER_NOT_FOUND", f"order not found: {order_id}", 404)
    if order.status not in _REFUNDABLE:
        raise ApiError(
            "STATE_TRANSITION_FORBIDDEN",
            f"cannot refund order in status {order.status.value if hasattr(order.status,'value') else order.status}",
            422, "status",
        )
    total = Decimal(str(order.total_amount or 0))
    already = Decimal(str(order.total_refunded or 0))
    remaining = total - already
    if remaining <= 0:
        raise ApiError("STATE_TRANSITION_FORBIDDEN", "order already fully refunded", 422, "status")
    if body.full or body.amount is None:
        refund_amt = remaining
        is_full = True
    else:
        refund_amt = Decimal(str(body.amount))
        if refund_amt <= 0 or refund_amt > remaining:
            raise ApiError("VALIDATION_ERROR", f"refund amount must be in (0, {remaining}]", 400, "amount")
        is_full = refund_amt >= remaining

    # 환불 대상 티켓 — Refund 원장(RefundItem) 기록용. 전액 환불은 좌석/티켓을
    # 해제하기 전에 미리 모아둔다(해제 후 status 가 CANCELLED 로 바뀌므로 before 기록 불가).
    refund_tickets = (
        await db.execute(select(Ticket).where(Ticket.purchase_order_id == order.id))
    ).scalars().all()

    # 🔴 입장 완료 티켓 환불 차단 (2026-07-28 실측 결함).
    #    소비자 환불 경로(refund_service.py) 에는 "already checked in" 가드가 있는데
    #    이 write-through 경로에는 없어서, **입장해서 `used` 가 된 티켓이 환불되고
    #    `cancelled` 로 바뀌는** 것을 prod E2E 에서 실제로 재현했다. 이미 관람한 입장권을
    #    환불하면 매출이 그대로 새고, 좌석/재고까지 되돌아가 초과판매로 이어진다.
    #
    #    ⚠️ 게이트의 정본은 **go 쪽(돈이 움직이기 전)** 이다. 여기까지 왔다는 건 이미
    #    PG void 가 끝났을 수 있다는 뜻이라, 여기서 막는 것은 최후 방어선이다. 그래도
    #    막는다 — 통과시키면 원장이 조용히 틀어지고 아무도 모른다.
    if not body.allow_admitted:
        admitted = [
            t for t in refund_tickets
            if t.checked_in_at is not None
            or (t.status.value if hasattr(t.status, "value") else t.status) == "used"
        ]
        if admitted:
            raise ApiError(
                "TICKET_ALREADY_ADMITTED",
                f"이미 입장한 티켓이 {len(admitted)}장 있어 환불할 수 없습니다",
                422, "tickets",
            )

    # ── 🔴 T16: PG 승인취소 — 여기서 부르지 않으면 아무도 부르지 않는다 ──────────────
    #
    # 그동안 주최자 환불은 **원장만 바꾸고 카드 승인 취소를 하지 않았다.** 양쪽 주석이
    # 서로에게 책임을 미루고 있었다:
    #     organizer refund/route.ts   "PG 취소도 v2 가 소유"
    #     여기(옛 주석)                "PG void 는 go 측에서 이미 수행됐으므로 재호출 없이 COMPLETED"
    # 실측하면 organizer 의 PG 취소 호출은 compensation.ts 의 Toss 하나뿐이고, 주최자 환불
    # 3경로는 전부 이 엔드포인트로 온다. ⟹ 원장은 refunded, **고객 돈은 PG 에 남는다.**
    #
    # 순서: **원장 변경 전에** 부른다. PG 가 실패하면 예외로 트랜잭션이 롤백돼 원장이
    #       그대로 남는다(부분 성공 없음). 반대로 하면 "원장은 환불인데 돈은 안 나감"이 된다.
    #
    # 🔴 "PG 없음" 과 "PG 호출 실패" 를 구분한다:
    #     payment_id 없음  = 결제수단 없는 주문(내부확정·무료·초대권) → 건너뛰되 기록
    #     호출 실패        = 502 로 끊고 원장 미변경
    #    뭉개면 "돈 안 나갔는데 환불 완료"가 조용히 생긴다.
    pg_refund_id: str | None = None
    pg_note: dict = {}
    if body.pg_already_voided:
        # 호출측이 provider 취소를 이미 마쳤다(go Toss 보상 경로·운영자 확정).
        # 여기서 또 부르면 **이중 환불**이다.
        pg_note = {"pg": "already_voided_by_caller"}
    elif not order.payment_id:
        pg_note = {"pg": "absent", "note": "no payment_id (내부확정·무료·초대권)"}
    else:
        from app.services.payment_gateway import (
            build_void_kwargs,
            get_payment_gateway,
            resolve_cancel_amount,
        )
        # 전액이면 amount=None(전액취소), 부분이면 금액 명시 — refund_service 와 동일 규약.
        cancel_amount = resolve_cancel_amount(order, refund_amt, is_full=is_full)
        try:
            # 🔴 종전에는 여기서만 `transaction_id`·`payment_method`·`original_amount` 를
            #    빠뜨리고 있었다. 나이스 구형 취소는 **TID 가 필수**라, 실키를 연결하는 순간
            #    주최자 환불 3경로(환불 라우트·주문 PATCH·보상 드레인)가 전부 502 로 마비된다.
            #    mock/샌드박스에서는 `_resolve_tid` 가 조기 반환해 드러나지 않는다.
            #    → 다른 환불 경로와 같은 `build_void_kwargs` 단일 규칙을 쓴다.
            _gateway = get_payment_gateway(getattr(order, "pg_provider", None))
            pg_result = await _gateway.void_authorization(
                **build_void_kwargs(
                    _gateway,
                    order,
                    payment_id=order.payment_id,
                    reason=(body.reason or "internal write-through refund")[:100],
                    amount=cancel_amount,
                )
            )
            # 🔴 PG 거절은 예외가 아니라 voided=False 로 온다. 검사하지 않으면
            #    `pg_note={"pg": "voided"}` 라는 **거짓 기록**과 함께 원장만 환불로 확정된다
            #    (돈은 PG 에 남는다). 아래 except 와 같은 취급으로 502 로 끊고 원장을 지킨다.
            # `voided` 부재 = 게이트웨이 계약 위반 → 신뢰할 수 없으므로 실패로 본다(fail-closed).
            if not getattr(pg_result, "voided", False):
                raise RuntimeError(
                    f"PG void rejected (voided=False): {getattr(pg_result, 'raw', {})}"
                )
            pg_refund_id = getattr(pg_result, "transaction_id", None)
            pg_note = {"pg": "voided", "raw": getattr(pg_result, "raw", {})}
        except PartialCancelUnsupportedError as e:
            # 🔴 부분취소 가드 — **돈이 움직이기 전에** 끊은 것이라 장애가 아니다.
            #    502("잠시 후 다시 시도")로 뭉개면 운영자가 계속 재시도한다.
            #    409 + 사유로 내려 "이 건은 전액환불로" 를 알 수 있게 한다.
            logger.info("internal refund: 부분취소 차단 order=%s", order_id)
            raise ApiError("PARTIAL_REFUND_UNSUPPORTED", str(e), 409, "amount") from e
        except Exception as e:  # noqa: BLE001
            logger.error(
                "internal refund: PG void failed order=%s provider=%s err=%s",
                order_id, getattr(order, "pg_provider", None), e,
            )
            raise ApiError(
                "PG_REFUND_FAILED",
                f"PG 승인취소에 실패해 환불을 진행하지 않았습니다: {e}",
                502, "payment",
            ) from e

    # ``is_full`` 은 PG에 돌려줄 돈이 잔액 전부인지, ``cancel_all`` 은 구매계약의
    # 티켓 전부를 취소하는지다. 취소 수수료가 있으면 두 값은 의도적으로 다르다.
    cancel_all = is_full or body.cancel_all
    released = 0
    if cancel_all:
        released = await _release_order_seats_and_tickets(db, order)
        _validate_order_transition(order.status, OrderStatus.REFUNDED.value)
        order.status = OrderStatus.REFUNDED
    else:
        _validate_order_transition(order.status, OrderStatus.PARTIALLY_REFUNDED.value)
        order.status = OrderStatus.PARTIALLY_REFUNDED
    order.total_refunded = already + refund_amt

    # 표준 환불 원장 기록 (M-3): write-through 환불도 Refund row 를 남겨 재무 집계·
    # 대사(reconciliation) 가 단일 원장을 본다.
    # ⚠️ 옛 주석은 "PG void 는 go 가 이미 했으므로 재호출 없이 COMPLETED" 였는데 **사실이 아니었다**
    #    (T16). 이제 위에서 직접 취소하고 그 결과를 pg_refund_id/pg_response 에 남긴다.
    refund = Refund(
        order_id=order.id,
        refund_type=RefundType.FULL if cancel_all else RefundType.PARTIAL,
        status=RefundStatus.COMPLETED,
        amount=refund_amt,
        currency=order.payment_currency or "KRW",
        reason=(body.reason or "internal write-through refund")[:300],
        initiated_by="system",
        requires_approval=False,
        processed_at=datetime.now(timezone.utc),
        # T16: PG 취소 결과를 원장에 남긴다 — 대사(reconciliation)가 "돈이 실제로 나갔는지"를
        #      원장 하나로 판정할 수 있어야 한다. pg_response 로 없음/이미취소/취소됨을 구분.
        pg_refund_id=pg_refund_id,
        pg_response=pg_note,
    )
    db.add(refund)
    await db.flush()
    if cancel_all:
        # 주문 전체 취소: 환불된 티켓 단위로 RefundItem 기록 (refund_service 패턴과 동일).
        for t in refund_tickets:
            before = t.status.value if hasattr(t.status, "value") else str(t.status)
            db.add(
                RefundItem(
                    refund_id=refund.id,
                    ticket_id=t.id,
                    seat_id=t.seat_id,
                    amount=Decimal(str(t.purchase_price or 0)),
                    ticket_status_before=before,
                    ticket_status_after="cancelled",
                )
            )

    await db.commit()
    await _emit_state_changed(order, body.reason or "refund", db)
    # 🔴 go 전파 — **commit 이후**에 큐잉한다 (2026-08-01 신설).
    #    롤백되면 없는 환불을 go 에 알리게 된다.
    #    종전엔 이 경로에 전파가 **아예 없었다** — 카드 취소는 성공하는데 구매자가
    #    환불완료 알림톡을 못 받고 go `attendees` 도 취소로 안 바뀌었다.
    _drain_go_refund_propagation(
        _build_go_refund_hint(order, refund, is_full=is_full, reason=body.reason)
    )
    logger.info(
        "internal order refund: order=%s full_amount=%s cancel_all=%s amount=%s seats_released=%s",
        order_id, is_full, cancel_all, refund_amt, released,
    )
    return {
        "order_id": str(order_id),
        "status": order.status.value if hasattr(order.status, "value") else order.status,
        "refunded": float(refund_amt),
        "total_refunded": float(order.total_refunded),
        "seats_released": released,
    }


async def _do_refund_order_items(
    db: AsyncSession,
    order_id: uuid.UUID,
    body: InternalRefundItemsRequest,
    idempotency_key: str,
) -> dict:
    order = await db.get(Order, order_id)
    if order is None:
        raise ApiError("ORDER_NOT_FOUND", f"order not found: {order_id}", 404)

    ticket_ids = [item.ticket_id for item in body.items]
    tickets = (
        await db.execute(
            select(Ticket).where(
                Ticket.purchase_order_id == order_id,
                Ticket.id.in_(ticket_ids),
            )
        )
    ).scalars().all()
    if len(tickets) != len(ticket_ids):
        raise ApiError(
            "TICKET_NOT_FOUND",
            "one or more tickets do not belong to this order",
            404,
            "items",
        )
    sold_seat_ids = [ticket.seat_id for ticket in tickets if ticket.seat_id]

    service = PartialRefundService(db)
    try:
        refund = await service.process_partial_refund(
            order_id,
            [item.model_dump() for item in body.items],
            reason=body.reason,
            initiated_by="system",
            idempotency_key=idempotency_key,
            force_auto_approve=True,
        )
    except PartialRefundError as exc:
        raise ApiError("REFUND_ITEMS_FAILED", str(exc), 422, "items") from exc

    await db.commit()
    await db.refresh(order)
    released = 0
    if sold_seat_ids:
        released = int((await db.execute(
            select(func.count(Seat.id)).where(
                Seat.id.in_(sold_seat_ids),
                Seat.status == SeatStatus.AVAILABLE,
            )
        )).scalar_one())
    await _emit_state_changed(order, body.reason, db)
    # 🔴 라인단위 환불도 같은 전파가 필요하다 — 안 보내면 go 참석자 투영이 어긋난다.
    #    (전액 여부는 주문 상태로 판정한다. 라인 취소가 잔여를 0으로 만들면 refunded 다.)
    _drain_go_refund_propagation(
        _build_go_refund_hint(
            order,
            refund,
            is_full=(
                (order.status.value if hasattr(order.status, "value") else str(order.status))
                == OrderStatus.REFUNDED.value
            ),
            reason=body.reason,
        )
    )
    return {
        "order_id": str(order_id),
        "status": order.status.value if hasattr(order.status, "value") else str(order.status),
        "refunded": float(refund.amount),
        "seats_released": released,
        "cancelled_ticket_ids": [str(item.ticket_id) for item in refund.items],
    }


async def _do_cancel_order(db: AsyncSession, order_id: uuid.UUID, body: CancelRequest) -> dict:
    order = (
        await db.execute(select(Order).where(Order.id == order_id).with_for_update())
    ).scalar_one_or_none()
    if order is None:
        raise ApiError("ORDER_NOT_FOUND", f"order not found: {order_id}", 404)
    if order.status not in _CANCELABLE_UNPAID:
        raise ApiError(
            "STATE_TRANSITION_FORBIDDEN",
            f"cannot cancel order in status {order.status.value if hasattr(order.status,'value') else order.status}; use refund",
            422, "status",
        )
    released = await _release_order_seats_and_tickets(db, order)
    _validate_order_transition(order.status, OrderStatus.CANCELLED.value)
    order.status = OrderStatus.CANCELLED
    await db.commit()
    await _emit_state_changed(order, body.reason or "cancel")
    logger.info("internal order cancel: order=%s seats_released=%s", order_id, released)
    return {"order_id": str(order_id), "status": "cancelled", "seats_released": released}


@router.post("/orders/{order_id}/refund", summary="go write-through: 주문 환불(전액/부분, 티켓취소+좌석release 원자)")
async def refund_order(
    order_id: uuid.UUID,
    request: Request,
    body: InternalRefundRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(
            idempotency_key, f"orders.refund.{order_id}",
            lambda: _do_refund_order(db, order_id, body),
            fingerprint=_refund_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


@router.post(
    "/orders/{order_id}/refund-items",
    summary="go write-through: 티켓 라인 단위 환불(가격 자동산출+좌석 release)",
)
async def refund_order_items(
    order_id: uuid.UUID,
    request: Request,
    body: InternalRefundItemsRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        if not idempotency_key:
            raise ApiError(
                "IDEMPOTENCY_KEY_REQUIRED",
                "Idempotency-Key header is required",
                400,
            )
        return await _idempotent(
            idempotency_key,
            f"orders.refund-items.{order_id}",
            lambda: _do_refund_order_items(db, order_id, body, idempotency_key),
            # reason은 지급 결과를 바꾸지 않는다. 같은 주문+티켓+금액은 같은 작업이다.
            fingerprint=_fingerprint({
                "items": sorted(
                    (str(item.ticket_id), item.amount) for item in body.items
                ),
            }),
        )
    except ApiError as e:
        await db.rollback()
        return _err(e)


@router.post("/orders/{order_id}/cancel", summary="go write-through: 미결제 주문 취소(좌석/티켓 release)")
async def cancel_order(
    order_id: uuid.UUID,
    request: Request,
    body: CancelRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(
            idempotency_key, f"orders.cancel.{order_id}",
            lambda: _do_cancel_order(db, order_id, body), fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


# ── 내부 결제확정 (manual/group/외부수금 주문 → CONFIRMED) ───────────────
#
# go createOrder(write-through) 후 결제가 go/외부에서 완결된 주문(수동·단체·comp)을
# v2 에서 CONFIRMED 로 전이. 소비자 PG 결제는 기존 /orders/{id}/pay(payment_service,
# PG검증·사기탐지·AP)가 담당 — 이건 service-token 신뢰 경로(PG 검증 생략).


class ConfirmPaymentRequest(BaseModel):
    pg_transaction_id: str | None = None
    amount: float | None = None
    method: str | None = None
    source: str | None = None


async def _do_confirm_payment(db: AsyncSession, order_id: uuid.UUID, body: ConfirmPaymentRequest) -> dict:
    order = (
        await db.execute(select(Order).where(Order.id == order_id).with_for_update())
    ).scalar_one_or_none()
    if order is None:
        raise ApiError("ORDER_NOT_FOUND", f"order not found: {order_id}", 404)
    # 멱등: 이미 확정/결제됨 → 그대로 반환.
    if order.status in (OrderStatus.CONFIRMED, OrderStatus.PAID):
        return {"order_id": str(order_id),
                "status": order.status.value if hasattr(order.status, "value") else order.status,
                "already": True}
    if order.status not in (OrderStatus.PENDING, OrderStatus.PAYMENT_REQUIRED, OrderStatus.AUTHORIZED):
        raise ApiError(
            "STATE_TRANSITION_FORBIDDEN",
            f"cannot confirm payment for order in status {order.status.value if hasattr(order.status,'value') else order.status}",
            422, "status",
        )
    if body.amount is not None and abs(Decimal(str(body.amount)) - Decimal(str(order.total_amount or 0))) > Decimal("0.01"):
        raise ApiError("AMOUNT_MISMATCH", f"expected {order.total_amount}, got {body.amount}", 400, "amount")

    # ── 🔴 T15 우회 차단: 카드사 할인 주문은 이 경로로 확정될 수 없다 ──────────────
    #
    # 이 엔드포인트는 manual/group/무통장입금 확정용이라 **PG 승인 응답이 없다** →
    # PaymentService 의 카드사 재검증(T15)이 아예 돌지 않는다. BC 10% 가 깎인 주문을
    # 여기로 흘리면 **카드를 한 장도 안 내고 할인만 받는다**(감사 발견 경로:
    # 체크아웃에서 BC 선택 → 무통장입금으로 완료 → 주최자 입금확정).
    #
    # 판정은 v2 원장뿐이다 — card_discount 는 주문 생성 시 적용된 할인, card_issuer 는
    # T15 가 승인 응답에서 확인해 남긴 값. 할인은 있는데 확인 기록이 없으면 거부한다.
    _pmeta = order.payment_metadata if isinstance(order.payment_metadata, dict) else {}
    if _pmeta.get("card_discount") and not _pmeta.get("card_issuer"):
        raise ApiError(
            "CARD_DISCOUNT_UNVERIFIED",
            "카드사 자동할인이 적용된 주문은 해당 카드로 결제해야 확정됩니다 "
            "(무통장입금·수기확정 불가). 할인 없이 재주문하거나 카드로 결제해주세요.",
            422, "payment_metadata.card_discount",
        )

    # fee 동결 보장(W3.2 외 경로로 생성된 주문 대비).
    if order.platform_fee is None:
        fin = FinanceService(db)
        comp = await fin.get_fee_components(event_id=order.event_id)
        plat, pg = fin.compute_fees(order.total_amount or 0, comp)
        order.platform_fee_rate = Decimal(str(comp["platform_fee_rate"]))
        order.platform_fee = plat
        order.pg_fee_rate = Decimal(str(comp["pg_fee_rate"]))
        order.pg_fee = pg
        order.net_amount = Decimal(str(order.total_amount or 0)) - plat - pg

    order.status = OrderStatus.CONFIRMED
    order.captured_at = datetime.now(timezone.utc)
    if body.pg_transaction_id:
        order.pg_transaction_id = body.pg_transaction_id
    if body.method or body.source:
        order.pg_provider = body.method or body.source or order.pg_provider
    # 티켓 활성화: PENDING → ACTIVE (둘 다 점유 → sold_count 불변).
    await db.execute(
        update(Ticket)
        .where(Ticket.purchase_order_id == order_id, Ticket.status == TicketStatus.PENDING)
        .values(status=TicketStatus.ACTIVE)
    )
    await db.commit()
    logger.info("internal order confirm-payment: order=%s source=%s", order_id, body.source)
    # 레벨2 영역C: 결제확정 = 구매완료. 커밋 후 트리거(트랜잭션 알림 + 조직자 new_order).
    from app.services.messaging import triggers

    await triggers.on_order_confirmed(db, order)
    return {"order_id": str(order_id), "status": "confirmed", "already": False}


@router.post("/orders/{order_id}/confirm-payment", summary="go write-through: 내부 결제확정(manual/group)")
async def confirm_payment_internal(
    order_id: uuid.UUID,
    request: Request,
    body: ConfirmPaymentRequest,
    db: AsyncSession = Depends(get_db),
):
    try:
        return _ok(await _do_confirm_payment(db, order_id, body))
    except ApiError as e:
        return _err(e)


# ── 내부 결제 prepare (go self-checkout 나이스 구형 결제창 form params) ──────
#
# organizer(go) self-checkout 은 서비스토큰으로 go+v2 주문을 write-through 생성(_do_create_order)
# 하고 {order_id, provider} 만 받는다. 나이스 구형 결제창(goPay)은 서버계산 SignData(=payForm)가
# 필수인데, go 는 회원(get_current_user)·게스트(view 토큰) prepare 를 쓸 수 없다(토큰 미보유) →
# provider_params 를 못 받아 라이브 구형결제가 불가(현재 mock 폴백).
#
# 이 엔드포인트는 **서비스토큰 인증**(_internal_auth: HMAC 또는 전환기 토큰, production fail-closed)
# + **order_ref 매칭**(v2 order id 또는 external_ref=go order id) + **PaymentService.initiate_payment
# 재사용**(회원/게스트와 동일 로직)으로 provider_params 를 반환한다.
#
# 계약 불변:
#   - PaymentPrepareResponse 형태·provider_params(nice payForm)·게이트웨이 서명·initiate_payment
#     로직은 전부 재사용(무변형). 회원/게스트 prepare 무영향.
#   - U4 판매게이트·0원 free·멱등·pg_provider 라우팅은 initiate_payment/주문생성이 이미 처리한다
#     (0원 주문은 생성 시 이미 CONFIRMED → initiate_payment 가 ValueError → 400, 라이브 구형결제
#      대상 아님. 판매게이트는 주문 생성(_do_create_order U4)에서 이미 통과).
#   - 트랜잭션 경계: initiate_payment 는 커밋하지 않는다(호출자 경계). PG prepare 외부호출은
#     order.status 를 PAYMENT_REQUIRED 로 전이시키므로 여기서 commit 한다. prepare 는 조회·서명
#     계산·세션기록만 하는 read-mostly 준비단계이며, 재호출은 동일 idempotency_key 시 기존
#     payment 세션을 재반환(멱등) → "동시 2회 실행"·"외부호출 후 crash" 모두 재시도 안전.


class InternalPreparePaymentRequest(BaseModel):
    """go self-checkout 나이스 구형 결제창 prepare — 서비스토큰 경로(회원/게스트 토큰 없음).

    success_url/fail_url/pay_method/idempotency_key 는 회원 PaymentPrepareRequest 와 동형.
    success_url 은 'go' origin 센티넬(v2 return 핸들러가 MallReserved 를 읽어 go 전역 랜딩으로
    302)이거나 pickket.kr redirect URL. redirect URL 도메인 검증도 회원 스키마와 동일하게 재사용.
    """

    success_url: str | None = Field(None, max_length=500)
    fail_url: str | None = Field(None, max_length=500)
    pay_method: str | None = Field(default=None, max_length=32)
    idempotency_key: str | None = Field(default=None, max_length=120)

    @field_validator("success_url", "fail_url", mode="before")
    @classmethod
    def _validate_redirect_url(cls, v: str | None) -> str | None:
        # go origin 센티넬 'go' 는 URL 이 아니므로 도메인 검증을 건너뛴다(initiate_payment 가
        # PG prepare 로 넘기고, v2 return 핸들러가 실제 목적지 URL 을 소유 — open-redirect 차단).
        if v == "go":
            return v
        # 그 외는 회원 PaymentPrepareRequest 검증기 재사용(pickket.kr·딥링크만 허용).
        from app.schemas.order import PaymentPrepareRequest

        return PaymentPrepareRequest.validate_redirect_url(v)


async def _resolve_internal_order(db: AsyncSession, order_ref: str) -> Order:
    """order_ref(v2 order id 또는 external_ref=go order id)로 주문 로드(테넌트 안전).

    guest _load_guest_order·_do_create_order dedup 패턴과 동형: v2 UUID 우선, 아니면 external_ref.
    미존재/미매칭은 동일 404(enumeration-safe). external_ref 는 UNIQUE(ix_orders_external_ref)라
    단일 매칭이 보장되며, 이 조회는 order_ref 자체로만 판정하므로 크로스테넌트 누출이 없다
    (order_ref 를 아는 주체 = 그 주문을 write-through 로 만든 go 세션).
    """
    order: Order | None = None
    try:
        oid = uuid.UUID(order_ref)
    except (ValueError, TypeError):
        oid = None
    if oid is not None:
        order = (
            await db.execute(select(Order).where(Order.id == oid))
        ).scalar_one_or_none()
    if order is None:
        order = (
            await db.execute(select(Order).where(Order.external_ref == order_ref))
        ).scalar_one_or_none()
    if order is None:
        raise ApiError("ORDER_NOT_FOUND", f"order not found: {order_ref}", 404)
    return order


@router.post(
    "/orders/{order_ref}/payment/prepare",
    summary="go self-checkout: 나이스 구형 결제창 prepare(서비스토큰 + external_ref 매칭 + initiate_payment 재사용)",
)
async def prepare_payment_internal(
    order_ref: str,
    request: Request,
    body: InternalPreparePaymentRequest,
    db: AsyncSession = Depends(get_db),
):
    """go self-checkout 유료주문 PG 결제창 준비(provider_params.form 반환, nice 구형).

    소유증명: 서비스토큰(_internal_auth, HMAC 또는 전환기 토큰) — 회원/게스트 토큰 불요.
    order_ref: v2 order id 또는 external_ref(go order id). 준비 로직은 회원/게스트와 동일한
    PaymentService.initiate_payment(order 기반·PG prepare·payment_id·deadline·PAYMENT_REQUIRED
    전이·audit)를 그대로 재사용한다 — 유일 차이는 인증 게이트(토큰)뿐이다.
    """
    from app.core.audit import write_audit_log
    from app.core.errors import client_error_detail
    from app.services.payment_service import PaymentService

    try:
        order = await _resolve_internal_order(db, order_ref)
    except ApiError as e:
        return _err(e)

    # rollback 후 expired ORM 속성 재로딩(lazy IO)을 피하려고 필요한 값은 미리 plain 으로 캡처한다.
    resolved_order_id = order.id
    resolved_event_id = order.event_id
    resolved_external_ref = order.external_ref

    service = PaymentService(db)
    try:
        prepared = await service.initiate_payment(
            order_id=resolved_order_id,
            idempotency_key=body.idempotency_key,
            success_url=body.success_url,
            fail_url=body.fail_url,
            pay_method=body.pay_method,
        )
        await write_audit_log(
            db,
            actor_id=None,  # 서비스토큰 경로 — order 스코프로 추적.
            action="payment.prepare.internal",
            resource_type="order",
            resource_id=str(resolved_order_id),
            event_id=resolved_event_id,
            new_value={"external_ref": resolved_external_ref, "pay_method": body.pay_method},
        )
        await db.commit()
        # PaymentPrepareResponse(pydantic) 그대로 반환 — provider_params 포함(nice 구형 payForm).
        return prepared
    except ValueError as e:
        # 0원 자동confirm 주문/판매창 밖/이미 확정 등 initiate 불가 상태 → 400(조용한 실패 금지).
        await db.rollback()
        logger.warning(
            "internal 결제 준비 실패: order=%s ref=%s", resolved_order_id, order_ref, exc_info=True
        )
        raise HTTPException(
            status_code=400,
            detail=client_error_detail(e, "결제 준비에 실패했습니다."),
        )


# ── #5 정산 freeze/갱신 (go settlements 테이블 DROP 대체) ────────────────
#
# go finalize(go-local INSERT) → v2 POST. go settlements/[id] PATCH(현 501) → v2 PATCH.
# v2 settlement=organizer·period 집계(이벤트별 아님). 동결값(order.platform_fee/pg_fee) SUM.

from app.models.settlement import OrganizerSettlement  # noqa: E402

_VALID_SETTLEMENT_STATUS = {"draft", "pending_review", "reviewed", "approved", "paid", "disputed"}


class SettlementFreezeRequest(BaseModel):
    period_start: str
    period_end: str
    event_ids: list[uuid.UUID] | None = None


class SettlementPatchRequest(BaseModel):
    status: str | None = None
    bank_name: str | None = None
    account_number: str | None = None
    account_holder: str | None = None
    memo: str | None = None
    paid_at: str | None = None


async def _do_freeze_settlement(db: AsyncSession, organizer_id: uuid.UUID, body: SettlementFreezeRequest) -> dict:
    from sqlalchemy import func as _F
    from app.models.order import Order, OrderStatus
    from app.models.event import Event
    start = _parse_dt(body.period_start, "period_start")
    end = _parse_dt(body.period_end, "period_end")
    if end <= start:
        raise ApiError("VALIDATION_ERROR", "period_end must be after period_start", 400, "period_end")
    filt = [
        Event.organizer_id == organizer_id,
        Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID,
                          OrderStatus.PARTIALLY_REFUNDED, OrderStatus.REFUNDED]),
        Order.created_at >= start, Order.created_at < end,
    ]
    if body.event_ids:
        filt.append(Order.event_id.in_(body.event_ids))
    row = (
        await db.execute(
            select(
                _F.coalesce(_F.sum(Order.total_amount), 0),
                _F.coalesce(_F.sum(Order.total_refunded), 0),
                _F.coalesce(_F.sum(Order.platform_fee), 0),
                _F.coalesce(_F.sum(Order.pg_fee), 0),
                _F.count(Order.id),
            ).select_from(Order).join(Event, Event.id == Order.event_id).where(*filt)
        )
    ).first()
    gross = Decimal(str(row[0] or 0)); refunds = Decimal(str(row[1] or 0))
    plat = Decimal(str(row[2] or 0)); pg = Decimal(str(row[3] or 0))
    net = gross - plat - pg - refunds
    s = OrganizerSettlement(
        organizer_id=organizer_id, period_start=start, period_end=end,
        gross_revenue=gross, total_refunds=refunds, platform_fee=plat, pg_fee=pg,
        net_payout=net, status="draft",
    )
    db.add(s)
    await _commit_or_conflict(db, "settlement")
    logger.info("internal settlement freeze: org=%s net=%s orders=%s", organizer_id, net, row[4])
    return {"settlement_id": str(s.id), "organizer_id": str(organizer_id),
            "gross_amount": float(gross), "platform_fee": float(plat), "pg_fee": float(pg),
            "refund_amount": float(refunds), "net_amount": float(net),
            "order_count": int(row[4] or 0), "status": "draft"}


async def _do_patch_settlement(db: AsyncSession, organizer_id: uuid.UUID, settlement_id: uuid.UUID,
                               body: SettlementPatchRequest) -> dict:
    s = await db.get(OrganizerSettlement, settlement_id)
    if s is None or s.organizer_id != organizer_id:
        raise ApiError("SETTLEMENT_NOT_FOUND", f"settlement not found: {settlement_id}", 404)
    if body.status is not None:
        if body.status not in _VALID_SETTLEMENT_STATUS:
            raise ApiError("VALIDATION_ERROR", f"invalid settlement status: {body.status}", 400, "status")
        s.status = body.status
    if body.memo is not None:
        s.dispute_reason = body.memo
    if body.paid_at is not None:
        s.paid_at = _parse_dt(body.paid_at, "paid_at")
    # 은행정보는 organizer User 의 정산계좌(여러 정산 공통).
    if body.bank_name is not None or body.account_number is not None or body.account_holder is not None:
        org = await db.get(User, organizer_id)
        if org is not None:
            if body.bank_name is not None:
                org.settlement_bank = body.bank_name
            if body.account_number is not None:
                org.settlement_account_number = body.account_number
            if body.account_holder is not None:
                org.settlement_account_holder = body.account_holder
    await db.commit()
    logger.info("internal settlement patch: id=%s status=%s", settlement_id, s.status)
    return {"settlement_id": str(settlement_id), "status": s.status,
            "paid_at": s.paid_at.isoformat() if s.paid_at else None}


@router.post("/organizers/{organizer_ref}/settlements", summary="go write-through: 정산 동결(freeze)")
async def freeze_settlement(
    organizer_ref: str,
    request: Request,
    body: SettlementFreezeRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        try:
            org_ref = OrganizerRef(organizer_id=uuid.UUID(organizer_ref))
        except ValueError:
            org_ref = OrganizerRef(go_account_id=organizer_ref)
        organizer_id = await _resolve_organizer(db, org_ref)
        return await _idempotent(
            idempotency_key, f"settlement.freeze.{organizer_id}",
            lambda: _do_freeze_settlement(db, organizer_id, body), fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


@router.patch("/organizers/{organizer_ref}/settlements/{settlement_id}", summary="go write-through: 정산 갱신")
async def patch_settlement(
    organizer_ref: str,
    settlement_id: uuid.UUID,
    request: Request,
    body: SettlementPatchRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        try:
            org_ref = OrganizerRef(organizer_id=uuid.UUID(organizer_ref))
        except ValueError:
            org_ref = OrganizerRef(go_account_id=organizer_ref)
        organizer_id = await _resolve_organizer(db, org_ref)
        return await _idempotent(
            idempotency_key, f"settlement.patch.{settlement_id}",
            lambda: _do_patch_settlement(db, organizer_id, settlement_id, body),
            fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


# ── 판매 단계(sale plan) — 레벨2 컷오버 T2-PHASE ──────────────────────────
#
# go `sale_phases` 를 흡수한 정본 write/read 경로. 이전에는 주최자 applyMode 가
# go DB 에만 쓰이고 v2 `phase_configs` 는 "심사 요청" 웹훅 한 번으로만 갱신돼,
# 승인 이후의 판매계획 변경이 v2 자동 추첨·FCFS 전환에 **영원히 반영되지 않았다**
# (현존 P0 #1). 이 엔드포인트가 그 유일 writer 문제를 닫는다.

class SalePlanPhaseIn(BaseModel):
    mode: str = Field(..., min_length=1, max_length=50)
    ratio_pct: float = Field(..., ge=0, le=100)
    opens_at: str
    closes_at: str
    fanclub_id: str | None = None


class SalePlanRequest(BaseModel):
    # 빈 배열 = 선착순 단독 이벤트(fcfs_opens_at 필수). 서비스가 fcfs_residual 1단계를
    # 생성하므로 **저장 시퀀스는 절대 비지 않는다**(delete-then-insert 안전).
    phases: list[SalePlanPhaseIn] = Field(default_factory=list, max_length=3)
    fcfs_opens_at: str | None = None


async def _do_apply_sale_plan(
    db: AsyncSession, event_id: uuid.UUID, body: SalePlanRequest
) -> dict:
    from app.services import sale_phase_service as sps

    event = await _require_event(db, event_id)
    try:
        specs = [
            sps.PhaseSpec(
                mode=p.mode,
                ratio_pct=p.ratio_pct,
                opens_at=_parse_dt(p.opens_at, f"phases[{i}].opens_at"),
                closes_at=_parse_dt(p.closes_at, f"phases[{i}].closes_at"),
                fanclub_id=p.fanclub_id,
            )
            for i, p in enumerate(body.phases)
        ]
        fcfs_opens_at = (
            _parse_dt(body.fcfs_opens_at, "fcfs_opens_at") if body.fcfs_opens_at else None
        )
        created = await sps.apply_sale_plan(db, event, specs, fcfs_opens_at)
    except sps.SalePlanError as exc:
        # 주최자 입력 오류 — 한국어 메시지를 그대로 봉투에 실어 go 가 표시한다.
        raise ApiError(exc.code, exc.message, 400) from exc

    out = [sps.phase_to_dict(pc) for pc in created]
    await _commit_or_conflict(db, "sale plan")
    await cache_delete_many_safe(event_id)
    return {"phases": out, "total": len(out)}


async def cache_delete_many_safe(event_id: uuid.UUID) -> None:
    """판매계획 변경 시 이벤트 상세/공개 단계 캐시 무효화 (실패해도 write 는 성공)."""
    try:
        from app.core.redis import cache_delete_pattern

        await cache_delete_pattern(f"events:detail:{event_id}*")
        await cache_delete_pattern(f"phase:current:{event_id}*")
    except Exception:  # noqa: BLE001
        logger.debug("sale-plan cache invalidation failed", exc_info=True)


@router.put("/events/{event_id}/sale-plan", summary="go write-through: 판매 단계 계획 저장")
async def put_sale_plan(
    event_id: uuid.UUID,
    request: Request,
    body: SalePlanRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        # fingerprint 필수 — 주최자가 같은 이벤트의 계획을 반복 수정할 때 go 는 안정 멱등키
        # (`sale-plan:{eventId}`)를 재사용한다. 지문이 없으면 첫 저장 응답이 replay 되어
        # 수정이 v2 에 반영되지 않는다.
        return await _idempotent(
            idempotency_key,
            f"saleplan.apply.{event_id}",
            lambda: _do_apply_sale_plan(db, event_id, body),
            fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


@router.get("/events/{event_id}/sale-plan", summary="go live read: 판매 단계 목록")
async def get_sale_plan(
    event_id: uuid.UUID,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    from app.services import sale_phase_service as sps

    event = await db.get(Event, event_id)
    if event is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    phases = await sps.list_phases(db, event_id)
    current = await sps.get_current_phase(db, event_id)
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok(
        {
            "phases": [sps.phase_to_dict(p) for p in phases],
            "current": sps.phase_to_dict(current) if current else None,
            "total": len(phases),
        }
    )


# ════════════════════════════════════════════════════════════════════════
# Wave5 W5-COMMERCE — 상거래 부가기능 (레벨2 컷오버, go DB 완전 제거)
#
# 담당 go 테이블 6종의 v2 대응 API.
#   promo_codes          → discount_codes (기존 모델) + 이 절의 CRUD/validate
#   group_bookings       → group_bookings (신설)
#   product_bundle_items → seat_tiers.bundle_items (기존 JSONB — 신규 API 없음)
#   pricing_rules        → tier_pricing_rules (신설)
#   price_history        → tier_price_history (신설, writer 는 _do_upsert_tiers)
#   refund_policies      → event_refund_policies (신설, **write 경로 신설**)
#
# 🔴 이 절은 전부 "돈이 틀어지는" 경로다. 조회 실패를 할인 0·환불 불가·정책 없음으로
#    흘리지 않는다 — 실패는 에러로 전파하고 go 라우트가 503 으로 끊는다.
# ════════════════════════════════════════════════════════════════════════

# ── 프로모코드(= discount_codes) CRUD ─────────────────────────────────────
#
# go `promo_codes` 는 v2 discount_codes 의 thin 앵커였다(id ↔ v2_code_id). 앵커를 없애면
# 주최자 화면이 코드를 **v2 discount_code_id 로 직접 주소지정**해야 하므로, upsert 배치
# API 만으로는 부족한 부분(409 중복, 부분수정, 삭제, 체크아웃 검증)을 여기서 채운다.

_GO_PROMO_TYPES = {"fixed", "percentage"}


def _as_utc(dt: datetime | None) -> datetime | None:
    """naive datetime 을 UTC 로 간주해 비교 가능하게 만든다.

    PG 는 TIMESTAMPTZ 로 tz-aware 를 돌려주지만 일부 드라이버/백엔드(sqlite 테스트)는
    naive 를 돌려준다. 그대로 비교하면 TypeError 로 **유효기간 판정 자체가 500 으로 터진다** —
    프로모코드 검증에서 그건 "코드가 먹지 않는다"가 아니라 "체크아웃이 죽는다"이다.
    """
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _promo_row(c: DiscountCode) -> dict:
    """v2 discount_code → go 프로모코드 화면 계약(1행)."""
    dtype = c.discount_type.value if hasattr(c.discount_type, "value") else c.discount_type
    is_pct = dtype == DiscountCodeType.PERCENTAGE.value
    return {
        # go 화면이 쓰는 id = v2 canonical discount_code_id (앵커 폐기 후 유일 식별자).
        "promo_id": str(c.id),
        "code": c.code,
        "promo_type": "percentage" if is_pct else "fixed",
        "discount_value": float(c.rate or 0) if is_pct else float(c.amount or 0),
        "usage_limit": c.max_uses,
        "used_count": c.used_count or 0,
        "starts_at": c.valid_from.isoformat() if c.valid_from else None,
        "ends_at": c.valid_until.isoformat() if c.valid_until else None,
        "is_active": bool(c.is_active),
        "description": c.description,
        "min_order_amount": float(c.min_order_amount) if c.min_order_amount is not None else None,
        "max_discount_amount": (
            float(c.max_discount_amount) if c.max_discount_amount is not None else None
        ),
        "created_at": c.created_at.isoformat() if c.created_at else None,
    }


def _assert_promo_value(promo_type: str, value: float) -> None:
    """정률 1~100 / 정액 0 이상. go 라우트 검증의 서버측 복제(우회 차단)."""
    if promo_type not in _GO_PROMO_TYPES:
        raise ApiError("VALIDATION_ERROR", f"invalid promo_type: {promo_type}", 400, "promo_type")
    if promo_type == "percentage":
        if value < 1 or value > 100:
            raise ApiError("VALIDATION_ERROR", "percentage discount must be 1~100", 400, "discount_value")
    elif value < 0:
        raise ApiError("VALIDATION_ERROR", "fixed discount must be >= 0", 400, "discount_value")


def _apply_promo_value(code: DiscountCode, promo_type: str, value: float) -> None:
    """promo_type 전환 시 반대편 컬럼을 **반드시 비운다**.

    percentage→fixed 로 바꾸면서 rate 를 남겨두면, 나중에 타입만 되돌렸을 때 옛 비율이
    되살아나 의도치 않은 금액이 나간다. 두 컬럼은 언제나 한쪽만 채워져 있어야 한다.
    """
    if promo_type == "percentage":
        code.discount_type = DiscountCodeType.PERCENTAGE
        code.rate = value
        code.amount = None
    else:
        code.discount_type = DiscountCodeType.FIXED
        code.amount = value
        code.rate = None


class PromoCodeCreate(BaseModel):
    code: str = Field(..., min_length=2, max_length=50)
    promo_type: str
    discount_value: float = Field(..., ge=0)
    usage_limit: int | None = Field(default=None, gt=0)
    starts_at: str | None = None
    ends_at: str | None = None
    is_active: bool = True
    description: str | None = None
    min_order_amount: float | None = None
    max_discount_amount: float | None = None


class PromoCodePatch(BaseModel):
    """부분 수정 — `model_fields_set` 기반. 안 보낸 필드는 보존한다.

    ⚠️ `promo_type` 과 `discount_value` 는 짝이다. 한쪽만 보내면 400 으로 끊는다
    (예: 정액 5000원 코드에 promo_type=percentage 만 보내면 "5000%" 가 된다).
    """

    code: str | None = Field(default=None, min_length=2, max_length=50)
    promo_type: str | None = None
    discount_value: float | None = Field(default=None, ge=0)
    usage_limit: int | None = None
    starts_at: str | None = None
    ends_at: str | None = None
    is_active: bool | None = None
    description: str | None = None
    min_order_amount: float | None = None
    max_discount_amount: float | None = None


async def _load_promo(db: AsyncSession, event_id: uuid.UUID, promo_id: uuid.UUID) -> DiscountCode:
    """이벤트 스코프 프로모코드 1건. 미존재/타 이벤트/삭제됨 → 404(구분하지 않는다)."""
    code = (
        await db.execute(
            select(DiscountCode).where(
                DiscountCode.id == promo_id,
                DiscountCode.event_id == event_id,
                DiscountCode.deleted_at.is_(None),
            )
        )
    ).scalar_one_or_none()
    if code is None:
        raise ApiError("PROMO_NOT_FOUND", f"promo code not found: {promo_id}", 404)
    return code


async def _do_create_promo(db: AsyncSession, event_id: uuid.UUID, body: PromoCodeCreate) -> dict:
    await _require_event(db, event_id)
    promo_type = body.promo_type.lower()
    _assert_promo_value(promo_type, body.discount_value)
    vf = _parse_dt(body.starts_at, "starts_at") if body.starts_at else None
    vu = _parse_dt(body.ends_at, "ends_at") if body.ends_at else None

    normalized = body.code.upper()
    existing = (
        await db.execute(
            select(DiscountCode).where(
                DiscountCode.event_id == event_id, DiscountCode.code == normalized
            )
        )
    ).scalar_one_or_none()
    if existing is not None and existing.deleted_at is None:
        raise _Conflict(f"promo code already exists: {normalized}")

    code = existing
    if code is None:
        code = DiscountCode(event_id=event_id, code=normalized, discount_type=DiscountCodeType.FIXED)
        db.add(code)
    else:
        # 소프트 삭제된 같은 코드의 부활. UNIQUE(event_id, code) 때문에 새 행을 못 만든다.
        # 🔴 used_count 는 **초기화하지 않는다** — 초기화하면 삭제→재생성으로 사용 한도를
        #    무한 우회할 수 있다(fail-closed).
        code.deleted_at = None
    _apply_promo_value(code, promo_type, body.discount_value)
    code.max_uses = body.usage_limit
    code.valid_from = vf
    code.valid_until = vu
    code.is_active = body.is_active
    code.description = body.description
    code.min_order_amount = body.min_order_amount
    code.max_discount_amount = body.max_discount_amount
    await _commit_or_conflict(db, "promo code (event_id, code)")
    await db.refresh(code)
    return _promo_row(code)


async def _do_patch_promo(
    db: AsyncSession, event_id: uuid.UUID, promo_id: uuid.UUID, body: PromoCodePatch
) -> dict:
    await _require_event(db, event_id)
    code = await _load_promo(db, event_id, promo_id)
    sent = body.model_fields_set

    type_sent = "promo_type" in sent and body.promo_type is not None
    value_sent = "discount_value" in sent and body.discount_value is not None
    if type_sent != value_sent:
        raise ApiError(
            "VALIDATION_ERROR",
            "promo_type and discount_value must be changed together",
            400,
            "discount_value",
        )
    if type_sent:
        promo_type = body.promo_type.lower()
        _assert_promo_value(promo_type, body.discount_value)
        _apply_promo_value(code, promo_type, body.discount_value)

    if "code" in sent and body.code is not None:
        code.code = body.code.upper()
    # null 이 유효값인 필드들(무제한/무기한) — 전달 여부로 판정한다.
    if "usage_limit" in sent:
        code.max_uses = body.usage_limit
    if "starts_at" in sent:
        code.valid_from = _parse_dt(body.starts_at, "starts_at") if body.starts_at else None
    if "ends_at" in sent:
        code.valid_until = _parse_dt(body.ends_at, "ends_at") if body.ends_at else None
    if "is_active" in sent and body.is_active is not None:
        code.is_active = body.is_active
    if "description" in sent:
        code.description = body.description
    if "min_order_amount" in sent:
        code.min_order_amount = body.min_order_amount
    if "max_discount_amount" in sent:
        code.max_discount_amount = body.max_discount_amount

    await _commit_or_conflict(db, "promo code (event_id, code)")
    await db.refresh(code)
    return _promo_row(code)


async def _do_delete_promo(db: AsyncSession, event_id: uuid.UUID, promo_id: uuid.UUID) -> dict:
    """소프트 삭제 + 즉시 비활성.

    🔴 `is_active=False` 를 반드시 함께 세팅한다. 주문 생성 경로(`_do_create_order`)는
    is_active 만 보므로 deleted_at 만 찍으면 **삭제한 코드가 계속 할인된다**.
    "이미 없음"을 성공으로 흡수하지 않는다 — 미존재는 404 다.
    """
    await _require_event(db, event_id)
    code = await _load_promo(db, event_id, promo_id)
    code.deleted_at = datetime.now(timezone.utc)
    code.is_active = False
    await db.commit()
    return {"promo_id": str(promo_id), "deleted": True}


@router.get("/events/{event_id}/promo-codes", summary="go live read: 프로모코드 목록(사용량 포함)")
async def list_promo_codes(
    event_id: uuid.UUID,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    codes = (
        await db.execute(
            select(DiscountCode)
            .where(DiscountCode.event_id == event_id, DiscountCode.deleted_at.is_(None))
            .order_by(DiscountCode.created_at.desc())
        )
    ).scalars().all()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok({"promo_codes": [_promo_row(c) for c in codes], "total": len(codes)})


@router.post("/events/{event_id}/promo-codes", summary="go write-through: 프로모코드 생성")
async def create_promo_code(
    event_id: uuid.UUID,
    request: Request,
    body: PromoCodeCreate,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(
            idempotency_key,
            f"promo.create.{event_id}",
            lambda: _do_create_promo(db, event_id, body),
            fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


@router.patch("/events/{event_id}/promo-codes/{promo_id}", summary="go write-through: 프로모코드 수정")
async def patch_promo_code(
    event_id: uuid.UUID,
    promo_id: uuid.UUID,
    request: Request,
    body: PromoCodePatch,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(
            idempotency_key,
            f"promo.patch.{event_id}.{promo_id}",
            lambda: _do_patch_promo(db, event_id, promo_id, body),
            fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


@router.delete("/events/{event_id}/promo-codes/{promo_id}", summary="go write-through: 프로모코드 삭제")
async def delete_promo_code(
    event_id: uuid.UUID,
    promo_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    try:
        return _ok(await _do_delete_promo(db, event_id, promo_id))
    except ApiError as e:
        return _err(e)


class PromoValidateRequest(BaseModel):
    code: str = Field(..., min_length=1, max_length=50)
    gross_amount: float = Field(..., ge=0)


@router.post(
    "/events/{event_id}/promo-codes/validate",
    summary="go live read: 프로모코드 검증 + 할인액 산정(차감 없음)",
)
async def validate_promo_code(
    event_id: uuid.UUID,
    request: Request,
    body: PromoValidateRequest,
    db: AsyncSession = Depends(get_db),
):
    """체크아웃 표시/합산용 할인액 산정.

    ## 🔴 여기서 used_count 를 차감하지 않는 이유
    차감은 **주문 생성 트랜잭션 안에서만** 일어난다(`_do_create_order`, 같은 트랜잭션에서
    `FOR UPDATE` 로 코드 행을 잠그고 +1). 검증 단계에서 차감하면
      - 결제까지 안 간 검증이 한도를 갉아먹고,
      - 검증 재시도가 2회 차감되며(멱등 아님),
      - 검증/주문 사이 crash 가 유령 사용량을 남긴다.
    반대로 한도 초과는 **여기서도 막는다**(PROMO_EXHAUSTED 409) — "일단 통과시키고 주문에서
    걸러라"로 두면 화면은 할인된 금액을 보여주고 결제만 실패한다.

    ## 금액 정본
    할인액은 주문 생성이 쓰는 `_compute_discount_amount` **그 함수**로 계산한다. 다른 식을
    쓰면 표시액과 청구액이 갈라지고, v2 의 total_amount 재검증이 AMOUNT_MISMATCH 로 터진다.
    """
    try:
        await _require_event(db, event_id)
        normalized = body.code.upper()
        code = (
            await db.execute(
                select(DiscountCode).where(
                    DiscountCode.event_id == event_id,
                    DiscountCode.code == normalized,
                    DiscountCode.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        if code is None or not code.is_active:
            raise ApiError("PROMO_NOT_FOUND", "discount code invalid or inactive", 404, "code")
        now = datetime.now(timezone.utc)
        valid_from = _as_utc(code.valid_from)
        valid_until = _as_utc(code.valid_until)
        if valid_from and valid_from > now:
            raise ApiError("PROMO_NOT_YET", "discount not yet valid", 400, "code")
        if valid_until and valid_until < now:
            raise ApiError("PROMO_EXPIRED", "discount expired", 400, "code")
        if code.max_uses is not None and (code.used_count or 0) >= code.max_uses:
            raise ApiError("PROMO_EXHAUSTED", "discount usage limit reached", 409, "code")

        gross = Decimal(str(body.gross_amount))
        discount = _compute_discount_amount(code, gross)
        final = gross - discount
        if final < 0:
            final = Decimal(0)
        row = _promo_row(code)
        return _ok(
            {
                "valid": True,
                "promo_id": row["promo_id"],
                "code": row["code"],
                "promo_type": row["promo_type"],
                "discount_value": row["discount_value"],
                "gross_amount": float(gross),
                "discount_amount": float(discount),
                "final_amount": float(final),
            }
        )
    except ApiError as e:
        return _err(e)


# ── 단체예약 ──────────────────────────────────────────────────────────────


def _group_booking_row(b: GroupBooking, tier: SeatTier | None) -> dict:
    return {
        "booking_id": str(b.id),
        "event_id": str(b.event_id),
        "product_ref": b.product_ref,
        # 상품명/가격은 v2 티어 카탈로그가 정본. 티어가 지워졌으면 null 로 노출하고
        # **0원으로 위장하지 않는다**(승인 금액 산정은 go 가 이 값으로 하므로 치명적).
        "product_name": tier.name if tier is not None else None,
        "product_price": float(tier.base_price or 0) if tier is not None else None,
        "order_ref": b.order_ref,
        "order_number": b.order_number,
        "organization_name": b.organization_name,
        "contact_name": b.contact_name,
        "contact_email": b.contact_email,
        "contact_phone": b.contact_phone,
        "attendee_count": b.attendee_count,
        "discount_rate": float(b.discount_rate or 0),
        "notes": b.notes,
        "rejection_reason": b.rejection_reason,
        "approved_by_ref": b.approved_by_ref,
        "approved_at": b.approved_at.isoformat() if b.approved_at else None,
        "status": b.status,
        "created_at": b.created_at.isoformat() if b.created_at else None,
    }


class GroupBookingCreate(BaseModel):
    product_ref: str = Field(..., min_length=1, max_length=100)
    organization_name: str = Field(..., min_length=2, max_length=200)
    contact_name: str = Field(..., min_length=2, max_length=100)
    contact_email: EmailStr
    contact_phone: str | None = Field(default=None, max_length=40)
    attendee_count: int = Field(..., ge=2)
    notes: str | None = None


class GroupBookingPatch(BaseModel):
    """승인/거절 전이. `status` 는 필수 — 이 API 는 상태 전이 전용이다."""

    status: str
    discount_rate: float | None = Field(default=None, ge=0, le=100)
    rejection_reason: str | None = None
    order_ref: str | None = Field(default=None, max_length=100)
    order_number: str | None = Field(default=None, max_length=64)
    approved_by_ref: str | None = Field(default=None, max_length=100)


async def _tier_by_ref(db: AsyncSession, event_id: uuid.UUID, ref: str) -> SeatTier | None:
    return await _resolve_tier_ref(db, event_id, ref)


async def _do_create_group_booking(
    db: AsyncSession, event_id: uuid.UUID, body: GroupBookingCreate
) -> dict:
    await _require_event(db, event_id)
    # 존재하지 않는 상품으로 신청을 받으면 승인 시점에 금액을 산정할 수 없다 → 입구에서 막는다.
    tier = await _tier_by_ref(db, event_id, body.product_ref)
    if tier is None:
        raise ApiError("TIER_NOT_FOUND", f"product not found: {body.product_ref}", 404, "product_ref")
    booking = GroupBooking(
        event_id=event_id,
        product_ref=body.product_ref,
        organization_name=body.organization_name,
        contact_name=body.contact_name,
        contact_email=str(body.contact_email),
        contact_phone=body.contact_phone,
        attendee_count=body.attendee_count,
        discount_rate=0,
        notes=body.notes,
        status="pending",
    )
    db.add(booking)
    await _commit_or_conflict(db, "group booking")
    await db.refresh(booking)
    return _group_booking_row(booking, tier)


async def _do_patch_group_booking(
    db: AsyncSession, event_id: uuid.UUID, booking_id: uuid.UUID, body: GroupBookingPatch
) -> dict:
    """상태 전이를 **원자적으로** 집행한다.

    ## 왜 v2 로 옮겼나 (go 감사 P0-9 의 잔여 레이스)
    go 는 `SELECT status` → 분기 → `UPDATE` 였다. 동시에 두 번 승인하면 둘 다 pending 을
    읽고 둘 다 통과한다. 여기서는 `FOR UPDATE` 로 행을 잠그고 판정하므로 하나만 통과한다.
    (주문 자체는 go createOrder 의 결정적 멱등키 `group-booking:{event}:{booking}` 로
     이미 중복이 봉쇄돼 있다 — 이 잠금은 **승인 기록·주문 연결**의 중복을 막는다.)

    허용 전이: pending→confirmed · pending→cancelled · confirmed→cancelled. 그 외 409.
    """
    await _require_event(db, event_id)
    target = body.status.lower()
    if target not in ("confirmed", "cancelled"):
        raise ApiError("VALIDATION_ERROR", f"invalid status: {body.status}", 400, "status")

    booking = (
        await db.execute(
            select(GroupBooking)
            .where(GroupBooking.id == booking_id, GroupBooking.event_id == event_id)
            .with_for_update()
        )
    ).scalar_one_or_none()
    if booking is None:
        raise ApiError("GROUP_BOOKING_NOT_FOUND", f"group booking not found: {booking_id}", 404)

    current = booking.status
    if target == "confirmed" and current != "pending":
        raise _Conflict(f"group booking not approvable from status={current}")
    if target == "cancelled" and current == "cancelled":
        raise _Conflict("group booking already cancelled")

    if target == "confirmed":
        booking.status = "confirmed"
        booking.discount_rate = body.discount_rate or 0
        booking.order_ref = body.order_ref
        booking.order_number = body.order_number
        booking.approved_by_ref = body.approved_by_ref
        booking.approved_at = datetime.now(timezone.utc)
    else:
        booking.status = "cancelled"
        booking.rejection_reason = body.rejection_reason or "관리자 거절"

    await db.commit()
    await db.refresh(booking)
    tier = await _tier_by_ref(db, event_id, booking.product_ref)
    return _group_booking_row(booking, tier)


@router.get("/events/{event_id}/group-bookings", summary="go live read: 단체예약 목록")
async def list_group_bookings(
    event_id: uuid.UUID,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    bookings = (
        await db.execute(
            select(GroupBooking)
            .where(GroupBooking.event_id == event_id)
            .order_by(GroupBooking.created_at.desc())
        )
    ).scalars().all()
    tiers = (
        await db.execute(select(SeatTier).where(SeatTier.event_id == event_id))
    ).scalars().all()
    by_ref: dict[str, SeatTier] = {}
    for t in tiers:
        if t.external_ref:
            by_ref[t.external_ref] = t
        by_ref[str(t.id)] = t
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    return _ok(
        {
            "bookings": [_group_booking_row(b, by_ref.get(b.product_ref)) for b in bookings],
            "total": len(bookings),
        }
    )


@router.get(
    "/events/{event_id}/group-bookings/{booking_id}", summary="go live read: 단체예약 단건"
)
async def get_group_booking(
    event_id: uuid.UUID,
    booking_id: uuid.UUID,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    try:
        await _require_event(db, event_id)
        booking = (
            await db.execute(
                select(GroupBooking).where(
                    GroupBooking.id == booking_id, GroupBooking.event_id == event_id
                )
            )
        ).scalar_one_or_none()
        if booking is None:
            raise ApiError("GROUP_BOOKING_NOT_FOUND", f"group booking not found: {booking_id}", 404)
        tier = await _tier_by_ref(db, event_id, booking.product_ref)
        response.headers["Cache-Control"] = _READ_CACHE_CONTROL
        return _ok(_group_booking_row(booking, tier))
    except ApiError as e:
        return _err(e)


@router.post("/events/{event_id}/group-bookings", summary="go write-through: 단체예약 신청(공개)")
async def create_group_booking(
    event_id: uuid.UUID,
    request: Request,
    body: GroupBookingCreate,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(
            idempotency_key,
            f"groupbooking.create.{event_id}",
            lambda: _do_create_group_booking(db, event_id, body),
            fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


@router.patch(
    "/events/{event_id}/group-bookings/{booking_id}", summary="go write-through: 단체예약 승인/거절"
)
async def patch_group_booking(
    event_id: uuid.UUID,
    booking_id: uuid.UUID,
    request: Request,
    body: GroupBookingPatch,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(
            idempotency_key,
            f"groupbooking.patch.{event_id}.{booking_id}",
            lambda: _do_patch_group_booking(db, event_id, booking_id, body),
            fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


# ── 환불 정책 ─────────────────────────────────────────────────────────────


def _refund_policy_row(p: EventRefundPolicy) -> dict:
    return {
        "policy_id": str(p.id),
        "event_id": str(p.event_id),
        "title": p.title,
        "description": p.description,
        "refund_type": p.refund_type,
        "rules": p.rules or [],
        "created_at": p.created_at.isoformat() if p.created_at else None,
        "updated_at": p.updated_at.isoformat() if p.updated_at else None,
    }


class RefundRuleIn(BaseModel):
    daysBefore: int = Field(..., ge=0)
    percent: int = Field(..., ge=0, le=100)
    label: str = Field(..., min_length=1, max_length=100)


class RefundPolicyRequest(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: str | None = None
    refund_type: str = "partial"
    rules: list[RefundRuleIn] = Field(..., min_length=1, max_length=50)


async def _do_put_refund_policy(
    db: AsyncSession, event_id: uuid.UUID, body: RefundPolicyRequest
) -> dict:
    """이벤트 환불 정책 upsert — **go 에 없던 write 경로**.

    go `refund_policies` 는 SELECT 만 있고 writer 가 0 이었다(손으로 INSERT 하지 않는 한
    커스텀 정책은 존재할 수 없었다). 여기서 처음으로 저장 경로가 생긴다.

    `daysBefore` 중복은 거부한다 — 같은 경계에 두 규칙이 있으면 어느 %가 적용될지
    정렬 안정성에 의존하게 되고, 그건 곧 환불액이 우연에 좌우된다는 뜻이다.
    """
    await _require_event(db, event_id)
    if body.refund_type not in ("full", "partial"):
        raise ApiError("VALIDATION_ERROR", f"invalid refund_type: {body.refund_type}", 400, "refund_type")
    days = [r.daysBefore for r in body.rules]
    if len(days) != len(set(days)):
        raise ApiError("VALIDATION_ERROR", "duplicate daysBefore in rules", 400, "rules")

    policy = (
        await db.execute(select(EventRefundPolicy).where(EventRefundPolicy.event_id == event_id))
    ).scalar_one_or_none()
    if policy is None:
        policy = EventRefundPolicy(event_id=event_id)
        db.add(policy)
    policy.title = body.title
    policy.description = body.description
    policy.refund_type = body.refund_type
    policy.rules = [r.model_dump() for r in body.rules]
    await _commit_or_conflict(db, "event refund policy")
    await db.refresh(policy)
    return _refund_policy_row(policy)


@router.get("/events/{event_id}/refund-policy", summary="go live read: 이벤트 커스텀 환불 정책")
async def get_refund_policy(
    event_id: uuid.UUID,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    if await db.get(Event, event_id) is None:
        return _err(ApiError("EVENT_NOT_FOUND", f"event not found: {event_id}", 404))
    policy = (
        await db.execute(select(EventRefundPolicy).where(EventRefundPolicy.event_id == event_id))
    ).scalar_one_or_none()
    response.headers["Cache-Control"] = _READ_CACHE_CONTROL
    # policy=null 은 "커스텀 정책 없음"(기본규칙 적용). 조회 실패와 구분되도록 200 으로만 쓴다 —
    # 실패는 예외로 나가고 go 가 503 으로 끊는다.
    return _ok({"policy": _refund_policy_row(policy) if policy is not None else None})


@router.put("/events/{event_id}/refund-policy", summary="go write-through: 환불 정책 저장")
async def put_refund_policy(
    event_id: uuid.UUID,
    request: Request,
    body: RefundPolicyRequest,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(
            idempotency_key,
            f"refundpolicy.put.{event_id}",
            lambda: _do_put_refund_policy(db, event_id, body),
            fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


@router.delete("/events/{event_id}/refund-policy", summary="go write-through: 환불 정책 제거(기본규칙 복귀)")
async def delete_refund_policy(
    event_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    try:
        await _require_event(db, event_id)
        policy = (
            await db.execute(select(EventRefundPolicy).where(EventRefundPolicy.event_id == event_id))
        ).scalar_one_or_none()
        if policy is None:
            # "이미 없음"을 200 으로 흡수하지 않는다(호출측이 멱등 판단).
            raise ApiError("REFUND_POLICY_NOT_FOUND", "no custom refund policy", 404)
        await db.delete(policy)
        await db.commit()
        return _ok({"event_id": str(event_id), "deleted": True})
    except ApiError as e:
        return _err(e)


# ── 동적 가격 규칙 · 가격 이력 ────────────────────────────────────────────


def _pricing_rule_row(r: TierPricingRule) -> dict:
    return {
        "rule_id": str(r.id),
        "rule_type": r.rule_type,
        "config": r.config or {},
        "priority": r.priority,
        "is_active": bool(r.is_active),
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


class PricingRuleCreate(BaseModel):
    rule_type: str
    config: dict = Field(default_factory=dict)
    priority: int = 0
    is_active: bool = True


async def _require_tier(db: AsyncSession, event_id: uuid.UUID, tier_ref: str) -> SeatTier:
    await _require_event(db, event_id)
    tier = await _resolve_tier_ref(db, event_id, tier_ref)
    if tier is None:
        raise ApiError("TIER_NOT_FOUND", f"tier not found: {tier_ref}", 404)
    return tier


async def _do_create_pricing_rule(
    db: AsyncSession, event_id: uuid.UUID, tier_ref: str, body: PricingRuleCreate
) -> dict:
    tier = await _require_tier(db, event_id, tier_ref)
    if body.rule_type not in PRICING_RULE_TYPES:
        raise ApiError("VALIDATION_ERROR", f"invalid rule_type: {body.rule_type}", 400, "rule_type")
    rule = TierPricingRule(
        tier_id=tier.id,
        rule_type=body.rule_type,
        config=body.config,
        priority=body.priority,
        is_active=body.is_active,
    )
    db.add(rule)
    await _commit_or_conflict(db, "tier pricing rule")
    await db.refresh(rule)
    return _pricing_rule_row(rule)


@router.get(
    "/events/{event_id}/tiers/{tier_ref}/pricing-rules", summary="go live read: 동적 가격 규칙 목록"
)
async def list_pricing_rules(
    event_id: uuid.UUID,
    tier_ref: str,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    try:
        tier = await _require_tier(db, event_id, tier_ref)
        rules = (
            await db.execute(
                select(TierPricingRule)
                .where(TierPricingRule.tier_id == tier.id)
                .order_by(TierPricingRule.priority.desc())
            )
        ).scalars().all()
        response.headers["Cache-Control"] = _READ_CACHE_CONTROL
        return _ok({"rules": [_pricing_rule_row(r) for r in rules], "total": len(rules)})
    except ApiError as e:
        return _err(e)


@router.post(
    "/events/{event_id}/tiers/{tier_ref}/pricing-rules", summary="go write-through: 동적 가격 규칙 생성"
)
async def create_pricing_rule(
    event_id: uuid.UUID,
    tier_ref: str,
    request: Request,
    body: PricingRuleCreate,
    db: AsyncSession = Depends(get_db),
    idempotency_key: str | None = Header(None, alias="Idempotency-Key"),
):
    try:
        return await _idempotent(
            idempotency_key,
            f"pricingrule.create.{event_id}.{tier_ref}",
            lambda: _do_create_pricing_rule(db, event_id, tier_ref, body),
            fingerprint=_fingerprint(body),
        )
    except ApiError as e:
        return _err(e)


@router.delete(
    "/events/{event_id}/tiers/{tier_ref}/pricing-rules/{rule_id}",
    summary="go write-through: 동적 가격 규칙 삭제",
)
async def delete_pricing_rule(
    event_id: uuid.UUID,
    tier_ref: str,
    rule_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    try:
        tier = await _require_tier(db, event_id, tier_ref)
        rule = (
            await db.execute(
                select(TierPricingRule).where(
                    TierPricingRule.id == rule_id, TierPricingRule.tier_id == tier.id
                )
            )
        ).scalar_one_or_none()
        if rule is None:
            raise ApiError("PRICING_RULE_NOT_FOUND", f"pricing rule not found: {rule_id}", 404)
        await db.delete(rule)
        await db.commit()
        return _ok({"rule_id": str(rule_id), "deleted": True})
    except ApiError as e:
        return _err(e)


@router.get(
    "/events/{event_id}/tiers/{tier_ref}/price-history", summary="go live read: 가격 변경 이력"
)
async def list_price_history(
    event_id: uuid.UUID,
    tier_ref: str,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
    limit: int = 50,
):
    try:
        tier = await _require_tier(db, event_id, tier_ref)
        limit = max(1, min(int(limit), 200))
        rows = (
            await db.execute(
                select(TierPriceHistory, TierPricingRule.rule_type)
                .join(TierPricingRule, TierPriceHistory.rule_id == TierPricingRule.id, isouter=True)
                .where(TierPriceHistory.tier_id == tier.id)
                .order_by(TierPriceHistory.applied_at.desc())
                .limit(limit)
            )
        ).all()
        response.headers["Cache-Control"] = _READ_CACHE_CONTROL
        return _ok(
            {
                "history": [
                    {
                        "history_id": str(h.id),
                        "old_price": float(h.old_price or 0),
                        "new_price": float(h.new_price or 0),
                        "reason": h.reason,
                        "rule_type": rule_type,
                        "applied_at": h.applied_at.isoformat() if h.applied_at else None,
                    }
                    for h, rule_type in rows
                ],
                "total": len(rows),
            }
        )
    except ApiError as e:
        return _err(e)
