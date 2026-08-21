"""레벨2 영역C — 조직자 메시징 스키마·컴플라이언스 게이트·dispatch 골격 회귀.

검증:
  - 신규 모델 11종이 metadata 에 등록되고 테이블 생성됨(create_all 성공).
  - message_deliveries 멱등 UNIQUE(message_id, channel, contact) 동작.
  - message_consents 스코프 UNIQUE(account, contact, channel) 동작.
  - reminder_sends 멱등 UNIQUE(event, attendee, type, date) 동작.
  - 컴플라이언스 게이트: 야간창·suppression(전역/스코프)·consent·정보성 vs 광고성.
  - dispatch_service: 게이트 판정(알림톡 광고금지·no_contact·통과) + provider 스텁 raise.
"""

import uuid
from datetime import date, datetime, timezone

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models.organizer_messaging import (
    EventMessage,
    MessageConsent,
    MessageDelivery,
    MessageSuppression,
    OrganizerNotification,
    ReminderSend,
)
from app.services.messaging import compliance
from app.services.messaging.dispatch_service import (
    DispatchParams,
    NotImplementedProviderSender,
    dispatch_one,
    evaluate_compliance_gate,
)


def _acct() -> uuid.UUID:
    return uuid.uuid4()


# ── 모델 등록 / 멱등 제약 ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_models_registered_and_created(db_session):
    """11종 신규 모델이 create_all 로 생성되고 삽입 가능(스키마 정합)."""
    acct = _acct()
    db_session.add(
        OrganizerNotification(
            account_id=acct, type="new_order", title="새 주문", message="내용"
        )
    )
    msg = EventMessage(
        id=uuid.uuid4(),
        account_id=acct,
        event_id=uuid.uuid4(),
        title="공지",
        channel="email",
        message_type="informational",
        status="draft",
        body="본문",
    )
    db_session.add(msg)
    await db_session.commit()

    got = (
        await db_session.execute(
            select(OrganizerNotification).where(OrganizerNotification.account_id == acct)
        )
    ).scalar_one()
    assert got.is_read is False


