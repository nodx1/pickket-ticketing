"""W5-COMMERCE — go 상거래 부가기능 흡수 계약 회귀 (레벨2 컷오버 wave5).

여기서 고정하는 것(전부 "틀리면 돈이 틀어지는" 경로):

  1. 프로모코드 CRUD — 생성/목록/부분수정/삭제, 중복 409, 삭제 후 부활 시 **used_count 보존**
     (초기화하면 삭제→재생성으로 사용 한도를 무한 우회할 수 있다).
  2. 프로모코드 검증(validate) — 할인액이 주문 생성과 **같은 함수**로 계산되고,
     검증은 used_count 를 **차감하지 않으며**, 한도 초과·만료·비활성은 여기서도 막힌다.
  3. 삭제한 코드는 `is_active=False` 가 함께 세팅돼 **주문 경로에서도 즉시 거부**된다.
  4. 단체예약 상태 전이 — pending→confirmed 1회만(재승인 409), 취소 후 부활 불가.
  5. 환불 정책 — go 에 없던 write 경로(PUT)가 실제로 저장하고 되읽힌다. daysBefore 중복 거부.
  6. 동적 가격 규칙 CRUD + 가격 이력이 **티어 가격 변경 시 실제로 기록**된다
     (go 에서는 writer 가 0이라 화면이 늘 비어 있었다).
"""

import uuid

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.discount_code import DiscountCode

pytestmark = pytest.mark.asyncio

_SECRET = "test_go_webhook_secret_w5com"
_HDR = {"x-pickket-service-token": _SECRET}


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)


def _idem() -> dict:
    return {**_HDR, "Idempotency-Key": str(uuid.uuid4())}


async def _seed_organizer(db_session, go_account_id="go_org_w5com"):
    from app.models.organizer import OrganizerProfile
    from app.models.user import User

    user = User(
        email=f"{go_account_id}-{uuid.uuid4().hex[:6]}@org.test",
        hashed_password="!x!",
        name="주최자",
        is_organizer=True,
    )
    db_session.add(user)
    await db_session.flush()
    db_session.add(
        OrganizerProfile(
            user_id=user.id,
            company_name="테스트 주최",
            contact_email="org@test.com",
            go_account_id=go_account_id,
        )
    )
    await db_session.commit()
    return user


async def _create_event(client, go_account_id="go_org_w5com") -> str:
    body = {
        "organizer_ref": {"go_account_id": go_account_id},
        "external_ref": f"go_evt_{uuid.uuid4().hex[:8]}",
        "title": "W5-COMMERCE 테스트",
        "venue": "홀",
        "category": "concert",
        "event_date": "2026-09-20T19:00:00+09:00",
        "sale_window": {
            "opens_at": "2026-08-01T10:00:00+09:00",
            "closes_at": "2026-09-10T23:59:59+09:00",
        },
        "sale_channels": ["self"],
        "status": "draft",
    }
    r = await client.post("/api/v1/internal/events", json=body, headers=_idem())
    assert r.status_code == 200, r.text
    return r.json()["data"]["event_id"]


async def _upsert_tier(client, eid, ref="p_main", price=10000, name="일반권"):
    r = await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={
            "tiers": [
                {
                    "external_ref": ref,
                    "name": name,
                    "capacity": 100,
                    "base_price": price,
                    "sale_mode": "fixed_fcfs",
                }
            ]
        },
        headers=_idem(),
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]["tiers"][0]["tier_id"]


async def _create_promo(client, eid, **over):
    body = {
        "code": "EARLY20",
        "promo_type": "percentage",
        "discount_value": 20,
        "usage_limit": None,
        "is_active": True,
    }
    body.update(over)
    return await client.post(
        f"/api/v1/internal/events/{eid}/promo-codes", json=body, headers=_idem()
    )


# ══════════════════════════════════════════════════════════════════════
# 1) 프로모코드 CRUD
# ══════════════════════════════════════════════════════════════════════


