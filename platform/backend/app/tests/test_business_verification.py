"""레벨2 2차 D4 — 사업자 인증 심사 v2 워크플로 회귀테스트.

커버:
  - 내부(go 프록시) save/submit 상태전이 + 필수값/서류 검증
  - draft 재사용(중복 신청 방지) + 편집 잠금(pending/approved 409)
  - go_account_id 테넌트 경계(교차 계정 격리)
  - admin 심사 대기열 + 승인/반려 상태머신 + 재심사 방지(409)
  - 승인 게이트 상태(current) 노출
"""

import hashlib
import hmac as _hmac
import uuid
from datetime import datetime, timezone

import pytest

from app.core.config import settings
from app.main import app
from app.middleware.auth import get_current_admin
from app.models.user import User

_SECRET = "test-go-webhook-secret-bizverif"
_BASE = "/api/v1/internal/business-verifications"


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)


def _sign(body_bytes: bytes) -> dict:
    ts = datetime.now(timezone.utc).isoformat()
    msg = f"{ts}.".encode() + body_bytes
    sig = _hmac.new(_SECRET.encode(), msg, hashlib.sha256).hexdigest()
    return {"x-pickket-signature": sig, "x-pickket-timestamp": ts}


def _full_submit_body(account_id: str) -> dict:
    return {
        "account_id": account_id,
        "action": "submit",
        "biz_number": "123-45-67890",
        "company_name": "테스트 주식회사",
        "rep_name": "홍길동",
        "biz_type": "서비스업",
        "biz_item": "공연기획",
        "address": "서울시 강남구",
        "opened_on": "2020-01-01",
        "bank_name": "국민은행",
        "bank_account": "123456-78-901234",
        "bank_holder": "홍길동",
        "authorized_confirmed": True,
        "masking_confirmed": True,
        "documents": [
            {"doc_type": "biz_cert", "file_url": "https://cdn.pickket.kr/bc.png"},
            {"doc_type": "bankbook", "file_url": "https://cdn.pickket.kr/bb.png"},
        ],
    }


async def _put(client, body: dict):
    import json as _json

    raw = _json.dumps(body).encode()
    headers = {**_sign(raw), "Content-Type": "application/json"}
    return await client.request("PUT", _BASE, content=raw, headers=headers)


async def _get_current(client, account_id: str):
    headers = _sign(b"")
    return await client.get(f"{_BASE}/current", params={"account_id": account_id}, headers=headers)


async def _make_admin(db_session) -> User:
    admin = User(
        email=f"admin-{uuid.uuid4().hex[:8]}@biz.test",
        hashed_password="!x!",
        name="심사관",
        is_admin=True,
        admin_role="super_admin",
    )
    db_session.add(admin)
    await db_session.commit()
    return admin


# ── 인증 경계 ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_internal_requires_signature(client, db_session):
    acc = str(uuid.uuid4())
    # 서명/토큰 없이 호출 → 401 (전환기 토큰 폴백도 미제공)
    resp = await client.get(f"{_BASE}/current", params={"account_id": acc})
    assert resp.status_code == 401


# ── save / submit 상태전이 ──────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_save_creates_draft(client, db_session):
    acc = str(uuid.uuid4())
    resp = await _put(client, {"account_id": acc, "action": "save", "company_name": "부분입력"})
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "draft"

    cur = await _get_current(client, acc)
    assert cur.status_code == 200
    body = cur.json()
    assert body["verification_status"] == "draft"
    assert body["current"]["company_name"] == "부분입력"


@pytest.mark.asyncio
async def test_submit_requires_all_fields(client, db_session):
    acc = str(uuid.uuid4())
    # 필수값 누락 submit → 400
    resp = await _put(client, {"account_id": acc, "action": "submit", "company_name": "부족"})
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_submit_requires_documents(client, db_session):
    acc = str(uuid.uuid4())
    body = _full_submit_body(acc)
    body["documents"] = [{"doc_type": "biz_cert", "file_url": "https://x/bc.png"}]  # bankbook 누락
    resp = await _put(client, body)
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_full_submit_transitions_to_pending(client, db_session):
    acc = str(uuid.uuid4())
    resp = await _put(client, _full_submit_body(acc))
    assert resp.status_code == 200, resp.text
    assert resp.json()["status"] == "pending"

    cur = await _get_current(client, acc)
    body = cur.json()
    assert body["verification_status"] == "pending"
    assert len(body["current"]["documents"]) == 2


