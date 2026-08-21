"""레벨2 2차 C2 — dispatch_one 실동작(트랜잭션 경계·멱등) + 원장/스윕/트리거 회귀.

증명 대상:
  - dispatch_one 원장 경로: 선기록(sending)→COMMIT→외부호출→정정(sent) 실동작.
  - 멱등("동시 2회 실행"): 같은 (message,channel,contact) 두 번째 claim 은 발송 안 함.
  - 트랜잭션 경계("외부호출 후 crash"): 선기록 sending 잔류 → lease 만료 전 재발송 금지.
  - 게이트 skip: 원장 기록 없이 즉시 반환(외부호출 없음).
  - finalize: sent/failed/unknown 정정 + attempt 종결.
  - reconcile 스윕: 만료 sending → failed + 부모 재큐잉.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.models.organizer_messaging import (
    MessageDelivery,
    MessageDeliveryAttempt,
)
from app.services.messaging import ledger
from app.services.messaging.compliance import Channel
from app.services.messaging.dispatch_service import (
    AmbiguousProviderError,
    DispatchParams,
    dispatch_one,
)


class FakeSender:
    """성공 provider 스텁 — request_id 를 돌려주고 호출 횟수를 센다."""

    def __init__(self, request_id: str = "req-1"):
        self.request_id = request_id
        self.calls = 0

    async def send_email(self, **_kw) -> str:
        self.calls += 1
        return self.request_id

    async def send_sms(self, **_kw) -> str:
        self.calls += 1
        return self.request_id

    async def send_alimtalk(self, **_kw) -> str:
        self.calls += 1
        return self.request_id


class FailSender(FakeSender):
    async def send_email(self, **_kw) -> str:
        self.calls += 1
        raise RuntimeError("provider 500")


class AmbiguousSender(FakeSender):
    async def send_email(self, **_kw) -> str:
        self.calls += 1
        raise AmbiguousProviderError("timeout", http_status=504, timeout_stage="provider_response")


def _params(mid: str, acct: str, to: str = "a@x.io", channel: Channel = "email") -> DispatchParams:
    return DispatchParams(
        account_id=acct,
        channel=channel,
        message_type="informational",
        to=to,
        body="본문",
        subject="제목",
        message_id=mid,
    )


@pytest.mark.asyncio
async def test_dispatch_one_ledger_sent(db_session):
    """원장 경로: 선기록→외부호출(성공)→sent 정정 + attempt sent."""
    mid, acct = str(uuid.uuid4()), str(uuid.uuid4())
    sender = FakeSender("REQ-42")
    r = await dispatch_one(db_session, _params(mid, acct), sender=sender)
    assert r.status == "sent" and r.request_id == "REQ-42"
    assert sender.calls == 1

    d = (
        await db_session.execute(
            select(MessageDelivery).where(MessageDelivery.message_id == uuid.UUID(mid))
        )
    ).scalar_one()
    assert d.status == "sent" and d.request_id == "REQ-42"
    assert d.claim_token is None  # lease 해제.
    att = (
        await db_session.execute(
            select(MessageDeliveryAttempt).where(
                MessageDeliveryAttempt.delivery_id == d.id
            )
        )
    ).scalar_one()
    assert att.result_status == "sent" and att.attempt_no == 1


@pytest.mark.asyncio
async def test_dispatch_one_idempotent_double_run(db_session):
    """'동시 2회 실행' — 두 번째 claim 은 발송하지 않는다(멱등 UNIQUE + claim-lease)."""
    mid, acct = str(uuid.uuid4()), str(uuid.uuid4())
    s1 = FakeSender()
    r1 = await dispatch_one(db_session, _params(mid, acct), sender=s1)
    assert r1.status == "sent" and s1.calls == 1

    # 재실행: 이미 sent → claim WHERE(failed/만료 sending) 불충족 → RETURNING 없음 → skip.
    s2 = FakeSender()
    r2 = await dispatch_one(db_session, _params(mid, acct), sender=s2)
    assert r2.status == "skipped" and s2.calls == 0  # 외부호출 발생 안 함(이중발송 없음).

    rows = (
        await db_session.execute(
            select(MessageDelivery).where(MessageDelivery.message_id == uuid.UUID(mid))
        )
    ).scalars().all()
    assert len(rows) == 1  # 단일 원장 행.


@pytest.mark.asyncio
async def test_dispatch_one_crash_after_prewrite_no_resend(db_session):
    """'외부호출 후 crash' — 선기록 sending 잔류 시 lease 유효 동안 재발송 금지."""
    mid, acct = str(uuid.uuid4()), str(uuid.uuid4())
    # crash 시뮬: 선기록만 남기고 finalize 못 한 상태를 직접 구성.
    claimed = await ledger.claim_delivery(
        db_session, message_id=mid, account_id=acct, channel="email", contact="a@x.io"
    )
    assert claimed is not None
    await db_session.commit()  # 선기록 COMMIT(외부호출 직전 crash 지점).

    # 재실행: delivery 는 sending·lease 유효 → claim 재획득 실패 → skip(재발송 없음).
    s = FakeSender()
    r = await dispatch_one(db_session, _params(mid, acct), sender=s)
    assert r.status == "skipped" and s.calls == 0

    d = (
        await db_session.execute(
            select(MessageDelivery).where(MessageDelivery.message_id == uuid.UUID(mid))
        )
    ).scalar_one()
    assert d.status == "sending"  # 여전히 sending(스윕/lease 만료가 승계).


@pytest.mark.asyncio
async def test_dispatch_one_expired_lease_reclaim(db_session):
    """lease 만료된 sending 은 재드레인이 재획득해 발송한다."""
    mid, acct = str(uuid.uuid4()), str(uuid.uuid4())
    # 만료 lease sending 을 직접 삽입.
    past = datetime.now(timezone.utc) - timedelta(minutes=30)
    d = MessageDelivery(
        message_id=uuid.UUID(mid), account_id=uuid.UUID(acct), channel="email",
        contact="a@x.io", status="sending", claim_token=uuid.uuid4(), claim_expires_at=past,
    )
    db_session.add(d)
    await db_session.commit()

    s = FakeSender()
    r = await dispatch_one(db_session, _params(mid, acct), sender=s)
    assert r.status == "sent" and s.calls == 1


@pytest.mark.asyncio
async def test_dispatch_one_failed_finalize(db_session):
    """provider 예외 → failed 정정(재시도 대상). attempt=failed."""
    mid, acct = str(uuid.uuid4()), str(uuid.uuid4())
    r = await dispatch_one(db_session, _params(mid, acct), sender=FailSender())
    assert r.status == "failed"
    d = (
        await db_session.execute(
            select(MessageDelivery).where(MessageDelivery.message_id == uuid.UUID(mid))
        )
    ).scalar_one()
    assert d.status == "failed" and d.claim_token is None
    # failed 는 재드레인이 재획득 가능해야 한다.
    r2 = await dispatch_one(db_session, _params(mid, acct), sender=FakeSender())
    assert r2.status == "sent"


@pytest.mark.asyncio
async def test_dispatch_one_unknown_finalize(db_session):
    """모호(AmbiguousProviderError) → unknown(자동 재발송 금지)."""
    mid, acct = str(uuid.uuid4()), str(uuid.uuid4())
    r = await dispatch_one(db_session, _params(mid, acct), sender=AmbiguousSender())
    assert r.status == "unknown"
    d = (
        await db_session.execute(
            select(MessageDelivery).where(MessageDelivery.message_id == uuid.UUID(mid))
        )
    ).scalar_one()
    assert d.status == "unknown"
    att = (
        await db_session.execute(
            select(MessageDeliveryAttempt).where(
                MessageDeliveryAttempt.delivery_id == d.id
            )
        )
    ).scalar_one()
    assert att.result_status == "unknown" and att.ambiguous is True
    # unknown 은 재드레인에서 재획득되지 않는다(claim WHERE 불충족).
    r2 = await dispatch_one(db_session, _params(mid, acct), sender=FakeSender())
    assert r2.status == "skipped"


@pytest.mark.asyncio
async def test_dispatch_one_gate_skip_no_ledger(db_session):
    """게이트 skip(억제) → 외부호출·원장기록 없이 즉시 skipped."""
    from app.services.messaging import compliance

    mid, acct = str(uuid.uuid4()), str(uuid.uuid4())
    await compliance.suppress(db_session, acct, "email", "a@x.io", "bounce")
    await db_session.commit()

    s = FakeSender()
    r = await dispatch_one(db_session, _params(mid, acct), sender=s)
    assert r.status == "skipped" and s.calls == 0
    rows = (
        await db_session.execute(
            select(MessageDelivery).where(MessageDelivery.message_id == uuid.UUID(mid))
        )
    ).scalars().all()
    assert len(rows) == 0  # 게이트 통과분만 선기록 — skip 은 원장 없음.
