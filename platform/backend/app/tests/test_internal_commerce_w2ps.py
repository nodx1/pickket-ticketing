"""W2-PS — go `products` / `seat_tiers` 흡수 계약 회귀 (레벨2 컷오버 wave2).

여기서 고정하는 것:
  1. `stock_limit` 왕복 — NULL(무제한) / 0(재고없음) / N 이 손실 없이 되읽힌다.
     `capacity` 는 거기서 파생된 집행값이다.
  2. `capacity = 0` 허용 — 종전 `gt=0` 계약이 좌석등급 생성(정원은 배치도가 나중에 채움)을
     422 로 막고 있었고, 상품 재고 0 을 무제한(1,000,000)으로 승격시켜 **초과판매**를 열었다.
  3. 빌더/뷰 메타(color_hex·seat_map_id·tier_metadata·view_*)가 upsert→read 로 왕복한다.
  4. 명시 null 반영 — `model_fields_set` 기반이라 "무제한으로 되돌리기"가 표현된다.
     반대로 **키를 안 보내면 보존**(옛 호출자 무영향).
  5. `DELETE /tiers/{ref}` — 미존재 404 / 판매분 409 / 좌석 409 / 정상 삭제.
"""

import uuid

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.event import SeatTier
from app.models.organizer import OrganizerProfile
from app.models.seat import Seat, SeatStatus
from app.models.user import User

pytestmark = pytest.mark.asyncio

_SECRET = "test_go_webhook_secret_w2ps"
_HDR = {"x-pickket-service-token": _SECRET}


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)


async def _seed_organizer(db_session, go_account_id="go_org_w2ps") -> User:
    user = User(
        email=f"{go_account_id}@org.test",
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


async def _create_event(client, go_account_id="go_org_w2ps") -> str:
    body = {
        "organizer_ref": {"go_account_id": go_account_id},
        "external_ref": f"go_evt_{uuid.uuid4().hex[:8]}",
        "title": "W2-PS 테스트",
        "venue": "홀",
        "category": "concert",
        "event_date": "2026-08-20T19:00:00+09:00",
        "sale_window": {
            "opens_at": "2026-07-01T10:00:00+09:00",
            "closes_at": "2026-07-10T23:59:59+09:00",
        },
        "sale_channels": ["self"],
        "status": "draft",
    }
    r = await client.post(
        "/api/v1/internal/events",
        json=body,
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]["event_id"]


async def _upsert(client, eid, tier: dict, replace=False):
    return await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [tier], "replace": replace},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )


async def _read(client, eid, ref):
    r = await client.get(f"/api/v1/internal/events/{eid}/tiers", headers=_HDR)
    assert r.status_code == 200, r.text
    return next((t for t in r.json()["data"]["tiers"] if t["external_ref"] == ref), None)


# ── 1) stock_limit 왕복 ─────────────────────────────────────────────────


async def test_stock_limit_unlimited_roundtrip(client, db_session):
    """무제한(null) → capacity sentinel, 되읽으면 stock_limit 은 다시 null."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await _upsert(client, eid, {
        "external_ref": "p_unl", "name": "무제한권", "capacity": 1,
        "base_price": 1000, "stock_limit": None,
    })
    assert r.status_code == 200, r.text
    row = await _read(client, eid, "p_unl")
    assert row["stock_limit"] is None
    assert row["capacity"] == 1_000_000  # 집행값은 sentinel


async def test_stock_limit_finite_roundtrip(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert(client, eid, {
        "external_ref": "p_50", "name": "50석", "capacity": 999,
        "base_price": 1000, "stock_limit": 50,
    })
    row = await _read(client, eid, "p_50")
    # stock_limit 을 보냈으면 그것이 정본 — capacity 인자는 무시된다.
    assert row["stock_limit"] == 50
    assert row["capacity"] == 50


async def test_stock_zero_is_not_promoted_to_unlimited(client, db_session):
    """🔴 초과판매 결함 회귀 — 재고 0 이 무제한(1,000,000)으로 승격되면 안 된다."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await _upsert(client, eid, {
        "external_ref": "p_zero", "name": "품절권", "capacity": 0,
        "base_price": 1000, "stock_limit": 0,
    })
    assert r.status_code == 200, r.text
    row = await _read(client, eid, "p_zero")
    assert row["stock_limit"] == 0
    assert row["capacity"] == 0
    assert row["capacity"] != 1_000_000


