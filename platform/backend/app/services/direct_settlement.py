"""주최사 PG 직결 정산 — 무경유 오케스트레이션 (과업 WP7).

흐름 (이벤트 settlement_mode = direct)
    ① 결제 준비   PaymentService.initiate_payment 가 route_for_event() 로 직결 게이트웨이를 받는다.
                  결제창에는 **주최사의 클라이언트 키**가 내려가고, 주문 pg_provider = "toss_direct".
    ② 승인        기존 confirm 흐름이 _gateway_for(order) → DirectTossGateway 로 라우팅된다.
                  게이트웨이가 주문의 직결 계정을 찾아 **주최사 시크릿 키**로 토스에 승인을 요청한다.
                  → 대금은 주최사 상점으로 바로 들어간다. 피켓은 자금을 거치지 않는다.
    ③ 수수료      승인 직후 platform_fee_invoices 에 플랫폼 수수료를 청구 기록(대금에서 떼지 않음).
    ④ 정산 제외   settlement_generate 가 toss_direct 주문을 정산 지급 대상에서 뺀다.
    ⑤ Pull 확인   pull_status(): 웹훅을 기다리지 않고 토스 주문 조회로 상태를 끌어와 대조한다.
    ⑥ 원장        모든 PG 호출(승인·조회·취소·키 확인)은 integration_ledger(해시 체인)에 남는다.

기존 platform 모드 이벤트는 이 모듈을 전혀 거치지 않는다(기본값).
"""

from __future__ import annotations

import logging
import re
import time
import uuid
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal

import httpx
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import write_audit_log
from app.core.config import settings
from app.core.database import async_session
from app.models.direct_settlement import EventSettlementMode, OrganizerPgAccount, PlatformFeeInvoice
from app.models.event import Event
from app.models.order import Order
from app.services.integration_ledger import record_integration
from app.services.toss_gateway import TossGateway

logger = logging.getLogger(__name__)

# 별도 트랜잭션용 세션 팩토리(테스트에서 바꿔 끼운다)
session_factory = async_session

DIRECT_PROVIDER = "toss_direct"
CLIENT_KEY_RE = re.compile(r"^(test|live)_(ck|gck)_[A-Za-z0-9_]{8,}$")
# 직결 결제창은 토스 표준 결제창(payment())이라 API 개별 연동 키(ck/sk)만 쓴다. 위젯 키(gck/gsk)는 거부.
DIRECT_KEY_KINDS = ("ck", "sk")
SECRET_KEY_RE = re.compile(r"^(test|live)_(sk|gsk)_[A-Za-z0-9_]{8,}$")


class DirectSettlementError(ValueError):
    pass


def _now() -> datetime:
    return datetime.now(UTC)


def _hint(secret: str) -> str:
    return f"{secret[:8]}…{secret[-4:]}"


async def _ledger(operation: str, *, account_id, event_id=None, request=None, response=None, status="ok", latency_ms=None):
    """PG 호출 기록은 업무 트랜잭션과 **분리된** 세션으로 남긴다(업무가 롤백돼도 호출 사실은 남는다)."""
    try:
        async with session_factory() as db:
            await record_integration(
                db,
                counterpart="pg",
                counterpart_id=str(account_id) if account_id else None,
                direction="outbound",
                operation=operation,
                event_id=event_id,
                request=request,
                response=response,
                status=status,
                latency_ms=latency_ms,
            )
            await db.commit()
    except Exception:
        logger.error("direct settlement ledger write failed", exc_info=True)


