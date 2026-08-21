import pytest

from .conftest import (
    get_auth_token,
    auth_headers,
    create_event_as_organizer,
    register_user,
    set_fanclub_member,
)


async def _create_tier(client, event_id, token, **overrides):
    """Helper to create a tier on an event and return the tier data."""
    payload = {
        "name": overrides.get("name", "General Admission"),
        "capacity": overrides.get("capacity", 100),
        "base_price": overrides.get("base_price", 50.0),
        "sale_mode": overrides.get("sale_mode", "fixed_fcfs"),
        "face_price": overrides.get("face_price", 50.0),
        "fanclub_discount_pct": overrides.get("fanclub_discount_pct", 0.0),
    }
    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers",
        json=payload,
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, f"Tier creation failed: {resp.text}"
    return resp.json()


@pytest.mark.asyncio
async def test_fcfs_purchase_success(client):
    """FCFS purchase of 1 ticket succeeds (201)."""
    org_token = await get_auth_token(
        client, "porg1@test.com", "Password1!", "Purchase Org 1", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]
    tier = await _create_tier(client, event_id, org_token)
    tier_id = tier["id"]

    user_token = await get_auth_token(
        client, "buyer1@test.com", "Password1!", "Buyer One", is_organizer=False
    )
    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/purchase",
        json={"quantity": 1},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["success"] is True
    assert data["sale_mode"] == "fixed_fcfs"
    assert data["unit_price"] == 50.0
    assert data["total_price"] == 50.0
    assert len(data["ticket_ids"]) == 1
    assert data["order_id"] is not None


@pytest.mark.asyncio
async def test_direct_purchase_rejected_for_lottery_tier(client):
    """point_lottery 티어는 직접 FCFS 구매가 거부돼야 한다 (공정 추첨 우회 방지).

    라이브 시뮬레이션 회귀: point_lottery 티어에 /purchase 직접 호출이
    success=True + 0원 티켓을 발급하던 결함. sale_mode 가드로 차단.
    """
    org_token = await get_auth_token(
        client, "porg_lot@test.com", "Password1!", "Lottery Org", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]
    tier = await _create_tier(client, event_id, org_token, sale_mode="point_lottery")
    tier_id = tier["id"]

    user_token = await get_auth_token(
        client, "buyer_lot@test.com", "Password1!", "Lottery Buyer", is_organizer=False
    )
    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/purchase",
        json={"quantity": 1},
        headers=auth_headers(user_token),
    )
    data = resp.json()
    assert data["success"] is False
    assert data["order_id"] is None
    assert data["ticket_ids"] == []
    assert "point_lottery" in (data.get("message") or "")


@pytest.mark.asyncio
async def test_fcfs_purchase_multiple_quantity(client):
    """FCFS purchase of 2 tickets at once succeeds (201)."""
    org_token = await get_auth_token(
        client, "porg2@test.com", "Password1!", "Purchase Org 2", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]
    tier = await _create_tier(
        client, event_id, org_token, capacity=50, base_price=30.0, face_price=30.0
    )
    tier_id = tier["id"]

    user_token = await get_auth_token(
        client, "buyer2@test.com", "Password1!", "Buyer Two", is_organizer=False
    )
    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/purchase",
        json={"quantity": 2},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["success"] is True
    assert len(data["ticket_ids"]) == 2
    assert data["unit_price"] == 30.0
    assert data["total_price"] == 60.0


@pytest.mark.asyncio
async def test_fcfs_purchase_sold_out(client):
    """Purchasing more tickets than remaining capacity returns success=False (200)."""
    org_token = await get_auth_token(
        client, "porg3@test.com", "Password1!", "Purchase Org 3", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]
    tier = await _create_tier(
        client, event_id, org_token, capacity=2, base_price=20.0, face_price=20.0
    )
    tier_id = tier["id"]

    user_token = await get_auth_token(
        client, "buyer3@test.com", "Password1!", "Buyer Three", is_organizer=False
    )

    # Try to buy 3 tickets when only 2 are available
    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/purchase",
        json={"quantity": 3},
        headers=auth_headers(user_token),
    )
    # Router always returns 201, but response has success=False
    assert resp.status_code == 201
    data = resp.json()
    assert data["success"] is False


