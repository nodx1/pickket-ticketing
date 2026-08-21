"""Regression tests for delegation-token scope enforcement (default-DENY).

A delegation ("AI agent") token must only be able to write to paths explicitly
mapped to a scope it holds. A read-only ("view") token must never be able to
mutate state — historically a default-ALLOW bug let a view token POST/DELETE to
any path not containing /bids, /purchase, /orders, /admin or /manage (e.g.
account deletion, ticket transfers, password change).
"""

import uuid

import pytest

from app.services.delegation_service import issue_token
from .conftest import register_user, auth_headers


@pytest.mark.asyncio
async def test_view_token_allows_read(client, db_session):
    """A view-scoped delegation token may perform GET requests."""
    reg = await register_user(client, email="deleg_view@example.com")
    user_id = reg["user"]["id"]

    _, jwt_token = await issue_token(
        db_session,
        user_id=uuid.UUID(user_id),
        agent_name="reader-agent",
        scopes=["view"],
    )
    await db_session.commit()

    resp = await client.get("/api/v1/users/me", headers=auth_headers(jwt_token))
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_view_token_denies_unmapped_write(client, db_session):
    """A view token must be denied a write to an unmapped path (account deletion-cancel)."""
    reg = await register_user(client, email="deleg_view2@example.com")
    user_id = reg["user"]["id"]

    _, jwt_token = await issue_token(
        db_session,
        user_id=uuid.UUID(user_id),
        agent_name="reader-agent",
        scopes=["view"],
    )
    await db_session.commit()

    # /me/cancel-deletion is not in the bid/purchase/manage path map → default-deny.
    resp = await client.post(
        "/api/v1/users/me/cancel-deletion", headers=auth_headers(jwt_token)
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_purchase_token_denies_unmapped_write(client, db_session):
    """Even a purchase-scoped token cannot write to a non-purchase path."""
    reg = await register_user(client, email="deleg_purchase@example.com")
    user_id = reg["user"]["id"]

    _, jwt_token = await issue_token(
        db_session,
        user_id=uuid.UUID(user_id),
        agent_name="buyer-agent",
        scopes=["purchase"],
    )
    await db_session.commit()

    # Toggling a favorite is not a purchase/bid/manage path → denied.
    resp = await client.post(
        f"/api/v1/events/{uuid.uuid4()}/favorite", headers=auth_headers(jwt_token)
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_normal_access_token_unaffected(client):
    """A regular (non-delegation) access token is not subject to scope path-mapping."""
    reg = await register_user(client, email="deleg_normal@example.com")
    token = reg["access_token"]
    # A normal user hitting an unmapped write path should NOT get the delegation 403
    # (it may 400/404 from the handler, but never the delegation scope rejection).
    resp = await client.post("/api/v1/users/me/cancel-deletion", headers=auth_headers(token))
    assert resp.status_code != 403
