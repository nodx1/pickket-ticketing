"""Tests for AP Shop API endpoints (WP09/WP15).

Test coverage:
- GET /shop/items — empty list, with items, category filter, total count
- POST /shop/exchange — success, insufficient AP
- GET /shop/my-exchanges — list with total count
- POST /shop/exchanges/{id}/cancel — cancel success
- Authentication required checks
- Edge cases: monthly limit, offline verification, stock management, out-of-stock
"""

import uuid

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.tests.conftest import (
    TestSession,
    auth_headers,
    get_auth_token,
    register_user,
)
from app.models.shop import ShopCategory, ShopItem
from app.models.point import PointWallet, PointTransaction, PointType, PointTransactionType


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _create_shop_item(
    session: AsyncSession,
    name: str = "Test Digital Item",
    category: ShopCategory = ShopCategory.DIGITAL,
    ap_price: int = 50,
    stock: int | None = 10,
    is_active: bool = True,
) -> ShopItem:
    """Create a shop item directly in the DB."""
    item = ShopItem(
        name=name,
        description=f"Test item: {name}",
        category=category,
        ap_price=ap_price,
        stock=stock,
        is_active=is_active,
    )
    session.add(item)
    await session.flush()
    return item


async def _give_user_ap(
    session: AsyncSession,
    user_id: uuid.UUID,
    amount: int = 500,
    point_type: PointType = PointType.FAN,
) -> PointWallet:
    """Give AP to a user by creating/updating a wallet and transaction."""
    from sqlalchemy import select

    result = await session.execute(
        select(PointWallet).where(
            PointWallet.user_id == user_id,
            PointWallet.point_type == point_type,
        )
    )
    wallet = result.scalar_one_or_none()

    if wallet:
        wallet.balance += amount
        wallet.lifetime_earned += amount
    else:
        wallet = PointWallet(
            user_id=user_id,
            point_type=point_type,
            balance=amount,
            lifetime_earned=amount,
        )
        session.add(wallet)
        await session.flush()

    tx = PointTransaction(
        wallet_id=wallet.id,
        user_id=user_id,
        tx_type=PointTransactionType.EARN_SIGNUP,
        amount=amount,
        balance_after=wallet.balance,
        description="test AP grant",
    )
    session.add(tx)
    await session.flush()
    return wallet


# ---------------------------------------------------------------------------
# GET /shop/items
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_shop_items_empty(client, db_session: AsyncSession):
    """GET /shop/items returns empty list when no items exist."""
    resp = await client.get("/api/v1/shop/items")
    assert resp.status_code == 200
    data = resp.json()
    assert data["items"] == []
    assert data["total"] == 0


@pytest.mark.asyncio
async def test_shop_items_with_data(client, db_session: AsyncSession):
    """GET /shop/items returns items with correct total count."""
    async with TestSession() as session:
        await _create_shop_item(session, name="Item A", ap_price=100)
        await _create_shop_item(session, name="Item B", ap_price=200)
        await _create_shop_item(session, name="Item C", ap_price=300)
        await session.commit()

    resp = await client.get("/api/v1/shop/items")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 3
    assert len(data["items"]) == 3

    # Check item structure
    item = data["items"][0]
    assert "id" in item
    assert "name" in item
    assert "ap_price" in item
    assert "category" in item
    assert "is_active" in item


@pytest.mark.asyncio
async def test_shop_items_category_filter(client, db_session: AsyncSession):
    """GET /shop/items with category filter returns only matching items."""
    async with TestSession() as session:
        await _create_shop_item(session, name="Digital A", category=ShopCategory.DIGITAL)
        await _create_shop_item(session, name="Digital B", category=ShopCategory.DIGITAL)
        await _create_shop_item(session, name="Badge A", category=ShopCategory.LIMITED_BADGE)
        await session.commit()

    # Filter by digital
    resp = await client.get("/api/v1/shop/items?category=digital")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    assert len(data["items"]) == 2
    for item in data["items"]:
        assert item["category"] == "digital"

    # Filter by limited_badge
    resp2 = await client.get("/api/v1/shop/items?category=limited_badge")
    assert resp2.status_code == 200
    data2 = resp2.json()
    assert data2["total"] == 1
    assert data2["items"][0]["category"] == "limited_badge"


@pytest.mark.asyncio
async def test_shop_items_inactive_not_shown(client, db_session: AsyncSession):
    """GET /shop/items does not return inactive items."""
    async with TestSession() as session:
        await _create_shop_item(session, name="Active Item", is_active=True)
        await _create_shop_item(session, name="Inactive Item", is_active=False)
        await session.commit()

    resp = await client.get("/api/v1/shop/items")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["items"][0]["name"] == "Active Item"


@pytest.mark.asyncio
async def test_shop_items_pagination(client, db_session: AsyncSession):
    """GET /shop/items supports limit and offset parameters."""
    async with TestSession() as session:
        for i in range(5):
            await _create_shop_item(session, name=f"Item {i}", ap_price=100 + i)
        await session.commit()

    # Get first 2 items
    resp = await client.get("/api/v1/shop/items?limit=2&offset=0")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 5
    assert len(data["items"]) == 2


