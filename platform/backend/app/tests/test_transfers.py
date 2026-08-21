import uuid

import pytest
from sqlalchemy import select

from app.models.ownership_transfer import OwnershipTransfer
from app.models.resale import ResaleListingModel, ResaleListingStatus
from app.models.ticket import Ticket, TicketStatus
from app.tests.conftest import (
    TestSession,
    auth_headers,
    confirm_purchase_payment,
    create_event_as_organizer,
    get_auth_token,
)


async def _get_user_id(client, token: str) -> str:
    resp = await client.get("/api/v1/users/me", headers=auth_headers(token))
    assert resp.status_code == 200
    return resp.json()["id"]


async def _create_ticket_for_transfer(client, owner_email: str):
    """Create event + tier + purchase and return owner token, ticket_id, event_id."""
    org_token = await get_auth_token(client, email=f"org_{owner_email}", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)

    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": 30,
            "base_price": 50.0,
            "sale_mode": "fixed_fcfs",
            "face_price": 50.0,
        },
        headers=auth_headers(org_token),
    )
    assert tier_resp.status_code in (200, 201)
    tier = tier_resp.json()

    owner_token = await get_auth_token(client, email=owner_email)
    purchase_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
        json={"quantity": 1},
        headers=auth_headers(owner_token),
    )
    assert purchase_resp.status_code in (200, 201)
    purchase = purchase_resp.json()

    # 결제 확인 → ACTIVE 상태로 전환 (양도는 ACTIVE 티켓만 가능)
    await confirm_purchase_payment(client, owner_token, purchase["order_id"])

    ticket_id = purchase["ticket_ids"][0]
    return owner_token, ticket_id, event["id"]


async def _create_transfer(client, owner_email: str, recipient_email: str):
    owner_token, ticket_id, event_id = await _create_ticket_for_transfer(client, owner_email)
    recipient_token = await get_auth_token(client, email=recipient_email)
    recipient_id = await _get_user_id(client, recipient_token)

    transfer_resp = await client.post(
        "/api/v1/transfers",
        json={
            "ticket_id": ticket_id,
            "to_user_id": recipient_id,
            "transfer_type": "gift",
            "price": 0.0,
        },
        headers=auth_headers(owner_token),
    )
    assert transfer_resp.status_code == 200
    transfer_id = transfer_resp.json()["id"]

    return {
        "owner_token": owner_token,
        "recipient_token": recipient_token,
        "recipient_id": recipient_id,
        "ticket_id": ticket_id,
        "event_id": event_id,
        "transfer_id": transfer_id,
    }