class DirectTossGateway(TossGateway):
    """주최사 상점 키로 토스를 호출하는 게이트웨이. 주문의 직결 계정을 스스로 찾는다."""

    provider_name = DIRECT_PROVIDER

    def __init__(self, account: OrganizerPgAccount | None = None, *, mock: bool | None = None) -> None:
        super().__init__()
        self.account_id = account.id if account else None
        self.secret_key = account.secret_key if account else ""
        self.client_key = account.client_key if account else ""
        self.mock_mode = bool(settings.DIRECT_PG_MOCK) if mock is None else mock
        self._event_id: uuid.UUID | None = None

    async def _bind(self, payment_id: str) -> None:
        if self.secret_key and self.account_id:
            return
        async with session_factory() as db:
            row = (
                await db.execute(
                    select(Order.event_id, Order.payment_metadata).where(Order.payment_id == payment_id)
                )
            ).first()
            account_id = (row.payment_metadata or {}).get("direct_pg_account_id") if row else None
            account = await db.get(OrganizerPgAccount, uuid.UUID(account_id)) if account_id else None
            if account is None:
                raise ValueError("직결 정산 계정을 찾을 수 없습니다")
            self.account_id, self.secret_key, self.client_key = account.id, account.secret_key, account.client_key
            self._event_id = row.event_id

    async def prepare_payment(self, **kwargs):
        result = await super().prepare_payment(**kwargs)
        result.raw.update({"clientKey": self.client_key, "settlement": "direct", "pgAccountId": str(self.account_id)})
        return result

    async def verify_payment(self, *, payment_id: str, transaction_id: str, expected_amount: float, currency: str, expected_statuses=None):
        await self._bind(payment_id)
        started = time.perf_counter()
        try:
            result = await super().verify_payment(
                payment_id=payment_id,
                transaction_id=transaction_id,
                expected_amount=expected_amount,
                currency=currency,
                expected_statuses=expected_statuses,
            )
        except Exception as exc:
            await _ledger(
                "confirm",
                account_id=self.account_id,
                event_id=self._event_id,
                request={"orderId": payment_id, "paymentKey": transaction_id, "amount": expected_amount},
                response={"error": str(exc)[:200]},
                status="error",
                latency_ms=int((time.perf_counter() - started) * 1000),
            )
            raise
        await _ledger(
            "confirm",
            account_id=self.account_id,
            event_id=self._event_id,
            request={"orderId": payment_id, "paymentKey": transaction_id, "amount": expected_amount},
            response={"status": (result.raw or {}).get("status"), "totalAmount": result.amount, "mode": "mock" if self.mock_mode else "live"},
            latency_ms=int((time.perf_counter() - started) * 1000),
        )
        await _issue_fee_invoice(payment_id, self.account_id, result.amount)
        return result

    async def void_authorization(self, *, payment_id: str, **kwargs):
        await self._bind(payment_id)
        started = time.perf_counter()
        try:
            result = await super().void_authorization(payment_id=payment_id, **kwargs)
        except Exception as exc:
            await _ledger(
                "cancel",
                account_id=self.account_id,
                event_id=self._event_id,
                request={"orderId": payment_id, "amount": kwargs.get("amount")},
                response={"error": str(exc)[:200]},
                status="error",
            )
            raise
        await _ledger(
            "cancel",
            account_id=self.account_id,
            event_id=self._event_id,
            request={"orderId": payment_id, "amount": kwargs.get("amount")},
            response={"ok": True},
            latency_ms=int((time.perf_counter() - started) * 1000),
        )
        await _void_fee_invoice(payment_id)
        return result

    async def fetch_payment_by_order_id(self, order_id: str, *, transaction_id: str | None = None):
        await self._bind(order_id)
        started = time.perf_counter()
        result = await super().fetch_payment_by_order_id(order_id, transaction_id=transaction_id)
        await _ledger(
            "pull_status",
            account_id=self.account_id,
            event_id=self._event_id,
            request={"orderId": order_id},
            response={"status": (result or {}).get("status"), "totalAmount": (result or {}).get("totalAmount")},
            latency_ms=int((time.perf_counter() - started) * 1000),
        )
        return result