async def test_capacity_zero_accepted_for_seat_tier(client, db_session):
    """좌석등급은 정원 0 으로 먼저 만들어지고 배치도가 나중에 채운다(종전 422 → 200)."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await _upsert(client, eid, {
        "external_ref": "t_new", "name": "VIP", "capacity": 0, "base_price": 50000,
    })
    assert r.status_code == 200, r.text
    assert (await _read(client, eid, "t_new"))["capacity"] == 0


async def test_stock_limit_not_sent_preserves_existing(client, db_session):
    """키를 안 보낸 옛 호출자(좌석 빌더·resync)는 기존 stock_limit 을 지우지 않는다."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert(client, eid, {
        "external_ref": "p_keep", "name": "A", "capacity": 10,
        "base_price": 1000, "stock_limit": 10,
    })
    # stock_limit 없이 재전송 → capacity 인자가 그대로 집행되고 stock_limit 은 보존
    await _upsert(client, eid, {
        "external_ref": "p_keep", "name": "A2", "capacity": 20, "base_price": 1000,
    })
    row = await _read(client, eid, "p_keep")
    assert row["name"] == "A2"
    assert row["capacity"] == 20
    assert row["stock_limit"] == 10


async def test_stock_limit_explicit_null_returns_to_unlimited(client, db_session):
    """명시 null 은 '무제한으로 되돌리기'로 반영된다(None-보존 규칙으론 불가능한 조작)."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert(client, eid, {
        "external_ref": "p_back", "name": "A", "capacity": 10,
        "base_price": 1000, "stock_limit": 10,
    })
    await _upsert(client, eid, {
        "external_ref": "p_back", "name": "A", "capacity": 10,
        "base_price": 1000, "stock_limit": None,
    })
    row = await _read(client, eid, "p_back")
    assert row["stock_limit"] is None
    assert row["capacity"] == 1_000_000


# ── 2) 빌더/뷰 메타 왕복 ────────────────────────────────────────────────


async def test_builder_and_view_meta_roundtrip(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    map_id = str(uuid.uuid4())
    r = await _upsert(client, eid, {
        "external_ref": "t_meta", "name": "VIP", "capacity": 10, "base_price": 50000,
        "color_hex": "#6C5CE7", "seat_map_id": map_id,
        "tier_metadata": {"go_source": "seat_tier", "product_id": "prod-x"},
        "sort_order": 3, "section_name": "A",
        "view_description": "무대 정면", "distance_from_stage": 12, "view_rating": 5,
        "view_image_url": "https://cdn.example.com/v.png", "position_label": "1층 중앙",
        "resale_allowed": False, "resale_max_price": 70000,
        "allow_group_tickets": False, "max_group_size": 2,
    })
    assert r.status_code == 200, r.text
    row = await _read(client, eid, "t_meta")
    assert row["color_hex"] == "#6C5CE7"
    assert row["seat_map_id"] == map_id
    assert row["tier_metadata"] == {"go_source": "seat_tier", "product_id": "prod-x"}
    assert row["sort_order"] == 3
    assert row["section_name"] == "A"
    assert row["view_description"] == "무대 정면"
    assert row["distance_from_stage"] == 12
    assert row["view_rating"] == 5
    assert row["view_image_url"] == "https://cdn.example.com/v.png"
    assert row["position_label"] == "1층 중앙"
    assert row["resale_allowed"] is False
    assert row["resale_max_price"] == 70000
    assert row["allow_group_tickets"] is False
    assert row["max_group_size"] == 2


async def test_meta_not_sent_is_preserved(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert(client, eid, {
        "external_ref": "t_p", "name": "VIP", "capacity": 10, "base_price": 1,
        "color_hex": "#111111", "description": "설명",
    })
    await _upsert(client, eid, {
        "external_ref": "t_p", "name": "VIP2", "capacity": 10, "base_price": 1,
    })
    row = await _read(client, eid, "t_p")
    assert row["color_hex"] == "#111111"
    assert row["description"] == "설명"


# ── 3) DELETE /tiers/{ref} ─────────────────────────────────────────────


async def test_delete_tier_by_external_ref(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert(client, eid, {
        "external_ref": "t_del", "name": "삭제대상", "capacity": 5, "base_price": 1000,
    })
    r = await client.delete(f"/api/v1/internal/events/{eid}/tiers/t_del", headers=_HDR)
    assert r.status_code == 200, r.text
    assert r.json()["data"]["deleted"] is True
    assert await _read(client, eid, "t_del") is None


async def test_delete_tier_missing_is_404_not_silent_success(client, db_session):
    """🔴 '이미 없음'을 200 으로 흡수하지 않는다 — 호출측이 멱등 판단을 해야 한다."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await client.delete(f"/api/v1/internal/events/{eid}/tiers/nope", headers=_HDR)
    assert r.status_code == 404, r.text


