"""정산 수동 조정 4-eyes 통제 테스트 (M-3, Major #4).

수정 전 결함: create_adjustment 가 작성 즉시 net_payout 에 반영 → 단일 admin 이
승인 완료 정산 금액을 사후 변경 가능(4-eyes 우회). float 연산으로 정밀도 손실.

수정 후 불변식:
- 조정은 pending_approval 로 생성되며 net_payout 즉시 변동 없음.
- 작성자≠승인자 승인 후에만 net_payout 에 Decimal 연산으로 반영.
- 작성자 본인 승인 시도는 403.
- 금액 상·하한 검증.
"""
import uuid
from datetime import datetime, timezone
from decimal import Decimal

import pytest

from app.main import app
from app.middleware.auth import get_current_admin
from app.models.settlement import (
    OrganizerSettlement,
    SettlementAdjustment,
    SettlementStatus,
    SettlementType,
)
from app.models.user import User
from app.tests.conftest import TestSession


async def _seed_admin(role="admin") -> uuid.UUID:
    async with TestSession() as session:
        u = User(
            email=f"adm-{uuid.uuid4().hex[:8]}@fin.test",
            hashed_password="!x!",
            name="관리자",
            is_admin=True,
            admin_role=role,
        )
        session.add(u)
        await session.commit()
        return u.id


async def _seed_settlement(*, net=1_000_000) -> uuid.UUID:
    async with TestSession() as session:
        organizer = User(
            email=f"org-{uuid.uuid4().hex[:8]}@fin.test",
            hashed_password="!x!",
            name="주최자",
            is_organizer=True,
        )
        session.add(organizer)
        await session.flush()
        s = OrganizerSettlement(
            organizer_id=organizer.id,
            settlement_type=SettlementType.ORGANIZER.value,
            period_start=datetime(2026, 5, 1, tzinfo=timezone.utc),
            period_end=datetime(2026, 5, 31, tzinfo=timezone.utc),
            gross_revenue=Decimal("1000000"),
            platform_fee=Decimal("0"),
            pg_fee=Decimal("0"),
            net_payout=Decimal(str(net)),
            status=SettlementStatus.APPROVED.value,
        )
        session.add(s)
        await session.commit()
        return s.id


def _as_admin(admin_id: uuid.UUID):
    async def _override():
        async with TestSession() as session:
            from sqlalchemy import select

            return (await session.execute(select(User).where(User.id == admin_id))).scalar_one()

    return _override


@pytest.mark.asyncio
async def test_adjustment_requires_separate_approver(client):
    author_id = await _seed_admin()
    approver_id = await _seed_admin()
    settlement_id = await _seed_settlement(net=1_000_000)

    # 1. 작성자가 조정 제안 — net_payout 은 변하지 않아야 한다.
    app.dependency_overrides[get_current_admin] = _as_admin(author_id)
    resp = await client.post(
        f"/api/v1/admin/settlements/{settlement_id}/adjust",
        json={"amount": 100_000_000 - 1, "reason": "보정", "adjustment_type": "manual"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["status"] == "pending_approval"
    adjustment_id = body["adjustment_id"]

    async with TestSession() as session:
        from sqlalchemy import select

        s = (await session.execute(
            select(OrganizerSettlement).where(OrganizerSettlement.id == settlement_id)
        )).scalar_one()
        assert float(s.net_payout) == 1_000_000.0  # 승인 전 — 변동 없음

    # 2. 작성자 본인 승인 → 403 (4-eyes).
    resp = await client.post(
        f"/api/v1/admin/settlements/{settlement_id}/adjust/{adjustment_id}/approve",
    )
    assert resp.status_code == 403, resp.text

    # 3. 다른 admin 승인 → 반영.
    app.dependency_overrides[get_current_admin] = _as_admin(approver_id)
    resp = await client.post(
        f"/api/v1/admin/settlements/{settlement_id}/adjust/{adjustment_id}/approve",
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["new_net_payout"] == 1_000_000.0 + (100_000_000 - 1)

    # 4. 재승인은 거부(이미 applied).
    resp = await client.post(
        f"/api/v1/admin/settlements/{settlement_id}/adjust/{adjustment_id}/approve",
    )
    assert resp.status_code == 400, resp.text

    app.dependency_overrides.pop(get_current_admin, None)


@pytest.mark.asyncio
async def test_adjustment_amount_bounds(client):
    author_id = await _seed_admin()
    settlement_id = await _seed_settlement()

    app.dependency_overrides[get_current_admin] = _as_admin(author_id)
    # 상한 초과
    resp = await client.post(
        f"/api/v1/admin/settlements/{settlement_id}/adjust",
        json={"amount": 200_000_000, "reason": "초과", "adjustment_type": "manual"},
    )
    assert resp.status_code == 400, resp.text
    # 0 금액
    resp = await client.post(
        f"/api/v1/admin/settlements/{settlement_id}/adjust",
        json={"amount": 0, "reason": "영", "adjustment_type": "manual"},
    )
    assert resp.status_code == 400, resp.text

    app.dependency_overrides.pop(get_current_admin, None)