@pytest.mark.asyncio
async def test_fcfs_purchase_without_auth(client):
    """Purchasing without authentication returns 401."""
    org_token = await get_auth_token(
        client, "porg4@test.com", "Password1!", "Purchase Org 4", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]
    tier = await _create_tier(client, event_id, org_token)
    tier_id = tier["id"]

    # No auth headers
    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/purchase",
        json={"quantity": 1},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_fanclub_purchase_with_discount(client, monkeypatch):
    """Fanclub purchase applies the discount percentage (201)."""
    # 단계4a fanclub 자격 게이트 우회 — 이 테스트는 할인율 검증용
    # (set_fanclub_member 레거시 플래그는 community 매칭 is_member_for_event를 통과시키지 않음)
    async def _yes(_self, _u, _e):
        return True

    monkeypatch.setattr(
        "app.services.fanclub_service.FanclubService.is_member_for_event", _yes
    )
    org_token = await get_auth_token(
        client, "porg5@test.com", "Password1!", "Purchase Org 5", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]
    tier = await _create_tier(
        client,
        event_id,
        org_token,
        face_price=100.0,
        base_price=100.0,
        fanclub_discount_pct=10.0,
    )
    tier_id = tier["id"]

    user_data = await register_user(
        client, email="fan1@test.com", password="Password1!", name="Fan One", is_organizer=False
    )
    user_token = user_data["access_token"]
    await set_fanclub_member(user_data["user"]["id"])
    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/purchase/fanclub",
        json={"quantity": 1},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["success"] is True
    # 10% discount on face_price of 100.0 -> unit_price = 90.0
    assert data["unit_price"] == 90.0
    assert data["total_price"] == 90.0
    assert len(data["ticket_ids"]) == 1


@pytest.mark.asyncio
async def test_purchase_creates_ticket_records(client):
    """After purchase, tickets appear in the buyer's ticket list."""
    org_token = await get_auth_token(
        client, "porg6@test.com", "Password1!", "Purchase Org 6", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]
    tier = await _create_tier(client, event_id, org_token)
    tier_id = tier["id"]

    user_token = await get_auth_token(
        client, "buyer6@test.com", "Password1!", "Buyer Six", is_organizer=False
    )
    purchase_resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/purchase",
        json={"quantity": 2},
        headers=auth_headers(user_token),
    )
    assert purchase_resp.status_code == 201
    purchased_ticket_ids = set(purchase_resp.json()["ticket_ids"])

    # Verify tickets via GET /tickets/my
    tickets_resp = await client.get(
        "/api/v1/tickets/my",
        headers=auth_headers(user_token),
    )
    assert tickets_resp.status_code == 200
    my_tickets = tickets_resp.json()["tickets"]
    my_ticket_ids = {t["id"] for t in my_tickets}
    assert purchased_ticket_ids.issubset(my_ticket_ids)


@pytest.mark.asyncio
async def test_purchase_creates_order_records(client):
    """After purchase, an order appears in the buyer's order list."""
    org_token = await get_auth_token(
        client, "porg7@test.com", "Password1!", "Purchase Org 7", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]
    tier = await _create_tier(client, event_id, org_token)
    tier_id = tier["id"]

    user_token = await get_auth_token(
        client, "buyer7@test.com", "Password1!", "Buyer Seven", is_organizer=False
    )
    purchase_resp = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/purchase",
        json={"quantity": 1},
        headers=auth_headers(user_token),
    )
    assert purchase_resp.status_code == 201
    order_id = purchase_resp.json()["order_id"]

    # Verify order via GET /orders/my
    orders_resp = await client.get(
        "/api/v1/orders/my",
        headers=auth_headers(user_token),
    )
    assert orders_resp.status_code == 200
    my_orders = orders_resp.json()
    order_ids = {o["id"] for o in my_orders}
    assert order_id in order_ids
    created_order = next(o for o in my_orders if o["id"] == order_id)
    assert created_order["payment_deadline"] is not None