async def test_delete_tier_cross_event_is_404(client, db_session):
    """다른 이벤트의 티어는 지울 수 없다(크로스이벤트 조작 차단)."""
    await _seed_organizer(db_session)
    eid_a = await _create_event(client)
    eid_b = await _create_event(client)
    await _upsert(client, eid_a, {
        "external_ref": "t_a", "name": "A", "capacity": 1, "base_price": 1,
    })
    r = await client.delete(f"/api/v1/internal/events/{eid_b}/tiers/t_a", headers=_HDR)
    assert r.status_code == 404, r.text
    assert await _read(client, eid_a, "t_a") is not None  # 보존


async def test_delete_tier_with_sales_is_409(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert(client, eid, {
        "external_ref": "t_sold", "name": "판매됨", "capacity": 10, "base_price": 1000,
    })
    tier = (
        await db_session.execute(select(SeatTier).where(SeatTier.external_ref == "t_sold"))
    ).scalar_one()
    tier.sold_count = 3
    await db_session.commit()

    r = await client.delete(f"/api/v1/internal/events/{eid}/tiers/t_sold", headers=_HDR)
    assert r.status_code == 409, r.text
    assert await _read(client, eid, "t_sold") is not None


async def test_delete_tier_with_seats_is_409(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert(client, eid, {
        "external_ref": "t_seats", "name": "좌석있음", "capacity": 10, "base_price": 1000,
    })
    tier = (
        await db_session.execute(select(SeatTier).where(SeatTier.external_ref == "t_seats"))
    ).scalar_one()
    db_session.add(
        Seat(
            event_id=uuid.UUID(eid),
            tier_id=tier.id,
            section="A",
            row_number=1,
            seat_number=1,
            status=SeatStatus.AVAILABLE,
        )
    )
    await db_session.commit()

    r = await client.delete(f"/api/v1/internal/events/{eid}/tiers/t_seats", headers=_HDR)
    assert r.status_code == 409, r.text


async def test_shrink_below_sold_count_is_409(client, db_session):
    """재고를 판매수 아래로 줄이는 건 계속 막힌다(초과판매 방지 불변식)."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert(client, eid, {
        "external_ref": "t_s", "name": "S", "capacity": 10, "base_price": 1000,
    })
    tier = (
        await db_session.execute(select(SeatTier).where(SeatTier.external_ref == "t_s"))
    ).scalar_one()
    tier.sold_count = 4
    await db_session.commit()

    r = await _upsert(client, eid, {
        "external_ref": "t_s", "name": "S", "capacity": 999,
        "base_price": 1000, "stock_limit": 0,
    })
    assert r.status_code == 409, r.text


# ── max_per_order 해제(무제한 복귀) ────────────────────────────────────────
#
# 🔴 2026-08-01: `max_per_order` 가 `_TIER_META_FIELDS`(None=보존 규칙)에 있어
#    **한번 상한을 걸면 해제할 수 없었다.** 화면에는 "제한 없음"으로 보이는데 원장에는
#    옛 상한이 남는다. go 는 빈칸을 null 로 보낸다(`products/[productId]/route.ts:138`)라
#    정확히 이 경로로 도달한다.
#
#    ⚠️ 집행 범위: 이 상한을 실제로 강제하는 코드는 **go 주문 경로 한 곳**뿐이다
#    (`organizer/src/lib/server/orders.ts`). v2 통합 결제 경로·consumer 에는 집행 코드가
#    없다(전수 grep 0건). 즉 "구매자가 막힌다"는 go 경로(초대권·RSVP·수동주문)에서만
#    성립한다 — 원장 정합성 문제는 어느 경로든 동일하다.


async def test_max_per_order_can_be_cleared(client, db_session):
    """🔴 상한을 걸었다가 null 로 해제할 수 있다."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert(client, eid, {
        "external_ref": "p_cap", "name": "상한권", "capacity": 100,
        "base_price": 1000, "max_per_order": 2,
    })
    assert (await _read(client, eid, "p_cap"))["max_per_order"] == 2

    r = await _upsert(client, eid, {
        "external_ref": "p_cap", "name": "상한권", "capacity": 100,
        "base_price": 1000, "max_per_order": None,
    })
    assert r.status_code == 200, r.text
    assert (await _read(client, eid, "p_cap"))["max_per_order"] is None   # 🔴 종전엔 2 가 남았다


