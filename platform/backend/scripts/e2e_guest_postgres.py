#!/usr/bin/env python3
"""게스트(비회원) 결제 E2E — 실 dev postgres 검증 (S4 관문 2).

설계 정본: docs/plans/DETAIL-UNIFICATION-DB-DESIGN.md §2.1~§2.4·§6.3·§7.3.

목적:
    pytest 스위트는 **SQLite in-memory** 라 postgres 트리거(trg_sync_sold_count)·
    XOR CHECK(ck_orders_buyer_exactly_one·ck_tickets_owner_not_both)·FK RESTRICT 가
    실동작하지 않는다. 이 하니스는 **실 dev postgres(localhost:5435)** 위에서
    공개 게스트 엔드포인트(HTTP, ASGITransport)를 그대로 태워 실동작을 증명한다.

    ⚠️ dev DB 전용. prod 아님. 각 실행마다 전용 이벤트/티어를 만들고 종료 시 정리한다.

플로우(단계별 pass 보고):
    1) 유료 게스트: 주문생성(view 토큰) → prepare → confirm → view(PII 마스킹) → 환불
    2) 무료 게스트: 0원 주문 → 즉시 confirmed(payment_method='free')
    3) claim: 유료 게스트(미체크인) → 회원승격 매직링크 → claim(회원세션) → FK rebind
    4) opt-in 게이트: guest_checkout_enabled=False 이벤트 → 403

실동작 확인(관문 2):
    - trg_sync_sold_count: confirm 후 tier.sold_count 증가, 환불 후 감소
    - ck_orders_buyer_exactly_one: 게스트 주문 user_id=NULL·guest_id 세팅(XOR)
    - ck_tickets_owner_not_both: 티켓 guest_owner_id 세팅·current_owner_id=NULL, claim 후 뒤집힘
    - FK: guest_id→guests, guest_owner_id→guests(RESTRICT)

사용법:
    cd platform/backend && .venv/bin/python scripts/e2e_guest_postgres.py
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))
# talkfile_engine(추첨 엔진)은 platform/engine 에 있다 — app.main 라우터가 import 하므로 경로 추가.
_ENGINE = BACKEND_ROOT.parent / "engine"
if _ENGINE.is_dir() and str(_ENGINE) not in sys.path:
    sys.path.insert(0, str(_ENGINE))

from httpx import ASGITransport, AsyncClient  # noqa: E402
from sqlalchemy import delete, func, select, text  # noqa: E402

from app.core.database import async_session, get_db, get_read_db  # noqa: E402
from app.core.security import create_access_token, hash_password  # noqa: E402
from app.models.event import Event, EventStatus, SeatTier  # noqa: E402
from app.models.guest import Guest, GuestAccessToken  # noqa: E402
from app.models.order import Order  # noqa: E402
from app.models.ownership_transfer import OwnershipTransfer  # noqa: E402
from app.models.ticket import Ticket  # noqa: E402
from app.models.user import User  # noqa: E402

E2E_MARK = "E2E_GUEST_PG_"
PASS = "  ✅"
FAIL = "  ❌"

_results: list[tuple[bool, str]] = []


def check(cond: bool, label: str) -> bool:
    _results.append((bool(cond), label))
    print(f"{PASS if cond else FAIL} {label}")
    return bool(cond)


# ---------------------------------------------------------------------------
# 셋업 — 전용 이벤트/티어/회원 (실 dev postgres)
# ---------------------------------------------------------------------------
async def _setup() -> dict:
    """게스트 opt-in 이벤트(유료·무료) + opt-in OFF 이벤트 + claim용 회원 생성."""
    now = datetime.now(timezone.utc)
    async with async_session() as s:
        org = User(
            email=f"{E2E_MARK}org@test.pickket.kr",
            hashed_password=hash_password("E2e2026!"),
            name="[E2E] 주최자", is_organizer=True, is_verified=True, is_active=True,
        )
        member = User(
            email=f"{E2E_MARK}member@test.pickket.kr",
            hashed_password=hash_password("E2e2026!"),
            name="[E2E] 승격회원", is_verified=True, is_active=True,
        )
        s.add_all([org, member])
        await s.flush()

        def _ev(title, *, guest_ck, channels, is_free, price):
            ev = Event(
                organizer_id=org.id, title=title,
                slug=f"e2e-guest-{uuid.uuid4().hex[:8]}",
                external_ref=f"{E2E_MARK}{uuid.uuid4().hex[:8]}",
                description="[E2E] 게스트 postgres 검증", venue="[E2E] 검증장",
                event_date=now + timedelta(days=20),
                bidding_opens_at=now - timedelta(days=1),
                bidding_closes_at=now + timedelta(days=19),
                total_seats=1000, min_price=price, max_price=price,
                category="concert", status=EventStatus.BIDDING_OPEN,
                is_free=is_free, sale_channels=["self", "marketplace"],
                guest_checkout_enabled=guest_ck, guest_checkout_channels=channels,
            )
            s.add(ev)
            return ev

        ev_paid = _ev("[E2E] 유료 게스트", guest_ck=True, channels=["fixed_fcfs"], is_free=False, price=50000)
        ev_free = _ev("[E2E] 무료 게스트", guest_ck=True, channels=["fixed_fcfs", "free"], is_free=True, price=0)
        ev_off = _ev("[E2E] opt-in OFF", guest_ck=False, channels=None, is_free=False, price=30000)
        await s.flush()

        def _tier(ev, name, price):
            t = SeatTier(
                event_id=ev.id, external_ref=f"{E2E_MARK}tier_{uuid.uuid4().hex[:8]}",
                name=name, capacity=1000, base_price=float(price), face_price=float(price),
                min_price=float(price), sale_mode="fixed_fcfs", seating_type="general",
                sold_count=0,
            )
            s.add(t)
            return t

        t_paid = _tier(ev_paid, "일반", 50000)
        t_free = _tier(ev_free, "무료", 0)
        t_off = _tier(ev_off, "일반", 30000)
        await s.flush()
        ctx = {
            "member_id": str(member.id),
            "ev_paid": str(ev_paid.id), "tier_paid": str(t_paid.id),
            "ev_free": str(ev_free.id), "tier_free": str(t_free.id),
            "ev_off": str(ev_off.id), "tier_off": str(t_off.id),
        }
        await s.commit()
        return ctx


async def _teardown() -> None:
    """E2E 마킹된 모든 산출물 삭제(FK 역방향).

    ⚠️ 발견(설계): audit_logs.guest_id FK 는 ON DELETE SET NULL 인데 audit_logs 는
    append-only 불변 트리거(trg_audit_logs_immutable)가 UPDATE/DELETE 를 전면 차단한다.
    → 게스트를 **하드 삭제**하면 SET NULL 이 audit_logs UPDATE 를 유발해 트리거가 거부한다
    (users 는 soft-delete 라 이 충돌을 피함 — 게스트도 prod 에선 deleted_at 소프트삭제가 정본).
    dev 테스트 데이터 정리 목적으로만 session_replication_role=replica 로 트리거를 우회해
    스코프 audit_logs 를 선삭제한 뒤 하드 삭제한다(운영 경로 아님, dev 전용).
    """
    async with async_session() as s:
        # 트리거 우회(dev 테스트 데이터 정리 전용) — 스코프 audit_logs 를 물리 삭제 가능하게.
        await s.execute(text("SET session_replication_role = replica"))
        ev_ids = (
            await s.execute(select(Event.id).where(Event.external_ref.like(f"{E2E_MARK}%")))
        ).scalars().all()
        guest_ids = (
            await s.execute(select(Guest.id).where(Guest.email.like(f"%{E2E_MARK}%")))
        ).scalars().all()
        # guests 는 게스트 주문 email(E2E_MARK 포함) 로 식별
        order_ids = []
        if ev_ids:
            order_ids = (
                await s.execute(select(Order.id).where(Order.event_id.in_(ev_ids)))
            ).scalars().all()
        if order_ids:
            await s.execute(delete(GuestAccessToken).where(GuestAccessToken.order_id.in_(order_ids)))
            # OwnershipTransfer 는 ticket_id 로 연결 → 대상 티켓 id 로 선삭제
            tkt_ids = (
                await s.execute(select(Ticket.id).where(Ticket.purchase_order_id.in_(order_ids)))
            ).scalars().all()
            if tkt_ids:
                await s.execute(delete(OwnershipTransfer).where(OwnershipTransfer.ticket_id.in_(tkt_ids)))
            await s.execute(delete(Ticket).where(Ticket.purchase_order_id.in_(order_ids)))
            await s.execute(delete(Order).where(Order.id.in_(order_ids)))
        # 남은 게스트 토큰 + 게스트
        g2 = (
            await s.execute(select(Guest.id).where(Guest.email.like(f"%{E2E_MARK}%")))
        ).scalars().all()
        # audit_logs(스코프: 이 게스트/이벤트/주문 참조) 물리 삭제 — replica 모드라 트리거 우회.
        # guest 하드삭제 시 SET NULL(=UPDATE) 유발을 원천 제거(참조 자체를 없앤다).
        if g2:
            await s.execute(text("DELETE FROM audit_logs WHERE guest_id = ANY(:g)"), {"g": list(g2)})
        if ev_ids:
            await s.execute(text("DELETE FROM audit_logs WHERE event_id = ANY(:e)"), {"e": list(ev_ids)})
        if g2:
            await s.execute(delete(GuestAccessToken).where(GuestAccessToken.guest_id.in_(g2)))
            await s.execute(delete(Guest).where(Guest.id.in_(g2)))
        if ev_ids:
            await s.execute(delete(SeatTier).where(SeatTier.event_id.in_(ev_ids)))
            await s.execute(delete(Event).where(Event.id.in_(ev_ids)))
        # 회원(actor_id) 참조 audit_logs 도 정리 후 회원 삭제
        u_ids = (
            await s.execute(select(User.id).where(User.email.like(f"{E2E_MARK}%")))
        ).scalars().all()
        if u_ids:
            await s.execute(text("DELETE FROM audit_logs WHERE actor_id = ANY(:u)"), {"u": list(u_ids)})
        await s.execute(delete(User).where(User.email.like(f"{E2E_MARK}%")))
        await s.execute(text("SET session_replication_role = origin"))
        await s.commit()


async def _tier_sold(tier_id: str) -> int:
    async with async_session() as s:
        return (
            await s.execute(select(SeatTier.sold_count).where(SeatTier.id == uuid.UUID(tier_id)))
        ).scalar_one()


# ---------------------------------------------------------------------------
# E2E — 공개 게스트 엔드포인트를 ASGITransport 로 태운다(실 dev postgres get_db)
# ---------------------------------------------------------------------------
async def run_e2e(ctx: dict, *, redis_ok: bool = True) -> None:
    from app.main import app
    from app.api.v1 import deps as _deps
    from app.middleware import rate_limit as _rl

    # 봇방지/레이트리밋 우회(하니스는 사람 흐름 대신 자동화). get_db 는 실 dev postgres.
    app.dependency_overrides[_deps.verify_behavior_token] = lambda: None
    app.dependency_overrides[_rl.rate_limit_payment] = lambda: None
    app.dependency_overrides[_rl.rate_limit_general] = lambda: None
    # get_db 는 프로덕션 async_session(=dev postgres) — 오버라이드 불요(기본이 dev DB).

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        gemail = f"guest_{E2E_MARK}{uuid.uuid4().hex[:6]}@test.pickket.kr"

        # ══ 1) 유료 게스트: 생성 → prepare → confirm → view → 환불 ══
        print("\n[1] 유료 게스트 플로우")
        sold_before = await _tier_sold(ctx["tier_paid"])
        r = await c.post("/api/v1/guests/orders", json={
            "event_id": ctx["ev_paid"],
            "items": [{"tier_id": ctx["tier_paid"], "quantity": 1, "unit_price": 50000}],
            "guest_buyer": {"email": gemail, "name": "게스트김", "phone": "010-9911-2233"},
            "total_amount": 50000,
            "idempotency_key": f"e2e-{uuid.uuid4().hex}",
        })
        ok = check(r.status_code == 200, f"주문 생성 200 (got {r.status_code}: {r.text[:120]})")
        if not ok:
            return
        body = r.json()
        order_id = body["order_id"]
        view_token = body["view_token"]
        check(body["status"] in ("pending", "payment_required"), f"유료 주문 미확정 status={body['status']}")

        # XOR CHECK 실동작: 게스트 주문은 guest_id 세팅·user_id NULL
        async with async_session() as s:
            o = await s.get(Order, uuid.UUID(order_id))
            check(o is not None and o.user_id is None and o.guest_id is not None,
                  "ck_orders_buyer_exactly_one: user_id=NULL·guest_id 세팅(게스트)")
            guest_id_paid = str(o.guest_id)

        # prepare(mock PG)
        r = await c.post(f"/api/v1/guests/orders/{order_id}/payment/prepare", json={
            "view_token": view_token,
            "idempotency_key": f"e2e-prep-{uuid.uuid4().hex}",
        })
        check(r.status_code == 200, f"prepare 200 (got {r.status_code}: {r.text[:120]})")

        # confirm(mock PG — TOSS_SECRET_KEY 없음)
        r = await c.post(f"/api/v1/guests/orders/{order_id}/confirm", json={
            "view_token": view_token,
            "pg_provider": "toss",
            "pg_transaction_id": f"e2e_txn_{uuid.uuid4().hex[:10]}",
            "amount": 50000,
        })
        check(r.status_code == 200, f"confirm 200 (got {r.status_code}: {r.text[:160]})")

        # 트리거 실동작: confirm 후 sold_count +1 + 게스트 소유 티켓
        sold_after = await _tier_sold(ctx["tier_paid"])
        check(sold_after == sold_before + 1,
              f"trg_sync_sold_count: confirm 후 sold_count {sold_before}→{sold_after}")
        async with async_session() as s:
            tk = (
                await s.execute(select(Ticket).where(Ticket.purchase_order_id == uuid.UUID(order_id)))
            ).scalars().all()
            check(len(tk) == 1, f"티켓 1장 발권 (got {len(tk)})")
            if tk:
                t0 = tk[0]
                check(t0.guest_owner_id is not None and t0.current_owner_id is None,
                      "ck_tickets_owner_not_both: guest_owner_id 세팅·current_owner_id=NULL")

        # view(PII 마스킹)
        r = await c.post(f"/api/v1/guests/orders/{order_id}/view", json={"view_token": view_token})
        check(r.status_code == 200, f"view 200 (got {r.status_code})")
        if r.status_code == 200:
            vb = r.json()
            raw = str(vb)
            check(gemail not in raw, "view PII 마스킹: 원본 이메일 미노출")
            check("010-9911-2233" not in raw, "view PII 마스킹: 원본 전화 미노출")

        # 환불 매직링크 발급 → 환불(W1 트랜잭션 경계)
        r = await c.post(f"/api/v1/guests/orders/{order_id}/tokens/refund", json={"view_token": view_token})
        check(r.status_code == 200, f"환불 토큰 발급 200 (got {r.status_code}: {r.text[:120]})")
        refund_token = r.json().get("raw_token") if r.status_code == 200 else None
        if refund_token:
            r = await c.post(f"/api/v1/guests/orders/{order_id}/refund", json={
                "refund_token": refund_token, "reason": "E2E 검증 환불",
            })
            check(r.status_code == 200, f"환불 실행 200 (got {r.status_code}: {r.text[:160]})")
            # 트리거 실동작: 환불(티켓 CANCELLED) 후 sold_count 감소
            sold_refunded = await _tier_sold(ctx["tier_paid"])
            check(sold_refunded == sold_before,
                  f"trg_sync_sold_count: 환불 후 sold_count {sold_after}→{sold_refunded}(원복)")
            # single-use: 재환불 거부
            r2 = await c.post(f"/api/v1/guests/orders/{order_id}/refund", json={
                "refund_token": refund_token, "reason": "재사용",
            })
            check(r2.status_code in (403, 400), f"환불 토큰 single-use 재사용 거부 (got {r2.status_code})")

        # ══ 2) 무료 게스트: 0원 → 즉시 confirmed(payment_method='free') ══
        print("\n[2] 무료 게스트 플로우")
        gfree = f"free_{E2E_MARK}{uuid.uuid4().hex[:6]}@test.pickket.kr"
        r = await c.post("/api/v1/guests/orders", json={
            "event_id": ctx["ev_free"],
            "items": [{"tier_id": ctx["tier_free"], "quantity": 1, "unit_price": 0}],
            "guest_buyer": {"email": gfree, "name": "무료게스트", "phone": "010-0000-1111"},
            "total_amount": 0,
            "idempotency_key": f"e2e-free-{uuid.uuid4().hex}",
        })
        ok = check(r.status_code == 200, f"무료 주문 생성 200 (got {r.status_code}: {r.text[:120]})")
        if ok:
            fb = r.json()
            check(fb["status"] == "confirmed", f"0원 즉시 confirmed (got {fb['status']})")
            async with async_session() as s:
                o = await s.get(Order, uuid.UUID(fb["order_id"]))
                check(o is not None and o.payment_method == "free",
                      f"무료 주문 payment_method='free' (got {o.payment_method if o else None})")
                ftk = (
                    await s.execute(select(Ticket).where(Ticket.purchase_order_id == o.id))
                ).scalars().all()
                check(len(ftk) == 1 and ftk[0].status.value == "active",
                      f"무료 티켓 ACTIVE 발권 (got {len(ftk)})")

        # ══ 3) claim: 유료 게스트(미체크인) → 회원 승격 ══
        print("\n[3] claim(회원 승격) 플로우")
        gclaim = f"claim_{E2E_MARK}{uuid.uuid4().hex[:6]}@test.pickket.kr"
        r = await c.post("/api/v1/guests/orders", json={
            "event_id": ctx["ev_paid"],
            "items": [{"tier_id": ctx["tier_paid"], "quantity": 1, "unit_price": 50000}],
            "guest_buyer": {"email": gclaim, "name": "승격대상", "phone": "010-5555-6666"},
            "total_amount": 50000,
            "idempotency_key": f"e2e-claim-{uuid.uuid4().hex}",
        })
        if check(r.status_code == 200, f"claim 대상 주문 생성 200 (got {r.status_code})"):
            cb = r.json()
            corder = cb["order_id"]
            cview = cb["view_token"]
            # confirm(티켓 발권 필요 — claim rebind 대상)
            await c.post(f"/api/v1/guests/orders/{corder}/confirm", json={
                "view_token": cview, "pg_provider": "toss",
                "pg_transaction_id": f"e2e_claim_{uuid.uuid4().hex[:10]}", "amount": 50000,
            })
            # claim 토큰 발급
            r = await c.post(f"/api/v1/guests/orders/{corder}/tokens/claim", json={"view_token": cview})
            claim_token = r.json().get("raw_token") if r.status_code == 200 else None
            check(claim_token is not None, f"claim 토큰 발급 (got {r.status_code})")
            if claim_token:
                # 무인증 claim → 401
                r_noauth = await c.post(f"/api/v1/guests/orders/{corder}/claim", json={"claim_token": claim_token})
                check(r_noauth.status_code == 401, f"무인증 claim 401 (got {r_noauth.status_code})")
            if claim_token and not redis_ok:
                print("  ⏭ Redis 없음 — 회원세션 claim(rebind) 단계 스킵")
            if claim_token and redis_ok:
                # 회원 세션으로 claim
                token = create_access_token(subject=ctx["member_id"])
                r = await c.post(
                    f"/api/v1/guests/orders/{corder}/claim",
                    json={"claim_token": claim_token},
                    headers={"Authorization": f"Bearer {token}"},
                )
                check(r.status_code == 200, f"회원 세션 claim 200 (got {r.status_code}: {r.text[:160]})")
                # rebind 실동작: order.user_id 세팅·guest_id NULL, 티켓 current_owner_id 세팅·guest_owner_id NULL
                async with async_session() as s:
                    o = await s.get(Order, uuid.UUID(corder))
                    check(o is not None and str(o.user_id) == ctx["member_id"] and o.guest_id is None,
                          "claim rebind: order.user_id 세팅·guest_id=NULL(XOR 뒤집힘)")
                    tk = (
                        await s.execute(select(Ticket).where(Ticket.purchase_order_id == uuid.UUID(corder)))
                    ).scalars().all()
                    if tk:
                        check(str(tk[0].current_owner_id) == ctx["member_id"] and tk[0].guest_owner_id is None,
                              "claim rebind: ticket current_owner_id 세팅·guest_owner_id=NULL")
                    g = (
                        await s.execute(select(Guest).where(Guest.email == gclaim))
                    ).scalar_one_or_none()
                    check(g is not None and str(g.claimed_user_id) == ctx["member_id"],
                          "claim: guests.claimed_user_id 세팅")
                    tkt_ids = [t.id for t in tk] if tk else []
                    ot = 0
                    if tkt_ids:
                        ot = (
                            await s.execute(select(func.count(OwnershipTransfer.id)).where(
                                OwnershipTransfer.ticket_id.in_(tkt_ids)))
                        ).scalar_one()
                    check(ot >= 1, f"OwnershipTransfer(GUEST_CLAIM) 원장 기록 (got {ot})")
                # 재클레임 거부
                r_re = await c.post(
                    f"/api/v1/guests/orders/{corder}/claim",
                    json={"claim_token": claim_token},
                    headers={"Authorization": f"Bearer {token}"},
                )
                check(r_re.status_code in (403, 404, 409), f"재클레임 거부 (got {r_re.status_code})")

        # ══ 4) opt-in 게이트: OFF 이벤트 → 403 ══
        print("\n[4] opt-in 게이트")
        r = await c.post("/api/v1/guests/orders", json={
            "event_id": ctx["ev_off"],
            "items": [{"tier_id": ctx["tier_off"], "quantity": 1, "unit_price": 30000}],
            "guest_buyer": {"email": f"off_{E2E_MARK}@test.pickket.kr", "name": "차단", "phone": "010-1-2"},
            "total_amount": 30000,
            "idempotency_key": f"e2e-off-{uuid.uuid4().hex}",
        })
        check(r.status_code == 403, f"opt-in OFF 이벤트 게스트 주문 403 (got {r.status_code}: {r.text[:120]})")

    app.dependency_overrides.clear()


async def main() -> int:
    from app.core.config import settings

    if settings.ENVIRONMENT == "production":
        print("🚫 production 에서 실행 금지(dev DB 전용).")
        return 2

    print(f"{'='*56}\n  게스트 결제 E2E — 실 dev postgres(관문 2)\n{'='*56}")
    print(f"  ENVIRONMENT={settings.ENVIRONMENT}")

    # Redis 초기화 — get_current_user 의 토큰 블랙리스트 조회가 Redis 를 요구(claim 회원세션).
    # 미초기화 시 claim 이 503(Auth degraded)로 떨어진다. dev redis(6381) 사용.
    redis_ok = False
    try:
        from app.core.redis import init_redis, close_redis
        await init_redis()
        redis_ok = True
        print("  ✓ Redis 초기화(claim 회원세션 검증용)")
    except Exception as e:  # noqa: BLE001
        print(f"  ⚠ Redis 초기화 실패 — claim 회원세션 단계는 스킵됩니다: {e}")

    await _teardown()  # 이전 잔재 정리(멱등)
    ctx = await _setup()
    try:
        await run_e2e(ctx, redis_ok=redis_ok)
    finally:
        await _teardown()
        if redis_ok:
            try:
                await close_redis()
            except Exception:  # noqa: BLE001
                pass

    passed = sum(1 for ok, _ in _results if ok)
    total = len(_results)
    print(f"\n{'='*56}")
    print(f"  결과: {passed}/{total} pass")
    if passed != total:
        print("  실패 항목:")
        for ok, lbl in _results:
            if not ok:
                print(f"    ❌ {lbl}")
    print(f"{'='*56}\n")
    return 0 if passed == total else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