# ---------------------------------------------------------------------------
# POST /shop/exchange
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_shop_exchange_success(client, db_session: AsyncSession):
    """POST /shop/exchange succeeds when user has enough AP."""
    # Register user and get token
    reg_data = await register_user(client, email="shopuser@test.com")
    token = reg_data["access_token"]
    user_id = reg_data["user"]["id"]

    # Create item and give user AP
    async with TestSession() as session:
        item = await _create_shop_item(session, name="Exchange Test", ap_price=50)
        item_id = item.id
        await _give_user_ap(session, uuid.UUID(user_id), amount=500)
        await session.commit()

    resp = await client.post(
        "/api/v1/shop/exchange",
        json={"item_id": str(item_id)},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["item_id"] == str(item_id)
    assert data["ap_spent"] == 50
    assert data["status"] == "completed"


@pytest.mark.asyncio
async def test_shop_exchange_insufficient_ap(client, db_session: AsyncSession):
    """POST /shop/exchange fails when user has insufficient AP."""
    reg_data = await register_user(client, email="pooruser@test.com")
    token = reg_data["access_token"]

    # Create expensive item, don't give user AP
    async with TestSession() as session:
        item = await _create_shop_item(session, name="Expensive Item", ap_price=99999)
        item_id = item.id
        await session.commit()

    resp = await client.post(
        "/api/v1/shop/exchange",
        json={"item_id": str(item_id)},
        headers=auth_headers(token),
    )
    assert resp.status_code == 400
    assert "AP" in resp.json()["detail"] or "부족" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_shop_exchange_nonexistent_item(client, db_session: AsyncSession):
    """POST /shop/exchange fails for nonexistent item."""
    token = await get_auth_token(client, email="noitem@test.com")

    resp = await client.post(
        "/api/v1/shop/exchange",
        json={"item_id": str(uuid.uuid4())},
        headers=auth_headers(token),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_shop_exchange_requires_auth(client):
    """POST /shop/exchange requires authentication."""
    resp = await client.post(
        "/api/v1/shop/exchange",
        json={"item_id": str(uuid.uuid4())},
    )
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# GET /shop/my-exchanges
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_shop_my_exchanges_empty(client, db_session: AsyncSession):
    """GET /shop/my-exchanges returns empty list for new user."""
    token = await get_auth_token(client, email="noexchanges@test.com")

    resp = await client.get(
        "/api/v1/shop/my-exchanges",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["exchanges"] == []
    assert data["total"] == 0


@pytest.mark.asyncio
async def test_shop_my_exchanges_after_exchange(client, db_session: AsyncSession):
    """GET /shop/my-exchanges returns exchanges after a successful exchange."""
    reg_data = await register_user(client, email="exchuser@test.com")
    token = reg_data["access_token"]
    user_id = reg_data["user"]["id"]

    # Create item, give AP, and exchange
    async with TestSession() as session:
        item = await _create_shop_item(session, name="My Exchange Item", ap_price=30)
        item_id = item.id
        await _give_user_ap(session, uuid.UUID(user_id), amount=500)
        await session.commit()

    # Perform exchange
    await client.post(
        "/api/v1/shop/exchange",
        json={"item_id": str(item_id)},
        headers=auth_headers(token),
    )

    # Check my-exchanges
    resp = await client.get(
        "/api/v1/shop/my-exchanges",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert len(data["exchanges"]) == 1
    assert data["exchanges"][0]["ap_spent"] == 30


@pytest.mark.asyncio
async def test_shop_my_exchanges_requires_auth(client):
    """GET /shop/my-exchanges requires authentication."""
    resp = await client.get("/api/v1/shop/my-exchanges")
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# POST /shop/exchanges/{id}/cancel
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_shop_cancel_exchange(client, db_session: AsyncSession):
    """POST /shop/exchanges/{id}/cancel cancels an exchange and refunds AP."""
    reg_data = await register_user(client, email="canceluser@test.com")
    token = reg_data["access_token"]
    user_id = reg_data["user"]["id"]

    async with TestSession() as session:
        item = await _create_shop_item(session, name="Cancel Test Item", ap_price=40)
        item_id = item.id
        await _give_user_ap(session, uuid.UUID(user_id), amount=500)
        await session.commit()

    # Exchange
    exchange_resp = await client.post(
        "/api/v1/shop/exchange",
        json={"item_id": str(item_id)},
        headers=auth_headers(token),
    )
    assert exchange_resp.status_code == 201
    exchange_id = exchange_resp.json()["id"]

    # Cancel
    cancel_resp = await client.post(
        f"/api/v1/shop/exchanges/{exchange_id}/cancel",
        headers=auth_headers(token),
    )
    assert cancel_resp.status_code == 200
    assert cancel_resp.json()["status"] == "cancelled"


@pytest.mark.asyncio
async def test_shop_cancel_nonexistent_exchange(client, db_session: AsyncSession):
    """POST /shop/exchanges/{id}/cancel fails for nonexistent exchange."""
    token = await get_auth_token(client, email="cancelnonexist@test.com")

    resp = await client.post(
        f"/api/v1/shop/exchanges/{uuid.uuid4()}/cancel",
        headers=auth_headers(token),
    )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_shop_cancel_requires_auth(client):
    """POST /shop/exchanges/{id}/cancel requires authentication."""
    resp = await client.post(f"/api/v1/shop/exchanges/{uuid.uuid4()}/cancel")
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Edge cases: monthly limit, verification, stock management
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_exchange_monthly_limit(client, db_session: AsyncSession):
    """Monthly AP limit per category should be enforced."""
    reg_data = await register_user(client, email="monthlylimit@test.com")
    token = reg_data["access_token"]
    user_id = reg_data["user"]["id"]

    # Create a DIGITAL item worth 1000 AP (DIGITAL limit is 3000)
    async with TestSession() as session:
        item = await _create_shop_item(
            session, name="Digital Item", category=ShopCategory.DIGITAL, ap_price=1000
        )
        item_id = item.id
        await _give_user_ap(session, uuid.UUID(user_id), amount=10000)
        await session.commit()

    # Exchange 3 times (3000 AP = at limit)
    for i in range(3):
        resp = await client.post(
            "/api/v1/shop/exchange",
            json={"item_id": str(item_id)},
            headers=auth_headers(token),
        )
        assert resp.status_code == 201, f"Exchange {i + 1} failed: {resp.json()}"

    # 4th exchange should fail (exceeds 3000 monthly limit)
    resp = await client.post(
        "/api/v1/shop/exchange",
        json={"item_id": str(item_id)},
        headers=auth_headers(token),
    )
    assert resp.status_code == 400
    detail = resp.json().get("detail", "")
    assert "한도" in detail or "limit" in detail.lower()


@pytest.mark.asyncio
async def test_exchange_offline_requires_verification(client, db_session: AsyncSession):
    """OFFLINE category items require verification level >= 1."""
    reg_data = await register_user(client, email="offlineverify@test.com")
    token = reg_data["access_token"]
    user_id = reg_data["user"]["id"]

    async with TestSession() as session:
        item = await _create_shop_item(
            session, name="Offline Perk", category=ShopCategory.OFFLINE, ap_price=500
        )
        item_id = item.id
        await _give_user_ap(session, uuid.UUID(user_id), amount=5000)
        await session.commit()

    # User has verification_level=0 by default, should fail
    resp = await client.post(
        "/api/v1/shop/exchange",
        json={"item_id": str(item_id)},
        headers=auth_headers(token),
    )
    assert resp.status_code == 400
    detail = resp.json().get("detail", "")
    assert "인증" in detail or "verif" in detail.lower()


@pytest.mark.asyncio
async def test_exchange_decrements_stock(client, db_session: AsyncSession):
    """Stock should decrease after exchange and restore after cancel."""
    reg_data = await register_user(client, email="stocktest@test.com")
    token = reg_data["access_token"]
    user_id = reg_data["user"]["id"]

    async with TestSession() as session:
        item = await _create_shop_item(
            session, name="Limited Item", category=ShopCategory.DIGITAL, ap_price=100, stock=2
        )
        item_id = item.id
        await _give_user_ap(session, uuid.UUID(user_id), amount=5000)
        await session.commit()

    # Exchange once
    resp = await client.post(
        "/api/v1/shop/exchange",
        json={"item_id": str(item_id)},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    exchange_id = resp.json()["id"]

    # Check stock decreased
    async with TestSession() as session:
        result = await session.execute(select(ShopItem).where(ShopItem.id == item_id))
        refreshed_item = result.scalar_one()
        assert refreshed_item.stock == 1

    # Cancel exchange
    resp2 = await client.post(
        f"/api/v1/shop/exchanges/{exchange_id}/cancel",
        headers=auth_headers(token),
    )
    assert resp2.status_code == 200

    # Stock should be restored
    async with TestSession() as session:
        result = await session.execute(select(ShopItem).where(ShopItem.id == item_id))
        refreshed_item = result.scalar_one()
        assert refreshed_item.stock == 2


@pytest.mark.asyncio
async def test_exchange_out_of_stock(client, db_session: AsyncSession):
    """Cannot exchange item with zero stock."""
    reg_data = await register_user(client, email="outofstock@test.com")
    token = reg_data["access_token"]
    user_id = reg_data["user"]["id"]

    async with TestSession() as session:
        item = await _create_shop_item(
            session, name="Sold Out Item", category=ShopCategory.DIGITAL, ap_price=100, stock=0
        )
        item_id = item.id
        await _give_user_ap(session, uuid.UUID(user_id), amount=5000)
        await session.commit()

    resp = await client.post(
        "/api/v1/shop/exchange",
        json={"item_id": str(item_id)},
        headers=auth_headers(token),
    )
    assert resp.status_code == 400