async def test_max_per_order_unsent_is_preserved(client, db_session):
    """무회귀: 안 보낸 필드는 보존된다."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert(client, eid, {
        "external_ref": "p_keep", "name": "상한권", "capacity": 100,
        "base_price": 1000, "max_per_order": 3,
    })
    await _upsert(client, eid, {
        "external_ref": "p_keep", "name": "이름만 변경", "capacity": 100, "base_price": 1000,
    })
    row = await _read(client, eid, "p_keep")
    assert row["name"] == "이름만 변경"
    assert row["max_per_order"] == 3          # 보존


async def test_max_per_order_change_still_works(client, db_session):
    """무회귀: 상한 변경."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert(client, eid, {
        "external_ref": "p_chg", "name": "상한권", "capacity": 100,
        "base_price": 1000, "max_per_order": 2,
    })
    await _upsert(client, eid, {
        "external_ref": "p_chg", "name": "상한권", "capacity": 100,
        "base_price": 1000, "max_per_order": 5,
    })
    assert (await _read(client, eid, "p_chg"))["max_per_order"] == 5


async def test_image_url_null_does_not_wipe(client, db_session):
    """🔴 `image_url` 은 **여전히 None-보존**이어야 한다 (데이터 유실 방지).

    go 상품 라우트가 `imageUrl: body.imageUrl ?? null` 로 **항상** 싣는데 상품 폼에는
    그 입력칸이 없다 ⟹ 저장할 때마다 `image_url: null` 이 온다. 지금은 None-보존 규칙이
    그걸 버려서 데이터를 지켜준다. NULLABLE 목록으로 옮기면 **저장할 때마다 이미지가
    삭제된다.** 그 이동을 막는 가드다 — go 를 먼저 고쳐야 옮길 수 있다.
    """
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert(client, eid, {
        "external_ref": "p_img", "name": "이미지권", "capacity": 100,
        "base_price": 1000, "image_url": "https://cdn.example/a.png",
    })
    assert (await _read(client, eid, "p_img"))["image_url"] == "https://cdn.example/a.png"

    # 폼에 없는 필드가 null 로 딸려오는 상황을 그대로 재현
    r = await _upsert(client, eid, {
        "external_ref": "p_img", "name": "이미지권", "capacity": 100,
        "base_price": 1000, "image_url": None,
    })
    assert r.status_code == 200, r.text
    assert (await _read(client, eid, "p_img"))["image_url"] == "https://cdn.example/a.png"


async def test_max_per_order_null_actively_clears_on_reupsert(client, db_session):
    """🔴 이번 이동으로 생긴 **행동 변화**를 고정한다 (2026-08-01 감사 지적).

    `max_per_order: null` 을 실은 upsert 는 이제 **능동적으로 상한을 해제**한다.
    종전(None-보존)에는 no-op 이었다.

    go `ensureFreeProduct`(`lib/server/rsvp-product.ts`)가 hidden 상품을 보증할 때
    `maxPerOrder: null` 을 **항상** 싣는다 ⟹ 그 함수가 돌 때마다 해당 상품의 상한이
    NULL 로 강제된다. 그 함수가 선언하는 의도값이 곧 null 이라 무해하지만,
    "no-op 이었다가 능동 소거로 바뀐 것" 은 명시적으로 못 박아 둔다.
    (prod 실측: hidden 상품 '초대권' 의 상한은 이미 무제한이라 잃을 값이 없다.)
    """
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await _upsert(client, eid, {
        "external_ref": "p_hidden", "name": "초대권", "capacity": 100,
        "base_price": 0, "max_per_order": 4, "visibility": "hidden",
    })
    assert (await _read(client, eid, "p_hidden"))["max_per_order"] == 4

    # ensureFreeProduct 가 보내는 모양 — 상한 칸이 없어 항상 null 이 실린다
    r = await _upsert(client, eid, {
        "external_ref": "p_hidden", "name": "초대권", "capacity": 100,
        "base_price": 0, "max_per_order": None, "visibility": "hidden",
    })
    assert r.status_code == 200, r.text
    assert (await _read(client, eid, "p_hidden"))["max_per_order"] is None
