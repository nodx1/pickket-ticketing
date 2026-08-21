import pytest

from app.services.rehearsal_service import RehearsalService
from app.tests.conftest import auth_headers, get_auth_token


def test_generate_virtual_bids_count():
    svc = RehearsalService()
    bids = svc.generate_virtual_bids(
        num_bids=100,
        min_price=50000,
        max_price=150000,
        seed=42,
    )
    assert len(bids) == 100


def test_generate_bids_price_range():
    svc = RehearsalService()
    bids = svc.generate_virtual_bids(
        num_bids=200,
        min_price=50000,
        max_price=150000,
        seed=7,
    )
    assert all(50000 <= b["bid_amount"] <= 150000 for b in bids)


def test_generate_bids_quantity_distribution():
    svc = RehearsalService()
    bids = svc.generate_virtual_bids(
        num_bids=1000,
        min_price=50000,
        max_price=150000,
        seed=99,
    )
    counts = {q: sum(1 for b in bids if b["quantity"] == q) for q in [1, 2, 3, 4]}
    assert counts[1] > counts[2]
    assert counts[1] > counts[3]
    assert counts[1] > counts[4]


def test_simulation_basic():
    svc = RehearsalService()
    result = svc.run_simulation(
        total_seats=100,
        min_price=50000,
        max_price=150000,
        num_bids=100,
        seed=3,
    )
    assert result["total_bids"] == 100
    assert result["total_seats"] == 100
    assert result["winners_count"] > 0


def test_simulation_oversupply():
    svc = RehearsalService()
    result = svc.run_simulation(
        total_seats=1000,
        min_price=50000,
        max_price=150000,
        num_bids=10,
        seed=11,
    )
    assert result["winners_count"] == 10


def test_simulation_high_competition():
    svc = RehearsalService()
    result = svc.run_simulation(
        total_seats=10,
        min_price=50000,
        max_price=150000,
        num_bids=1000,
        seed=5,
    )
    assert result["competition_ratio"] > 1.0
    assert result["winners_count"] <= 10


@pytest.mark.asyncio
async def test_api_simulate(client):
    token = await get_auth_token(client, email="rehearsal_org@test.com", is_organizer=True)
    resp = await client.post(
        "/api/v1/rehearsal/simulate",
        json={
            "total_seats": 100,
            "min_price": 50000,
            "max_price": 150000,
            "num_bids": 100,
            "category": "concert",
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total_bids"] == 100
    assert "winners_count" in data
    assert "price_stats" in data