@pytest.mark.asyncio
async def test_initiate_transfer(client):
    owner_token, ticket_id, _ = await _create_ticket_for_transfer(
        client, owner_email="transfer_owner_1@test.com"
    )
    recipient_token = await get_auth_token(client, email="transfer_recipient_1@test.com")
    recipient_id = await _get_user_id(client, recipient_token)

    resp = await client.post(
        "/api/v1/transfers",
        json={
            "ticket_id": ticket_id,
            "to_user_id": recipient_id,
            "transfer_type": "gift",
            "price": 0.0,
        },
        headers=auth_headers(owner_token),
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "initiated"
    assert body["ticket_id"] == ticket_id
    assert body["to_user_id"] == recipient_id


@pytest.mark.asyncio
async def test_send_code(client):
    data = await _create_transfer(
        client,
        owner_email="transfer_owner_2@test.com",
        recipient_email="transfer_recipient_2@test.com",
    )

    resp = await client.post(
        f"/api/v1/transfers/{data['transfer_id']}/send-code",
        headers=auth_headers(data["owner_token"]),
    )

    assert resp.status_code == 200
    assert resp.json()["ok"] is True


@pytest.mark.asyncio
async def test_verify_code_success(client):
    data = await _create_transfer(
        client,
        owner_email="transfer_owner_3@test.com",
        recipient_email="transfer_recipient_3@test.com",
    )

    async with TestSession() as session:
        transfer = await session.scalar(
            select(OwnershipTransfer).where(OwnershipTransfer.id == uuid.UUID(data["transfer_id"]))
        )
        assert transfer is not None
        code = transfer.transfer_code

    resp = await client.post(
        f"/api/v1/transfers/{data['transfer_id']}/verify",
        json={"code": code},
        headers=auth_headers(data["recipient_token"]),
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "identity_verified"


@pytest.mark.asyncio
async def test_verify_code_wrong(client):
    data = await _create_transfer(
        client,
        owner_email="transfer_owner_4@test.com",
        recipient_email="transfer_recipient_4@test.com",
    )

    resp = await client.post(
        f"/api/v1/transfers/{data['transfer_id']}/verify",
        json={"code": "999999"},
        headers=auth_headers(data["recipient_token"]),
    )

    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_complete_transfer(client):
    data = await _create_transfer(
        client,
        owner_email="transfer_owner_5@test.com",
        recipient_email="transfer_recipient_5@test.com",
    )

    async with TestSession() as session:
        transfer = await session.scalar(
            select(OwnershipTransfer).where(OwnershipTransfer.id == uuid.UUID(data["transfer_id"]))
        )
        assert transfer is not None
        code = transfer.transfer_code

    verify_resp = await client.post(
        f"/api/v1/transfers/{data['transfer_id']}/verify",
        json={"code": code},
        headers=auth_headers(data["recipient_token"]),
    )
    assert verify_resp.status_code == 200
    assert verify_resp.json()["status"] == "identity_verified"

    complete_resp = await client.post(
        f"/api/v1/transfers/{data['transfer_id']}/complete",
        headers=auth_headers(data["recipient_token"]),
    )
    assert complete_resp.status_code == 200
    assert complete_resp.json()["status"] == "completed"

    async with TestSession() as session:
        ticket = await session.scalar(
            select(Ticket).where(Ticket.id == uuid.UUID(data["ticket_id"]))
        )
        assert ticket is not None
        assert str(ticket.current_owner_id) == data["recipient_id"]


@pytest.mark.asyncio
async def test_cancel_transfer(client):
    data = await _create_transfer(
        client,
        owner_email="transfer_owner_6@test.com",
        recipient_email="transfer_recipient_6@test.com",
    )

    resp = await client.post(
        f"/api/v1/transfers/{data['transfer_id']}/cancel",
        headers=auth_headers(data["owner_token"]),
    )

    assert resp.status_code == 200
    assert resp.json()["status"] == "cancelled"


@pytest.mark.asyncio
async def test_complete_without_verify_fails(client):
    data = await _create_transfer(
        client,
        owner_email="transfer_owner_7@test.com",
        recipient_email="transfer_recipient_7@test.com",
    )

    resp = await client.post(
        f"/api/v1/transfers/{data['transfer_id']}/complete",
        headers=auth_headers(data["recipient_token"]),
    )

    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_initiate_transfer_blocked_when_active_resale_listing(client):
    owner_token, ticket_id, _ = await _create_ticket_for_transfer(
        client, owner_email="transfer_owner_active_listing@test.com"
    )
    owner_id = await _get_user_id(client, owner_token)
    recipient_token = await get_auth_token(
        client, email="transfer_recipient_active_listing@test.com"
    )
    recipient_id = await _get_user_id(client, recipient_token)

    async with TestSession() as session:
        ticket = await session.scalar(select(Ticket).where(Ticket.id == uuid.UUID(ticket_id)))
        assert ticket is not None
        ticket.status = TicketStatus.ACTIVE
        session.add(
            ResaleListingModel(
                ticket_id=ticket.id,
                seller_id=uuid.UUID(owner_id),
                asking_price=ticket.purchase_price,
                status=ResaleListingStatus.ACTIVE,
                seller_receives=ticket.purchase_price,
                platform_fee=0.0,
                artist_royalty=0.0,
            )
        )
        await session.commit()

    resp = await client.post(
        "/api/v1/transfers",
        json={
            "ticket_id": ticket_id,
            "to_user_id": recipient_id,
            "transfer_type": "gift",
            "price": 0.0,
        },
        headers=auth_headers(owner_token),
    )

    assert resp.status_code == 400
    assert "active resale listing" in resp.json()["detail"].lower()
