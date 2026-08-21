"""Payment service with PortOne-ready flow and mock-safe fallback."""

from __future__ import annotations

import json
import logging
import math
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace

from fastapi import HTTPException
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.audit import write_audit_log
from app.core.pii import mask_payment_payload
from app.middleware.metrics import PAYMENT_TOTAL, PAYMENT_CONFIRM_DURATION
from app.models.order import Order, OrderStatus, OrderType, validate_order_transition
from app.models.ticket import Ticket, TicketStatus
from app.repositories.event_repo import SeatTierRepository
from app.repositories.order_repo import OrderRepository
from app.schemas.order import OrderResponse, PaymentPrepareResponse
from app.services.nicepay_gateway import (
    normalize_allowed_pay_methods,
    pay_method_allowed,
)
from app.services.payment_gateway import PaymentVerificationResult, get_payment_gateway
from app.services.payment_method_map import (
    normalize_fee_provider,
    resolve_payment_method,
)
from app.services.fraud_detector import analyze_payment as analyze_fraud, record_payment_success, record_payment_failure

logger = logging.getLogger(__name__)


# 🔴 **결제를 걸 수 있는 주문 상태** — 단일 출처.
#
#    2026-08-08 실장애: 원자주문 dedup(`internal_commerce._do_create_order`)이 만료 주문을
#    그대로 재생했고, 여기 가드가 그걸 거절해 손님이 **영구히 결제 불가**가 됐다
#    (같은 브라우저 = 같은 checkoutToken → 매번 같은 만료 주문 → 매번 502).
#
#    두 곳이 같은 질문("이 주문에 결제를 걸 수 있나")에 다르게 답한 것이 원인이다.
#    ⟹ 목록을 **여기 한 곳**에만 둔다. 두 벌로 적으면 다음에 한쪽만 바뀐다 —
#      이 결함이 정확히 그렇게 생겼다.
PAYABLE_ORDER_STATUSES: tuple[OrderStatus, ...] = (
    OrderStatus.PENDING,
    OrderStatus.PAYMENT_REQUIRED,
)

# ── 마감 초과 paid 결제 정책 (M-1: 돈만 빠지고 주문 소멸 금지) ──────────
# PG에서 이미 결제(paid)가 확인된 건을 비즈니스 사유로 거부할 때는 반드시
# PG 자동 환불을 동반한다. 단, 웹훅이 마감 직후 늦게 도착하는 정상 케이스를
# 위해 grace 윈도우를 둔다: 마감 후 이 시간 내 도착한 paid 웹훅은 확정을
# 허용하고(돈을 이미 받았고 재고가 살아있으므로 자동환불보다 확정이 유리),
# 이 시간을 지나 도착하면 자동 PG 환불과 함께 거부한다.
# NOTE: payment_expiry 태스크의 만료 grace는 이 값보다 길어야 한다 —
#       grace 내 주문이 먼저 EXPIRED(터미널)로 가면 확정 가능한 결제가
#       자동환불로 강등된다. (tasks/payment_expiry.py가 이 상수를 import)
WEBHOOK_DEADLINE_GRACE_SECONDS = 600  # 10분

# Fernet 토큰은 항상 버전 바이트 0x80으로 시작 → urlsafe-base64 인코딩 시 "gAAAA".
# 저장된 빌링키가 평문(레거시)인지 암호문인지 판별하는 데 사용한다 (M-1).
_FERNET_TOKEN_PREFIX = "gAAAA"


class PaymentConfirmationRejected(ValueError):
    """PG paid 확인 후 비즈니스 사유(마감 초과·사기 차단)로 확정이 거부됨.

    raise 전에 PG 자동 환불이 시도·기록된다.
    - ``refunded=True``: 환불 성공 — 웹훅 경로는 이 예외를 swallow하고
      200 OK로 ack해야 한다 (PortOne 재시도 무의미).
    - ``refunded=False``: 환불 실패 — 웹훅 경로는 예외를 전파해
      PortOne 재시도가 환불을 재시도하게 해야 한다.
    """

    def __init__(self, message: str, *, refunded: bool):
        super().__init__(message)
        self.refunded = refunded


class _SkipFraudForGuest(Exception):
    """내부 제어 흐름: 게스트 주문에서 회원 사기탐지 블록을 건너뛰기 위한 센티널.

    ValueError 가 아니므로 confirm 의 generic except(degraded-mode)에 삼켜지지 않도록
    전용 except 절이 먼저 잡는다. 결제 로직 밖으로 새어나가지 않는다.
    """