async def _issue_fee_invoice(payment_id: str, account_id, amount: float) -> None:
    async with session_factory() as db:
        order = await db.scalar(select(Order).where(Order.payment_id == payment_id))
        if order is None:
            return
        exists = await db.scalar(select(PlatformFeeInvoice.id).where(PlatformFeeInvoice.order_id == order.id))
        if exists:
            return
        mode = await db.get(EventSettlementMode, order.event_id)
        rate = Decimal(str(mode.fee_rate if mode else 0.05))
        gross = int(Decimal(str(amount)))
        fee = int((Decimal(gross) * rate).quantize(Decimal(1), rounding=ROUND_HALF_UP))
        db.add(
            PlatformFeeInvoice(
                event_id=order.event_id,
                order_id=order.id,
                pg_account_id=account_id,
                gross_amount=gross,
                fee_rate=float(rate),
                fee_amount=fee,
                status="issued",
                created_at=_now(),
            )
        )
        await db.commit()


async def _void_fee_invoice(payment_id: str) -> None:
    async with session_factory() as db:
        order = await db.scalar(select(Order).where(Order.payment_id == payment_id))
        if order is None:
            return
        invoice = await db.scalar(select(PlatformFeeInvoice).where(PlatformFeeInvoice.order_id == order.id))
        if invoice is not None and invoice.status != "void":
            invoice.status = "void"
            await db.commit()