async def test_promo_create_list_patch_delete(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)

    r = await _create_promo(client, eid)
    assert r.status_code == 200, r.text
    promo = r.json()["data"]
    assert promo["code"] == "EARLY20"
    assert promo["promo_type"] == "percentage"
    assert promo["discount_value"] == 20
    assert promo["used_count"] == 0
    pid = promo["promo_id"]

    r = await client.get(f"/api/v1/internal/events/{eid}/promo-codes", headers=_HDR)
    assert r.status_code == 200
    assert r.json()["data"]["total"] == 1

    # 부분 수정 — 안 보낸 필드는 보존된다.
    r = await client.patch(
        f"/api/v1/internal/events/{eid}/promo-codes/{pid}",
        json={"is_active": False},
        headers=_idem(),
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["is_active"] is False
    assert r.json()["data"]["discount_value"] == 20  # 보존

    # 삭제 → 목록에서 사라진다.
    r = await client.delete(f"/api/v1/internal/events/{eid}/promo-codes/{pid}", headers=_HDR)
    assert r.status_code == 200, r.text
    r = await client.get(f"/api/v1/internal/events/{eid}/promo-codes", headers=_HDR)
    assert r.json()["data"]["total"] == 0

    # 🔴 "이미 없음"을 200 으로 흡수하지 않는다.
    r = await client.delete(f"/api/v1/internal/events/{eid}/promo-codes/{pid}", headers=_HDR)
    assert r.status_code == 404


async def test_promo_duplicate_code_conflicts(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    assert (await _create_promo(client, eid)).status_code == 200
    r = await _create_promo(client, eid)
    assert r.status_code == 409, r.text


async def test_promo_percentage_range_enforced(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await _create_promo(client, eid, discount_value=120)
    assert r.status_code == 400


async def test_promo_type_and_value_must_change_together(client, db_session):
    """정액 5000원 코드에 promo_type=percentage 만 보내면 '5000%' 가 된다 → 400."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await _create_promo(client, eid, code="FLAT5000", promo_type="fixed", discount_value=5000)
    pid = r.json()["data"]["promo_id"]
    r = await client.patch(
        f"/api/v1/internal/events/{eid}/promo-codes/{pid}",
        json={"promo_type": "percentage"},
        headers=_idem(),
    )
    assert r.status_code == 400, r.text


async def test_promo_type_switch_clears_other_column(client, db_session):
    """percentage→fixed 전환 시 rate 가 남아 있으면 안 된다(되돌릴 때 유령 할인)."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    pid = (await _create_promo(client, eid)).json()["data"]["promo_id"]
    r = await client.patch(
        f"/api/v1/internal/events/{eid}/promo-codes/{pid}",
        json={"promo_type": "fixed", "discount_value": 3000},
        headers=_idem(),
    )
    assert r.status_code == 200, r.text
    row = (
        await db_session.execute(select(DiscountCode).where(DiscountCode.id == uuid.UUID(pid)))
    ).scalar_one()
    assert row.rate is None
    assert float(row.amount) == 3000


async def test_promo_resurrect_preserves_used_count(client, db_session):
    """🔴 삭제→재생성으로 사용 한도를 우회할 수 없다 — used_count 는 보존된다."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    pid = (await _create_promo(client, eid, usage_limit=5)).json()["data"]["promo_id"]

    row = (
        await db_session.execute(select(DiscountCode).where(DiscountCode.id == uuid.UUID(pid)))
    ).scalar_one()
    row.used_count = 3
    await db_session.commit()

    assert (
        await client.delete(f"/api/v1/internal/events/{eid}/promo-codes/{pid}", headers=_HDR)
    ).status_code == 200
    r = await _create_promo(client, eid, usage_limit=5)
    assert r.status_code == 200, r.text
    assert r.json()["data"]["used_count"] == 3


async def test_promo_delete_also_deactivates(client, db_session):
    """🔴 deleted_at 만 찍으면 주문 경로(is_active 만 봄)에서 삭제한 코드가 계속 먹는다."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    pid = (await _create_promo(client, eid)).json()["data"]["promo_id"]
    await client.delete(f"/api/v1/internal/events/{eid}/promo-codes/{pid}", headers=_HDR)
    row = (
        await db_session.execute(select(DiscountCode).where(DiscountCode.id == uuid.UUID(pid)))
    ).scalar_one()
    assert row.is_active is False
    assert row.deleted_at is not None


# ══════════════════════════════════════════════════════════════════════
# 2) 프로모코드 검증(validate) — 금액 정확성 + 차감 없음
# ══════════════════════════════════════════════════════════════════════


async def _validate(client, eid, code, gross):
    return await client.post(
        f"/api/v1/internal/events/{eid}/promo-codes/validate",
        json={"code": code, "gross_amount": gross},
        headers=_HDR,
    )


async def test_validate_percentage_amount(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _create_promo(client, eid)  # 20%
    r = await _validate(client, eid, "EARLY20", 50000)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["discount_amount"] == 10000
    assert d["final_amount"] == 40000


async def test_validate_fixed_amount_and_floor_at_zero(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _create_promo(client, eid, code="FLAT", promo_type="fixed", discount_value=9000)
    r = await _validate(client, eid, "FLAT", 5000)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    # 정액이 주문액보다 크면 최종 결제액은 0 으로 바닥친다(음수 금지).
    assert d["final_amount"] == 0


async def test_validate_does_not_consume_usage(client, db_session):
    """🔴 검증이 차감하면 결제까지 안 간 조회가 한도를 갉아먹고 재시도가 2회 차감된다."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    pid = (await _create_promo(client, eid, usage_limit=1)).json()["data"]["promo_id"]
    for _ in range(3):
        assert (await _validate(client, eid, "EARLY20", 10000)).status_code == 200
    row = (
        await db_session.execute(select(DiscountCode).where(DiscountCode.id == uuid.UUID(pid)))
    ).scalar_one()
    assert row.used_count == 0


async def test_validate_rejects_unknown_inactive_expired_exhausted(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)

    assert (await _validate(client, eid, "NOPE", 10000)).status_code == 404

    pid = (await _create_promo(client, eid, usage_limit=1)).json()["data"]["promo_id"]

    # 한도 초과 → 409 (검증 단계에서도 막는다: "일단 통과"시키면 화면만 할인되고 결제가 실패)
    row = (
        await db_session.execute(select(DiscountCode).where(DiscountCode.id == uuid.UUID(pid)))
    ).scalar_one()
    row.used_count = 1
    await db_session.commit()
    assert (await _validate(client, eid, "EARLY20", 10000)).status_code == 409

    # 만료
    row.used_count = 0
    await db_session.commit()
    await client.patch(
        f"/api/v1/internal/events/{eid}/promo-codes/{pid}",
        json={"ends_at": "2020-01-01T00:00:00+09:00"},
        headers=_idem(),
    )
    assert (await _validate(client, eid, "EARLY20", 10000)).status_code == 400

    # 비활성 → 미존재와 동일 취급(404)
    await client.patch(
        f"/api/v1/internal/events/{eid}/promo-codes/{pid}",
        json={"ends_at": None, "is_active": False},
        headers=_idem(),
    )
    assert (await _validate(client, eid, "EARLY20", 10000)).status_code == 404


async def test_validate_rejects_soft_deleted_code(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    pid = (await _create_promo(client, eid)).json()["data"]["promo_id"]
    await client.delete(f"/api/v1/internal/events/{eid}/promo-codes/{pid}", headers=_HDR)
    assert (await _validate(client, eid, "EARLY20", 10000)).status_code == 404


# ══════════════════════════════════════════════════════════════════════
# 3) 단체예약
# ══════════════════════════════════════════════════════════════════════


async def _create_booking(client, eid, ref="p_main", **over):
    body = {
        "product_ref": ref,
        "organization_name": "테스트 학교",
        "contact_name": "김담당",
        "contact_email": "group@test.com",
        "attendee_count": 20,
    }
    body.update(over)
    return await client.post(
        f"/api/v1/internal/events/{eid}/group-bookings", json=body, headers=_idem()
    )


async def test_group_booking_create_and_list(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert_tier(client, eid)
    r = await _create_booking(client, eid)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["status"] == "pending"
    # 상품명/가격은 v2 티어 카탈로그에서 해석된다(0원 위장 금지).
    assert d["product_name"] == "일반권"
    assert d["product_price"] == 10000

    r = await client.get(f"/api/v1/internal/events/{eid}/group-bookings", headers=_HDR)
    assert r.status_code == 200
    assert r.json()["data"]["total"] == 1


async def test_group_booking_unknown_product_404(client, db_session):
    """존재하지 않는 상품으로 신청되면 승인 시점에 금액을 산정할 수 없다 → 입구에서 차단."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await _create_booking(client, eid, ref="ghost")
    assert r.status_code == 404, r.text


async def test_group_booking_approve_once_only(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert_tier(client, eid)
    bid = (await _create_booking(client, eid)).json()["data"]["booking_id"]

    r = await client.patch(
        f"/api/v1/internal/events/{eid}/group-bookings/{bid}",
        json={
            "status": "confirmed",
            "discount_rate": 10,
            "order_ref": "go-order-1",
            "order_number": "ORD-1",
            "approved_by_ref": "u1",
        },
        headers=_idem(),
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["status"] == "confirmed"
    assert r.json()["data"]["order_ref"] == "go-order-1"

    # 재승인 = v2 주문 중복 생성 위험 → 409
    r = await client.patch(
        f"/api/v1/internal/events/{eid}/group-bookings/{bid}",
        json={"status": "confirmed"},
        headers=_idem(),
    )
    assert r.status_code == 409, r.text


async def test_group_booking_cancel_is_terminal(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert_tier(client, eid)
    bid = (await _create_booking(client, eid)).json()["data"]["booking_id"]

    r = await client.patch(
        f"/api/v1/internal/events/{eid}/group-bookings/{bid}",
        json={"status": "cancelled", "rejection_reason": "정원 초과"},
        headers=_idem(),
    )
    assert r.status_code == 200, r.text

    # 재취소·부활 전부 409
    for target in ("cancelled", "confirmed"):
        r = await client.patch(
            f"/api/v1/internal/events/{eid}/group-bookings/{bid}",
            json={"status": target},
            headers=_idem(),
        )
        assert r.status_code == 409, (target, r.text)


async def test_group_booking_not_found_404(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await client.get(
        f"/api/v1/internal/events/{eid}/group-bookings/{uuid.uuid4()}", headers=_HDR
    )
    assert r.status_code == 404


# ══════════════════════════════════════════════════════════════════════
# 4) 환불 정책 — go 에 없던 write 경로
# ══════════════════════════════════════════════════════════════════════


_RULES = [
    {"daysBefore": 10, "percent": 100, "label": "D-10 이전"},
    {"daysBefore": 3, "percent": 50, "label": "D-3 ~ D-10"},
    {"daysBefore": 0, "percent": 0, "label": "당일"},
]


async def test_refund_policy_absent_returns_null(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await client.get(f"/api/v1/internal/events/{eid}/refund-policy", headers=_HDR)
    assert r.status_code == 200, r.text
    assert r.json()["data"]["policy"] is None


async def test_refund_policy_put_then_read(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await client.put(
        f"/api/v1/internal/events/{eid}/refund-policy",
        json={"title": "특별 환불 규정", "refund_type": "partial", "rules": _RULES},
        headers=_idem(),
    )
    assert r.status_code == 200, r.text

    r = await client.get(f"/api/v1/internal/events/{eid}/refund-policy", headers=_HDR)
    policy = r.json()["data"]["policy"]
    assert policy["title"] == "특별 환불 규정"
    assert len(policy["rules"]) == 3
    assert policy["rules"][0]["daysBefore"] == 10
    assert policy["rules"][0]["percent"] == 100


async def test_refund_policy_put_is_upsert_single_row(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    for title in ("v1", "v2"):
        r = await client.put(
            f"/api/v1/internal/events/{eid}/refund-policy",
            json={"title": title, "rules": _RULES},
            headers=_idem(),
        )
        assert r.status_code == 200, r.text
    r = await client.get(f"/api/v1/internal/events/{eid}/refund-policy", headers=_HDR)
    assert r.json()["data"]["policy"]["title"] == "v2"


async def test_refund_policy_rejects_duplicate_days(client, db_session):
    """같은 경계에 두 규칙이 있으면 환불액이 정렬 안정성(=우연)에 좌우된다 → 400."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    dup = [
        {"daysBefore": 3, "percent": 100, "label": "A"},
        {"daysBefore": 3, "percent": 0, "label": "B"},
    ]
    r = await client.put(
        f"/api/v1/internal/events/{eid}/refund-policy",
        json={"title": "충돌", "rules": dup},
        headers=_idem(),
    )
    assert r.status_code == 400, r.text


async def test_refund_policy_delete(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await client.put(
        f"/api/v1/internal/events/{eid}/refund-policy",
        json={"title": "x", "rules": _RULES},
        headers=_idem(),
    )
    assert (
        await client.delete(f"/api/v1/internal/events/{eid}/refund-policy", headers=_HDR)
    ).status_code == 200
    # 없는 정책 삭제는 200 으로 흡수하지 않는다.
    assert (
        await client.delete(f"/api/v1/internal/events/{eid}/refund-policy", headers=_HDR)
    ).status_code == 404


# ══════════════════════════════════════════════════════════════════════
# 5) 동적 가격 규칙 · 가격 이력
# ══════════════════════════════════════════════════════════════════════


async def test_pricing_rule_crud(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert_tier(client, eid)

    r = await client.post(
        f"/api/v1/internal/events/{eid}/tiers/p_main/pricing-rules",
        json={"rule_type": "demand", "config": {"threshold": 0.8}, "priority": 5},
        headers=_idem(),
    )
    assert r.status_code == 200, r.text
    rule_id = r.json()["data"]["rule_id"]

    r = await client.get(
        f"/api/v1/internal/events/{eid}/tiers/p_main/pricing-rules", headers=_HDR
    )
    assert r.json()["data"]["total"] == 1
    assert r.json()["data"]["rules"][0]["config"] == {"threshold": 0.8}

    r = await client.delete(
        f"/api/v1/internal/events/{eid}/tiers/p_main/pricing-rules/{rule_id}", headers=_HDR
    )
    assert r.status_code == 200, r.text
    r = await client.delete(
        f"/api/v1/internal/events/{eid}/tiers/p_main/pricing-rules/{rule_id}", headers=_HDR
    )
    assert r.status_code == 404


async def test_pricing_rule_invalid_type_and_unknown_tier(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert_tier(client, eid)

    r = await client.post(
        f"/api/v1/internal/events/{eid}/tiers/p_main/pricing-rules",
        json={"rule_type": "vcg", "config": {}},
        headers=_idem(),
    )
    assert r.status_code == 400, r.text

    r = await client.get(
        f"/api/v1/internal/events/{eid}/tiers/ghost/pricing-rules", headers=_HDR
    )
    assert r.status_code == 404


async def test_price_history_records_tier_price_change(client, db_session):
    """🔴 go 에서는 writer 가 0이라 이력이 늘 비어 있었다 — v2 는 실제로 기록한다."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert_tier(client, eid, price=10000)

    r = await client.get(f"/api/v1/internal/events/{eid}/tiers/p_main/price-history", headers=_HDR)
    assert r.status_code == 200, r.text
    assert r.json()["data"]["total"] == 0  # 생성은 "변경"이 아니다

    await _upsert_tier(client, eid, price=12000)
    r = await client.get(f"/api/v1/internal/events/{eid}/tiers/p_main/price-history", headers=_HDR)
    hist = r.json()["data"]["history"]
    assert len(hist) == 1
    assert hist[0]["old_price"] == 10000
    assert hist[0]["new_price"] == 12000

    # 같은 값 재전송(정상 재시도)은 이력을 늘리지 않는다.
    await _upsert_tier(client, eid, price=12000)
    r = await client.get(f"/api/v1/internal/events/{eid}/tiers/p_main/price-history", headers=_HDR)
    assert r.json()["data"]["total"] == 1
