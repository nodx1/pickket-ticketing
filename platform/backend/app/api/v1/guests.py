"""게스트(비회원) 셀프서비스 API — 상세페이지 통합 S2b.

설계 정본: docs/plans/DETAIL-UNIFICATION-DB-DESIGN.md
  §2.2(opt-in 게이트)·§2.3(토큰 조회/환불)·§2.4(클레임 FK rebind)·§2.5(결제)·§6.3.

게스트는 세션이 없으므로 모든 접근을 `guest_access_service`(SHA-256 토큰, IDOR 계층방어)로
소유증명한다. 이 라우터는 consumer 가 직접 호출하는 **공개 엔드포인트**(인증 미들웨어 없음)로,
권한은 오직 토큰으로 판정한다.

엔드포인트:
  - POST /guests/orders                          게스트 주문 생성(공개 진입점 — S2c, opt-in 게이트+봇방지, view 토큰 발급)
  - POST /guests/orders/{order_id}/payment/prepare 게스트 유료 PG prepare(view 토큰 + PaymentService.initiate_payment 재사용)
  - POST /guests/orders/{order_id}/confirm       게스트 결제 confirm(view 토큰 + PaymentService 재사용)
  - GET  /guests/orders/{order_id}               게스트 주문 조회(view 토큰, ⚠️W2 PII 마스킹)
  - POST /guests/orders/{order_id}/tokens/refund refund 매직링크 발급(view 토큰 → refund 토큰 1회)
  - POST /guests/orders/{order_id}/tokens/claim  claim 매직링크 발급(view 토큰 → claim 토큰 1회)
  - POST /guests/orders/{order_id}/refund        게스트 환불(refund 토큰, ⚠️W1 트랜잭션 경계)
  - POST /guests/orders/{order_id}/claim         게스트 회원승격(⚠️회원 세션 + claim 토큰, §6.3 checked-in 방어)

⚠️ 매직링크(refund/claim) 발급은 S2b 범위에서 **view 토큰 소유증명**(=주문직후 조회권 보유자)으로
   허용한다. 이메일 소유증명 기반 재방문 매직링크(발송 배선)는 S3 consumer UI 에서 완성한다.
   raw 토큰은 응답에 1회만 실려나가고(발송=S3), 서버는 SHA-256 만 저장한다.

⚠️ C-1/C-2 보안: claim **실행**(회원승격)은 이 라우터에서 유일하게 **회원 세션(get_current_user)이
   필수**인 엔드포인트다. 승격 대상은 요청 body 가 아니라 세션(current_user.id)으로 서버가 강제한다
   — 무검증 body user_id 신뢰로 인한 임의 타인 계정 귀속/탈취(C-1)를 원천 차단한다. claim 토큰
   (single-use)은 그 주문의 소유증명으로 여전히 검증·소비하되, 회원 세션이 실질 gate 이므로
   view/claim 토큰 유출만으로는 탈취 불가(C-2 완화). 발급 엔드포인트(tokens/claim)는 view 소유증명
   유지 — 매직링크 발송용 raw 토큰만 반환하며 실행 권한을 부여하지 않는다.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.deps import verify_behavior_token
from app.api.v1.internal_commerce import (
    ApiError,
    BuyerBlock,
    OrderCreateRequest,
    OrderDiscountIn,
    OrderItemIn,
    _do_create_order,
    _err,
)
from app.core.audit import write_audit_log
from app.core.database import get_db
from app.core.errors import api_error, client_error_detail, ErrorCode
from app.middleware.auth import get_current_user
from app.middleware.rate_limit import rate_limit_payment, rate_limit_general
from app.models.guest import Guest
from app.models.order import Order, OrderStatus
from app.models.ownership_transfer import OwnershipTransfer, TransferType
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.services import guest_access_service as gsvc
from app.services.email_service import send_guest_magic_link
from app.services.guest_access_service import GuestTokenInvalid
from app.services.payment_service import PaymentService
from app.services.refund_service import RefundError, RefundService

logger = logging.getLogger(__name__)
router = APIRouter()


# ════════════════════════════════════════════════════════════════════════
# 공통 헬퍼
# ════════════════════════════════════════════════════════════════════════

def _client_ip(request: Request) -> str | None:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        return fwd.split(",")[0].strip()
    return request.client.host if request.client else None


async def _load_guest_order(db: AsyncSession, order_id: uuid.UUID) -> Order:
    """게스트 주문 로드 — 회원 주문(user_id 있음)이면 이 경로 대상 아님(404 위장)."""
    order = (
        await db.execute(select(Order).where(Order.id == order_id))
    ).scalar_one_or_none()
    if order is None or order.guest_id is None:
        # enumeration 방지: 게스트 주문 아님/없음 동일 404.
        raise api_error(ErrorCode.ORDER_NOT_FOUND)
    return order


def _mask_name(name: str | None) -> str | None:
    """이름 부분마스킹(W2). 홍길동 → 홍*동, 김철 → 김*. None/빈값은 그대로."""
    if not name:
        return name
    if len(name) <= 1:
        return name
    if len(name) == 2:
        return name[0] + "*"
    return name[0] + "*" * (len(name) - 2) + name[-1]


def _mask_email(email: str | None) -> str | None:
    """이메일 부분마스킹(W2). abcde@x.com → ab***@x.com. 로컬 2자 이하는 첫 글자만."""
    if not email or "@" not in email:
        return email
    local, _, domain = email.partition("@")
    if len(local) <= 2:
        masked_local = local[0] + "*" if local else "*"
    else:
        masked_local = local[:2] + "*" * (len(local) - 2)
    return f"{masked_local}@{domain}"


def _mask_phone(phone: str | None) -> str | None:
    """전화 부분마스킹(W2). 010-1234-5678 → 010-****-5678(끝 4자리만)."""
    if not phone:
        return phone
    digits = [c for c in phone if c.isdigit()]
    if len(digits) <= 4:
        return "*" * len(digits)
    return f"{''.join(digits[:3])}-****-{''.join(digits[-4:])}"


async def _resolve_guest_email(db: AsyncSession, order: Order) -> str | None:
    """발송 대상 게스트 이메일(스냅샷). guests.email 우선, 없으면 order.buyer_email 폴백."""
    if order.guest_id is not None:
        guest = await db.get(Guest, order.guest_id)
        if guest is not None and guest.email:
            return guest.email
    return order.buyer_email


async def _resolve_event_title(db: AsyncSession, order: Order) -> str | None:
    """발송 문구용 이벤트 제목(민감정보 아님)."""
    from app.models.event import Event

    event = await db.get(Event, order.event_id)
    return event.title if event is not None else None


async def _send_guest_email_best_effort(
    db: AsyncSession,
    order: Order,
    *,
    purpose: str,
    raw_token: str,
    order_summary: str | None = None,
) -> None:
    """게스트 매직링크 발송(커밋 후 호출·격리). 실패해도 예외 전파하지 않는다.

    이메일/이벤트 조회 실패, 발송 실패 어느 것도 호출자(주문/토큰 트랜잭션)를 깨지 않는다.
    """
    try:
        to = await _resolve_guest_email(db, order)
        if not to:
            logger.info("게스트 이메일 없음 — 매직링크 발송 스킵: order=%s", order.id)
            return
        event_title = await _resolve_event_title(db, order)
        await send_guest_magic_link(
            to=to,
            purpose=purpose,
            order_id=str(order.id),
            raw_token=raw_token,
            event_title=event_title,
            order_summary=order_summary,
        )
    except Exception:
        # 격리: 조회/발송 어떤 실패도 삼킨다(로깅만). 발송은 이미 커밋 후이므로 트랜잭션 무영향.
        logger.warning(
            "게스트 매직링크 발송 헬퍼 실패(격리): order=%s purpose=%s",
            order.id, purpose, exc_info=True,
        )


# ════════════════════════════════════════════════════════════════════════
# 요청 스키마
# ════════════════════════════════════════════════════════════════════════

class GuestPrepareRequest(BaseModel):
    """게스트 유료결제 prepare — view 토큰(order-scoped) + 회원과 동일한 PG 준비 파라미터.

    idempotency_key/success_url/fail_url 는 회원 PaymentPrepareRequest 와 동형이며,
    redirect URL 도메인 검증도 회원 스키마와 동일하게 재사용(pickket.kr·딥링크만 허용).
    """
    view_token: str = Field(..., min_length=8, max_length=200)
    idempotency_key: str | None = Field(default=None, max_length=120)
    success_url: str | None = Field(None, max_length=500)
    fail_url: str | None = Field(None, max_length=500)
    # 나이스 구형 결제창 사용자 선택 결제수단(회원 PaymentPrepareRequest 동형, 서버 정규화).
    pay_method: str | None = Field(default=None, max_length=32)

    @field_validator("success_url", "fail_url", mode="before")
    @classmethod
    def _validate_redirect_url(cls, v: str | None) -> str | None:
        # 회원 PaymentPrepareRequest 와 동일한 검증기를 위임(중복 로직 방지).
        from app.schemas.order import PaymentPrepareRequest

        return PaymentPrepareRequest.validate_redirect_url(v)


class GuestConfirmRequest(BaseModel):
    """게스트 결제 confirm — view 토큰(order-scoped) + PG 승인 파라미터."""
    view_token: str = Field(..., min_length=8, max_length=200)
    pg_provider: str = "toss"
    pg_transaction_id: str = "stub_txn"
    payment_id: str | None = None
    amount: float | None = None


class GuestViewRequest(BaseModel):
    view_token: str = Field(..., min_length=8, max_length=200)


class GuestIssueTokenRequest(BaseModel):
    """view 토큰 소유증명으로 refund/claim 매직링크 토큰 발급."""
    view_token: str = Field(..., min_length=8, max_length=200)


class GuestRefundRequest(BaseModel):
    refund_token: str = Field(..., min_length=8, max_length=200)
    reason: str = Field("게스트 환불 요청", max_length=300)


class GuestOrderBuyer(BaseModel):
    """게스트 주문 구매자 블록(공개 진입점).

    email 은 필수(주문 소유증명·영수증·매직링크의 기준). name 권장, phone 선택.
    email/phone 의 엄격한 형식검증은 주문코어(_validate_guest_email/_validate_guest_phone,
    §W1)에서 게스트 경로 진입 시 강제된다 — 여기서 중복구현하지 않는다(invalid → 400).
    """

    email: str = Field(..., min_length=3, max_length=320)
    name: str | None = Field(None, max_length=200)
    phone: str | None = Field(None, max_length=40)
    marketing_opt_in: bool = False


class GuestOrderItem(BaseModel):
    """게스트 주문 라인. 좌석지정이면 seat_ids(==quantity)+hold_id, 자유석이면 tier_id+quantity."""

    tier_id: uuid.UUID
    quantity: int = Field(..., gt=0, le=100)
    unit_price: float = Field(..., ge=0)
    seat_ids: list[uuid.UUID] = Field(default_factory=list)
    hold_id: uuid.UUID | None = None


class GuestOrderCreateRequest(BaseModel):
    """게스트(비회원) 주문 생성 요청(공개 진입점 — S2c).

    consumer(S3) BookingFlow 가 로그인 없이 호출한다. 봇방지(behavior_token·IP rate_limit)는
    회원 경로와 동일하게 적용하고, 권한/식별은 오직 guest_buyer.email + 발급된 view 토큰으로 판정.
    """

    event_id: uuid.UUID
    items: list[GuestOrderItem] = Field(..., min_length=1, max_length=100)
    guest_buyer: GuestOrderBuyer
    total_amount: float = Field(..., ge=0)
    discount_code: str | None = Field(None, max_length=100)
    # 멱등키(필수) — 동일 키 재요청은 동일 주문을 재생(external_ref dedup). consumer 가 UUID 생성.
    idempotency_key: str = Field(..., min_length=8, max_length=100)


class GuestClaimRequest(BaseModel):
    """게스트 회원승격 요청.

    ⚠️ C-1 보안: 승격 대상 회원 id 는 요청 body 로 받지 않는다(임의 타인 계정 귀속 차단).
    claimed_user_id 는 회원 세션(get_current_user)의 current_user.id 로 **서버가 강제**한다.
    구버전 클라이언트 호환을 위해 optional `user_id` 필드는 수용하되 **세션 sub 와 일치하지
    않으면 거부**(403)한다. 일치하거나 미전달이면 세션 id 를 사용.
    """
    claim_token: str = Field(..., min_length=8, max_length=200)
    user_id: uuid.UUID | None = None  # 레거시 호환 전용 — 세션 id 와 불일치 시 거부. 신뢰 대상 아님.


# ════════════════════════════════════════════════════════════════════════
# 0) 게스트 주문 생성 (공개 진입점 — S2c)
#
#   회원 주문생성(purchase.py)은 get_current_user 로 회원을 강제하므로 게스트가 쓸 수 없다.
#   consumer(S3)가 로그인 없이 호출할 공개 진입점을 여기에 둔다. 인증 없음(공개)이나 봇방지는
#   회원 경로와 동일(verify_behavior_token + IP rate_limit_payment).
#
#   재사용(중복구현 금지):
#     - opt-in 게이트(_assert_guest_checkout_allowed·_assert_guest_sale_mode_allowed),
#       guest upsert(_resolve_buyer_user 게스트 경로), 좌석 hold·재고·tier·가격 검증,
#       0원 자동confirm(payment_method='free'·티켓 ACTIVE) — 전부 _do_create_order 코어가 수행.
#     - buyer.email/phone 형식검증도 게스트 경로 진입 시 코어(_validate_guest_email/phone)가 강제.
#   신규:
#     - 공개 요청 스키마(GuestOrderCreateRequest) → 내부 OrderCreateRequest 매핑(user_id 없음=게스트).
#     - idempotency_key → external_order_id(주문 dedup 재생).
#     - marketing_opt_in 반영(guests 행).
#     - view 토큰 발급(주문직후 조회권, raw 1회 반환) — confirm/조회의 소유증명 진입점.
#
#   트랜잭션 경계: _do_create_order 가 주문/티켓/좌석을 **한 커밋**으로 확정(0원이면 confirm 까지).
#   view 토큰 발급은 그 커밋 이후 별도 flush+commit(DB write, 외부호출 아님). 토큰 발급 실패 시
#   주문은 이미 커밋됨 → 동일 idempotency_key 재요청이 external_ref dedup 으로 주문을 재생하고
#   view 토큰을 재발급(재시도 안전, view 토큰은 non-consuming 다중발급 허용).
# ════════════════════════════════════════════════════════════════════════

@router.post("/orders", summary="게스트 주문 생성(공개 — opt-in 게이트 + 봇방지 + view 토큰 발급)")
async def guest_create_order(
    body: GuestOrderCreateRequest,
    request: Request,
    _bot: None = Depends(verify_behavior_token),
    _rl: None = Depends(rate_limit_payment),
    db: AsyncSession = Depends(get_db),
):
    """게스트(비회원) 주문 생성.

    인증 없음(공개). 권한/식별은 guest_buyer.email + 발급 view 토큰으로만 판정.
    opt-in 미허용/회원전용 sale_mode → 403. invalid email → 400.
    응답: order_id·status·total_amount·created·view_token(1회)·(0원이면 confirmed).
    """
    # 공개 요청 → 내부 OrderCreateRequest 매핑. user_id 미설정(=게스트 경로) → _resolve_buyer_user
    # 가 guests upsert. external_order_id=idempotency_key → 동일 키 재요청 주문 재생(dedup).
    discount = (
        OrderDiscountIn(code=body.discount_code) if body.discount_code else None
    )
    internal_body = OrderCreateRequest(
        external_order_id=body.idempotency_key,
        user_id=None,
        buyer=BuyerBlock(
            name=body.guest_buyer.name,
            email=body.guest_buyer.email,
            phone=body.guest_buyer.phone,
        ),
        event_id=body.event_id,
        source="guest_public",
        items=[
            OrderItemIn(
                tier_id=it.tier_id,
                quantity=it.quantity,
                unit_price=it.unit_price,
                seat_ids=it.seat_ids,
                hold_id=it.hold_id,
            )
            for it in body.items
        ],
        discount=discount,
        total_amount=body.total_amount,
    )

    # ① 주문 생성(opt-in 게이트·guest upsert·좌석/재고/가격·0원 자동confirm 전부 코어 재사용).
    #    _do_create_order 가 내부에서 커밋한다(주문·티켓·좌석 한 트랜잭션).
    try:
        result = await _do_create_order(db, internal_body)
    except ApiError as e:
        # 코어의 표준 에러(GUEST_CHECKOUT_DISABLED 403 / GUEST_SALE_MODE_FORBIDDEN 403 /
        # AMOUNT_MISMATCH·VALIDATION_ERROR 400 / SOLD_OUT 409 …)를 그대로 봉투로 반환.
        await db.rollback()
        return _err(e)

    order_id = uuid.UUID(result["order_id"])

    # ② 게스트 행 로드 → marketing_opt_in 반영. 주문 커밋 후 별도 트랜잭션(재고/주문에 영향 없음).
    order = await db.get(Order, order_id)
    if order is None or order.guest_id is None:
        # 방어: 게스트 주문이어야 함(user_id 미설정). 아니면 계약 위반 500.
        logger.error("게스트 주문 생성 결과가 게스트가 아님: order=%s", order_id)
        raise api_error(ErrorCode.INTERNAL_ERROR, "주문 생성에 실패했습니다.")
    guest_id = order.guest_id
    if body.guest_buyer.marketing_opt_in:
        guest = await db.get(Guest, guest_id)
        if guest is not None:
            guest.marketing_opt_in = True

    # ③ view 토큰 발급(주문직후 조회권, raw 1회 반환). issue_token 은 flush 만 → 여기서 커밋.
    issued = await gsvc.issue_token(
        db,
        guest_id=guest_id,
        purpose="view",
        order_id=order_id,
        ip=_client_ip(request),
    )
    await write_audit_log(
        db,
        actor_type="guest",
        guest_id=guest_id,
        action="guest_order_created",
        resource_type="order",
        resource_id=str(order_id),
        event_id=order.event_id,
        new_value={
            "created": result.get("created"),
            "status": result.get("status"),
            "view_token_id": str(issued.token_id),
        },
    )
    await db.commit()

    # ④ 주문접수 확인 + view 매직링크 이메일(커밋 후·격리). 게스트 재방문 경로 개통.
    #    신규주문(created=True)일 때만 발송(멱등 재요청 시 중복발송 방지).
    if result.get("created", True):
        await _send_guest_email_best_effort(
            db, order, purpose="order_confirmed", raw_token=issued.raw_token,
            order_summary=f"총 결제금액 {float(order.total_amount or 0):,.0f}원",
        )

    return {
        "order_id": result["order_id"],
        "status": result["status"],
        "total_amount": float(order.total_amount or 0),
        "ticket_ids": result.get("ticket_ids", []),
        "created": result.get("created", True),
        # view 토큰은 응답에 1회만 실려나간다. 서버는 SHA-256 만 저장. 재방문 매직링크는 이메일 발송(F2).
        "view_token": issued.raw_token,
        "view_token_expires_at": issued.expires_at.isoformat(),
    }


# ════════════════════════════════════════════════════════════════════════
# 1a) 게스트 유료결제 prepare (view 토큰 + PaymentService.initiate_payment 재사용)
# ════════════════════════════════════════════════════════════════════════

@router.post(
    "/orders/{order_id}/payment/prepare",
    summary="게스트 유료 PG prepare(토큰 소유증명 + PG 결제창 준비)",
)
async def guest_prepare_payment(
    order_id: uuid.UUID,
    body: GuestPrepareRequest,
    request: Request,
    _rl: None = Depends(rate_limit_payment),
    db: AsyncSession = Depends(get_db),
):
    """게스트 유료 주문 PG 결제창 준비(redirect_url·payment_id·deadline 반환).

    게스트 e2e: 생성 → **prepare(여기)** → PG 결제창 → confirm.

    소유증명: order-scoped view 토큰(주문직후 응답 1회). 소비하지 않음(재prepare 멱등 허용
    — initiate_payment 가 동일 idempotency_key 시 기존 payment 세션을 재반환).

    준비 로직: 회원 prepare 와 **동일한** PaymentService.initiate_payment(order 기반, PG
    prepare·payment_id·deadline·PAYMENT_REQUIRED 전이·audit 를 그대로 재사용). 회원 경로와의
    유일 차이는 인증 게이트(get_current_user → view 토큰)뿐이며, 게스트/회원 분기는 order 의
    guest_id/user_id 로 결정된다(initiate_payment 는 order.user_id=None 을 안전 처리).
    """
    order = await _load_guest_order(db, order_id)

    # 토큰 소유증명(order-scoped). 실패 → 403(enumeration-safe 일반화 메시지).
    try:
        await gsvc.verify_only(
            db, raw_token=body.view_token, purpose="view", expected_order_id=order_id
        )
    except GuestTokenInvalid:
        raise api_error(ErrorCode.FORBIDDEN, "접근 토큰이 유효하지 않습니다.")

    service = PaymentService(db)
    try:
        prepared = await service.initiate_payment(
            order_id=order_id,
            idempotency_key=body.idempotency_key,
            success_url=body.success_url,
            fail_url=body.fail_url,
            pay_method=body.pay_method,
        )
        await write_audit_log(
            db,
            actor_id=None,  # 게스트는 세션 user 없음 — guest_id 로 추적(order 스코프).
            action="payment.prepare.guest",
            resource_type="order",
            resource_id=str(order_id),
            ip_address=_client_ip(request),
            user_agent=request.headers.get("user-agent", "")[:500],
        )
        await db.commit()
        return prepared
    except ValueError as e:
        await db.rollback()
        logger.warning("게스트 결제 준비 실패: order=%s", order_id, exc_info=True)
        raise api_error(
            ErrorCode.PAYMENT_FAILED,
            client_error_detail(e, "결제 준비에 실패했습니다."),
        )


# ════════════════════════════════════════════════════════════════════════
# 1) 게스트 결제 confirm (view 토큰 + PaymentService 재사용)
# ════════════════════════════════════════════════════════════════════════

@router.post("/orders/{order_id}/confirm", summary="게스트 결제 confirm(토큰 소유증명 + PG 재검증)")
async def guest_confirm_payment(
    order_id: uuid.UUID,
    body: GuestConfirmRequest,
    request: Request,
    _rl: None = Depends(rate_limit_payment),
    db: AsyncSession = Depends(get_db),
):
    """게스트 주문 결제 확정.

    소유증명: order-scoped view 토큰(주문직후 응답 1회). 소비하지 않음(재confirm 멱등 허용).
    확정 로직: 회원과 **동일한** PaymentService.confirm_payment(금액 v2 재검증·PG verify·
    티켓 ACTIVE·fee 동결·audit·notification). 게스트 분기는 confirm_payment 내부에서
    order.user_id/guest_id 로 자동 처리(사기탐지 스킵·guest 통지·actor_type='guest').
    """
    order = await _load_guest_order(db, order_id)

    # 토큰 소유증명(order-scoped). 실패 → 403(enumeration-safe 일반화 메시지).
    try:
        await gsvc.verify_only(
            db, raw_token=body.view_token, purpose="view", expected_order_id=order_id
        )
    except GuestTokenInvalid:
        raise api_error(ErrorCode.FORBIDDEN, "접근 토큰이 유효하지 않습니다.")

    service = PaymentService(db)
    try:
        updated = await service.confirm_payment(
            order_id=order_id,
            pg_provider=body.pg_provider,
            pg_txn_id=body.pg_transaction_id,
            payment_id=body.payment_id,
            amount=body.amount,
            source="guest",
        )
        await db.commit()
    except ValueError as e:
        await db.rollback()
        logger.warning("게스트 결제 확인 실패: order=%s", order_id, exc_info=True)
        raise api_error(
            ErrorCode.PAYMENT_FAILED,
            client_error_detail(e, "결제 확인에 실패했습니다."),
        )
    # confirm 성공 후 propagation(커밋 후 외부호출 규약).
    from app.api.v1.orders import _drain_propagations
    _drain_propagations(service.propagations)

    # 결제완료 확인 + view 매직링크 이메일(커밋 후·격리). 재방문 토큰은 요청자가 보유한
    # view 토큰(1회 응답)을 그대로 링크에 실어 재열람 경로를 확정한다(신규 토큰 미발급).
    await _send_guest_email_best_effort(
        db, order, purpose="order_confirmed", raw_token=body.view_token,
        order_summary=f"결제금액 {float(order.total_amount or 0):,.0f}원",
    )
    return updated


# ════════════════════════════════════════════════════════════════════════
# 2) 게스트 주문 조회 (view 토큰, ⚠️W2 PII 마스킹)
# ════════════════════════════════════════════════════════════════════════

@router.post("/orders/{order_id}/view", summary="게스트 주문/티켓 조회(view 토큰, PII 마스킹)")
async def guest_view_order(
    order_id: uuid.UUID,
    body: GuestViewRequest,
    request: Request,
    _rl: None = Depends(rate_limit_general),
    db: AsyncSession = Depends(get_db),
):
    """게스트 주문 상세 + 티켓 목록 조회.

    ⚠️ W2 PII 마스킹: 구매자 이름/이메일/전화는 부분마스킹으로만 노출(민감필드 최소노출).
    view 토큰은 소비하지 않음(주문직후 반복열람). 만료·스코프는 항상 검증.
    """
    order = await _load_guest_order(db, order_id)
    try:
        await gsvc.verify_only(
            db, raw_token=body.view_token, purpose="view", expected_order_id=order_id
        )
    except GuestTokenInvalid:
        raise api_error(ErrorCode.FORBIDDEN, "접근 토큰이 유효하지 않습니다.")

    tickets = (
        await db.execute(
            select(Ticket).where(Ticket.purchase_order_id == order_id).order_by(Ticket.created_at)
        )
    ).scalars().all()

    return {
        "order": {
            "order_id": str(order.id),
            "status": order.status.value if hasattr(order.status, "value") else order.status,
            "event_id": str(order.event_id),
            "quantity": order.quantity,
            "total_amount": float(order.total_amount or 0),
            "total_refunded": float(order.total_refunded or 0),
            "payment_method": order.payment_method,
            "created_at": order.created_at.isoformat() if order.created_at else None,
            # W2: 구매자 PII 는 부분마스킹만 노출.
            "buyer_name_masked": _mask_name(order.buyer_name),
            "buyer_email_masked": _mask_email(order.buyer_email),
            "buyer_phone_masked": _mask_phone(order.buyer_phone),
        },
        "tickets": [
            {
                "ticket_id": str(t.id),
                "status": t.status.value if hasattr(t.status, "value") else t.status,
                "tier_id": str(t.tier_id) if t.tier_id else None,
                "seat_id": str(t.seat_id) if t.seat_id else None,
                "admission_day": t.admission_day.isoformat() if t.admission_day else None,
                "checked_in": t.checked_in_at is not None,
            }
            for t in tickets
        ],
    }


# ════════════════════════════════════════════════════════════════════════
# 3) refund/claim 매직링크 토큰 발급 (view 토큰 소유증명 → single-use 토큰 1회)
# ════════════════════════════════════════════════════════════════════════

async def _issue_scoped_token(
    db: AsyncSession, request: Request, order: Order, purpose: str
) -> dict:
    """view 소유증명 후 refund/claim single-use 토큰 발급(응답 1회). 커밋 포함."""
    issued = await gsvc.issue_token(
        db,
        guest_id=order.guest_id,
        purpose=purpose,
        # claim 은 주문 무관(order_id=NULL 허용)이나, S2b 는 주문 스코프로 발급(disambiguation 단순화).
        order_id=order.id,
        ip=_client_ip(request),
    )
    await write_audit_log(
        db,
        actor_type="guest",
        guest_id=order.guest_id,
        action=f"guest_token_issued.{purpose}",
        resource_type="order",
        resource_id=str(order.id),
        event_id=order.event_id,
        new_value={"purpose": purpose, "token_id": str(issued.token_id)},
    )
    await db.commit()

    # 매직링크 이메일 발송(커밋 후·격리). refund/claim 링크를 게스트 이메일(스냅샷)로 발송.
    # raw_token 응답 반환도 유지(consumer 즉시 딥링크 폴백) — 발송 실패해도 발급은 성공.
    await _send_guest_email_best_effort(db, order, purpose=purpose, raw_token=issued.raw_token)

    return {
        "purpose": purpose,
        "raw_token": issued.raw_token,  # 발송(이메일)과 별개로 1회 반환(consumer 즉시 사용 폴백).
        "expires_at": issued.expires_at.isoformat(),
    }


@router.post("/orders/{order_id}/tokens/refund", summary="게스트 환불 매직링크 발급(single-use)")
async def guest_issue_refund_token(
    order_id: uuid.UUID,
    body: GuestIssueTokenRequest,
    request: Request,
    _rl: None = Depends(rate_limit_general),
    db: AsyncSession = Depends(get_db),
):
    order = await _load_guest_order(db, order_id)
    try:
        await gsvc.verify_only(
            db, raw_token=body.view_token, purpose="view", expected_order_id=order_id
        )
    except GuestTokenInvalid:
        raise api_error(ErrorCode.FORBIDDEN, "접근 토큰이 유효하지 않습니다.")
    return await _issue_scoped_token(db, request, order, "refund")


@router.post("/orders/{order_id}/tokens/claim", summary="게스트 회원승격 매직링크 발급(single-use)")
async def guest_issue_claim_token(
    order_id: uuid.UUID,
    body: GuestIssueTokenRequest,
    request: Request,
    _rl: None = Depends(rate_limit_general),
    db: AsyncSession = Depends(get_db),
):
    order = await _load_guest_order(db, order_id)
    try:
        await gsvc.verify_only(
            db, raw_token=body.view_token, purpose="view", expected_order_id=order_id
        )
    except GuestTokenInvalid:
        raise api_error(ErrorCode.FORBIDDEN, "접근 토큰이 유효하지 않습니다.")
    return await _issue_scoped_token(db, request, order, "claim")


# ════════════════════════════════════════════════════════════════════════
# 4) 게스트 환불 (refund 토큰, ⚠️W1 트랜잭션 경계)
# ════════════════════════════════════════════════════════════════════════

@router.post("/orders/{order_id}/refund", summary="게스트 환불(single-use 토큰, PG 환불)")
async def guest_refund(
    order_id: uuid.UUID,
    body: GuestRefundRequest,
    request: Request,
    _rl: None = Depends(rate_limit_payment),
    db: AsyncSession = Depends(get_db),
):
    """게스트 환불.

    ⚠️ W1(트랜잭션 경계 — fail-closed 창 방지):
      토큰 소비(UPDATE used_at)와 환불 원장/주문 상태 전이를 **하나의 커밋**으로 묶는다.
      그러나 PG 환불 외부호출은 initiate_refund 내부에서 이 커밋 이전에 수행되고, 실패 시
      **예외로 전파되어 전체 롤백**된다 → 토큰 used_at 도 롤백되어 재시도 가능(토큰만 소비되고
      PG 실패로 재시도 불가한 fail-closed 창이 없다). PG 성공 후 DB 커밋 단계 실패 시에도
      PG void 는 멱등(payment_id 기준)이라 재시도 안전.

    RefundService 내부는 이미 SELECT FOR UPDATE(order) + 정책 게이트 + PG void + 원장 기록 + audit +
    notification 을 수행하며 db.commit 은 하지 않는다(호출자 경계). 여기서 토큰 소비를
    동일 트랜잭션에 편입한 뒤 한 번에 커밋한다.
    """
    order = await _load_guest_order(db, order_id)

    # ① 토큰 원자 소비(single-use, order-scoped). flush 만 — 아직 커밋 안 함.
    try:
        await gsvc.verify_and_consume(
            db, raw_token=body.refund_token, purpose="refund", expected_order_id=order_id
        )
    except GuestTokenInvalid:
        raise api_error(ErrorCode.FORBIDDEN, "환불 링크가 유효하지 않거나 이미 사용되었습니다.")

    # ② 환불(PG void 포함) — 실패 시 예외 전파 → ③ 롤백(토큰 소비 포함)로 fail-closed 창 차단.
    service = RefundService(db)
    try:
        refund = await service.request_refund(
            order_id,
            reason=body.reason,
            initiated_by="guest",
            # refund 매직링크로 소유를 증명한 셀프서비스는 종전에도 즉시 환불 계약이었다.
            force_auto_approve=True,
        )
        await db.refresh(order)
        result = {
            "status": order.status.value,
            "refund_amount": float(refund.amount),
        }
        # 게스트 환불 감사(actor_type='guest').
        await write_audit_log(
            db,
            actor_type="guest",
            guest_id=order.guest_id,
            action="guest_refund",
            resource_type="order",
            resource_id=str(order_id),
            event_id=order.event_id,
            new_value={"amount": result.get("refund_amount"), "reason": body.reason},
        )
        # ③ 토큰 소비 + 환불 원장/상태를 한 번에 커밋(W1 원자성).
        await db.commit()
    except (ValueError, RefundError) as e:
        # 환불 불가 상태(예: 이미 환불됨/체크인됨) — 토큰 소비 롤백 후 4xx 로 반환.
        # W1: 롤백으로 토큰 used_at 도 원복 → fail-closed 창 없음(재시도 가능).
        await db.rollback()
        logger.warning("게스트 환불 거부(롤백): order=%s", order_id, exc_info=True)
        raise api_error(
            ErrorCode.PAYMENT_FAILED,
            client_error_detail(e, "환불을 처리할 수 없습니다."),
        )
    except HTTPException:
        # api_error/PG 502 등 이미 표준화된 예외 — 토큰 소비 롤백 후 그대로 전파.
        await db.rollback()
        logger.warning("게스트 환불 실패(롤백): order=%s", order_id, exc_info=True)
        raise
    except Exception:
        await db.rollback()  # 토큰 소비 롤백 → 재시도 가능(fail-closed 방지).
        logger.warning("게스트 환불 오류(롤백): order=%s", order_id, exc_info=True)
        raise
    _drain_refund_propagations(service)
    return {
        "order_id": str(order_id),
        "status": result["status"],
        "refund_amount": result["refund_amount"],
    }


def _drain_refund_propagations(service: PaymentService | RefundService) -> None:
    from app.api.v1.orders import _drain_propagations
    _drain_propagations(service.propagations)


# ════════════════════════════════════════════════════════════════════════
# 5) 게스트 claim(회원 승격) — claim 토큰, ⚠️§6.3 checked-in 방어 + 원자 rebind
# ════════════════════════════════════════════════════════════════════════

@router.post("/orders/{order_id}/claim", summary="게스트 주문 회원 승격(회원 세션 + single-use 토큰, FK rebind)")
async def guest_claim(
    order_id: uuid.UUID,
    body: GuestClaimRequest,
    request: Request,
    current_user: User = Depends(get_current_user),
    _rl: None = Depends(rate_limit_payment),
    db: AsyncSession = Depends(get_db),
):
    """게스트 주문을 **로그인한 회원 계정**으로 승격(§2.4 FK rebind).

    ⚠️ C-1 보안(임의 타인 계정 귀속 차단): claim 은 "게스트 주문을 로그인 회원 계정에 흡수"하는
    본질적 회원 인증 작업이다. 따라서 **회원 세션(get_current_user)** 이 필수 gate 이고,
    승격 대상 회원은 **current_user.id 로 서버가 강제**한다(요청 body 의 user_id 는 신뢰하지 않음).
      - 무인증 요청 → get_current_user 가 401.
      - body.user_id 가 세션 sub 와 다르면 → 403(타인 계정 귀속 시도 거부).
      - users 실존은 current_user 로 보장(claimed_user_id FK 위반 500 원천 제거).

    ⚠️ C-2 완화: claim 실행이 회원 세션을 요구하므로 view/claim 토큰만 유출돼도 타인이 승격을
    가로챌 수 없다(회원 세션이 실질 gate). claim 토큰(single-use)은 그 주문의 소유증명으로
    **여전히 검증·소비**한다 — 회원 세션 + claim 토큰 **둘 다** 필요.

    원자 트랜잭션(한 커밋):
      1. claim 토큰 소비(single-use, order-scoped).
      2. guests.claimed_user_id/claimed_at 세팅(재클레임 거부 — 이미 claimed 면 409).
      3. orders.guest_id → user_id rebind(XOR 제약이 이중 rebind 차단).
      4. tickets.guest_owner_id → current_owner_id/original_owner_id rebind.
      5. OwnershipTransfer(GUEST_CLAIM) 원장 + audit.

    ⚠️ §6.3 checked-in 방어: rebind 前 이미 checked_in 된 게스트 티켓이 있으면 거부(409).
       입장완료 티켓의 소유권 이전은 분쟁 리스크(입장자≠소유자). XOR 제약이 이중 rebind 를 차단.
    """
    # ⓪ 승격 대상 = 회원 세션(서버 강제). body.user_id 는 레거시 호환 전용 — 세션 id 와 불일치하면 거부.
    claim_user_id = current_user.id
    if body.user_id is not None and body.user_id != claim_user_id:
        raise api_error(
            ErrorCode.FORBIDDEN,
            "본인 계정으로만 주문을 승격할 수 있습니다.",
        )

    order = await _load_guest_order(db, order_id)
    guest_id = order.guest_id

    # ① 토큰 원자 소비(single-use, 그 주문의 소유증명). flush 만 — 회원 세션과 AND 조건.
    try:
        await gsvc.verify_and_consume(
            db, raw_token=body.claim_token, purpose="claim", expected_order_id=order_id
        )
    except GuestTokenInvalid:
        raise api_error(ErrorCode.FORBIDDEN, "승격 링크가 유효하지 않거나 이미 사용되었습니다.")

    try:
        # ② 게스트 잠금 + 재클레임 거부.
        guest = (
            await db.execute(select(Guest).where(Guest.id == guest_id).with_for_update())
        ).scalar_one_or_none()
        if guest is None:
            raise api_error(ErrorCode.ORDER_NOT_FOUND)
        if guest.claimed_user_id is not None:
            raise api_error(ErrorCode.CONFLICT, "이미 회원 계정으로 승격된 주문입니다.")

        # ③ §6.3 checked-in 방어 — 이 주문의 게스트 티켓 중 입장완료(checked_in_at) 카운트.
        checked_in_count = (
            await db.execute(
                select(func.count(Ticket.id)).where(
                    Ticket.purchase_order_id == order_id,
                    Ticket.checked_in_at.isnot(None),
                )
            )
        ).scalar_one()
        if checked_in_count and int(checked_in_count) > 0:
            raise api_error(
                ErrorCode.CONFLICT,
                "이미 입장 완료된 티켓이 있어 회원 승격이 불가합니다. 고객센터로 문의해 주세요.",
            )

        # ④ guests 승격 — claimed_user_id 는 회원 세션 id 로 강제(C-1).
        guest.claimed_user_id = claim_user_id
        guest.claimed_at = datetime.now(timezone.utc)

        # ⑤ orders rebind: guest_id → user_id (XOR — 둘 중 하나만). 이중 rebind 는 XOR 이 차단.
        await db.execute(
            update(Order)
            .where(Order.id == order_id, Order.guest_id == guest_id)
            .values(user_id=claim_user_id, guest_id=None)
        )

        # ⑥ tickets rebind: guest_owner_id → current_owner_id/original_owner_id.
        claimed_tickets = (
            await db.execute(
                select(Ticket).where(
                    Ticket.purchase_order_id == order_id,
                    Ticket.guest_owner_id == guest_id,
                )
            )
        ).scalars().all()
        for t in claimed_tickets:
            t.current_owner_id = claim_user_id
            if t.original_owner_id is None:
                t.original_owner_id = claim_user_id
            t.guest_owner_id = None
            # GUEST_CLAIM 원장(from_user_id NULL=게스트, to_user_id=회원). guest_id 는 metadata 대신
            # transfer_code 미사용 — 감사로그로 guest_id 추적.
            db.add(
                OwnershipTransfer(
                    ticket_id=t.id,
                    from_user_id=None,
                    to_user_id=claim_user_id,
                    transfer_type=TransferType.GUEST_CLAIM,
                    price=0,
                    seller_amount=0,
                    platform_fee=0,
                    artist_royalty=0,
                )
            )

        await write_audit_log(
            db,
            actor_id=claim_user_id,
            actor_type="user",
            guest_id=guest_id,
            action="guest_claim",
            resource_type="order",
            resource_id=str(order_id),
            event_id=order.event_id,
            new_value={
                "claimed_user_id": str(claim_user_id),
                "tickets_rebound": len(claimed_tickets),
            },
        )
        await db.commit()
    except Exception:
        # W-3: 실패 분기의 개별 rollback 을 제거하고 단일 rollback 으로 일원화(이중 rollback 방지).
        # api_error(409/404) 든 예기치 못한 예외든 여기서 한 번만 롤백하고 그대로 전파한다.
        await db.rollback()
        raise

    return {
        "order_id": str(order_id),
        "claimed_user_id": str(claim_user_id),
        "tickets_claimed": len(claimed_tickets),
    }