class PaymentService:
    """Payment orchestration layer for order lifecycle."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.order_repo = OrderRepository(session)
        self.tier_repo = SeatTierRepository(session)
        # 기본 게이트웨이(전역 provider). 신규 주문 initiate·generate_payment_id 등
        # pg_provider 미확정 단계에서 사용. 승인/취소/환불은 주문별로 라우팅한다(G6).
        self.gateway = get_payment_gateway()
        # v2→go propagation hints. Caller는 DB commit 후
        # `_drain_propagations(service.propagations)`로 Celery에 큐잉해야 함.
        self.propagations: list[dict] = []

    def _gateway_for(self, order):
        """주문의 pg_provider 로 게이트웨이를 라우팅한다(G6).

        기존 toss 주문은 toss, nicepay 주문은 nicepay 게이트웨이로 승인/취소/환불한다.
        pg_provider 미설정(신규 주문 초기 단계·레거시)이거나 주문 provider 가 이미
        기본 게이트웨이(self.gateway)와 같으면 **주입된 self.gateway 를 그대로 재사용**한다
        (테스트의 svc.gateway 교체 주입 존중 + 불필요한 새 인스턴스 생성 회피).
        """
        provider = getattr(order, "pg_provider", None)
        if not provider or provider.strip().lower() == self.gateway.provider_name:
            return self.gateway
        return get_payment_gateway(provider)

    async def _void_order_payment(
        self,
        order: Order,
        *,
        payment_id: str,
        reason: str,
        amount: int | None = None,
        transaction_id: str | None = None,
    ):
        """주문 provider/TID를 보존한 환불 호출 공통 경계.

        ``transaction_id`` 를 넘기면 그 값을 우선한다 — **승인 직후**처럼
        `order.pg_transaction_id` 가 아직 영속화되기 전 시점에서 TID 를 잃지 않기 위해서다
        (T15 카드사 재검증이 그 경우다. 안 넘기면 구형 나이스 취소가 TID 를 못 찾아 실패한다).
        """
        gateway = self._gateway_for(order)
        kwargs = {"payment_id": payment_id, "reason": reason}
        if amount is not None:
            kwargs["amount"] = amount
        if getattr(gateway, "provider_name", "") == "nicepay":
            kwargs["transaction_id"] = transaction_id or order.pg_transaction_id
            kwargs["payment_method"] = getattr(order, "payment_method", None)
            # 원거래 금액 정본 = 주문 원장(구형 거래조회는 금액 미제공, 실서버 실증).
            if order.total_amount is not None:
                kwargs["original_amount"] = int(order.total_amount)
        return await gateway.void_authorization(**kwargs)

    @staticmethod
    def _now() -> datetime:
        return datetime.now(timezone.utc)

    @staticmethod
    def _to_response(order: Order) -> OrderResponse:
        return OrderResponse.model_validate(order)

    @staticmethod
    def _build_provider_params(provider: str, raw: object) -> dict | None:
        """provider 별 결제창 form params 구성(nicepay 구형 전용, 그 외 None).

        나이스 구형 결제창(JS SDK `goPay(payForm)`)은 서버가 계산한 payForm 을
        consumer 로 내려줘야 한다(SignData 의 입력 MerchantKey 는 서버전용). 게이트웨이
        `prepare_payment` 이 이미 raw 에 MID·Moid·Amt·EdiDate·SignData·GoodsName·
        ReturnURL(=v2 return)·MallReserved(=success_url)·jsSdkUrl 을 계산해뒀으므로
        그대로 재구성해 반환한다. raw 는 신규 prepare 의 dict 이거나 저장된
        payment_metadata['prepare'] dict(재반환 경로) 둘 다 동일 형태다.

        토스/mock/포트원은 None — 기존 8필드 계약 무변.
        """
        if provider != "nicepay":
            return None
        if not isinstance(raw, dict):
            return None
        return {
            "js_url": raw.get("jsSdkUrl"),
            "form": {
                "MID": raw.get("MID"),
                "Moid": raw.get("Moid"),
                "Amt": raw.get("Amt"),
                "EdiDate": raw.get("EdiDate"),
                # PayMethod = 서버 정규화된 사용자 선택 결제수단(화이트리스트). SignData 무입력.
                "PayMethod": raw.get("PayMethod"),
                "SignData": raw.get("SignData"),
                "GoodsName": raw.get("GoodsName"),
                "ReturnURL": raw.get("ReturnURL"),
                "MallReserved": raw.get("MallReserved"),
            },
        }

    async def _get_order_for_update(self, order_id: uuid.UUID) -> Order:
        order = await self.order_repo.get_for_update(order_id)
        if not order:
            raise ValueError(f"Order {order_id} not found")
        return order

    async def _enforce_allowed_pay_method(
        self, event_id: uuid.UUID, pay_method: str | None
    ) -> None:
        """이벤트 ``allowed_pay_methods`` 로 요청 결제수단을 서버 강제한다(C1).

        - 이벤트 조회 실패/컬럼 NULL/빈값 → 무제한(현행 무변, fail-open to 전체 허용).
        - 허용목록 밖 수단 요청 → ``ValueError``(호출부가 400 으로 변환).

        ``allowed_pay_methods`` 컬럼만 SELECT(전체 Event 로드·relationship 회피).
        """
        from app.models.event import Event

        row = await self.session.execute(
            select(Event.allowed_pay_methods).where(Event.id == event_id)
        )
        allowed = row.scalar_one_or_none()
        if pay_method_allowed(pay_method, allowed):
            return
        norm = normalize_allowed_pay_methods(allowed) or []
        requested = (pay_method or "").strip().upper() or "(미지정)"
        raise ValueError(
            f"이 이벤트에서 허용되지 않은 결제수단입니다(요청: {requested}, "
            f"허용: {', '.join(norm)})."
        )

    async def initiate_payment(
        self,
        order_id: uuid.UUID,
        *,
        idempotency_key: str | None = None,
        success_url: str | None = None,
        fail_url: str | None = None,
        pay_method: str | None = None,
    ) -> PaymentPrepareResponse:
        """Prepare payment session for an order.

        This is safe to call repeatedly with the same idempotency key.

        ``pay_method`` 은 나이스 구형 결제창 사용자 선택 결제수단(CARD/BANK/VBANK/…)이며
        게이트웨이가 화이트리스트 정규화(오염값→CARD)한다. 나이스 승인/return 응답에는
        payMethod 필드가 없으므로 이 값이 order.payment_method 정규화의 데이터원이 된다
        (payment_metadata['prepare']['PayMethod'] 로 박제). 토스/포트원은 무시.
        """
        order = await self._get_order_for_update(order_id)

        if order.status not in PAYABLE_ORDER_STATUSES:
            raise ValueError(f"Cannot initiate payment for order in status '{order.status.value}'")

        # 카드전용 게이팅(C1) — 서버 강제. 프론트만 제한하면 payForm 직접 POST 로 우회
        # 가능하므로 여기서 이벤트 허용목록으로 요청 pay_method 를 검증한다. NULL(전체
        # 허용)이면 무제한(현행 무변). 세 prepare 경로(회원/게스트/internal) 공통 —
        # initiate_payment 단일 진입점이라 여기 한 곳에서 강제하면 전 경로 커버.
        await self._enforce_allowed_pay_method(order.event_id, pay_method)

        if (
            order.status == OrderStatus.PAYMENT_REQUIRED
            and order.payment_id
            and idempotency_key
            and order.payment_idempotency_key == idempotency_key
        ):
            redirect_url = ""
            prepared_raw: object = None
            if isinstance(order.payment_metadata, dict):
                redirect_url = order.payment_metadata.get("redirect_url", "")
                prepared_raw = order.payment_metadata.get("prepare")
            replay_provider = order.pg_provider or self.gateway.provider_name
            return PaymentPrepareResponse(
                order_id=order.id,
                provider=replay_provider,
                payment_id=order.payment_id,
                amount=order.total_amount,
                currency=order.payment_currency,
                redirect_url=redirect_url,
                payment_deadline=order.payment_deadline or self._now(),
                status=order.status.value,
                provider_params=self._build_provider_params(replay_provider, prepared_raw),
            )

        payment_id = order.payment_id or self.gateway.generate_payment_id(order.id)
        payment_deadline = self._now() + timedelta(minutes=settings.PAYMENT_EXPIRY_MINUTES)
        success_url = success_url or settings.PAYMENT_SUCCESS_URL
        fail_url = fail_url or settings.PAYMENT_FAIL_URL
        idem_key = idempotency_key or order.payment_idempotency_key or uuid.uuid4().hex

        # 나이스 구형만 pay_method 를 받는다(duck-typed prepare 계약 유지 — 토스는
        # 이 kwarg 를 모르므로 nicepay 게이트웨이에만 전달).
        prepare_kwargs: dict = dict(
            order_id=order.id,
            payment_id=payment_id,
            amount=order.total_amount,
            currency=order.payment_currency,
            success_url=success_url,
            fail_url=fail_url,
        )
        # 🔴 T14/T15: 카드사 할인 판정은 **provider 와 무관하게** 한다.
        #    nicepay 분기 안에 두면 토스 경로에서 메타가 안 남고 → T15 가 조기 return →
        #    **카드 검증 0 으로 할인**이 나간다(감사 발견). 토스가 dormant 여도 경로가
        #    살아 있으면 결함이다.
        #    판정 근거는 주문에 **실제 적용된 할인코드**(v2 원장)다 — 클라 주장이 아니다.
        card_discount = await self._resolve_order_card_discount(order)
        if getattr(self.gateway, "provider_name", None) == "nicepay":
            prepare_kwargs["pay_method"] = pay_method
            # SelectCardCode 는 나이스 구형 payForm 전용 — 결제창을 그 카드사로 제한한다.
            # 할인이 안 걸렸으면 넣지 않아 전 카드사 선택 가능(현행 불변).
            if card_discount:
                prepare_kwargs["select_card_code"] = card_discount["card_code"]
        prepared = await self.gateway.prepare_payment(**prepare_kwargs)

        if order.status != OrderStatus.PAYMENT_REQUIRED:
            validate_order_transition(order.status, OrderStatus.PAYMENT_REQUIRED)
        order.status = OrderStatus.PAYMENT_REQUIRED
        order.pg_provider = prepared.provider
        order.payment_id = prepared.payment_id
        order.payment_idempotency_key = idem_key
        order.payment_started_at = self._now()
        order.payment_deadline = payment_deadline
        order.payment_failed_at = None
        order.payment_failed_reason = None
        order.payment_metadata = {
            "prepare": prepared.raw,
            "redirect_url": prepared.redirect_url,
            "success_url": success_url,
            "fail_url": fail_url,
            # 🔴 T15 가 승인 후 읽는다. **여기서 같이 조립해야 한다** —
            #    prepare 앞에서 따로 써두면 이 재할당이 통째로 덮어써 T15 가 영구 무력화된다
            #    (자체검수에서 실제로 그 상태였다. 스텁 테스트라 못 잡았다).
            **({"card_discount": card_discount} if card_discount else {}),
        }

        await write_audit_log(
            self.session,
            actor_id=order.user_id,
            action="payment_initiated",
            resource_type="order",
            resource_id=str(order.id),
            event_id=order.event_id,
            tier_id=order.tier_id,
            new_value={
                "order_id": str(order.id),
                "payment_id": prepared.payment_id,
                "provider": prepared.provider,
                "amount": float(order.total_amount),
                "currency": order.payment_currency,
                "idempotency_key": idem_key,
                "result": "success",
            },
        )

        return PaymentPrepareResponse(
            order_id=order.id,
            provider=prepared.provider,
            payment_id=prepared.payment_id,
            amount=order.total_amount,
            currency=order.payment_currency,
            redirect_url=prepared.redirect_url,
            payment_deadline=payment_deadline,
            status=order.status.value,
            provider_params=self._build_provider_params(prepared.provider, prepared.raw),
        )

    async def _resolve_order_card_discount(self, order) -> dict | None:
        """주문에 적용된 카드사 자동할인을 판정한다(T14).

        판정 근거는 **주문에 실제 적용된 discount code** 다 — 클라이언트가 "BC 골랐다"고
        주장하는 것을 믿지 않는다. events.card_discounts 의 매핑과 대조해,
        그 코드로 할인이 실제로 걸린 주문에만 SelectCardCode 를 건다.

        반환 {"card": "BC", "card_code": "01", "discount_code": "..."} 또는 None.
        """
        from app.models.event import Event

        event = (
            await self.session.execute(select(Event).where(Event.id == order.event_id))
        ).scalar_one_or_none()
        mapping = getattr(event, "card_discounts", None) if event else None
        if not isinstance(mapping, dict) or not mapping:
            return None

        # 주문에 적용된 할인은 **order_items.discount_code_id** 로 남는다
        # (internal_commerce 주문생성: OrderItem(..., discount_code_id=discount_row.id)).
        # v2 는 주문당 코드 1개만 적용하므로 어느 라인에서 읽어도 같다.
        from app.models.discount_code import DiscountCode
        from app.models.order_item import OrderItem

        applied_code = (
            await self.session.execute(
                select(DiscountCode.code)
                .join(OrderItem, OrderItem.discount_code_id == DiscountCode.id)
                .where(OrderItem.order_id == order.id)
                .limit(1)
            )
        ).scalar_one_or_none()
        if not applied_code:
            return None

        # 🔴 대소문자를 정규화해 비교한다. v2 는 할인코드를 **대문자로 저장**하는데
        #    (create: `body.code.upper()`), events.card_discounts 설정에 소문자를 쓰면
        #    validate 는 통과하고(대문자로 조회) 여기 비교만 어긋난다 →
        #    card_discount 미기록 → T15 조기 return → **검증 0 으로 10% 할인**.
        #    설정 오타 하나가 조용히 fail-open 이 되는 구조라 정규화가 필수다.
        applied_norm = str(applied_code).strip().upper()
        for card, cfg in mapping.items():
            if not isinstance(cfg, dict):
                continue
            if str(cfg.get("discount_code") or "").strip().upper() == applied_norm:
                return {
                    "card": str(card),
                    "card_code": str(cfg.get("card_code") or "01"),
                    "discount_code": str(applied_code),
                }
        return None

    async def _enforce_card_discount_issuer(self, order, verified) -> None:
        """BC 자동할인이 걸린 주문이면 승인 카드사가 실제로 그 카드사인지 확인한다(T15).

        불일치·확인불가면 **승인을 취소하고** 예외를 올린다 → 주문은 확정되지 않는다.

        🔴 fail-closed: 카드사를 **확인하지 못해도** 확정하지 않는다. 실키 미발급이라
           응답 필드명이 확정되지 않았는데(extract_card_issuer 주석) "못 읽었으니 통과" 로
           두면 할인 우회가 조용히 성립한다.
        """
        from app.services.nicepay_gateway import (
            NICE_CARD_CODES_BC,
            extract_card_issuer,
            parse_card_codes,
        )

        meta = order.payment_metadata if isinstance(order.payment_metadata, dict) else {}
        applied = meta.get("card_discount") if isinstance(meta, dict) else None
        if not applied:
            return  # 카드사 할인이 걸리지 않은 일반 주문 — 검증 대상 아님

        # 🔴 카드사는 **여럿일 수 있다**. BC 계열만 해도 비씨(01)와 우리BC(15) 둘이다
        #    (PDF 표 11-1). `SelectCardCode` 가 콤마 나열을 받으므로 설정도 같은 형식이고,
        #    검증은 **그 목록에 대한 소속 판정**이어야 한다. 단일 비교로 두면 결제창은
        #    열어주고 T15 가 거절하는 — 손님이 "결제 완료 후 취소" 를 겪는 — 모양이 된다.
        expected_set = parse_card_codes(applied.get("card_code") or NICE_CARD_CODES_BC)
        expected = ",".join(sorted(expected_set))  # 로그·취소사유 표기용
        raw = verified.raw if isinstance(verified.raw, dict) else {}
        code, name = extract_card_issuer(raw)

        if code and code in expected_set:
            meta = dict(meta)
            meta["card_issuer"] = {"code": code, "name": name}
            order.payment_metadata = meta
            return

        reason = "card_issuer_mismatch" if code else "card_issuer_unknown"
        logger.error(
            "T15 카드사 재검증 실패 — 확정 거부: order=%s expected=%s got=%s reason=%s",
            order.id, expected, code, reason,
        )

        # 승인된 돈을 되돌린다.
        # 🔴 공통 헬퍼를 쓴다 — 게이트웨이를 직접 부르면 구형 나이스가 TID 를 못 찾아
        #    **실키에서 100% 실패**한다(감사에서 실증). 이 시점엔 order.pg_transaction_id 가
        #    아직 비어 있으므로 승인 응답의 TID 를 명시적으로 넘긴다.
        cancelled = False
        void_error: str | None = None
        try:
            if order.payment_id:
                await self._void_order_payment(
                    order,
                    payment_id=order.payment_id,
                    reason=f"T15 {reason}: expected card {expected}, got {code or 'unknown'}",
                    transaction_id=getattr(verified, "transaction_id", None),
                )
                cancelled = True
        except Exception as e:  # noqa: BLE001
            void_error = str(e)
            logger.exception("T15 승인취소 실패 — 부분 성공(돈 나감·주문 미확정): order=%s", order.id)

        # 🔴 `metadata=` 인자는 write_audit_log 에 **존재하지 않는다**(TypeError 로 터졌다).
        #    실제 시그니처는 old_value/new_value 다 — 감사에서 실증된 결함.
        await write_audit_log(
            self.session,
            actor_id=order.user_id,
            action="payment_card_issuer_rejected",
            resource_type="order",
            resource_id=str(order.id),
            event_id=order.event_id,
            new_value={
                "expected_card_code": expected,
                "actual_card_code": code,
                "actual_card_name": name,
                "reason": reason,
                "voided": cancelled,
                "void_error": void_error,
            },
        )

        # 🔴 취소까지 실패하면 **돈은 나갔고 주문은 미확정**이다. 로그만 남기면 아무도 모른다 —
        #    자매 로직(_refund_rejected_confirmation)과 동일하게 즉시 에스컬레이션한다.
        if not cancelled:
            try:
                from app.core.alerting import send_ops_alert

                await send_ops_alert(
                    "critical",
                    "T15 카드사 거부 후 승인취소 실패 — 고객 청구됨·주문 미확정",
                    {
                        "order_id": str(order.id),
                        "payment_id": order.payment_id,
                        "expected_card_code": expected,
                        "actual_card_code": code,
                        "error": void_error,
                    },
                    mention=True,
                )
            except Exception:  # noqa: BLE001
                logger.warning("T15 ops 알림 실패", exc_info=True)

        raise ValueError(
            "선택하신 카드로는 할인이 적용되지 않습니다. 비씨카드로 다시 시도해주세요."
            if code else
            "카드사를 확인하지 못해 결제를 완료하지 못했습니다. 다시 시도해주세요."
        )

    async def confirm_payment(
        self,
        order_id: uuid.UUID,
        *,
        pg_provider: str = "portone",
        pg_txn_id: str = "stub_txn",
        payment_id: str | None = None,
        amount: float | None = None,
        source: str = "client",
        auth_token: str | None = None,
        next_app_url: str | None = None,
        net_cancel_url: str | None = None,
        _verified: PaymentVerificationResult | None = None,
    ) -> OrderResponse:
        """Confirm payment for an order after provider verification.

        Uses Redis distributed lock to prevent concurrent client + webhook
        confirmation race condition.

        ``auth_token``/``next_app_url`` 은 나이스 구형 인증결제 전용(기본 None) —
        인증응답(returnUrl POST)에서 받은 값을 게이트웨이 ``verify_payment`` 로 넘겨
        NextAppURL(dc1/dc2) 로 실 승인(EdiType=KV)을 수행하게 한다. 토스/포트원·기존
        호출부는 넘기지 않으므로 동작 무변.
        """
        import time as _time
        from app.core.redis import redis_lock

        _confirm_start = _time.perf_counter()

        # 분산 락: 동일 주문에 대해 클라이언트 confirm과 웹훅 confirm이
        # 동시에 실행되는 것을 방지. SELECT FOR UPDATE만으로는 별도 트랜잭션에서
        # 동시 진입 시 두 번째가 첫 번째 커밋 후에 lock을 획득하여 이미 CONFIRMED된
        # 주문을 다시 처리할 수 있음. Redis 락이 application-level에서 직렬화.
        # Redis 불가 시 DB SELECT FOR UPDATE로 폴백 (안전성 약간 낮지만 서비스 거부보다 나음).
        _inner_kwargs = dict(
            pg_provider=pg_provider, pg_txn_id=pg_txn_id,
            payment_id=payment_id, amount=amount,
            source=source, _confirm_start=_confirm_start,
            auth_token=auth_token, next_app_url=next_app_url,
            net_cancel_url=net_cancel_url,
            _verified=_verified,
        )
        try:
            async with redis_lock(f"v2:payment:confirm:{{{order_id}}}", ttl=10):
                return await self._confirm_payment_inner(order_id, **_inner_kwargs)
        except (RuntimeError, OSError, ConnectionError):
            # Redis 연결 실패 → DB lock만으로 진행
            logger.warning("Redis lock unavailable for confirm_payment, falling back to DB lock")
            return await self._confirm_payment_inner(order_id, **_inner_kwargs)



    async def _resolve_nice_attempt_succeeded(self, *, order_id, pg_txn_id: str) -> None:
        """확정과 **같은 트랜잭션에서** 사전기록을 SUCCEEDED 로 닫는다 (C2).

        🔴 별도 세션으로 즉시 커밋하면 안 된다 (코덱스 F09 가 실 PG 로 잡음).
           `confirm_payment` 은 스스로 커밋하지 않고 커밋은 **호출자**가 한다. 별도
           세션에서 닫으면 그 커밋이 롤백돼도 기록만 SUCCEEDED 로 남아 **복구 대상에서
           빠진다.** 반대로 호출자 트랜잭션에 얹으면:

               커밋 성공 → 주문 확정과 함께 닫힌다        (F12)
               롤백      → 기록도 INITIATED 로 되돌아간다 (F09)

           사전기록(C1)은 별도 커밋이 맞고, **해결은 같은 트랜잭션이 맞다.** 둘의
           요구가 반대라는 것이 이 설계의 핵심이다.

        ⚠️ **성공했을 때만 닫는다.** 승인 거부·확정 거부·vbank 대기는 INITIATED 로 둔다.
           각자 다른 상태인데 여기서 추측으로 닫으면 조용한 오판이 된다.
           PG 에 물어보는 것은 복구의 몫이다.
        """
        if not pg_txn_id or pg_txn_id == "stub_txn":
            return
        from app.models.payment_attempt import PaymentAttempt, PaymentAttemptStatus

        await self.session.execute(
            update(PaymentAttempt)
            .where(
                PaymentAttempt.order_id == order_id,
                PaymentAttempt.pg_transaction_id == pg_txn_id,
                PaymentAttempt.status == PaymentAttemptStatus.INITIATED,
            )
            .values(status=PaymentAttemptStatus.SUCCEEDED)
        )

    async def _precommit_nice_attempt(
        self,
        *,
        order: Order,
        payment_id: str,
        pg_txn_id: str | None,
        amount: float,
    ) -> None:
        """🔴 승인 호출 **전에** (주문·Moid·TID) 를 별도 트랜잭션으로 커밋한다 (C1).

        ## 왜 필요한가

        나이스는 `① PG 승인 → ② DB 커밋` 순서다. ②가 깨지면 카드는 승인됐는데
        주문·티켓이 없다. 그 사고를 **나중에 찾으려면 TID 가 있어야 하는데**, 지금은
        TID 를 ②와 같은 트랜잭션에 저장하므로 ②가 깨지면 조회 키 자체가 사라진다.
        그래서 고아결제 대사가 나이스에 대해 통째로 무력하다.

        TID 는 승인 요청 **전에** 이미 손에 있다(return 폼의 TxTid). 그러니 승인 전에
        따로 커밋해두면 커밋이 깨져도 그 TID 로 PG 에 물어볼 수 있다.

        ## 🔴 반드시 별도 세션이어야 한다

        `self.session` 에 쓰고 flush 만 하면 **확정 트랜잭션과 운명을 같이 한다** —
        롤백되면 기록도 사라져 아무 의미가 없다. 별도 세션으로 **커밋**해야
        확정이 깨져도 남는다.

        ## 선행 미해결 TID 가 있으면 재승인하지 않는다

        같은 Moid 에 앞선 INITIATED 기록이 **다른 TID** 로 남아 있으면, 그 건이
        PG 에서 승인됐는지 아직 모른다는 뜻이다. 그 상태로 새 승인을 보내면
        같은 주문에 승인이 둘 생길 수 있다.

        ⚠️ 나이스가 같은 Moid 의 중복 승인을 거부하는지는 **스펙에 없다.**
           그래서 답에 의존하지 않는 쪽으로 막는다 — 우리가 안 보낸다.

        ## 실패하면 승인하지 않는다

        기록을 못 남겼다는 것은 **사고가 나도 못 찾는다**는 뜻이다. 그 상태로
        승인하면 정확히 우리가 없애려는 상황이 된다. 예외를 그대로 올린다.
        (승인 전이므로 이 시점의 실패는 돈이 나가지 않는다.)
        """
        if not pg_txn_id or pg_txn_id == "stub_txn":
            return

        from sqlalchemy.ext.asyncio import async_sessionmaker

        from app.models.payment_attempt import PaymentAttempt, PaymentAttemptStatus

        # 🔴 **같은 엔진**에 새 세션을 연다. `app.core.database.async_session` 을 직접
        #    쓰면 테스트(SQLite 인메모리)에서 실 Postgres 로 붙으려다 죽는다.
        #    ⚠️ 테스트 스택은 SQLite StaticPool 이라 커넥션이 하나다 — 거기서는 이 세션이
        #       **진짜로 분리되지 않는다.** "확정이 롤백돼도 기록이 남는가" 는 실 PG 로만
        #       증명된다(코덱스 F03).
        from sqlalchemy.ext.asyncio import AsyncEngine

        bind = getattr(self.session, "bind", None)
        if not isinstance(bind, AsyncEngine):
            # 세션이 커넥션에 직접 묶인 경우(일부 테스트) — 전역 엔진으로 떨어진다.
            from app.core.database import engine as _global_engine

            bind = _global_engine
        maker = async_sessionmaker(bind, class_=AsyncSession, expire_on_commit=False)
        async with maker() as db:
            rows = (
                await db.execute(
                    select(PaymentAttempt)
                    .where(PaymentAttempt.order_id == order.id)
                    .order_by(PaymentAttempt.attempt_no.desc())
                )
            ).scalars().all()

            # 🔴 **미해결 기록이 하나라도 있으면 승인하지 않는다 — TID 가 같아도.**
            #
            #    처음엔 "같은 TID 면 통과" 로 뒀는데 그게 구멍이었다(자체검수에서 발견):
            #    첫 return 이 사전기록만 남기고 승인 도중 죽었을 때, 손님이 새로고침하면
            #    같은 TID 로 **승인이 두 번** 나간다. 나이스가 같은 TID 의 중복 승인을
            #    거부하는지는 **스펙에 없다** — 그 미지에 기대지 않기로 한 것이 이 설계의
            #    전제인데, 같은 TID 만 예외로 두면 전제가 무너진다.
            #
            #    ⚠️ 대신 손님은 그 사이 결제를 못 한다. 그게 맞다 — 앞선 시도가 승인됐는지
            #       모르는 상태에서 한 번 더 긁는 것보다 잠시 막는 쪽이 낫다. 복구가
            #       PG 에 물어 수렴시키면 풀린다(그래서 드레인 주기가 짧아야 한다).
            for prior in rows:
                if prior.status == PaymentAttemptStatus.INITIATED and prior.pg_transaction_id:
                    logger.error(
                        "나이스 재승인 차단 — 선행 시도가 미해결이다: order=%s prior_tid=%s new_tid=%s",
                        order.id,
                        prior.pg_transaction_id,
                        pg_txn_id,
                    )
                    raise ValueError(
                        "이전 결제 시도의 결과가 확인되지 않았습니다. 잠시 후 다시 시도해 주세요."
                    )

            # 같은 TID 가 **종결된 상태**로 있으면 정상적인 재전송이다(F12).
            # 새 행을 만들지 않고 통과시킨다 — 확정 자체는 confirm_payment 가 멱등 처리한다.
            if any(prior.pg_transaction_id == pg_txn_id for prior in rows):
                return

            db.add(
                PaymentAttempt(
                    order_id=order.id,
                    attempt_no=(rows[0].attempt_no + 1) if rows else 1,
                    payment_id=payment_id,
                    method="nice_auth",
                    amount=Decimal(str(amount)),
                    currency=order.payment_currency,
                    status=PaymentAttemptStatus.INITIATED,
                    pg_transaction_id=pg_txn_id,
                )
            )
            await db.commit()

    async def _confirm_payment_inner(
        self,
        order_id: uuid.UUID,
        *,
        pg_provider: str,
        pg_txn_id: str,
        payment_id: str | None,
        amount: float | None,
        source: str,
        _confirm_start: float,
        auth_token: str | None = None,
        next_app_url: str | None = None,
        net_cancel_url: str | None = None,
        _verified: PaymentVerificationResult | None = None,
    ) -> OrderResponse:
        """Inner confirm logic, called under distributed lock."""
        import time as _time

        order = await self._get_order_for_update(order_id)

        if order.status in (OrderStatus.CANCELLED, OrderStatus.EXPIRED, OrderStatus.REFUNDED):
            raise ValueError(f"Cannot confirm payment for order in status '{order.status.value}'")

        if order.status in (OrderStatus.CONFIRMED, OrderStatus.PAID):
            if order.pg_transaction_id == pg_txn_id:
                return self._to_response(order)
            raise ValueError(f"Cannot confirm payment for order in status '{order.status.value}'")

        if order.status not in (OrderStatus.PENDING, OrderStatus.PAYMENT_REQUIRED):
            raise ValueError(f"Cannot confirm payment for order in status '{order.status.value}'")

        # 결제 마감 시간 초과 검증 — 거부 '확정'은 PG verify 이후로 미룬다.
        # PG에서 이미 paid인 건을 여기서 거부하면 '돈만 빠지고 주문 소멸'(M-1)이
        # 되므로, 여기서는 초과 여부만 계산하고 verify로 paid가 확인된 뒤
        # 자동 PG 환불과 함께 거부한다. 웹훅 경로는 마감 후
        # WEBHOOK_DEADLINE_GRACE_SECONDS 내 도착 시 확정을 허용한다.
        now = self._now()
        deadline_expired = False
        within_webhook_grace = False
        if order.payment_deadline:
            deadline = order.payment_deadline
            if deadline.tzinfo is None:
                deadline = deadline.replace(tzinfo=timezone.utc)
            if deadline < now:
                deadline_expired = True
                within_webhook_grace = (
                    source == "webhook"
                    and (now - deadline).total_seconds() <= WEBHOOK_DEADLINE_GRACE_SECONDS
                )

        effective_payment_id = payment_id or order.payment_id
        if not effective_payment_id:
            effective_payment_id = self.gateway.generate_payment_id(order.id)

        if order.payment_id and payment_id and payment_id != order.payment_id:
            raise ValueError("Payment ID mismatch for this order")

        # Prevent pg_transaction_id reuse across different orders
        if pg_txn_id and pg_txn_id != "stub_txn":
            existing = await self.session.execute(
                select(Order).where(
                    Order.pg_transaction_id == pg_txn_id,
                    Order.id != order_id,
                )
            )
            if existing.scalar_one_or_none():
                raise ValueError("This payment transaction has already been used for another order")

        expected_amount = float(order.total_amount)
        if amount is not None and abs(float(amount) - expected_amount) > 0.000001:
            raise ValueError(f"Amount mismatch: expected {expected_amount}, got {amount}")

        # 나이스 구형 인증결제: 인증응답에서 받은 auth_token·next_app_url 을 게이트웨이로
        # 넘겨 NextAppURL(dc1/dc2) 로 실 승인(EdiType=KV)을 수행하게 한다. 토스/포트원
        # 게이트웨이는 이 kwarg 를 받지 않으므로, **값이 있을 때만** 전달한다(계약 무변).
        _verify_kwargs: dict = {}
        if auth_token is not None:
            _verify_kwargs["auth_token"] = auth_token
        if next_app_url is not None:
            _verify_kwargs["next_app_url"] = next_app_url
        if net_cancel_url is not None and getattr(self._gateway_for(order), "provider_name", "") == "nicepay":
            _verify_kwargs["net_cancel_url"] = net_cancel_url
        if _verified is not None:
            if _verified.provider != order.pg_provider:
                raise ValueError("Provider verification mismatch")
            if _verified.transaction_id != pg_txn_id:
                raise ValueError("Verified transaction mismatch")
            if abs(float(_verified.amount) - expected_amount) > 0.000001:
                raise ValueError("Verified amount mismatch")
            verified = _verified
        else:
            verified = await self._gateway_for(order).verify_payment(
                payment_id=effective_payment_id,
                transaction_id=pg_txn_id,
                expected_amount=expected_amount,
                currency=order.payment_currency,
                expected_statuses={"paid", "succeeded", "success", "completed"},
                **_verify_kwargs,
            )

        # ── 🔴 T15: BC 자동할인 주문의 카드사 재검증 (승인 후·확정 전) ──────────────
        #
        # `SelectCardCode=01` 은 **결제창 UI 제약**일 뿐이라 우회 가능성을 배제할 수 없다.
        # BC 할인가(10% 차감)로 승인된 건이 실제로는 다른 카드사였다면 **그대로 손실**이다.
        # "확정은 하고 정산에서 잡자" 로 흘리면 안 된다 — 확정된 주문은 되돌리기 어렵고,
        # 티켓까지 발급되면 회수가 사실상 불가능하다.
        #
        # 🔴 fail-closed: 카드사를 **확인하지 못해도 확정하지 않는다.**
        #    실키 미발급이라 응답 필드명이 확정되지 않았는데(extract_card_issuer 주석 참조),
        #    "못 읽었으니 통과" 로 두면 할인 우회가 조용히 성립한다.
        await self._enforce_card_discount_issuer(order, verified)

        # ── vbank 채번(입금대기) 신호 — 결제 미완료이므로 확정 금지 (G9) ──
        # 나이스 vbank 는 승인 응답 status="ready"(가상계좌 채번)로, 아직 돈이 안 들어온
        # 상태다. NicepayGateway.verify_payment 가 예외 없이 raw._pending=True 로 반환한다.
        # 이 경우 주문을 PENDING/PAYMENT_REQUIRED 로 **그대로 두고**, tid·metadata 만
        # 영속화한다 — 실제 입금은 이후 웹훅 paid 로 확정된다(유실 fallback). 여기서
        # CONFIRMED 로 전이하면 미입금 주문이 확정되는 사고가 난다.
        if isinstance(verified.raw, dict) and verified.raw.get("_pending"):
            if verified.transaction_id:
                # tid 를 미리 저장해 웹훅 paid 가 order.payment_id 로 찾을 수 있게 한다.
                # pg_transaction_id UNIQUE 재사용 방지: 이미 다른 주문이 쓰면 저장 생략.
                if not order.pg_transaction_id:
                    dupe = await self.session.execute(
                        select(Order.id).where(
                            Order.pg_transaction_id == verified.transaction_id,
                            Order.id != order_id,
                        )
                    )
                    if dupe.scalar_one_or_none() is None:
                        order.pg_transaction_id = verified.transaction_id
            order.pg_provider = verified.provider
            order.payment_id = verified.payment_id or effective_payment_id
            meta = dict(order.payment_metadata) if isinstance(order.payment_metadata, dict) else {}
            meta["vbank_pending"] = mask_payment_payload(verified.raw)
            meta["verification_source"] = source
            order.payment_metadata = meta
            await write_audit_log(
                self.session,
                actor_id=order.user_id,
                action="payment_vbank_pending",
                resource_type="order",
                resource_id=str(order.id),
                event_id=order.event_id,
                tier_id=order.tier_id,
                new_value={
                    "order_id": str(order.id),
                    "payment_id": order.payment_id,
                    "pg_provider": order.pg_provider,
                    "source": source,
                    "result": "vbank_pending",
                },
            )
            return self._to_response(order)

        # ── 마감 초과 거부 — PG paid 확인 후이므로 자동 PG 환불 동반 (M-1) ──
        if deadline_expired and not within_webhook_grace:
            refunded = await self._refund_rejected_confirmation(
                order,
                payment_id=verified.payment_id or effective_payment_id,
                reason="payment_deadline_expired",
                source=source,
            )
            raise PaymentConfirmationRejected(
                "Payment deadline has expired. "
                + (
                    "The completed payment has been refunded automatically."
                    if refunded
                    else "Automatic refund failed — flagged for manual refund."
                ),
                refunded=refunded,
            )

        # ── 사기 탐지 ──
        # block 판정은 try 밖에서 처리한다 — 환불 헬퍼의 예외가 아래의
        # generic except(degraded-mode 통과)에 삼켜져 차단이 무력화되면 안 됨.
        fraud_block_score: int | None = None
        # 상세통합 S2b(§6.3): 게스트 주문(user_id 없음)은 회원 velocity/loyalty 기반 사기탐지
        # 로직을 건너뛴다 — analyze_fraud/record_payment_success 가 user_id(users FK)를 전제.
        # 게스트는 fixed_fcfs/무료로 제한되므로(opt-in 게이트) 회원 사기신호 축적이 없다.
        is_guest_order = order.user_id is None
        try:
            if is_guest_order:
                raise _SkipFraudForGuest
            from decimal import Decimal
            card_hash = (verified.raw or {}).get("card_hash")
            fraud_score = await analyze_fraud(
                db=self.session,
                order_id=order.id,
                user_id=order.user_id,
                amount=Decimal(str(order.total_amount)),
                card_hash=card_hash,
            )
            if fraud_score.action == "block":
                logger.warning(
                    "Fraud blocked: order=%s user=%s score=%d reasons=%s",
                    order.id, order.user_id, fraud_score.total_score, fraud_score.reasons,
                )
                fraud_block_score = fraud_score.total_score
            else:
                if fraud_score.action == "review":
                    logger.warning(
                        "Fraud review: order=%s user=%s score=%d reasons=%s",
                        order.id, order.user_id, fraud_score.total_score, fraud_score.reasons,
                    )
                    # review는 로그 + 알림, 결제는 진행
                await record_payment_success(order.user_id)
        except _SkipFraudForGuest:
            # 게스트 주문 — 회원 사기탐지 스킵(정상 경로, degraded 아님).
            logger.info("Fraud detection skipped for guest order=%s", order.id)
        except ValueError:
            raise
        except Exception:
            # §26 P1: Fraud detection failure must not be silent.
            # Log at ERROR level and record a degraded-mode alert so admins
            # can review orders that bypassed fraud checks.
            logger.error(
                "Fraud detection FAILED for order=%s user=%s — allowing payment in degraded mode",
                order.id, order.user_id, exc_info=True,
            )
            try:
                from app.services.fraud_detector import store_fraud_alert, FraudScore
                degraded_score = FraudScore(
                    order_id=order.id,
                    user_id=order.user_id,
                    total_score=0,
                    card_velocity_score=0,
                    amount_anomaly_score=0,
                    geo_velocity_score=0,
                    device_score=0,
                    failure_pattern_score=0,
                    reasons=["DEGRADED: fraud detection service failed, order allowed without checks"],
                    action="review",
                )
                await store_fraud_alert(degraded_score)
            except Exception:
                logger.error("Failed to store degraded-mode fraud alert for order=%s", order.id)

        # ── fraud block 거부 — PG paid 확인 후이므로 무조건 자동 PG 환불 (M-1) ──
        if fraud_block_score is not None:
            refunded = await self._refund_rejected_confirmation(
                order,
                payment_id=verified.payment_id or effective_payment_id,
                reason=f"fraud_block(score={fraud_block_score})",
                source=source,
            )
            raise PaymentConfirmationRejected(
                f"Payment blocked by fraud detection (score: {fraud_block_score})",
                refunded=refunded,
            )

        # ── 재판매 티켓 상태 재검증 (M-2) — PG paid 확인 후이므로 거부 시
        # 마감 초과·fraud block과 동일하게 자동 PG 환불을 동반한다 (M-1).
        resale_reject_reason = await self._resale_ticket_unsellable_reason(order)
        if resale_reject_reason:
            refunded = await self._refund_rejected_confirmation(
                order,
                payment_id=verified.payment_id or effective_payment_id,
                reason=resale_reject_reason,
                source=source,
            )
            raise PaymentConfirmationRejected(
                "Resale ticket is no longer sellable (refunded, checked-in or transferred). "
                + (
                    "The completed payment has been refunded automatically."
                    if refunded
                    else "Automatic refund failed — flagged for manual refund."
                ),
                refunded=refunded,
            )

        now = self._now()
        validate_order_transition(order.status, OrderStatus.CONFIRMED)
        order.status = OrderStatus.CONFIRMED
        order.pg_provider = verified.provider
        order.payment_id = verified.payment_id
        order.pg_transaction_id = verified.transaction_id
        order.pg_approved_at = now
        order.captured_at = order.captured_at or now
        order.payment_failed_at = None
        order.payment_failed_reason = None
        # dict() 복사: 동일 객체 재할당은 변경 감지가 누락됨 (기존 metadata 보유 주문)
        meta = dict(order.payment_metadata) if isinstance(order.payment_metadata, dict) else {}
        meta["verification"] = mask_payment_payload(verified.raw)
        meta["verification_source"] = source
        order.payment_metadata = meta

        # 결제수단 대분류 저장(dev_v3 계약 (5)) — provider 확정 raw 의 payMethod/method 를
        # 대분류로 정규화(세부는 metadata 유지). 미지/미상은 NULL(안전 기본, card 오분류 금지).
        # ⚠️ 나이스 구형 승인/return 응답에는 payMethod 필드가 없다 → prepare 시 사용자가
        # 선택해 payForm 에 실린 PayMethod(payment_metadata['prepare']['PayMethod'])를
        # 데이터원으로 폴백한다(그게 없으면 NULL 유지). 이걸 안 넘기면 모든 나이스 주문의
        # order.payment_method 가 NULL 로 저장되던 결함(감사 발견) 교정.
        _nice_pay_method: str | None = None
        if isinstance(order.payment_metadata, dict):
            _prep = order.payment_metadata.get("prepare")
            if isinstance(_prep, dict):
                _pm_raw = _prep.get("PayMethod")
                if isinstance(_pm_raw, str) and _pm_raw.strip():
                    _nice_pay_method = _pm_raw
        _pm = resolve_payment_method(
            order.pg_provider,
            raw=verified.raw if isinstance(verified.raw, dict) else None,
            total_amount=float(order.total_amount or 0),
            nice_pay_method=_nice_pay_method,
        )
        if _pm is not None:
            order.payment_method = _pm

        # Activate pending tickets upon payment confirmation (batch UPDATE)
        await self.session.execute(
            update(Ticket)
            .where(Ticket.purchase_order_id == order_id, Ticket.status == TicketStatus.PENDING)
            .values(status=TicketStatus.ACTIVE)
        )

        # fee 동결 (MASTER N5) — 확정 시점 platform/pg fee 1회 계산·기록(정산 역산 SSOT, 재계산 금지).
        # settlement(4d-2)는 이 동결값을 기간 SUM만 한다.
        await self._freeze_order_fees(order)

        # 구매 AP 적립 (WP07 / MASTER N2) — 멱등키로 재확정 시 중복 적립 차단.
        # best-effort: 적립 실패가 결제 확정을 막지 않음(멱등키로 재시도 안전).
        try:
            ap = int(float(order.total_amount or 0) * settings.POINT_EARN_RATE_PURCHASE)
            # 게스트 주문(user_id 없음)은 AP 적립 대상 아님(§6.3 회원전용 로열티 제외).
            if ap > 0 and order.order_type == OrderType.PURCHASE and order.user_id is not None:
                from app.services.point_service import PointService
                from app.models.point import PointType, PointTransactionType

                await PointService(self.session).earn(
                    order.user_id,
                    PointType.FAN,
                    ap,
                    PointTransactionType.EARN_PURCHASE,
                    reference_id=order.id,
                    description="구매 적립",
                    idempotency_key=f"purchase:{order.id}",
                )
        except Exception:  # noqa: BLE001 — 적립 실패는 결제확정과 분리
            logger.warning("구매 AP 적립 실패 order=%s", order.id, exc_info=True)

        # RESALE_BUY: 소유권 이전 (원클릭 결제 완료 경로와 공유).
        # 락 재독에서 티켓 비ACTIVE(레이스)·소유자/금액 불일치 발견 시 PG 청구
        # 후이므로 자동 환불로 라우팅한다 (M-1).
        await self._apply_resale_transfer_or_reject(
            order, payment_id=verified.payment_id or effective_payment_id, source=source
        )

        await write_audit_log(
            self.session,
            actor_id=order.user_id,
            # 상세통합 S2b(§6.3): 게스트 주문은 actor_type='guest' + guest_id 로 기록(actor_id NULL).
            actor_type="guest" if is_guest_order else "user",
            guest_id=order.guest_id if is_guest_order else None,
            action="payment_confirmed",
            resource_type="order",
            resource_id=str(order.id),
            event_id=order.event_id,
            tier_id=order.tier_id,
            new_value={
                "order_id": str(order.id),
                "payment_id": order.payment_id,
                "pg_provider": order.pg_provider,
                "pg_txn_id": order.pg_transaction_id,
                "amount": order.total_amount,
                "source": source,
                "result": "success",
            },
        )

        # 결제 완료 알림 발송
        try:
            await self._send_payment_notification(order, "payment_complete")
        except Exception:
            logger.warning("결제 완료 알림 발송 실패: order=%s", order.id)

        try:
            # 정본 provider = order.pg_provider(=verified.provider, prepare 확정값).
            # 요청 body 파라미터 pg_provider 는 신뢰하지 않는다(위조 방지).
            PAYMENT_TOTAL.labels(status="confirmed", provider=order.pg_provider).inc()
            PAYMENT_CONFIRM_DURATION.observe(_time.perf_counter() - _confirm_start)
        except Exception:
            logger.debug("Failed to record payment metrics")

        # v2→go 전파 hint 수집 (webhook 경로는 handle_portone_webhook이 직접
        # propagations를 빌드하므로 여기서는 건너뛴다).
        if source != "webhook":
            synthetic_event = SimpleNamespace(
                payment_id=order.payment_id,
                amount=order.total_amount,
                # go 원장 오염 방지: 요청 body 가 아닌 확정 provider(order.pg_provider).
                method=order.pg_provider,
            )
            self.propagations.append(
                _build_payment_confirmed_hint(order, synthetic_event)
            )

        return self._to_response(order)

    async def _freeze_order_fees(self, order: Order) -> None:
        """fee 동결 (MASTER N5) — 확정 시점 platform/pg fee 1회 계산·기록.

        정산(settlement)은 이 동결값을 기간 SUM만 하므로, 결제 확정의 모든
        경로(일반 confirm + 원클릭)에서 반드시 호출되어야 한다.
        실패는 결제확정과 분리(폴백 rate 존재) — warning 로깅 후 통과.
        """
        try:
            from app.services.finance_service import FinanceService
            from decimal import Decimal as _Dec

            _fin = FinanceService(self.session)
            # SPEC §2.7 — 정률+정액(fee_type) 컴포넌트로 동결. go fee-plan 미러 시 정액 반영.
            # dev_v3 계약 (3): order.pg_provider 로 provider 전용 pg_fee 오버라이드행을
            # 우선 선택(없으면 NULL 기본행 폴백 — pg_provider NULL 이면 기존 동작).
            _comp = await _fin.get_fee_components(
                event_id=order.event_id,
                pg_provider=normalize_fee_provider(order.pg_provider),
            )
            _total = order.total_amount or _Dec(0)
            _plat_fee, _pg_fee = _fin.compute_fees(_total, _comp)
            order.platform_fee_rate = _Dec(str(_comp["platform_fee_rate"]))
            order.platform_fee = _plat_fee  # 정액 포함 절대금액(정산 SUM 이 정액 포착)
            order.pg_fee_rate = _Dec(str(_comp["pg_fee_rate"]))
            order.pg_fee = _pg_fee
            order.net_amount = _total - _plat_fee - _pg_fee
        except Exception:  # noqa: BLE001 — fee 동결 실패는 결제확정과 분리(폴백 rate 존재)
            logger.warning("fee 동결 실패 order=%s", order.id, exc_info=True)

    async def _resale_ticket_unsellable_reason(self, order: Order) -> str | None:
        """RESALE_BUY 주문의 대상 티켓이 아직 판매 가능(ACTIVE)한지 재검증 (M-2).

        매칭(listing MATCHED) 이후 결제 확정까지의 윈도우에서 원 주문 환불
        (CANCELLED)·현장 체크인(USED) 등으로 티켓 상태가 바뀔 수 있다 — 소유자
        검증만으로는 잡히지 않으므로(환불/체크인은 current_owner_id 불변) 상태를
        반드시 다시 확인한다.

        Returns:
            판매 불가 사유 문자열, 판매 가능하거나 재판매 주문이 아니면 None.
        """
        if order.order_type != OrderType.RESALE_BUY:
            return None

        resale_meta = (order.payment_metadata or {}).get("resale", {})
        ticket_id_str = resale_meta.get("ticket_id")
        if not ticket_id_str:
            return None

        # 비락(non-locking) 읽기 — 거부(자동 환불) 경로가 흔한 케이스이며,
        # 여기서 티켓 락을 잡으면 _refund_rejected_confirmation의 PG void HTTP
        # 호출을 가로질러 락이 유지되는 안티패턴이 된다. 성공 경로의 검증~소유권
        # 이전 사이 레이스(M-1: status!=ACTIVE면 환불 없이 ValueError)는
        # _apply_resale_ownership_transfer의 락 재독(with_for_update)에서 자동
        # 환불로 라우팅해 닫는다 (호출부 _apply_resale_transfer_or_reject).
        ticket_obj = (
            await self.session.execute(
                select(Ticket).where(Ticket.id == uuid.UUID(ticket_id_str))
            )
        ).scalar_one_or_none()
        if not ticket_obj:
            return "resale_ticket_missing"
        if ticket_obj.status != TicketStatus.ACTIVE:
            return f"resale_ticket_not_sellable(status={ticket_obj.status.value})"
        return None

    async def _apply_resale_transfer_or_reject(
        self, order: Order, *, payment_id: str, source: str
    ) -> None:
        """소유권 이전 — PG 청구 후 실패(레이스로 티켓 비ACTIVE, 소유자/금액 불일치)
        시 자동 PG 환불로 라우팅한다 (M-1). confirm 성공 경로의 락 재독에서
        발견되는 불일치를 '환불 없이 ValueError'로 흘리지 않기 위함.

        흔한 거부 케이스(_resale_ticket_unsellable_reason)는 이 경로에 오기 전에
        비락 검증으로 먼저 걸러지므로, 여기 도달하는 건 검증~이전 사이의 드문
        레이스뿐이다(티켓 락은 그 드문 경로에서만 void HTTP를 가로지른다).
        """
        try:
            await self._apply_resale_ownership_transfer(order)
        except ValueError as exc:
            refunded = await self._refund_rejected_confirmation(
                order,
                payment_id=payment_id,
                reason=f"resale_transfer_failed: {exc}"[:200],
                source=source,
            )
            raise PaymentConfirmationRejected(
                "Resale ownership transfer failed after payment; "
                + (
                    "the completed payment has been refunded automatically."
                    if refunded
                    else "automatic refund failed — flagged for manual refund."
                ),
                refunded=refunded,
            ) from exc

    async def _apply_resale_ownership_transfer(self, order: Order) -> None:
        """RESALE_BUY 주문 결제 확정 시 티켓 소유권 이전 처리.

        listing→SOLD 전이, 티켓 current_owner_id 이전·디바이스 바인딩 무효화,
        OwnershipTransfer 레코드 생성을 결제 확정과 같은 트랜잭션에서 수행한다.
        일반 confirm 경로와 원클릭(빌링키) 완료 경로 양쪽에서 호출된다 (M-3).
        order_type이 RESALE_BUY가 아니면 no-op.
        """
        if order.order_type != OrderType.RESALE_BUY:
            return

        resale_meta = (order.payment_metadata or {}).get("resale", {})
        listing_id = resale_meta.get("listing_id")
        ticket_id_str = resale_meta.get("ticket_id")
        seller_id_str = resale_meta.get("seller_id")
        expected_seller_id = uuid.UUID(seller_id_str) if seller_id_str else None

        if not (listing_id and ticket_id_str):
            return

        from app.models.resale import ResaleListingModel, ResaleListingStatus
        from app.models.ownership_transfer import OwnershipTransfer, TransferType

        # 1. listing → SOLD (authoritative fee source)
        listing_stmt = (
            select(ResaleListingModel)
            .where(ResaleListingModel.id == uuid.UUID(listing_id))
            .with_for_update()
        )
        listing = (await self.session.execute(listing_stmt)).scalar_one_or_none()
        if not listing:
            raise ValueError("Resale listing not found")
        # 심층 방어: CANCELLED/EXPIRED listing이 SOLD로 잘못 전이되지 않도록 상태 검증.
        # 정상 흐름(MATCHED→결제확정)에서는 ACTIVE/MATCHED여야 한다. 향후 관리자
        # 강제 전이 등으로 listing이 비활성인데 ticket은 ACTIVE인 경로가 생겨도
        # 여기서 차단된다 (위 _apply_resale_transfer_or_reject가 자동 환불로 라우팅).
        if listing.status not in (
            ResaleListingStatus.ACTIVE,
            ResaleListingStatus.MATCHED,
        ):
            raise ValueError(
                f"Resale listing is not in a sellable state (status={listing.status.value})"
            )
        if expected_seller_id and listing.seller_id != expected_seller_id:
            raise ValueError("Resale seller mismatch detected")
        # 금액 검증: 주문 총액이 리스팅 가격과 일치하는지 확인 (클라이언트 조작 방지)
        if abs(float(order.total_amount) - float(listing.asking_price)) > 0.01:
            raise ValueError(
                f"Order amount {order.total_amount} does not match listing price {listing.asking_price}"
            )
        listing.status = ResaleListingStatus.SOLD

        # 2. 티켓 소유권 이전
        ticket_stmt = (
            select(Ticket).where(Ticket.id == uuid.UUID(ticket_id_str)).with_for_update()
        )
        ticket_obj = (await self.session.execute(ticket_stmt)).scalar_one_or_none()
        if not ticket_obj:
            raise ValueError("Resale ticket not found")
        if expected_seller_id and ticket_obj.current_owner_id != expected_seller_id:
            raise ValueError("Ticket ownership changed before resale payment confirmation")
        # M-2: 환불(CANCELLED)·체크인(USED)된 티켓은 소유자가 그대로여도 판매 불가.
        # 결제 확정 경로들은 이 시점 이전에 _resale_ticket_unsellable_reason으로
        # 거부(+자동 환불)하므로 여기는 최후의 심층 방어선이다.
        if ticket_obj.status != TicketStatus.ACTIVE:
            raise ValueError(
                f"Resale ticket is not sellable (status={ticket_obj.status.value})"
            )

        old_owner = ticket_obj.current_owner_id
        ticket_obj.current_owner_id = order.user_id
        ticket_obj.transfer_count = (ticket_obj.transfer_count or 0) + 1
        # 이전 소유자의 디바이스 바인딩 무효화 — 새 소유자가 QR 최초 요청 시 자동 재생성
        ticket_obj.device_hash = None
        ticket_obj.totp_seed = None

        # 3. OwnershipTransfer 레코드 — 수수료는 listing(DB)에서 직접 읽어 조작 방지
        transfer = OwnershipTransfer(
            ticket_id=ticket_obj.id,
            from_user_id=old_owner,
            to_user_id=order.user_id,
            transfer_type=TransferType.RESALE,
            price=float(listing.asking_price),
            seller_amount=float(listing.seller_receives),
            platform_fee=float(listing.platform_fee),
            artist_royalty=float(listing.artist_royalty),
            status="completed",
        )
        self.session.add(transfer)

    async def _refund_rejected_confirmation(
        self,
        order: Order,
        *,
        payment_id: str,
        reason: str,
        source: str,
    ) -> bool:
        """PG paid 확인 후 확정을 거부할 때의 자동 PG 환불 (M-1).

        환불 성공 시 주문을 CANCELLED로 전이(티켓 취소·좌석/재고 원복)하고
        환불 사실을 주문 메타·감사로그·운영알림·사용자 알림에 기록한다.
        환불 실패 시 critical 알림 후 False를 반환한다 — 호출자는 웹훅 5xx 등
        PortOne 재시도가 환불을 재시도할 수 있는 경로를 보존해야 한다.
        """
        now = self._now()
        try:
            void_result = await self._void_order_payment(
                order,
                payment_id=payment_id,
                reason=f"auto_refund:{reason}"[:200],
            )
            refunded = bool(void_result.voided)
            refund_raw = void_result.raw
        except Exception as exc:  # noqa: BLE001 — PG 실패도 기록 후 호출자가 판단
            refunded = False
            refund_raw = {"error": f"{type(exc).__name__}: {exc}"}
            logger.exception(
                "Auto-refund PG call failed: order=%s payment_id=%s reason=%s",
                order.id, payment_id, reason,
            )

        # dict() 복사 필수: 같은 객체를 재할당하면 SQLAlchemy 변경 감지가 누락되어
        # 기존 metadata가 있는 주문(재판매 등)에서 환불 기록이 유실된다.
        meta = dict(order.payment_metadata) if isinstance(order.payment_metadata, dict) else {}
        meta["confirm_rejected_refund"] = {
            "reason": reason,
            "source": source,
            "payment_id": payment_id,
            "amount": float(order.total_amount),
            "refunded": refunded,
            "at": now.isoformat(),
            "gateway": mask_payment_payload(refund_raw),
        }
        order.payment_metadata = meta
        order.payment_failed_reason = f"confirm rejected: {reason}"[:300]

        if refunded:
            try:
                await self.cancel_order(order.id, target_status=OrderStatus.CANCELLED)
            except ValueError:
                # 전이 불가 상태(이미 터미널 등) — 환불 기록은 보존
                logger.warning(
                    "Order cancel after auto-refund failed: order=%s", order.id, exc_info=True
                )
            try:
                await self._send_payment_notification(order, "refund_complete")
            except Exception:
                logger.warning("자동 환불 알림 발송 실패: order=%s", order.id)

        await write_audit_log(
            self.session,
            actor_id=order.user_id,
            action="payment_confirm_rejected",
            resource_type="order",
            resource_id=str(order.id),
            event_id=order.event_id,
            tier_id=order.tier_id,
            new_value={
                "order_id": str(order.id),
                "payment_id": payment_id,
                "reason": reason,
                "source": source,
                "amount": float(order.total_amount),
                "pg_refunded": refunded,
                "result": "refunded" if refunded else "refund_failed",
            },
        )

        try:
            from app.core.alerting import send_ops_alert

            await send_ops_alert(
                "warning" if refunded else "critical",
                "결제 확정 거부 자동 환불" + ("" if refunded else " 실패 — 수동 환불 필요"),
                {
                    "order_id": str(order.id),
                    "payment_id": payment_id,
                    "reason": reason,
                    "source": source,
                    "amount": f"{float(order.total_amount):,.0f}",
                    "refunded": refunded,
                },
                mention=not refunded,
                alert_key=f"confirm_reject_refund:{order.id}",
            )
        except Exception:
            logger.debug("Failed to send auto-refund ops alert", exc_info=True)

        return refunded

    async def authorize_payment(
        self,
        order_id: uuid.UUID,
        *,
        pg_provider: str = "portone",
        pg_txn_id: str = "stub_txn",
        payment_id: str | None = None,
        amount: float | None = None,
        source: str = "client",
    ) -> OrderResponse:
        """Authorize payment without capture."""
        order = await self._get_order_for_update(order_id)

        if order.status in (OrderStatus.CANCELLED, OrderStatus.EXPIRED, OrderStatus.REFUNDED):
            raise ValueError(f"Cannot authorize payment for order in status '{order.status.value}'")

        if order.status == OrderStatus.AUTHORIZED:
            if order.pg_transaction_id == pg_txn_id:
                return self._to_response(order)
            raise ValueError("Order is already authorized with a different transaction")

        if order.status not in (OrderStatus.PENDING, OrderStatus.PAYMENT_REQUIRED):
            raise ValueError(f"Cannot authorize payment for order in status '{order.status.value}'")

        effective_payment_id = payment_id or order.payment_id
        if not effective_payment_id:
            effective_payment_id = self.gateway.generate_payment_id(order.id)

        if order.payment_id and payment_id and payment_id != order.payment_id:
            raise ValueError("Payment ID mismatch for this order")

        # Prevent pg_transaction_id reuse across different orders
        if pg_txn_id and pg_txn_id != "stub_txn":
            existing = await self.session.execute(
                select(Order).where(
                    Order.pg_transaction_id == pg_txn_id,
                    Order.id != order_id,
                )
            )
            if existing.scalar_one_or_none():
                raise ValueError("This payment transaction has already been used for another order")

        expected_amount = float(order.total_amount)
        if amount is not None and abs(float(amount) - expected_amount) > 0.000001:
            raise ValueError(f"Amount mismatch: expected {expected_amount}, got {amount}")

        verified = await self._gateway_for(order).verify_payment(
            payment_id=effective_payment_id,
            transaction_id=pg_txn_id,
            expected_amount=expected_amount,
            currency=order.payment_currency,
            expected_statuses={"ready", "authorized", "auth"},
        )

        # 🔴 T15: 사전승인(authorize) 경로에도 카드사 재검증을 건다.
        #    여기서 통과시키면 나중에 capture 로 확정될 때 이미 늦다 —
        #    "확정 직전 한 곳만 막으면 된다"는 가정이 틀렸다(자체검수 지적).
        await self._enforce_card_discount_issuer(order, verified)

        now = self._now()
        validate_order_transition(order.status, OrderStatus.AUTHORIZED)
        order.status = OrderStatus.AUTHORIZED
        order.pg_provider = verified.provider
        order.payment_id = verified.payment_id
        order.pg_transaction_id = verified.transaction_id
        order.authorized_at = now
        order.payment_failed_at = None
        order.payment_failed_reason = None
        meta = order.payment_metadata if isinstance(order.payment_metadata, dict) else {}
        meta["authorization"] = mask_payment_payload(verified.raw)
        meta["authorization_source"] = source
        order.payment_metadata = meta

        await write_audit_log(
            self.session,
            actor_id=order.user_id,
            action="payment_authorized",
            resource_type="order",
            resource_id=str(order.id),
            event_id=order.event_id,
            tier_id=order.tier_id,
            new_value={
                "order_id": str(order.id),
                "payment_id": order.payment_id,
                "pg_provider": order.pg_provider,
                "pg_txn_id": order.pg_transaction_id,
                "amount": order.total_amount,
                "source": source,
                "result": "success",
            },
        )

        return self._to_response(order)

    async def capture_payment(
        self,
        order_id: uuid.UUID,
        *,
        source: str = "manual_api",
    ) -> OrderResponse:
        """Capture an already authorized payment."""
        order = await self._get_order_for_update(order_id)

        if order.status == OrderStatus.CONFIRMED and order.captured_at:
            return self._to_response(order)

        if order.status != OrderStatus.AUTHORIZED:
            raise ValueError(f"Cannot capture payment for order in status '{order.status.value}'")
        if not order.payment_id:
            raise ValueError("Missing payment_id for capture")

        captured = await self._gateway_for(order).capture_payment(
            payment_id=order.payment_id,
            amount=order.total_amount,
        )

        validate_order_transition(order.status, OrderStatus.CONFIRMED)
        order.status = OrderStatus.CONFIRMED
        order.captured_at = captured.captured_at
        order.pg_approved_at = order.pg_approved_at or captured.captured_at
        meta = order.payment_metadata if isinstance(order.payment_metadata, dict) else {}
        meta["capture"] = mask_payment_payload(captured.raw)
        meta["capture_source"] = source
        order.payment_metadata = meta

        await self.session.execute(
            update(Ticket)
            .where(Ticket.purchase_order_id == order_id, Ticket.status == TicketStatus.PENDING)
            .values(status=TicketStatus.ACTIVE)
        )

        await write_audit_log(
            self.session,
            actor_id=order.user_id,
            action="payment_captured",
            resource_type="order",
            resource_id=str(order.id),
            event_id=order.event_id,
            tier_id=order.tier_id,
            new_value={
                "order_id": str(order.id),
                "payment_id": order.payment_id,
                "capture_txn_id": captured.transaction_id,
                "amount": captured.amount,
                "source": source,
                "result": "success",
            },
        )

        try:
            PAYMENT_TOTAL.labels(status="captured", provider=order.pg_provider or "unknown").inc()
        except Exception:
            logger.debug("Failed to record PAYMENT_TOTAL captured metric")

        # v2→go 전파 hint (webhook 경로는 handle_portone_webhook이 직접 append)
        if source != "webhook":
            self.propagations.append(
                _build_payment_confirmed_hint(
                    order,
                    SimpleNamespace(
                        payment_id=order.payment_id,
                        amount=order.total_amount,
                        method=order.pg_provider or "unknown",
                    ),
                )
            )

        return self._to_response(order)

    async def void_payment(
        self,
        order_id: uuid.UUID,
        *,
        reason: str,
        source: str = "manual_api",
    ) -> OrderResponse:
        """Void an authorized payment and cancel the order.

        Lock ordering: SeatTier first, then Order — consistent with cancel_order.
        """
        # Peek at the order without locking to get tier_id for lock ordering
        order_peek = await self.order_repo.get(order_id)
        if not order_peek:
            raise ValueError(f"Order {order_id} not found")

        # Lock SeatTier FIRST (consistent ordering to prevent deadlocks)
        if order_peek.tier_id:
            await self.tier_repo.get_for_update(order_peek.tier_id)

        # Then lock the Order
        order = await self._get_order_for_update(order_id)

        if order.status != OrderStatus.AUTHORIZED:
            raise ValueError(f"Cannot void payment for order in status '{order.status.value}'")
        if not order.payment_id:
            raise ValueError("Missing payment_id for void")

        voided = await self._void_order_payment(
            order,
            payment_id=order.payment_id,
            reason=reason,
        )
        if not voided.voided:
            raise ValueError("Failed to void payment authorization")

        meta = order.payment_metadata if isinstance(order.payment_metadata, dict) else {}
        meta["void"] = mask_payment_payload(voided.raw)
        meta["void_source"] = source
        meta["void_reason"] = reason
        order.payment_metadata = meta
        order.payment_failed_reason = reason

        await self.cancel_order(order_id, target_status=OrderStatus.CANCELLED)

        await write_audit_log(
            self.session,
            actor_id=order.user_id,
            action="payment_voided",
            resource_type="order",
            resource_id=str(order.id),
            event_id=order.event_id,
            tier_id=order.tier_id,
            new_value={
                "order_id": str(order.id),
                "payment_id": order.payment_id,
                "reason": reason,
                "source": source,
                "result": "success",
            },
        )

        return self._to_response(order)

    async def cancel_order(
        self,
        order_id: uuid.UUID,
        target_status: OrderStatus = OrderStatus.CANCELLED,
    ) -> None:
        """Cancel an order, release seats, and rollback sold count.

        Lock ordering: SeatTier first, then Order — consistent everywhere
        to prevent deadlocks when void_payment -> cancel_order chains.
        """
        # Peek at the order without locking to get tier_id for lock ordering
        order_peek = await self.order_repo.get(order_id)
        if not order_peek:
            raise ValueError(f"Order {order_id} not found")

        # Lock SeatTier FIRST (consistent ordering to prevent deadlocks)
        if order_peek.tier_id:
            await self.tier_repo.get_for_update(order_peek.tier_id)

        # Then lock the Order
        order = await self._get_order_for_update(order_id)

        validate_order_transition(order.status, target_status)

        # Collect seat_ids before batch-cancelling tickets
        seat_result = await self.session.execute(
            select(Ticket.seat_id).where(
                Ticket.purchase_order_id == order_id, Ticket.seat_id.isnot(None)
            )
        )
        seat_ids_to_release = [row[0] for row in seat_result.all()]

        # Batch cancel all tickets in one UPDATE
        await self.session.execute(
            update(Ticket)
            .where(Ticket.purchase_order_id == order_id)
            .values(status=TicketStatus.CANCELLED)
        )

        if seat_ids_to_release:
            from app.repositories.seat_repo import SeatRepository

            seat_repo = SeatRepository(self.session)
            await seat_repo.release_holds(seat_ids_to_release)

        if order.tier_id:
            import os

            from app.services import inventory_service

            # sold_count: PostgreSQL 은 trg_sync_sold_count 트리거가 ticket→cancelled 시 자동 -1.
            # 명시 decrement_sold 동시 호출 시 이중감소 → SQLite(test, 트리거 없음)에서만 수동 감소.
            if os.environ.get("PYTEST_CURRENT_TEST"):
                await self.tier_repo.decrement_sold(order.tier_id, order.quantity)
            await inventory_service.release(order.tier_id, order.quantity)

        order.status = target_status
        order.payment_failed_at = self._now()
        if target_status in (OrderStatus.CANCELLED, OrderStatus.EXPIRED):
            order.payment_failed_reason = (
                order.payment_failed_reason or f"Order moved to {target_status.value}"
            )

        # 결제 실패 기록 (사기 탐지 패턴 추적)
        try:
            await record_payment_failure(order.user_id)
        except Exception:
            logger.warning("fraud pattern recording failed", exc_info=True)

        action_map = {
            OrderStatus.CANCELLED: "order_cancelled",
            OrderStatus.EXPIRED: "order_expired",
            OrderStatus.REFUNDED: "order_refunded",
        }
        await write_audit_log(
            self.session,
            actor_id=order.user_id,
            action=action_map.get(target_status, "order_cancelled"),
            resource_type="order",
            resource_id=str(order_id),
            event_id=order.event_id,
            tier_id=order.tier_id,
            new_value={
                "order_id": str(order_id),
                "quantity": order.quantity,
                "total_amount": order.total_amount,
                "tickets_cancelled": order.quantity,
                "seats_released": len(seat_ids_to_release),
                "result": "success",
            },
        )

        try:
            PAYMENT_TOTAL.labels(
                status=target_status.value,
                provider=order.pg_provider or "unknown",
            ).inc()
        except Exception:
            logger.debug("Failed to record PAYMENT_TOTAL %s metric", target_status.value)

    async def process_expired_orders(self) -> int:
        """Cancel expired, unpaid orders."""
        now = self._now()
        expired_orders = await self.order_repo.get_pending_expired(now)

        cancelled_count = 0
        for order in expired_orders:
            try:
                await self.cancel_order(order.id, target_status=OrderStatus.EXPIRED)
                cancelled_count += 1
            except ValueError:
                logger.warning("order expiration failed for order %s", order.id, exc_info=True)
                continue

        await self.session.flush()
        return cancelled_count

    async def initiate_refund(
        self,
        order_id: uuid.UUID,
        *,
        reason: str,
        amount: float | None = None,
    ) -> dict:
        """Initiate full or partial refund."""
        order = await self._get_order_for_update(order_id)
        if order.status == OrderStatus.REFUNDED:
            raise ValueError("이미 환불된 주문입니다")
        if order.status not in (OrderStatus.CONFIRMED, OrderStatus.PAID):
            raise ValueError(f"Cannot refund order in status '{order.status.value}'")

        # 체크인 완료된 티켓이 있으면 환불 차단
        tickets_result = await self.session.execute(
            select(Ticket).where(Ticket.purchase_order_id == order_id)
        )
        used_tickets = [
            t for t in tickets_result.scalars().all()
            if t.status == TicketStatus.USED
        ]
        if used_tickets:
            raise ValueError(
                f"Cannot refund: {len(used_tickets)} ticket(s) already checked in"
            )

        refund_amount = Decimal(str(order.total_amount)) if amount is None else Decimal(str(amount))
        if not refund_amount.is_finite():
            raise ValueError("Refund amount must be a finite number")
        stored_reason = reason[:300]
        if refund_amount <= 0:
            raise ValueError("Refund amount must be greater than 0")
        # 누적 환불 상한 검증 (order는 FOR UPDATE로 잠김 — 동시 환불 레이스컨디션 방지)
        max_refundable = Decimal(str(order.total_amount)) - Decimal(str(order.total_refunded))
        if refund_amount > max_refundable + Decimal("0.01"):
            raise ValueError(
                f"Refund amount {refund_amount} exceeds refundable balance {max_refundable:.2f}"
            )

        is_partial = abs(refund_amount - Decimal(str(order.total_amount))) > Decimal("0.000001")
        refunded_at = self._now()
        metadata = dict(order.payment_metadata) if isinstance(order.payment_metadata, dict) else {}

        if is_partial:
            if not order.payment_id:
                raise ValueError("Missing payment_id for refund")
            try:
                refund_result = await self._void_order_payment(
                    order,
                    payment_id=order.payment_id,
                    reason=reason,
                    amount=int(refund_amount),
                )
                if not refund_result.voided:
                    raise HTTPException(
                        status_code=502,
                        detail="Payment gateway failed to process refund",
                    )
            except HTTPException:
                raise
            except Exception as exc:
                logger.exception("Payment gateway partial refund failed for order %s", order_id)
                try:
                    from app.core.alerting import send_ops_alert
                    await send_ops_alert("critical", "PG 부분 환불 실패", {
                        "order_id": str(order_id),
                        "amount": float(refund_amount),
                        "error": str(exc),
                    }, mention=True)
                except Exception:
                    logger.debug("Failed to send PG refund failure ops alert", exc_info=True)
                raise HTTPException(
                    status_code=502,
                    detail=f"Payment gateway refund failed: {exc}",
                ) from exc
            metadata["partial_refund"] = {
                "amount": float(refund_amount),
                "reason": reason,
                "at": refunded_at.isoformat(),
                "gateway": refund_result.raw,
            }
            order.payment_metadata = metadata
            order.payment_failed_reason = stored_reason
            order.payment_failed_at = refunded_at
            # AUDIT 2026-04-20 §25 P0: DB-level atomic increment to avoid
            # clobbering concurrent partial refunds. The previous form
            # (``order.total_refunded = Order.total_refunded + refund_amount``)
            # stringifies the column expression on flush instead of issuing a
            # true SQL-side increment. Mirrors refund_service.py:420-423.
            await self.session.execute(
                update(Order)
                .where(Order.id == order.id)
                .values(total_refunded=Order.total_refunded + refund_amount)
            )
            await self.session.refresh(order, ["total_refunded"])
        else:
            if not order.payment_id:
                raise ValueError("Missing payment_id for refund")
            try:
                refund_result = await self._void_order_payment(
                    order,
                    payment_id=order.payment_id,
                    reason=reason,
                )
                if not refund_result.voided:
                    raise HTTPException(
                        status_code=502,
                        detail="Payment gateway failed to process refund",
                    )
                metadata["full_refund"] = {
                    "amount": float(refund_amount),
                    "reason": reason,
                    "at": refunded_at.isoformat(),
                    "gateway": refund_result.raw,
                }
                order.payment_metadata = metadata
                order.payment_failed_reason = stored_reason
            except HTTPException:
                raise
            except Exception as exc:
                logger.exception("Payment gateway refund failed for order %s", order_id)
                # PG 환불 실패 시 운영 알림
                try:
                    from app.core.alerting import send_ops_alert
                    await send_ops_alert("critical", "PG 환불 실패", {
                        "order_id": str(order_id),
                        "amount": refund_amount,
                        "error": str(exc),
                    }, mention=True)
                except Exception:
                    logger.debug("Failed to send PG refund failure ops alert", exc_info=True)
                raise HTTPException(
                    status_code=502,
                    detail=f"Payment gateway refund failed: {exc}",
                ) from exc

            await self.cancel_order(order_id, target_status=OrderStatus.REFUNDED)
            refunded_at = order.payment_failed_at or refunded_at

        # 환불 완료 알림 발송
        try:
            await self._send_payment_notification(order, "refund_complete")
        except Exception:
            logger.warning("환불 완료 알림 발송 실패: order=%s", order.id)

        await write_audit_log(
            self.session,
            actor_id=order.user_id,
            action="refund_initiated",
            resource_type="order",
            resource_id=str(order.id),
            event_id=order.event_id,
            tier_id=order.tier_id,
            new_value={
                "order_id": str(order.id),
                "amount": float(refund_amount),
                "original_amount": float(order.total_amount),
                "reason": reason,
                "is_partial": is_partial,
                "result": "success",
            },
        )

        return {
            "order_id": order.id,
            "status": order.status.value,
            "refund_amount": float(refund_amount),
            "original_amount": float(order.total_amount),
            "reason": reason,
            "refunded_at": refunded_at,
        }

    async def _send_payment_notification(self, order: Order, notification_type: str) -> None:
        """결제/환불 완료 알림 발송 헬퍼.

        상세통합 S2b(§7.3): 게스트 주문(user_id 없음)은 in-app 통지함이 없으므로
        `NotificationModel.guest_id` 로 원장을 남기고, 실제 전달은 buyer_email(스냅샷)로의
        직전송이다. 회원은 종전대로 user_id 통지함에 기록.
        """
        from app.models.notification import NotificationModel

        messages = {
            "payment_complete": f"결제가 완료되었습니다. (주문번호: {str(order.id)[:8]})",
            "refund_complete": f"환불이 완료되었습니다. (주문번호: {str(order.id)[:8]})",
        }
        message = messages.get(notification_type, f"주문 상태 업데이트: {notification_type}")

        is_guest = order.user_id is None
        data = {
            "order_id": str(order.id),
            "event_id": str(order.event_id),
            "amount": float(order.total_amount),
        }
        if is_guest:
            # 게스트 이메일 직전송 대상(발송 어댑터가 이 원장을 픽업). buyer_email 은 주문시점 스냅샷.
            data["channel"] = "email"
            data["to_email"] = order.buyer_email

        notification = NotificationModel(
            user_id=order.user_id,
            guest_id=order.guest_id if is_guest else None,
            type=notification_type,
            message=message,
            data=data,
        )
        self.session.add(notification)
        await self.session.flush()

    async def process_one_click_payment(
        self,
        user_id: uuid.UUID,
        order_id: uuid.UUID,
        billing_key_id: uuid.UUID,
        *,
        idempotency_key: str | None = None,
    ) -> OrderResponse:
        """Charge a saved card (one-click payment) and confirm the order.

        M-2 이중 청구 방어 — 2단계 결제 흐름:
          ① 트랜잭션 1: 결정론적 payment_id(order_id + DB 영속 attempt 카운터)와
             청구 시도(PaymentAttempt, INITIATED) 레코드를 커밋. order.payment_id도
             이 시점에 영속화되어, 이후 크래시가 나도 웹훅이 주문을 찾아 복구 가능.
          ② PG 청구 호출 — DB 트랜잭션 *밖*에서 실행.
          ③ 트랜잭션 2: 결과 반영(CONFIRMED 전이, 티켓 활성화, fee 동결,
             재판매 소유권 이전, attempt SUCCEEDED).

        NOTE: 이 메서드는 트랜잭션 1을 스스로 커밋한다. 호출자는 리턴 후
        트랜잭션 2를 커밋해야 한다 (기존 billing.py 패턴 유지).
        """
        from app.models.billing_key import BillingKey
        from app.models.payment_attempt import PaymentAttempt, PaymentAttemptStatus
        from app.core.config import settings as _settings
        from cryptography.fernet import Fernet, InvalidToken

        # ── 트랜잭션 1: 검증 + 청구 시도 레코드 영속화 ──────────────────
        order = await self._get_order_for_update(order_id)

        if order.user_id != user_id:
            raise ValueError("Order does not belong to user")

        # 멱등 재요청(DB 폴백): Redis 캐시가 만료/유실돼도 같은 키의 재요청은
        # 이미 확정된 주문을 그대로 반환한다 — 절대 재청구하지 않음.
        if order.status in (OrderStatus.CONFIRMED, OrderStatus.PAID):
            if idempotency_key and order.payment_idempotency_key == idempotency_key:
                return self._to_response(order)
            raise ValueError(
                f"Cannot process one-click payment for order in status '{order.status.value}'"
            )

        if order.status not in (OrderStatus.PENDING, OrderStatus.PAYMENT_REQUIRED):
            raise ValueError(f"Cannot process one-click payment for order in status '{order.status.value}'")

        # 결제 마감 시간 초과 검증 (confirm 경로와 동일)
        now = self._now()
        if order.payment_deadline:
            deadline = order.payment_deadline
            if deadline.tzinfo is None:
                deadline = deadline.replace(tzinfo=timezone.utc)
            if deadline < now:
                raise ValueError("Payment deadline has expired. Please create a new order.")

        # ── 재판매 티켓 상태 재검증 (M-2) — PG 청구 *전*이므로 환불 없이 거부.
        # 환불(CANCELLED)·체크인(USED)된 티켓의 재판매 주문은 청구 자체를 차단한다.
        resale_reject_reason = await self._resale_ticket_unsellable_reason(order)
        if resale_reject_reason:
            raise ValueError(
                "재판매 티켓이 더 이상 판매 가능한 상태가 아닙니다 "
                f"(환불·사용·양도된 티켓). [{resale_reject_reason}]"
            )

        # Fetch billing key
        bk_result = await self.session.execute(
            select(BillingKey).where(
                BillingKey.id == billing_key_id,
                BillingKey.user_id == user_id,
                BillingKey.deactivated_at.is_(None),
            )
        )
        bk = bk_result.scalar_one_or_none()
        if not bk:
            raise ValueError("Saved card not found or deactivated")
        bk_last_four = bk.last_four
        bk_card_brand = bk.card_brand

        # Decrypt billing key (M-1)
        # 과거 '키 미설정 평문 폴백' 시절 저장된 행은 Fernet 토큰이 아니므로
        # (Fernet 토큰은 항상 버전 바이트 0x80 → base64 "gAAAA" prefix)
        # 평문 그대로 사용하되, 같은 트랜잭션(트랜잭션 1 커밋)에서 lazy re-encrypt.
        # 반대로 Fernet 토큰 형태인데 복호화가 실패하면 키 불일치/손상이므로
        # 절대 평문으로 간주하지 않고 에러를 전파한다 (잘못된 토큰으로 PG 청구 방지).
        # 키 로테이션 폴백 (core/pii.py decrypt_pii_text 패턴 일치):
        #   - 암호화는 항상 현재 키.
        #   - 복호화는 현재 키 실패 시 PREVIOUS 키(들)로 재시도하고,
        #     성공하면 현재 키로 lazy re-encrypt → 점진적 무중단 로테이션.
        #   pii.py는 MultiFernet이 아닌 단일 PREVIOUS 키 폴백을 쓰므로 동일 방식 채택.
        raw_billing_key = bk.billing_key
        if _settings.BILLING_KEY_ENCRYPTION_KEY:
            fernet = Fernet(_settings.BILLING_KEY_ENCRYPTION_KEY.encode())
            if raw_billing_key.startswith(_FERNET_TOKEN_PREFIX):
                try:
                    raw_billing_key = fernet.decrypt(raw_billing_key.encode()).decode()
                except InvalidToken:
                    # 현재 키로 복호화 실패 → 이전 키(PREVIOUS)로 폴백 시도.
                    prev_key = _settings.BILLING_KEY_ENCRYPTION_KEY_PREVIOUS.strip()
                    decrypted: str | None = None
                    if prev_key:
                        prev_fernet = Fernet(prev_key.encode())
                        try:
                            decrypted = prev_fernet.decrypt(raw_billing_key.encode()).decode()
                        except InvalidToken:
                            decrypted = None
                    if decrypted is None:
                        logger.error(
                            "Billing key decryption failed with current and previous keys "
                            "(key mismatch or corrupt token) billing_key_id=%s user=%s — "
                            "check BILLING_KEY_ENCRYPTION_KEY rotation",
                            billing_key_id, user_id,
                        )
                        raise
                    # 이전 키로 복호화 성공 → 현재 키로 lazy re-encrypt.
                    logger.warning(
                        "Billing key decrypted with previous key billing_key_id=%s — "
                        "re-encrypting with current key",
                        billing_key_id,
                    )
                    raw_billing_key = decrypted
                    bk.billing_key = fernet.encrypt(raw_billing_key.encode()).decode()
            else:
                logger.warning(
                    "Legacy plaintext billing key detected billing_key_id=%s — lazy re-encrypting",
                    billing_key_id,
                )
                bk.billing_key = fernet.encrypt(raw_billing_key.encode()).decode()

        # 청구 시도 결정: 마지막 시도가 INITIATED(결과 미확정 — 타임아웃/크래시)면
        # 같은 payment_id를 재사용해 PortOne측 멱등성으로 이중 청구를 차단.
        # FAILED(확정 거부)였을 때만 카운터를 올려 새 payment_id로 진행.
        last_attempt_result = await self.session.execute(
            select(PaymentAttempt)
            .where(PaymentAttempt.order_id == order_id)
            .order_by(PaymentAttempt.attempt_no.desc())
            .limit(1)
        )
        last_attempt = last_attempt_result.scalar_one_or_none()
        # INITIATED attempt 재사용은 *같은 카드*일 때만 안전하다. PortOne 멱등성은
        # payment_id 기준이라, 첫 시도가 PG에서 실제 성공했다면 같은 payment_id로는
        # 그 청구가 반환/유지된다. 사용자가 다른 카드(billing_key_id 변경)로 재시도하면
        # 멱등 재사용은 의도한 카드가 아닌 첫 카드 청구를 굳혀버린다 → 카드가 바뀌면
        # 재사용하지 않고 새 attempt(새 payment_id, attempt_no 증가)를 만든다.
        if (
            last_attempt
            and last_attempt.status == PaymentAttemptStatus.INITIATED
            and last_attempt.billing_key_id == billing_key_id
        ):
            attempt = last_attempt
        else:
            attempt_no = (last_attempt.attempt_no + 1) if last_attempt else 1
            attempt = PaymentAttempt(
                order_id=order_id,
                attempt_no=attempt_no,
                payment_id=self.gateway.generate_payment_id(order_id, attempt=attempt_no),
                idempotency_key=idempotency_key,
                method="billing_key",
                billing_key_id=billing_key_id,
                amount=order.total_amount,
                currency=order.payment_currency,
                status=PaymentAttemptStatus.INITIATED,
            )
            self.session.add(attempt)
            await self.session.flush()  # attempt.id(uuid 기본값) 확정

        payment_id = attempt.payment_id
        attempt_id = attempt.id

        # 크래시 복구의 핵심: PG 호출 *전에* payment_id를 주문에 영속화.
        # 청구 후 서버가 죽어도 PortOne 웹훅이 payment_id로 주문을 찾아 확정한다.
        order.payment_id = payment_id
        order.pg_provider = self.gateway.provider_name
        order.payment_started_at = order.payment_started_at or now
        if idempotency_key and not order.payment_idempotency_key:
            order.payment_idempotency_key = idempotency_key

        await self.session.commit()  # ── 트랜잭션 1 커밋 ──

        # ── PG 청구 (트랜잭션 밖) ──────────────────────────────────────
        try:
            result = await self.gateway.pay_with_billing_key(
                billing_key=raw_billing_key,
                amount=order.total_amount,
                order_name=f"Order {order.id}",
                payment_id=payment_id,
                currency=order.payment_currency,
                customer_id=str(user_id),
            )
        except Exception as exc:
            await self.session.rollback()
            # HTTP 4xx/검증 오류 = PG가 확정적으로 거부 → FAILED (다음 시도는 새 payment_id).
            # 타임아웃/네트워크 오류 = 결과 미확정 → INITIATED 유지
            # (재시도 시 같은 payment_id 재사용, 웹훅/대사로 실제 결과 수렴).
            import httpx as _httpx

            definitive_failure = isinstance(exc, (_httpx.HTTPStatusError, ValueError, PermissionError))
            await self._record_payment_attempt_outcome(
                attempt_id,
                status=PaymentAttemptStatus.FAILED if definitive_failure else None,
                error_message=f"{type(exc).__name__}: {exc}",
            )
            raise

        # ── 트랜잭션 2: 결과 반영 ──────────────────────────────────────
        # confirm_payment과 같은 분산 락으로 웹훅 confirm과 직렬화.
        from app.core.redis import redis_lock

        try:
            async with redis_lock(f"v2:payment:confirm:{{{order_id}}}", ttl=10):
                return await self._finalize_one_click_payment(
                    order_id,
                    user_id=user_id,
                    billing_key_id=billing_key_id,
                    bk_last_four=bk_last_four,
                    bk_card_brand=bk_card_brand,
                    attempt_id=attempt_id,
                    result=result,
                )
        except (RuntimeError, OSError, ConnectionError) as lock_exc:
            # Redis 락 불가 → DB lock만으로 진행 (confirm_payment과 동일 폴백)
            logger.warning(
                "Redis lock unavailable for one-click finalize (order=%s): %s",
                order_id, lock_exc,
            )
            return await self._finalize_one_click_payment(
                order_id,
                user_id=user_id,
                billing_key_id=billing_key_id,
                bk_last_four=bk_last_four,
                bk_card_brand=bk_card_brand,
                attempt_id=attempt_id,
                result=result,
            )

    async def _finalize_one_click_payment(
        self,
        order_id: uuid.UUID,
        *,
        user_id: uuid.UUID,
        billing_key_id: uuid.UUID,
        bk_last_four: str,
        bk_card_brand: str,
        attempt_id: uuid.UUID,
        result,
    ) -> OrderResponse:
        """원클릭 결제 트랜잭션 2 — PG 청구 성공 결과를 DB에 반영.

        돈은 이미 움직였으므로, 여기서 어떤 예외가 나든 '청구 성공' 사실만은
        별도 트랜잭션으로 영속화한 뒤 예외를 전파한다 (웹훅/대사 복구 경로 보존).
        """
        from app.models.payment_attempt import PaymentAttempt, PaymentAttemptStatus

        try:
            order = await self._get_order_for_update(order_id)
            if not order:
                raise ValueError(f"Order {order_id} not found")

            # 웹훅이 먼저 확정한 경우 — 멱등 처리 (이미 같은 payment_id로 CONFIRMED)
            if order.status in (OrderStatus.CONFIRMED, OrderStatus.PAID):
                attempt_row = await self.session.get(PaymentAttempt, attempt_id)
                if attempt_row and attempt_row.status != PaymentAttemptStatus.SUCCEEDED:
                    attempt_row.status = PaymentAttemptStatus.SUCCEEDED
                    attempt_row.pg_transaction_id = result.transaction_id
                return self._to_response(order)

            now = self._now()
            validate_order_transition(order.status, OrderStatus.CONFIRMED)
            order.status = OrderStatus.CONFIRMED
            order.pg_provider = result.provider
            order.payment_id = result.payment_id
            order.pg_transaction_id = result.transaction_id
            order.pg_approved_at = now
            order.captured_at = now
            order.payment_started_at = order.payment_started_at or now
            order.payment_failed_at = None
            order.payment_failed_reason = None
            # dict() 복사: 동일 객체 재할당은 변경 감지가 누락됨 (재판매 주문은 항상 metadata 보유)
            meta = dict(order.payment_metadata) if isinstance(order.payment_metadata, dict) else {}
            meta["one_click"] = {
                "billing_key_id": str(billing_key_id),
                "card_last_four": bk_last_four,
                "card_brand": bk_card_brand,
                "verification": result.raw,
            }
            order.payment_metadata = meta
            # 원클릭(빌링키)은 카드 기반 결제 → payment_method=card (dev_v3 계약 (5)).
            order.payment_method = "card"

            # Activate pending tickets (batch UPDATE)
            await self.session.execute(
                update(Ticket)
                .where(Ticket.purchase_order_id == order_id, Ticket.status == TicketStatus.PENDING)
                .values(status=TicketStatus.ACTIVE)
            )

            # fee 동결 — confirm 경로와 동일 (미동결 시 정산 platform_fee=0 오귀속)
            await self._freeze_order_fees(order)

            # RESALE_BUY: 티켓 소유권 이전·리스팅 SOLD 전이 — confirm 경로와 동일 (M-3)
            await self._apply_resale_ownership_transfer(order)

            # 청구 시도 SUCCEEDED — 결제 확정과 같은 트랜잭션에서 마감
            attempt_row = await self.session.get(PaymentAttempt, attempt_id)
            if attempt_row:
                attempt_row.status = PaymentAttemptStatus.SUCCEEDED
                attempt_row.pg_transaction_id = result.transaction_id

            await write_audit_log(
                self.session,
                actor_id=user_id,
                action="payment_one_click",
                resource_type="order",
                resource_id=str(order.id),
                event_id=order.event_id,
                tier_id=order.tier_id,
                new_value={
                    "order_id": str(order.id),
                    "payment_id": result.payment_id,
                    "billing_key_id": str(billing_key_id),
                    "card_last_four": bk_last_four,
                    "amount": order.total_amount,
                    "result": "success",
                },
            )
        except Exception as exc:
            # 돈은 이미 빠졌다 — 확정 실패 사실과 무관하게 '청구 성공'을 영속화.
            # order.payment_id는 트랜잭션 1에서 커밋되어 있으므로 PortOne 웹훅
            # (Transaction.Paid)이 주문을 찾아 confirm_payment로 복구한다.
            await self.session.rollback()
            await self._record_payment_attempt_outcome(
                attempt_id,
                status=PaymentAttemptStatus.SUCCEEDED,
                pg_transaction_id=result.transaction_id,
                error_message=f"finalize failed: {type(exc).__name__}: {str(exc)[:300]}",
            )
            logger.error(
                "One-click finalize failed AFTER successful PG charge — "
                "order=%s payment_id=%s txn=%s (웹훅/대사 복구 대기)",
                order_id, result.payment_id, result.transaction_id, exc_info=True,
            )
            raise

        # 결제 완료 알림
        try:
            await self._send_payment_notification(order, "payment_complete")
        except Exception:
            logger.warning("원클릭 결제 완료 알림 발송 실패: order=%s", order.id)

        try:
            PAYMENT_TOTAL.labels(status="confirmed", provider=result.provider).inc()
        except Exception:
            logger.debug("Failed to record one-click payment metric")

        # v2→go 전파 hint
        self.propagations.append(
            _build_payment_confirmed_hint(
                order,
                SimpleNamespace(
                    payment_id=result.payment_id,
                    amount=order.total_amount,
                    method=result.provider,
                ),
            )
        )

        return self._to_response(order)

    async def _record_payment_attempt_outcome(
        self,
        attempt_id: uuid.UUID,
        *,
        status=None,
        pg_transaction_id: str | None = None,
        error_message: str | None = None,
    ) -> None:
        """청구 시도 결과를 독립 트랜잭션으로 기록 (best-effort).

        메인 트랜잭션이 롤백된 직후 호출되는 복구 기록 경로이므로,
        여기서의 실패가 호출자 예외를 가리면 안 된다.
        """
        from app.models.payment_attempt import PaymentAttempt

        try:
            attempt = await self.session.get(PaymentAttempt, attempt_id)
            if not attempt:
                return
            if status is not None:
                attempt.status = status
            if pg_transaction_id is not None:
                attempt.pg_transaction_id = pg_transaction_id
            if error_message is not None:
                attempt.error_message = error_message[:500]
            await self.session.commit()
        except Exception:
            logger.error(
                "Failed to record payment attempt outcome attempt=%s", attempt_id, exc_info=True
            )
            try:
                await self.session.rollback()
            except Exception:
                pass

    async def _handle_late_paid_terminal_webhook(self, order: Order, event) -> None:
        """터미널(EXPIRED/CANCELLED) 주문에 도착한 paid 웹훅 처리 (M-1).

        돈은 PG에서 빠졌는데 주문은 이미 소멸된 상태 — 자동 PG 환불 +
        critical 알림 + 메타 기록. 환불 실패 시 ValueError를 전파해
        웹훅이 5xx로 응답하고 PortOne 재시도가 환불을 재시도하게 한다.
        """
        payment_id = event.payment_id or order.payment_id
        meta = order.payment_metadata if isinstance(order.payment_metadata, dict) else {}

        # 이미 이 결제건이 자동 환불됐으면(마감초과 거부 등) 재환불 없이 ack —
        # 이미 취소된 PG 결제에 cancel을 다시 보내면 실패→무한 재시도가 된다.
        for prior_key in ("confirm_rejected_refund", "late_paid_refund"):
            prior = meta.get(prior_key)
            if (
                isinstance(prior, dict)
                and prior.get("refunded")
                and prior.get("payment_id") == payment_id
            ):
                logger.info(
                    "Late paid webhook for already-refunded order %s (%s) — ack",
                    order.id, prior_key,
                )
                return

        now = self._now()
        try:
            void_result = await self._void_order_payment(
                order,
                payment_id=payment_id,
                reason=f"auto_refund:late_paid_webhook_{order.status.value}"[:200],
            )
            refunded = bool(void_result.voided)
            refund_raw = void_result.raw
        except Exception as exc:  # noqa: BLE001 — 기록 후 5xx 전파
            refunded = False
            refund_raw = {"error": f"{type(exc).__name__}: {exc}"}
            logger.exception(
                "Late-paid-webhook auto refund failed: order=%s payment_id=%s",
                order.id, payment_id,
            )

        meta["late_paid_refund"] = {
            "payment_id": payment_id,
            "event_id": event.event_id,
            "event_type": event.event_type,
            "order_status": order.status.value,
            "amount": event.amount,
            "refunded": refunded,
            "at": now.isoformat(),
            "gateway": mask_payment_payload(refund_raw),
        }
        order.payment_metadata = meta

        await write_audit_log(
            self.session,
            actor_id=order.user_id,
            action="late_paid_webhook_refund",
            resource_type="order",
            resource_id=str(order.id),
            event_id=order.event_id,
            tier_id=order.tier_id,
            new_value={
                "order_id": str(order.id),
                "payment_id": payment_id,
                "order_status": order.status.value,
                "webhook_event_id": event.event_id,
                "amount": event.amount,
                "pg_refunded": refunded,
                "result": "refunded" if refunded else "refund_failed",
            },
        )

        try:
            from app.core.alerting import send_ops_alert

            await send_ops_alert(
                "critical",
                "터미널 주문에 늦은 paid 웹훅 — 자동 환불" + ("" if refunded else " 실패"),
                {
                    "order_id": str(order.id),
                    "order_status": order.status.value,
                    "payment_id": payment_id,
                    "amount": event.amount,
                    "refunded": refunded,
                },
                mention=True,
                alert_key=f"late_paid_webhook:{order.id}",
            )
        except Exception:
            logger.debug("Failed to send late-paid-webhook ops alert", exc_info=True)

        if not refunded:
            raise ValueError(
                f"Late paid webhook refund failed for terminal order {order.id}"
            )

        try:
            await self._send_payment_notification(order, "refund_complete")
        except Exception:
            logger.warning("늦은 웹훅 자동 환불 알림 발송 실패: order=%s", order.id)

        await self.session.flush()

    async def handle_portone_webhook(
        self,
        *,
        raw_body: bytes,
    ) -> list[dict] | None:
        """Handle PortOne webhook event with idempotency.

        Signature verification is done by the outer caller
        (``secure_portone_webhook_request``) using Standard Webhooks spec.

        Returns:
            List of propagation hints (for v2→go webhook task) or None.
            Each hint: {"event": <PropagateEvent>, "order_id": int, "data": dict}.
            The caller is responsible for enqueueing `propagate_order_event_to_go`
            **after** the DB commit — failures in propagation must not roll back
            the local state change.
        """

        try:
            payload = json.loads(raw_body.decode("utf-8"))
        except Exception as exc:  # noqa: BLE001
            raise ValueError("Invalid webhook payload JSON") from exc

        event = self.gateway.parse_webhook_event(payload)
        if not event.payment_id:
            return None

        order_result = await self.session.execute(
            select(Order).where(Order.payment_id == event.payment_id).with_for_update()
        )
        order = order_result.scalar_one_or_none()
        if not order:
            # 폴백: 청구 시도 원장(payment_attempts)으로 주문 식별.
            # 시도 N이 로컬에서 실패 처리된 후 order.payment_id가 시도 N+1로
            # 이동했는데, 실제로는 시도 N이 PG에서 성공해 웹훅이 도착하는
            # 케이스(고아 청구)를 복구한다 (M-2).
            from app.models.payment_attempt import PaymentAttempt

            attempt_result = await self.session.execute(
                select(PaymentAttempt).where(PaymentAttempt.payment_id == event.payment_id)
            )
            attempt = attempt_result.scalar_one_or_none()
            if not attempt:
                return None
            order_result = await self.session.execute(
                select(Order).where(Order.id == attempt.order_id).with_for_update()
            )
            order = order_result.scalar_one_or_none()
            if not order:
                return None
            if order.payment_id != event.payment_id:
                if event.status == "paid" and order.status in (
                    OrderStatus.PENDING,
                    OrderStatus.PAYMENT_REQUIRED,
                ):
                    # 실제 돈이 움직인 paymentId가 SSOT — 주문의 payment_id를 보정 후
                    # 아래 일반 confirm 플로우로 진행.
                    logger.warning(
                        "Webhook paid for attempt payment_id=%s but order=%s has payment_id=%s "
                        "— rebinding to charged attempt",
                        event.payment_id, order.id, order.payment_id,
                    )
                    order.payment_id = event.payment_id
                else:
                    # 이미 다른 payment_id로 확정된 주문 등 — 이중 청구 가능성.
                    # 웹훅은 ack(재시도 무의미)하고 운영 알림으로 사람이 판단.
                    logger.critical(
                        "Possible duplicate charge: webhook %s payment_id=%s but order=%s "
                        "status=%s payment_id=%s",
                        event.status, event.payment_id, order.id,
                        order.status.value, order.payment_id,
                    )
                    try:
                        from app.core.alerting import send_ops_alert
                        await send_ops_alert("critical", "원클릭 결제 이중 청구 의심", {
                            "order_id": str(order.id),
                            "webhook_payment_id": event.payment_id,
                            "order_payment_id": order.payment_id,
                            "order_status": order.status.value,
                            "webhook_status": event.status,
                        }, mention=True)
                    except Exception:
                        logger.debug("Failed to send duplicate-charge ops alert", exc_info=True)
                    meta = order.payment_metadata if isinstance(order.payment_metadata, dict) else {}
                    meta.setdefault("orphan_webhooks", []).append(
                        {"payment_id": event.payment_id, "status": event.status, "event_id": event.event_id}
                    )
                    order.payment_metadata = meta
                    await self.session.flush()
                    return None

        if order.payment_webhook_event_id == event.event_id:
            return None
        order.payment_webhook_event_id = event.event_id

        current_status = order.status
        propagations: list[dict] = []

        if event.status == "authorized":
            txn = event.transaction_id or f"auth_{event.event_id}"
            await self.authorize_payment(
                order.id,
                pg_provider=self.gateway.provider_name,
                pg_txn_id=txn,
                payment_id=event.payment_id,
                amount=event.amount,
                source="webhook",
            )
            return None

        if event.status == "paid":
            if current_status == OrderStatus.AUTHORIZED:
                await self.capture_payment(
                    order.id,
                    source="webhook",
                )
                propagations.append(_build_payment_confirmed_hint(order, event))
                return propagations

            if current_status in (OrderStatus.PENDING, OrderStatus.PAYMENT_REQUIRED):
                txn = event.transaction_id or f"webhook_{event.event_id}"
                try:
                    await self.confirm_payment(
                        order.id,
                        pg_provider=self.gateway.provider_name,
                        pg_txn_id=txn,
                        payment_id=event.payment_id,
                        amount=event.amount,
                        source="webhook",
                    )
                except PaymentConfirmationRejected as exc:
                    if not exc.refunded:
                        # PG 환불 실패 — 예외 전파(5xx)로 PortOne 재시도가
                        # 환불을 재시도하게 한다 (트랜잭션 rollback으로
                        # 웹훅 dedup event_id도 해제됨).
                        raise
                    # 환불 성공 — 재시도 무의미. 환불 기록을 commit하도록
                    # 200 OK ack (propagation 없음 — 확정 아님).
                    logger.warning(
                        "Paid webhook rejected & auto-refunded: order=%s reason=%s",
                        order.id, exc,
                    )
                    return None
                propagations.append(_build_payment_confirmed_hint(order, event))
                return propagations

            # ── 터미널 상태(EXPIRED/CANCELLED)에 늦게 도착한 paid 웹훅 (M-1) ──
            # 조용히 삼키면 '돈만 빠지고 주문 소멸'이 영구 미탐지된다 —
            # 자동 PG 환불 + critical 알림 + 메타 기록.
            if current_status in (OrderStatus.EXPIRED, OrderStatus.CANCELLED):
                await self._handle_late_paid_terminal_webhook(order, event)
                return None

            return None

        if event.status in {"failed", "cancelled"}:
            reason = f"PortOne webhook {event.status}: {event.event_type}"
            propagate_event = (
                "order.cancelled" if event.status == "cancelled" else "order.payment.failed"
            )
            if current_status == OrderStatus.AUTHORIZED:
                await self.void_payment(
                    order.id,
                    reason=reason,
                    source="webhook",
                )
                propagations.append(
                    _build_failure_hint(order, propagate_event, reason, event)
                )
                return propagations

            if current_status in (OrderStatus.PENDING, OrderStatus.PAYMENT_REQUIRED):
                order.payment_failed_reason = reason
                await self.cancel_order(order.id, target_status=OrderStatus.CANCELLED)
                propagations.append(
                    _build_failure_hint(order, propagate_event, reason, event)
                )
                return propagations

            return None

        # Unknown/ignored webhook event
        meta = order.payment_metadata if isinstance(order.payment_metadata, dict) else {}
        meta["last_webhook"] = mask_payment_payload(event.raw)
        order.payment_metadata = meta
        await self.session.flush()
        return None

    # ── NICEPAY 신형 v1 (Phase 1b) ──────────────────────────────────────
    async def _find_nice_order(
        self, order_id: str, *, for_update: bool = False
    ) -> "Order | None":
        """나이스 orderId → v2 주문 정확 매칭 조회(payment_id 우선, 없으면 external_ref).

        나이스 orderId 는 결제창 호출 시 우리가 심은 값 그대로 에코백된다:
          · consumer(v2 직접결제): payment_id(ord_<hex>_aN) 로 심음 → payment_id 매칭.
          · go-checkout(organizer): go order id(external_ref, UUID) 로 심음 → external_ref 매칭.
        두 컬럼 모두 partial-unique 인덱스라 **정확 등호 매칭이 유일 주문을 보장**한다. 교차주문·
        prefix·LIKE 매칭 금지(IDOR/교차승인 차단). payment_id 를 먼저 시도해, 혹시라도 값이
        양쪽에 해당하는 극단적 경우에도 consumer 경로를 우선한다(포맷상 실제 겹침 없음).
        """
        oid = (order_id or "").strip()
        if not oid:
            return None

        def _q(column):
            stmt = select(Order).where(column == oid)
            if for_update:
                stmt = stmt.with_for_update()
            return stmt

        order = (
            await self.session.execute(_q(Order.payment_id))
        ).scalar_one_or_none()
        if order is not None:
            return order
        return (
            await self.session.execute(_q(Order.external_ref))
        ).scalar_one_or_none()

    async def handle_nice_return(
        self,
        *,
        auth_result_code: str | None,
        tid: str | None,
        auth_token: str | None,
        order_id: str | None,
        client_id: str | None,
        amount_raw: str | None,
        signature: str | None,
        next_app_url: str | None = None,
        net_cancel_url: str | None = None,
    ) -> "NiceReturnResult":
        """나이스 returnUrl 승인·확정 (결정 C 4중검증 → 승인 → 기존 confirm 재사용).

        ⚠️ 소유권: 나이스 returnUrl 은 크로스사이트 POST 라 세션 쿠키가 없다.
        signature + orderId + DB금액 3중이 소유권을 대체한다(계획 결정 C). 쿠키 검증
        시도 금지.

        검증 순서(하나라도 실패=거부, NiceReturnResult.ok=False):
          ① authResultCode == "0000"
          ② signature 필수(누락/빈값 거부) + verify_returnurl_signature 통과
             — amount 는 **파싱 전 원문 문자열**(amount_raw)로 서명검증(High#1 계약).
          ③ orderId 로 v2 주문 조회 → 존재 + status 가 결제대기(PENDING/PAYMENT_REQUIRED)
          ④ returnUrl amount(원문) == 주문 DB 금액

        통과 시 confirm_payment(기존 v2 파이프라인)로 승인·확정한다 —
        승인은 그 안에서 **DB 재조회 금액**으로 이뤄지고, tid 는 pg_transaction_id
        (UNIQUE)로 저장돼 returnUrl↔웹훅 이중확정을 막는다(G5). vbank ready 는
        confirm_payment 의 _pending 가드가 주문을 pending 으로 유지한다(G9).

        멱등: 이미 확정된(CONFIRMED/PAID) 주문에 같은 tid 로 재진입하면 confirm_payment
        가 그대로 성공 반환한다. 다른 tid 면 거부.
        """
        # ① authResultCode
        if (auth_result_code or "").strip() != "0000":
            return NiceReturnResult(ok=False, reason="auth_failed", order=None)

        if not order_id or not (order_id or "").strip():
            return NiceReturnResult(ok=False, reason="missing_order_id", order=None)

        # ③ 주문 조회 — 나이스 orderId 는 두 경로에서 서로 다른 필드에 매핑된다:
        #     · consumer(v2 직접결제): orderId == order.payment_id(ord_<hex>_aN)
        #     · go-checkout(organizer): orderId == order.external_ref(go order id, UUID)
        #    둘 다 UNIQUE 이고 포맷이 겹치지 않으므로(payment_id=ord_ prefix, external_ref=UUID)
        #    payment_id 우선·없으면 external_ref 로 **정확 매칭만** 조회한다. 교차주문·부분매칭
        #    금지(IDOR 차단) — LIKE·prefix 매칭 없이 등호 조회. (Phase 2b)
        order = await self._find_nice_order(order_id.strip())
        if not order:
            return NiceReturnResult(ok=False, reason="order_not_found", order=None)

        # 이미 확정된 주문 — 멱등: 같은 tid 면 성공(이중확정 방어), 다른 tid 면 거부.
        if order.status in (OrderStatus.CONFIRMED, OrderStatus.PAID):
            if tid and order.pg_transaction_id == tid.strip():
                return NiceReturnResult(ok=True, reason="already_confirmed", order=order)
            return NiceReturnResult(ok=False, reason="already_finalized", order=order)

        if order.status not in (OrderStatus.PENDING, OrderStatus.PAYMENT_REQUIRED):
            return NiceReturnResult(ok=False, reason="order_not_pending", order=order)

        # ② signature 필수 + 검증 — 게이트웨이(주문 provider)로 라우팅.
        gateway = self._gateway_for(order)
        verify_sig = getattr(gateway, "verify_returnurl_signature", None)
        if verify_sig is None:
            return NiceReturnResult(ok=False, reason="provider_unsupported", order=order)
        if not verify_sig(
            auth_token=auth_token,
            client_id=client_id,
            amount=amount_raw,  # ⚠️ 파싱 전 원문 문자열(High#1)
            signature=signature,
        ):
            return NiceReturnResult(ok=False, reason="signature_invalid", order=order)

        # ④ returnUrl amount(원문) == DB 금액. 원문 문자열을 정수 비교로 좁힌다.
        db_amount = int(float(order.total_amount))
        try:
            returned_amount = int((amount_raw or "").strip())
        except (TypeError, ValueError):
            return NiceReturnResult(ok=False, reason="amount_invalid", order=order)
        if returned_amount != db_amount:
            return NiceReturnResult(ok=False, reason="amount_mismatch", order=order)

        if not tid or not tid.strip():
            return NiceReturnResult(ok=False, reason="missing_tid", order=order)

        # 승인 + 주문 확정 — 기존 v2 confirm 파이프라인 재사용(상태전이·티켓·fee·AP·전파).
        # confirm_payment 내부에서 verify_payment(=승인)가 DB 재조회 금액으로 실행되고,
        # vbank ready 는 _pending 가드로 pending 유지된다. 구형 나이스는 실 승인을
        # 인증응답의 NextAppURL(dc1/dc2) 로 POST(EdiType=KV) 하므로, 여기서 받은
        # auth_token·next_app_url 을 confirm_payment→verify_payment 로 넘긴다(게이트웨이가
        # _assert_approval_host 로 재검증). mock 모드에선 실 HTTP 없이 승인된다.
        # 🔴 승인 **전에** (주문·Moid·TID) 를 별도 트랜잭션으로 커밋한다 (C1).
        #
        # ⚠️ **여기여야 한다 — confirm 안이면 자기교착이다** (2026-08-01, 실 PG 로 확인).
        #    `_confirm_payment_inner` 는 `_get_order_for_update` 로 주문 행에 FOR UPDATE 를
        #    잡는다. 그 상태에서 별도 세션이 payment_attempts(FK order_id) 를 INSERT 하면
        #    부모 행의 FOR KEY SHARE 가 필요해 **영원히 블록된다**(같은 요청이 자기를
        #    기다린다). 실측: 락 보유 중 INSERT 가 타임아웃(exit 124).
        #    ⟹ 락을 잡기 **전**인 이 자리에서 기록한다. 여기서 order 는 잠금 없는
        #       SELECT 로만 읽혀 있어 충돌하지 않는다.
        #
        # 실패하면 승인하지 않는다 — 기록을 못 남겼다는 건 "사고가 나도 못 찾는다" 는
        # 뜻이고, 그 상태로 승인하면 정확히 없애려던 상황이 된다. 승인 전이라 돈은 안 나간다.
        try:
            await self._precommit_nice_attempt(
                order=order,
                payment_id=(order.payment_id or order_id.strip()),
                pg_txn_id=tid.strip(),
                amount=float(order.total_amount),
            )
        except Exception as exc:
            logger.exception("나이스 승인 사전기록 실패 — 승인하지 않는다: order=%s", order.id)
            return NiceReturnResult(ok=False, reason="precommit_failed", order=order)

        try:
            await self.confirm_payment(
                order.id,
                pg_provider=gateway.provider_name,
                pg_txn_id=tid.strip(),
                payment_id=order.payment_id,
                amount=None,  # DB 값으로 검증(confirm_payment 가 order.total_amount 사용)
                source="nice_return",
                auth_token=auth_token,
                next_app_url=next_app_url,
                net_cancel_url=net_cancel_url,
            )
        except PaymentConfirmationRejected as exc:
            # PG paid 확인 후 비즈니스 거부(마감초과·사기). 자동 환불은 confirm 내부에서
            # 이미 처리됨 — 사용자에겐 실패 페이지.
            logger.warning("나이스 returnUrl 확정 거부: order=%s reason=%s", order.id, exc)
            return NiceReturnResult(ok=False, reason="confirm_rejected", order=order)
        except ValueError as exc:
            logger.warning("나이스 returnUrl 승인 실패: order=%s err=%s", order.id, exc)
            return NiceReturnResult(ok=False, reason="approval_failed", order=order)

        # confirm 후 최신 상태 재조회(vbank pending 이면 여전히 대기).
        await self.session.refresh(order)
        pending = order.status in (OrderStatus.PENDING, OrderStatus.PAYMENT_REQUIRED)
        # 🔴 **여기서 닫으면 안 된다** (2026-08-01, 코덱스 F09 가 실 PG 로 잡음).
        #    `confirm_payment` 은 스스로 커밋하지 않는다 — 커밋은 **라우트**가 한다
        #    (`payment_webhook.py` 의 `if result.ok: await db.commit()`).
        #    여기서 닫으면 그 커밋이 실패·롤백돼도 기록만 SUCCEEDED 로 남아
        #    **복구 대상에서 빠진다.** 내가 주석에 "주문 커밋보다 먼저 닫으면 안 된다"
        #    고 써놓고 경계를 라우트가 아니라 서비스로 잡은 것이 원인이다.
        #    ⟹ 닫는 일은 라우트가 커밋한 **뒤에** 한다. 아래 플래그로 알린다.
        # 🔴 호출자 트랜잭션 안에서 닫는다 — 커밋되면 함께 확정되고 롤백되면 함께 되돌아간다.
        #    vbank 대기는 닫지 않는다(입금 전이라 결과가 아직 없다).
        if not pending:
            await self._resolve_nice_attempt_succeeded(order_id=order.id, pg_txn_id=tid.strip())
        return NiceReturnResult(
            ok=True,
            reason="vbank_pending" if pending else "confirmed",
            order=order,
        )

    async def handle_nice_webhook(
        self,
        *,
        payload: dict,
    ) -> list[dict] | None:
        """나이스 웹훅 처리 — vbank 입금확정·부분취소·만료 명시 분기(G8).

        서명 검증·IP 화이트리스트는 라우트(secure_nice_webhook_request)가 수행한다.
        여기서는 파싱된 payload 로 status 분기만 한다.

        분기(레퍼런스 §4.2 status):
          - paid            : vbank 입금확정 등 → PENDING/PAYMENT_REQUIRED 면 확정,
                              AUTHORIZED 면 capture. 터미널이면 late-paid 자동환불(M-1).
          - partialCancelled / cancelled : 취소 반영(total_refunded·재고·상태).
          - expired / failed : vbank 만료 등 정리(대기 주문만 취소).

        멱등: order.payment_webhook_event_id dedup(기존 원장 재사용).
        반환: v2→go 전파 hint 리스트(라우트가 commit 후 큐잉) 또는 None.
        """
        gateway = get_payment_gateway("nicepay")
        event = gateway.parse_webhook_event(payload)
        if not event.payment_id:
            return None

        # orderId(=event.payment_id) 는 consumer=payment_id / go=external_ref 두 경로.
        # returnUrl 승인 후엔 payment_id 가 채워지지만(승인응답이 orderId 에코), 웹훅이
        # returnUrl 보다 먼저 도착하거나 승인응답이 orderId 를 생략한 극단 케이스에도
        # go 주문(external_ref)을 놓치지 않도록 정확 매칭 2필드로 조회한다. (Phase 2b)
        order = await self._find_nice_order(event.payment_id, for_update=True)
        if not order:
            return None

        # 멱등: 같은 웹훅 이벤트 재수신 무시(원장 dedup).
        if order.payment_webhook_event_id == event.event_id:
            return None
        order.payment_webhook_event_id = event.event_id

        current_status = order.status
        propagations: list[dict] = []

        # ── paid: vbank 입금확정 등 ──────────────────────────────────────
        if event.status == "paid":
            if current_status == OrderStatus.AUTHORIZED:
                await self.capture_payment(order.id, source="webhook")
                propagations.append(_build_payment_confirmed_hint(order, event))
                return propagations
            if current_status in (OrderStatus.PENDING, OrderStatus.PAYMENT_REQUIRED):
                txn = event.transaction_id or f"nice_wh_{event.event_id}"
                try:
                    verified_override = None
                    # 4110은 인증/승인 요청이 아니라 가상계좌 입금통보다. 이미
                    # 입금된 거래에 pay_process.jsp를 다시 POST하면 승인 경로가
                    # 실패하거나 중복 처리될 수 있으므로 거래조회 결과를 확정
                    # 증거로 사용해 confirm 파이프라인에 주입한다.
                    if str(payload.get("ResultCode") or payload.get("resultCode") or "") == "4110":
                        verified_override = await self._verify_nice_vbank_deposit(
                            order, event
                        )
                    await self.confirm_payment(
                        order.id,
                        pg_provider="nicepay",
                        pg_txn_id=txn,
                        payment_id=event.payment_id,
                        amount=event.amount,
                        source="webhook",
                        _verified=verified_override,
                    )
                except PaymentConfirmationRejected as exc:
                    if not exc.refunded:
                        raise
                    logger.warning(
                        "나이스 paid 웹훅 거부·자동환불: order=%s reason=%s", order.id, exc
                    )
                    return None
                propagations.append(_build_payment_confirmed_hint(order, event))
                return propagations
            # 터미널(EXPIRED/CANCELLED)에 늦게 도착한 paid — 돈만 빠짐, 자동환불(M-1).
            if current_status in (OrderStatus.EXPIRED, OrderStatus.CANCELLED):
                await self._handle_late_paid_terminal_webhook(order, event)
                return None
            return None

        # ── cancelled / partialCancelled: 취소 반영 (명시 분기, G8) ───────
        # ⚠️ parse_webhook_event 는 partialCancelled 를 "cancelled" 로 접는다
        # (_normalize_status). 따라서 event.status 만 보면 부분/전액을 구분할 수
        # 없다 — **raw 원문 status 로 먼저 갈라** 삼킴(부분취소를 전액취소로 오처리)을
        # 막는다(G8). detectPaymentOutcome류가 partialCancelled 를 삼키는 함정 회피.
        raw = event.raw if isinstance(event.raw, dict) else {}
        if event.transaction_id and order.pg_transaction_id and str(event.transaction_id) != str(order.pg_transaction_id):
            raise ValueError("NICE 취소 웹훅 원거래 TID 불일치")
        status_raw = str(
            raw.get("status")
            or raw.get("Status")
            or raw.get("StateCd")
            or raw.get("stateCd")
            or ""
        ).strip().lower()

        if status_raw in ("partialcancelled", "partialcanceled"):
            reason = f"nicepay webhook partialCancelled: {event.event_type}"
            return await self._apply_nice_cancel_webhook(
                order, event, reason=reason, is_partial=True
            )
        if event.status == "cancelled":
            reason = f"nicepay webhook cancelled: {event.event_type}"
            return await self._apply_nice_cancel_webhook(
                order, event, reason=reason, is_partial=False
            )

        # ── expired / failed: vbank 만료 등 정리 ─────────────────────────
        if event.status == "failed":
            if current_status in (OrderStatus.PENDING, OrderStatus.PAYMENT_REQUIRED):
                reason = f"nicepay webhook {status_raw or 'failed'}: {event.event_type}"
                order.payment_failed_reason = reason[:300]
                await self.cancel_order(order.id, target_status=OrderStatus.CANCELLED)
                propagations.append(
                    _build_failure_hint(order, "order.payment.failed", reason, event)
                )
                return propagations
            return None

        # Unknown/ignored — 기록만.
        meta = order.payment_metadata if isinstance(order.payment_metadata, dict) else {}
        meta["last_nice_webhook"] = mask_payment_payload(event.raw)
        order.payment_metadata = meta
        await self.session.flush()
        return None

    async def _verify_nice_vbank_deposit(self, order: Order, event) -> PaymentVerificationResult:
        """4110 입금통보를 승인 호출 없이 거래조회로 검증한다."""
        gateway = self._gateway_for(order)
        if getattr(gateway, "provider_name", "") != "nicepay":
            raise ValueError("NICE vbank 입금은 NICE 게이트웨이에서만 처리할 수 있습니다")
        tid = str(event.transaction_id or "").strip()
        if not tid:
            raise ValueError("NICE vbank 입금통보에 TID가 없습니다")
        lookup_id = str(order.payment_id or order.external_ref or event.payment_id or "")
        body = await gateway.fetch_payment_by_order_id(
            lookup_id, transaction_id=tid
        )
        if not body:
            raise ValueError("NICE vbank 입금 거래조회 결과가 없습니다")
        server_event = gateway.parse_webhook_event(body)
        if server_event.status != "paid":
            raise ValueError(
                f"NICE vbank 입금 상태가 승인 상태가 아닙니다: {server_event.status}"
            )
        body_tid = str(body.get("TID") or body.get("tid") or body.get("TxTid") or "").strip()
        if body_tid != tid:
            raise ValueError("NICE vbank 거래조회 TID 불일치")
        body_moid = str(body.get("Moid") or body.get("MOID") or "").strip()
        if body_moid and body_moid not in {str(order.payment_id or ""), str(order.external_ref or "")}:
            raise ValueError("NICE vbank 거래조회 Moid 불일치")
        amount_raw = body.get("Amt") or body.get("amount")
        if amount_raw in (None, ""):
            raise ValueError("NICE vbank 거래조회 금액 누락")
        amount = float(str(amount_raw).strip())
        if abs(amount - float(order.total_amount)) > 0.01:
            raise ValueError("NICE vbank 입금 금액 불일치")
        return PaymentVerificationResult(
            provider="nicepay",
            payment_id=order.payment_id or event.payment_id,
            transaction_id=tid,
            amount=amount,
            currency=order.payment_currency,
            raw={**body, "_vbank_deposit": True, "_normalized_status": "paid"},
        )

    async def _apply_nice_cancel_webhook(
        self, order: Order, event, *, reason: str, is_partial: bool
    ) -> list[dict] | None:
        """나이스 취소 웹훅(전액/부분) 반영 — total_refunded·상태·재고.

        나이스 관리자/API 취소가 웹훅으로 통보되는 경로. v2 가 취소를 개시한 경우
        (refund_service) 이미 상태·재고가 반영돼 있을 수 있으므로, 여기서는
        total_refunded 를 **웹훅이 알려준 취소액만큼 상한 내에서** 정합시킨다.
        """
        if order.status in (OrderStatus.CANCELLED, OrderStatus.REFUNDED):
            # 이미 취소/환불 완료 — 재적용 금지(멱등).
            return None

        raw = event.raw if isinstance(event.raw, dict) else {}
        # 취소액: cancels[-1].amount 우선, 없으면 balanceAmt 로 역산(amount-balanceAmt).
        cancel_amt: Decimal | None = None
        cancels = raw.get("cancels")
        if isinstance(cancels, list) and cancels:
            last = cancels[-1]
            if isinstance(last, dict) and last.get("amount") is not None:
                try:
                    cancel_amt = Decimal(str(last["amount"]))
                except (ValueError, TypeError):
                    cancel_amt = None
        if cancel_amt is None:
            raw_cancel_amt = raw.get("CancelAmt") or raw.get("cancelAmt")
            if raw_cancel_amt not in (None, ""):
                try:
                    cancel_amt = Decimal(str(raw_cancel_amt))
                except (ValueError, TypeError):
                    cancel_amt = None
        if cancel_amt is None:
            total = Decimal(str(event.amount)) if event.amount is not None else Decimal(str(order.total_amount))
            balance = raw.get("balanceAmt")
            if balance is not None:
                try:
                    cancel_amt = total - Decimal(str(balance))
                except (ValueError, TypeError):
                    cancel_amt = None
        if cancel_amt is None or cancel_amt <= 0:
            raise ValueError("NICE 취소 웹훅 취소금액이 없습니다")

        now = self._now()
        max_refundable = Decimal(str(order.total_amount)) - Decimal(str(order.total_refunded))
        if cancel_amt > max_refundable + Decimal("0.01"):
            raise ValueError("NICE 취소 웹훅 취소금액이 환불가능 잔액을 초과합니다")
        applied = cancel_amt
        if applied > 0:
            await self.session.execute(
                update(Order)
                .where(Order.id == order.id)
                .values(total_refunded=Order.total_refunded + applied)
            )
            await self.session.refresh(order, ["total_refunded"])

        meta = dict(order.payment_metadata) if isinstance(order.payment_metadata, dict) else {}
        meta["nice_cancel_webhook"] = {
            "reason": reason,
            "is_partial": is_partial,
            "applied": float(applied),
            "cancelledTid": raw.get("cancelledTid"),
            "balanceAmt": raw.get("balanceAmt"),
            "at": now.isoformat(),
        }
        order.payment_metadata = meta

        propagations: list[dict] = []
        fully_cancelled = (
            Decimal(str(order.total_refunded)) >= Decimal(str(order.total_amount)) - Decimal("0.01")
        )
        # 전액 취소이고 아직 취소 상태가 아니면 주문 취소(재고·티켓 원복).
        if not is_partial or fully_cancelled:
            if order.status in (OrderStatus.CONFIRMED, OrderStatus.PAID):
                try:
                    await self.cancel_order(order.id, target_status=OrderStatus.REFUNDED)
                except ValueError:
                    logger.warning(
                        "나이스 취소 웹훅 상태전이 실패: order=%s", order.id, exc_info=True
                    )
            propagations.append(
                _build_failure_hint(order, "order.cancelled", reason, event)
            )

        await write_audit_log(
            self.session,
            actor_id=order.user_id,
            action="nice_cancel_webhook",
            resource_type="order",
            resource_id=str(order.id),
            event_id=order.event_id,
            tier_id=order.tier_id,
            new_value={
                "order_id": str(order.id),
                "is_partial": is_partial,
                "applied": float(applied),
                "total_refunded": float(order.total_refunded),
                "result": "success",
            },
        )
        await self.session.flush()
        return propagations or None


class NiceReturnResult:
    """나이스 returnUrl 처리 결과 — 라우트가 302 redirect 판정에 쓴다."""

    __slots__ = ("ok", "reason", "order")

    def __init__(self, *, ok: bool, reason: str, order: "Order | None") -> None:
        self.ok = ok
        self.reason = reason
        self.order = order


async def record_rejection_reason(
    *,
    order_id: str | None,
    reason: str,
    order: "Order | None",
    detail: dict | None = None,
    session_factory=None,
) -> None:
    """🔴 거부 사유를 **별도 트랜잭션**으로 남긴다 (2026-08-10 실장애).

    ## 무엇이 사라졌나

    나이스 returnUrl 핸들러는 거부 시 트랜잭션 전체를 롤백한다
    (`payment_webhook.py:647`). 롤백 자체는 **의도된 동작**이다 — 반쪽 상태를
    커밋하지 않기 위한 것이라 건드리면 안 된다.

    문제는 거부 경로가 **같은 세션에** 사유를 써 뒀다는 것이다:

        payment_service.py:471   audit  payment_card_issuer_rejected
                     :1328       meta   confirm_rejected_refund
                     :1356       audit  payment_confirm_rejected

    전부 롤백과 함께 사라진다. 살아남는 건 외부 호출(PG 취소·ops 알림)뿐이라
    **돈은 움직였는데 왜 그랬는지가 안 남는다.**

    실측(2026-08-08 09:16): BC 할인가 12,150원 주문이 승인 후 취소됐는데
    `audit_logs` 에 사유 0건 — 원인을 끝내 못 찾았다. 그 손님은 9분 뒤 정가로 다시 샀다.

    ## 🔴 왜 별도 세션인가

    롤백되는 세션에 쓰면 그게 바로 이 결함이다. **새 세션**을 열어 커밋한다.

    ⚠️ 실패해도 삼킨다 — 기록이 안 남는 것보다 나쁜 건 기록 때문에 결제 흐름이
       깨지는 것이다. 로그에는 남긴다.
    """
    from app.core.database import async_session

    # 🔴 세션 팩토리를 주입받는다 — **검증용**이다. 프로덕션은 기본값(별도 세션)을 쓴다.
    #    ⚠️ SQLite(StaticPool)에서는 두 세션이 같은 커넥션을 공유해 트랜잭션 분리가
    #       성립하지 않는다 ⟹ pytest 로는 "롤백 뒤에도 남는가" 를 증명할 수 없다.
    #       그 증명은 실 PG 스크립트가 한다(scripts/verify/rejection_reason_pg.py).
    factory = session_factory or async_session

    payload = {
        "reason": reason,
        "order_id": order_id,
        # 🔴 무엇이 거부했는가 · 금액 · 시각 — 이 셋이 원인 식별의 최소 단위다.
        "amount": float(order.total_amount) if order is not None and order.total_amount is not None else None,
        "order_status": (
            order.status.value if order is not None and hasattr(order.status, "value")
            else (str(order.status) if order is not None else None)
        ),
        "occurred_at": datetime.now(timezone.utc).isoformat(),
        **(detail or {}),
    }
    try:
        async with factory() as audit_db:
            await write_audit_log(
                audit_db,
                actor_id=order.user_id if order is not None else None,
                action="payment_rejected_reason",
                resource_type="order",
                resource_id=str(order.id) if order is not None else (order_id or None),
                event_id=order.event_id if order is not None else None,
                new_value=payload,
            )
            await audit_db.commit()
    except Exception:
        # 🔴 기록 실패가 결제 응답을 바꾸면 안 된다.
        logger.exception("거부 사유 기록 실패: order_id=%s reason=%s", order_id, reason)


def _build_payment_confirmed_hint(order: Order, event) -> dict:
    """Build v2→go propagation hint for a successful payment event.

    🔴 `order_id` 는 **반드시 str** 이다 (2026-08-01 실사고).
       종전엔 `order.id`(UUID 객체)를 그대로 실었다. celery 는 UUID 를 알아서 실어
       보내고 worker 에서 UUID 객체로 복원하지만, 태스크 안의 서명 body 생성
       (`propagate_order_event.py` 의 `json.dumps(envelope)`)은 UUID 를 모른다
       ⟹ worker 가 **받은 직후 TypeError 로 죽었다.**

       증상이 고약했다: `.delay()` 는 예외를 안 내므로 v2 는 발행에 성공했다고 믿고,
       15분 크론 대사가 뒤늦게 구조해서 **"느리다" 로만 보였다.** 실결제 3건이
       14~17분씩 지연되는 동안 아무도 몰랐다.

       같은 파일의 다른 21곳은 전부 `str(order.id)` 다. 이 빌더와 `_build_failure_hint`
       두 곳만 빠져 있었다.
    """
    return {
        "event": "order.payment.confirmed",
        "order_id": str(order.id),
        "data": {
            "payment_id": event.payment_id,
            "paid_at": datetime.now(timezone.utc).isoformat(),
            "amount": float(event.amount) if event.amount is not None else None,
            "method": getattr(event, "method", None) or "unknown",
            "source_product": "consumer",
        },
    }


def _build_failure_hint(order: Order, event_name: str, reason: str, event) -> dict:
    """Build v2→go propagation hint for a failed/cancelled payment.

    🔴 `order_id` 는 **반드시 str** — 근거는 `_build_payment_confirmed_hint` 참조.
    """
    return {
        "event": event_name,
        "order_id": str(order.id),
        "data": {
            "reason": reason,
            "failed_at": datetime.now(timezone.utc).isoformat(),
            "payment_id": event.payment_id,
            "source_product": "consumer",
        },
    }