class DirectSettlementService:
    def __init__(self, session: AsyncSession):
        self.session = session

    # ───────── 주최사 PG 계정 ─────────

    async def register_account(
        self, organizer_id: uuid.UUID, *, client_key: str, secret_key: str, label: str = "", actor: str | None = None
    ) -> OrganizerPgAccount:
        client_key, secret_key = client_key.strip(), secret_key.strip()
        cm, sm = CLIENT_KEY_RE.match(client_key), SECRET_KEY_RE.match(secret_key)
        if not cm:
            raise DirectSettlementError("클라이언트 키 형식이 올바르지 않습니다 (test_ck_… / live_ck_… / test_gck_…)")
        if not sm:
            raise DirectSettlementError("시크릿 키 형식이 올바르지 않습니다 (test_sk_… / live_sk_… / test_gsk_…)")
        if cm.group(1) != sm.group(1):
            raise DirectSettlementError("클라이언트 키와 시크릿 키의 테스트/운영 구분이 다릅니다")
        if (cm.group(2) == "gck") != (sm.group(2) == "gsk"):
            raise DirectSettlementError("결제위젯 키(gck/gsk)와 API 개별 연동 키(ck/sk)를 섞을 수 없습니다")
        if cm.group(2) != DIRECT_KEY_KINDS[0] or sm.group(2) != DIRECT_KEY_KINDS[1]:
            raise DirectSettlementError("주최사 직결은 ‘API 개별 연동 키’(test_ck_/test_sk_ 또는 live_ck_/live_sk_)만 지원합니다")
        account = OrganizerPgAccount(
            organizer_id=organizer_id,
            provider="toss",
            mode=cm.group(1),
            label=label.strip()[:80],
            client_key=client_key,
            secret_key=secret_key,
            secret_hint=_hint(secret_key),
            status="pending",
            created_by=actor,
            created_at=_now(),
            updated_at=_now(),
        )
        self.session.add(account)
        await self.session.flush()
        await write_audit_log(
            self.session,
            action="organizer_pg_account_registered",
            resource_type="organizer_pg_account",
            resource_id=str(account.id),
            new_value={"organizer_id": str(organizer_id), "mode": account.mode, "client_key": client_key, "secret_hint": account.secret_hint, "actor": actor},
        )
        return account

    async def verify_account(self, account_id: uuid.UUID) -> OrganizerPgAccount:
        """키 확인: 존재하지 않는 주문을 조회해 본다.

        404 + NOT_FOUND_PAYMENT = 상점 인증 성공(주문만 없음) · 401 UNAUTHORIZED_KEY = 키 오류 ·
        404 + NOT_FOUND_MERCHANT = 상점 없음(문서용 공개 키 등) → 모두 성공 외에는 실패로 기록.
        """
        account = await self.session.get(OrganizerPgAccount, account_id)
        if account is None:
            raise DirectSettlementError("PG 계정을 찾을 수 없습니다")
        gateway = DirectTossGateway(account)
        probe = f"pickket-keycheck-{uuid.uuid4().hex[:12]}"
        started = time.perf_counter()
        ok, detail = False, ""
        if gateway.mock_mode:
            ok, detail = True, "mock"
        else:
            try:
                async with httpx.AsyncClient(timeout=10.0) as client:
                    resp = await client.get(f"{gateway.base_url}/payments/orders/{probe}", headers=gateway._auth_header())
                code = ""
                try:
                    code = str(resp.json().get("code") or "")
                except ValueError:
                    code = ""
                # 🔴 404 라고 다 성공이 아니다. NOT_FOUND_MERCHANT(상점 없음)도 404 다(실측).
                #    "그 주문이 없다"(NOT_FOUND_PAYMENT)여야 상점 인증까지 통과한 것이다.
                ok = resp.status_code == 404 and code == "NOT_FOUND_PAYMENT"
                detail = f"HTTP {resp.status_code} {code}".strip()
            except httpx.HTTPError as exc:
                detail = f"network: {exc.__class__.__name__}"
        account.status = "verified" if ok else "failed"
        account.verified_at = _now() if ok else None
        account.last_error = None if ok else detail[:300]
        account.updated_at = _now()
        await self.session.flush()
        await _ledger(
            "key_check",
            account_id=account.id,
            request={"probe_order": probe, "mode": account.mode},
            response={"result": detail},
            status="ok" if ok else "error",
            latency_ms=int((time.perf_counter() - started) * 1000),
        )
        return account

    async def accounts_for(self, organizer_id: uuid.UUID) -> list[dict]:
        rows = (
            await self.session.execute(
                select(OrganizerPgAccount).where(OrganizerPgAccount.organizer_id == organizer_id).order_by(OrganizerPgAccount.created_at)
            )
        ).scalars().all()
        return [_account_view(a) for a in rows]

    # ───────── 이벤트 정산 방식 ─────────

    async def set_event_mode(
        self, event_id: uuid.UUID, *, mode: str, account_id: uuid.UUID | None, fee_rate: float | None = None, actor: str | None = None
    ) -> EventSettlementMode:
        if mode not in ("platform", "direct"):
            raise DirectSettlementError("정산 방식은 platform 또는 direct 입니다")
        event = await self.session.get(Event, event_id)
        if event is None:
            raise DirectSettlementError("이벤트를 찾을 수 없습니다")
        if mode == "direct":
            account = await self.session.get(OrganizerPgAccount, account_id) if account_id else None
            if account is None or account.organizer_id != event.organizer_id:
                raise DirectSettlementError("이 이벤트 주최사의 PG 계정이 아닙니다")
            if account.status != "verified":
                raise DirectSettlementError("키 확인을 통과한 PG 계정만 연결할 수 있습니다")
        if fee_rate is not None and not 0 <= fee_rate <= 0.3:
            raise DirectSettlementError("수수료율은 0~30% 사이여야 합니다")
        row = await self.session.get(EventSettlementMode, event_id)
        old = {"mode": row.mode, "pg_account_id": str(row.pg_account_id) if row and row.pg_account_id else None} if row else None
        if row is None:
            row = EventSettlementMode(event_id=event_id)
            self.session.add(row)
        row.mode = mode
        row.pg_account_id = account_id if mode == "direct" else None
        if fee_rate is not None:
            row.fee_rate = fee_rate
        elif row.fee_rate is None:
            row.fee_rate = 0.05
        row.updated_by = actor
        row.updated_at = _now()
        await self.session.flush()
        await write_audit_log(
            self.session,
            action="event_settlement_mode_set",
            resource_type="event_settlement_mode",
            resource_id=str(event_id),
            event_id=event_id,
            old_value=old,
            new_value={"mode": mode, "pg_account_id": str(row.pg_account_id) if row.pg_account_id else None, "fee_rate": float(row.fee_rate), "actor": actor},
        )
        return row

    async def route_for_event(self, event_id: uuid.UUID) -> tuple[DirectTossGateway, OrganizerPgAccount] | None:
        """결제 준비 시 호출. direct 이벤트면 (게이트웨이, 계정), 아니면 None(기존 경로)."""
        row = await self.session.get(EventSettlementMode, event_id)
        if not isinstance(row, EventSettlementMode) or row.mode != "direct" or row.pg_account_id is None:
            return None
        account = await self.session.get(OrganizerPgAccount, row.pg_account_id)
        if account is None or account.status != "verified":
            raise DirectSettlementError("주최사 PG 계정이 확인되지 않아 결제를 시작할 수 없습니다")
        return DirectTossGateway(account), account

    # ───────── Pull 확인 ─────────

    async def pull_status(self, order_id: uuid.UUID) -> dict:
        """웹훅을 기다리지 않고 PG 에서 결제 상태를 끌어와 주문 상태와 대조한다."""
        order = await self.session.get(Order, order_id)
        if order is None or order.pg_provider != DIRECT_PROVIDER or not order.payment_id:
            raise DirectSettlementError("직결 정산 주문이 아닙니다")
        gateway = DirectTossGateway()
        fetched = await gateway.fetch_payment_by_order_id(order.payment_id)
        pg_status = gateway._normalize_status(str(fetched.get("status") or "")) if fetched else None
        order_status = order.status.value if hasattr(order.status, "value") else str(order.status)
        return {
            "order_id": str(order.id),
            "payment_id": order.payment_id,
            "order_status": order_status,
            "pg_status": pg_status,
            "consistent": _consistent(order_status, pg_status),
            "pulled_at": _now().isoformat(),
        }

    # ───────── 화면 ─────────

    async def event_overview(self, event_id: uuid.UUID) -> dict:
        event = await self.session.get(Event, event_id)
        if event is None:
            raise DirectSettlementError("이벤트를 찾을 수 없습니다")
        row = await self.session.get(EventSettlementMode, event_id)
        account = await self.session.get(OrganizerPgAccount, row.pg_account_id) if row and row.pg_account_id else None
        sums = (
            await self.session.execute(
                select(func.count(), func.coalesce(func.sum(PlatformFeeInvoice.gross_amount), 0), func.coalesce(func.sum(PlatformFeeInvoice.fee_amount), 0)).where(
                    PlatformFeeInvoice.event_id == event_id, PlatformFeeInvoice.status == "issued"
                )
            )
        ).one()
        ledger = []
        if self.session.get_bind().dialect.name == "postgresql":
            ledger = [
                dict(r._mapping)
                for r in (
                    await self.session.execute(
                        text(
                            "SELECT id, at, operation, status, latency_ms, response FROM integration_ledger "
                            "WHERE counterpart = 'pg' AND (event_id = :e OR counterpart_id = :a) ORDER BY id DESC LIMIT 30"
                        ),
                        {"e": event_id, "a": str(account.id) if account else ""},
                    )
                ).all()
            ]
            for item in ledger:
                item["at"] = item["at"].isoformat()
        return {
            "event_id": str(event_id),
            "mode": row.mode if row else "platform",
            "fee_rate": float(row.fee_rate) if row else 0.05,
            "account": _account_view(account) if account else None,
            "accounts": await self.accounts_for(event.organizer_id),
            "direct_orders": int(sums[0]),
            "direct_gross": int(sums[1]),
            "platform_fee_due": int(sums[2]),
            "ledger": ledger,
        }


def _consistent(order_status: str, pg_status: str | None) -> bool:
    paid_like = {"confirmed", "paid", "completed"}
    if pg_status is None:
        return order_status not in paid_like
    if pg_status in ("paid", "captured", "done"):
        return order_status in paid_like
    if pg_status in ("cancelled", "canceled", "refunded", "voided"):
        return order_status not in paid_like
    return True


def _account_view(account: OrganizerPgAccount | None) -> dict | None:
    if account is None:
        return None
    return {
        "id": str(account.id),
        "provider": account.provider,
        "mode": account.mode,
        "label": account.label,
        "client_key": account.client_key,
        "secret_hint": account.secret_hint,
        "status": account.status,
        "verified_at": account.verified_at.isoformat() if account.verified_at else None,
        "last_error": account.last_error,
    }