@pytest.mark.asyncio
async def test_message_delivery_idempotent_unique(db_session):
    """(message_id, channel, contact) 유일 — 중복 delivery 삽입 차단."""
    mid = uuid.uuid4()
    acct = _acct()
    db_session.add(
        MessageDelivery(
            message_id=mid, account_id=acct, channel="email", contact="a@x.io"
        )
    )
    await db_session.commit()

    db_session.add(
        MessageDelivery(
            message_id=mid, account_id=acct, channel="email", contact="a@x.io"
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_consent_scope_unique(db_session):
    """(account, contact, channel) 유일 — 스코프별 동의 단일 행."""
    acct = _acct()
    db_session.add(MessageConsent(account_id=acct, contact="a@x.io", channel="email"))
    await db_session.commit()
    db_session.add(MessageConsent(account_id=acct, contact="a@x.io", channel="email"))
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


@pytest.mark.asyncio
async def test_reminder_ledger_idempotent(db_session):
    """(event, attendee, type, date) 유일 — 리마인더 중복 발송 원장 차단."""
    ev, att = uuid.uuid4(), uuid.uuid4()
    when = date(2026, 8, 20)
    db_session.add(
        ReminderSend(
            event_id=ev, attendee_id=att, reminder_type="D7", occurrence_date=when
        )
    )
    await db_session.commit()
    db_session.add(
        ReminderSend(
            event_id=ev, attendee_id=att, reminder_type="D7", occurrence_date=when
        )
    )
    with pytest.raises(IntegrityError):
        await db_session.commit()
    await db_session.rollback()


# ── 컴플라이언스 게이트 ───────────────────────────────────────────────────────


def test_normalize_contact():
    assert compliance.normalize_contact("email", "  A@X.io ") == "a@x.io"
    assert compliance.normalize_contact("sms", "010-1234-5678") == "01012345678"


def test_night_window_kst():
    # 12:00 UTC = 21:00 KST → 야간.
    assert compliance.is_night_window(datetime(2026, 8, 20, 12, 0, tzinfo=timezone.utc))
    # 03:00 UTC = 12:00 KST → 주간.
    assert not compliance.is_night_window(datetime(2026, 8, 20, 3, 0, tzinfo=timezone.utc))
    # 23:00 UTC = 08:00 KST → 주간(경계 open).
    assert not compliance.is_night_window(datetime(2026, 8, 20, 23, 0, tzinfo=timezone.utc))


@pytest.mark.asyncio
async def test_suppression_scope_and_global(db_session):
    acct = _acct()
    await compliance.suppress(db_session, acct, "email", "a@x.io", "unsubscribe")
    await compliance.suppress(db_session, None, "sms", "01099998888", "bounce")
    await db_session.commit()

    # 스코프 억제: 해당 account 만.
    assert await compliance.is_suppressed(db_session, acct, "email", "A@X.io")
    assert not await compliance.is_suppressed(db_session, _acct(), "email", "a@x.io")

    # 전역 억제: 모든 account 에 적용(bounce = undeliverable → 정보성도 차단).
    other = _acct()
    assert await compliance.is_suppressed(db_session, other, "sms", "010-9999-8888")
    assert not await compliance.can_send_info(db_session, other, "sms", "01099998888")


@pytest.mark.asyncio
async def test_suppress_idempotent(db_session):
    acct = _acct()
    await compliance.suppress(db_session, acct, "email", "a@x.io")
    await compliance.suppress(db_session, acct, "email", "A@X.io")  # 정규화 → 동일
    await db_session.commit()
    rows = (
        await db_session.execute(
            select(MessageSuppression).where(MessageSuppression.contact == "a@x.io")
        )
    ).scalars().all()
    assert len(rows) == 1


@pytest.mark.asyncio
async def test_can_send_info_ignores_marketing_optout(db_session):
    """정보성은 마케팅 거부(unsubscribe)를 무시 — 거래 알림은 계속."""
    acct = _acct()
    await compliance.suppress(db_session, acct, "email", "a@x.io", "unsubscribe")
    await db_session.commit()
    # 정보성: unsubscribe 는 배달가능 → 계속 발송.
    assert await compliance.can_send_info(db_session, acct, "email", "a@x.io")
    # 광고성: unsubscribe → 차단.
    ad = await compliance.can_send_ad(db_session, acct, "email", "a@x.io")
    assert ad.ok is False and ad.reason == "suppressed"


@pytest.mark.asyncio
async def test_can_send_ad_requires_consent(db_session):
    acct = _acct()
    day = datetime(2026, 8, 20, 3, 0, tzinfo=timezone.utc)  # 주간
    # 동의 없음 → no_consent.
    r = await compliance.can_send_ad(db_session, acct, "email", "a@x.io", day)
    assert r.ok is False and r.reason == "no_consent"

    db_session.add(
        MessageConsent(account_id=acct, contact="a@x.io", channel="email", consented=True)
    )
    await db_session.commit()
    r2 = await compliance.can_send_ad(db_session, acct, "email", "a@x.io", day)
    assert r2.ok is True


@pytest.mark.asyncio
async def test_can_send_ad_night_blocked_without_night_consent(db_session):
    acct = _acct()
    night = datetime(2026, 8, 20, 13, 0, tzinfo=timezone.utc)  # 22:00 KST
    db_session.add(
        MessageConsent(
            account_id=acct,
            contact="a@x.io",
            channel="email",
            consented=True,
            night_consented=False,
        )
    )
    await db_session.commit()
    r = await compliance.can_send_ad(db_session, acct, "email", "a@x.io", night)
    assert r.ok is False and r.reason == "night"


# ── dispatch_service 골격 ─────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_gate_alimtalk_ad_forbidden(db_session):
    p = DispatchParams(
        account_id=str(_acct()),
        channel="kakao",
        message_type="advertising",
        to="01012345678",
        body="광고",
    )
    r = await evaluate_compliance_gate(db_session, p)
    assert r is not None and r.status == "skipped" and r.reason == "alimtalk_ad_forbidden"


@pytest.mark.asyncio
async def test_gate_stored_alimtalk_normalizes_to_kakao(db_session):
    """event_messages 저장 채널 alimtalk도 카카오 광고 게이트를 우회하지 않는다."""
    p = DispatchParams(
        account_id=str(_acct()),
        channel="alimtalk",
        message_type="advertising",
        to="01012345678",
        body="광고",
    )
    r = await evaluate_compliance_gate(db_session, p)
    assert r is not None and r.status == "skipped" and r.reason == "alimtalk_ad_forbidden"


@pytest.mark.asyncio
async def test_gate_push_is_explicitly_unsupported(db_session):
    """push는 조직자 provider로 잘못 fallback하지 않고 명시적으로 skip한다."""
    p = DispatchParams(
        account_id=str(_acct()),
        channel="push",
        message_type="informational",
        to="01012345678",
        body="안내",
    )
    r = await evaluate_compliance_gate(db_session, p)
    assert r is not None and r.status == "skipped" and r.reason == "unsupported_channel"


@pytest.mark.asyncio
async def test_gate_no_contact(db_session):
    p = DispatchParams(
        account_id=str(_acct()),
        channel="email",
        message_type="informational",
        to="   ",
        body="본문",
    )
    r = await evaluate_compliance_gate(db_session, p)
    assert r is not None and r.reason == "no_contact"


@pytest.mark.asyncio
async def test_gate_pass_informational(db_session):
    """정보성 + 억제 없음 → 게이트 통과(None)."""
    p = DispatchParams(
        account_id=str(_acct()),
        channel="email",
        message_type="informational",
        to="a@x.io",
        body="본문",
    )
    assert await evaluate_compliance_gate(db_session, p) is None


@pytest.mark.asyncio
async def test_dispatch_one_provider_stub_raises_on_pass(db_session):
    """게이트 통과 시 provider 스텁이 조용히 실패하지 않고 NotImplemented raise."""
    p = DispatchParams(
        account_id=str(_acct()),
        channel="email",
        message_type="informational",
        to="a@x.io",
        body="본문",
    )
    with pytest.raises(NotImplementedError):
        await dispatch_one(db_session, p, sender=NotImplementedProviderSender())


@pytest.mark.asyncio
async def test_dispatch_one_skipped_short_circuits_provider(db_session):
    """게이트 skip 시 provider 미호출(스텁 raise 안 됨) — skipped 반환."""
    acct = str(_acct())
    p = DispatchParams(
        account_id=acct,
        channel="kakao",
        message_type="advertising",
        to="01012345678",
        body="광고",
    )
    r = await dispatch_one(db_session, p)  # 기본 스텁이어도 raise 안 됨(게이트에서 차단).
    assert r.status == "skipped" and r.reason == "alimtalk_ad_forbidden"