@pytest.mark.asyncio
async def test_save_reuses_draft_row(client, db_session):
    """save 반복 시 draft 행 재사용(중복 신청 방지)."""
    acc = str(uuid.uuid4())
    await _put(client, {"account_id": acc, "action": "save", "company_name": "v1"})
    r2 = await _put(client, {"account_id": acc, "action": "save", "company_name": "v2"})
    assert r2.status_code == 200

    from sqlalchemy import func, select
    from app.models.business_verification import BusinessVerification

    count = (
        await db_session.execute(
            select(func.count())
            .select_from(BusinessVerification)
            .where(BusinessVerification.go_account_id == uuid.UUID(acc))
        )
    ).scalar_one()
    assert count == 1


@pytest.mark.asyncio
async def test_pending_locks_editing(client, db_session):
    acc = str(uuid.uuid4())
    await _put(client, _full_submit_body(acc))  # → pending
    # pending 상태에서 save 시도 → 409
    resp = await _put(client, {"account_id": acc, "action": "save", "company_name": "수정시도"})
    assert resp.status_code == 409


# ── 테넌트 경계 ──────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_tenant_isolation(client, db_session):
    acc_a = str(uuid.uuid4())
    acc_b = str(uuid.uuid4())
    await _put(client, {"account_id": acc_a, "action": "save", "company_name": "A사"})
    # B 계정 current 는 A 를 보지 못함
    cur_b = await _get_current(client, acc_b)
    assert cur_b.json()["current"] is None


# ── admin 심사 워크플로 ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_admin_approve_flow(client, db_session):
    acc = str(uuid.uuid4())
    await _put(client, _full_submit_body(acc))  # → pending

    from sqlalchemy import select
    from app.models.business_verification import BusinessVerification

    ver = (
        await db_session.execute(
            select(BusinessVerification).where(BusinessVerification.go_account_id == uuid.UUID(acc))
        )
    ).scalar_one()

    admin = await _make_admin(db_session)
    app.dependency_overrides[get_current_admin] = lambda: admin
    try:
        # 대기열
        q = await client.get("/api/v1/admin/business-verifications", params={"status_filter": "pending"})
        assert q.status_code == 200
        assert any(row["id"] == str(ver.id) for row in q.json()["data"])

        # 승인
        resp = await client.patch(
            f"/api/v1/admin/business-verifications/{ver.id}",
            json={"action": "approve"},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["data"]["status"] == "approved"

        # 재심사 방지 — 이미 approved → 409
        again = await client.patch(
            f"/api/v1/admin/business-verifications/{ver.id}",
            json={"action": "reject", "reason": "재심사"},
        )
        assert again.status_code == 409
    finally:
        app.dependency_overrides.pop(get_current_admin, None)

    # 게이트 상태 approved 반영
    cur = await _get_current(client, acc)
    body = cur.json()
    assert body["verification_status"] == "approved"
    assert body["has_approved"] is True


@pytest.mark.asyncio
async def test_admin_reject_requires_reason(client, db_session):
    acc = str(uuid.uuid4())
    await _put(client, _full_submit_body(acc))

    from sqlalchemy import select
    from app.models.business_verification import BusinessVerification

    ver = (
        await db_session.execute(
            select(BusinessVerification).where(BusinessVerification.go_account_id == uuid.UUID(acc))
        )
    ).scalar_one()

    admin = await _make_admin(db_session)
    app.dependency_overrides[get_current_admin] = lambda: admin
    try:
        # 사유 없는 반려 → 400
        no_reason = await client.patch(
            f"/api/v1/admin/business-verifications/{ver.id}", json={"action": "reject"}
        )
        assert no_reason.status_code == 400

        # 사유 반려 → rejected
        resp = await client.patch(
            f"/api/v1/admin/business-verifications/{ver.id}",
            json={"action": "reject", "reason": "서류 불명확"},
        )
        assert resp.status_code == 200
        assert resp.json()["data"]["status"] == "rejected"
    finally:
        app.dependency_overrides.pop(get_current_admin, None)

    # 반려 후 재작성(save) 허용 — 잠금 해제
    resp = await _put(client, {"account_id": acc, "action": "save", "company_name": "재작성"})
    assert resp.status_code == 200
    assert resp.json()["status"] == "draft"

    cur = await _get_current(client, acc)
    assert cur.json()["verification_status"] == "draft"


@pytest.mark.asyncio
async def test_admin_requires_admin_gate(client, db_session):
    # admin override 없이 호출 → 인증 필요(401/403)
    resp = await client.get("/api/v1/admin/business-verifications")
    assert resp.status_code in (401, 403)
