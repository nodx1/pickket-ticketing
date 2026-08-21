"""레벨2 컷오버 W5-ATTENDEE — go 참석자 부속 원장 v2 이관 회귀.

검증 축(요구된 회귀 항목 포함):
  1. 설문 문항 CRUD + 순서변경 + `events.questions` 투영 동기.
  2. 설문 문항 **id 승계** — go UUID 를 그대로 넣어야 `tickets.answers` 키가 살아남는다.
  3. 설문 문항 삭제 = soft delete — `include_archived=true` 로 라벨이 계속 해석된다.
  4. 초대권 발급 **멱등** — 같은 (event, phone) 2회 예약이 1장만 만든다(created=false 재생).
  5. 초대권 발송 큐 claim-lease — 동시 2회 클레임에 같은 항목이 두 번 나가지 않는다.
  6. 초대권 **send_epoch** — 재클레임(crash 재시도)은 epoch 유지, resend 만 +1.
     (= 외부 알림톡 멱등키가 재시도에서 같고 재발송에서만 달라진다는 계약의 증명)
  7. 초대권 회수 — nonce++ + 대기 큐 제거.
  8. 체크인 로그 멱등 — 같은 (ticket, attended_date) 재기록이 2행이 되지 않는다.
  9. 체크인 명단/로그 테넌트 경계 — 타 organizer 는 404 로 일반화.
 10. 좌석 찜 upsert + 선점(claim) 1회성 + 해제(release).
"""

import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select, update

from app.core.config import settings
from app.models.event import Event, EventStatus, SeatTier
from app.models.go_attendee_ledger import (
    INVITATION_MAX_PER_PHONE,
    CheckInLog,
    EventInvitation,
    EventQuestion,
    InvitationDispatch,
    SeatWatch,
)
from app.models.ticket import Ticket, TicketStatus
from app.models.organizer import OrganizerProfile
from app.models.user import User

_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SECRET}

_BASE = "/api/v1/internal"


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)
    monkeypatch.setattr(settings, "INTERNAL_COMMERCE_REQUIRE_HMAC", False, raising=False)


async def _seed_organizer(db_session, go_account_id: str) -> User:
    user = User(
        email=f"{go_account_id}@attendee.test",
        hashed_password="!x!",
        name="주최자",
        is_organizer=True,
    )
    db_session.add(user)
    await db_session.flush()
    db_session.add(
        OrganizerProfile(
            user_id=user.id,
            company_name="참석자 원장 테스트",
            contact_email=f"{go_account_id}@attendee.test",
            go_account_id=go_account_id,
        )
    )
    await db_session.commit()
    return user


async def _seed_event(db_session, organizer: User) -> Event:
    now = datetime.now(timezone.utc)
    ev = Event(
        organizer_id=organizer.id,
        title="참석자 원장 테스트",
        slug=f"attendee-{uuid.uuid4().hex[:10]}",
        venue="홀",
        event_date=now + timedelta(days=30),
        bidding_opens_at=now,
        bidding_closes_at=now + timedelta(days=10),
        total_seats=100,
        category="concert",
        status=EventStatus.APPROVED,
    )
    db_session.add(ev)
    await db_session.commit()
    return ev


async def _fixture(db_session, prefix: str):
    acct = f"go_{prefix}_{uuid.uuid4().hex[:8]}"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    return acct, org, ev


def _ref(acct: str) -> dict:
    return {"go_account_id": acct}


# ══════════════════════════════════════════════════════════════════════════════
# 1~3. 예매 설문 문항
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def _seed_ticket(db_session, ev, ticket_number: str, status=TicketStatus.ACTIVE) -> Ticket:
    """초대권이 참조하는 comp 티켓 1장. `sold_count` 트리거는 실 PostgreSQL 에만 있다."""
    tier = SeatTier(
        id=uuid.uuid4(),
        event_id=ev.id,
        name="초대권",
        base_price=0,
        capacity=100,
    )
    db_session.add(tier)
    await db_session.flush()
    t = Ticket(
        id=uuid.uuid4(),
        event_id=ev.id,
        tier_id=tier.id,
        purchase_price=0,
        sale_mode="fixed_fcfs",
        status=status,
        ticket_number=ticket_number,
    )
    db_session.add(t)
    await db_session.flush()
    return t


async def test_question_crud_and_event_projection(client, db_session):
    acct, _org, ev = await _fixture(db_session, "q")

    res = await client.post(
        f"{_BASE}/events/{ev.id}/questions",
        json={
            "organizer_ref": _ref(acct),
            "label": "티셔츠 사이즈",
            "question_type": "single_choice",
            "is_required": True,
            "options": ["S", "M", "L"],
        },
        headers=_HDR,
    )
    assert res.status_code == 200, res.text
    q1 = res.json()["data"]["question"]
    assert q1["sort_order"] == 0
    assert q1["options"] == ["S", "M", "L"]

    res = await client.post(
        f"{_BASE}/events/{ev.id}/questions",
        json={
            "organizer_ref": _ref(acct),
            "label": "차량 번호",
            "question_type": "short_text",
        },
        headers=_HDR,
    )
    q2 = res.json()["data"]["question"]
    assert q2["sort_order"] == 1

    # 소비자 상세가 읽는 events.questions 투영이 같은 트랜잭션에서 갱신됐는지.
    await db_session.refresh(ev)
    assert ev.questions is not None
    assert [q["label"] for q in ev.questions] == ["티셔츠 사이즈", "차량 번호"]

    # 순서 변경
    res = await client.put(
        f"{_BASE}/events/{ev.id}/questions/order",
        json={"organizer_ref": _ref(acct), "ordered_ids": [q2["id"], q1["id"]]},
        headers=_HDR,
    )
    assert res.json()["data"]["reordered"] == 2
    await db_session.refresh(ev)
    assert [q["label"] for q in ev.questions] == ["차량 번호", "티셔츠 사이즈"]

    # 수정
    res = await client.patch(
        f"{_BASE}/events/{ev.id}/questions/{q1['id']}",
        json={"organizer_ref": _ref(acct), "label": "상의 사이즈", "is_required": False},
        headers=_HDR,
    )
    assert res.json()["data"]["question"]["label"] == "상의 사이즈"
    assert res.json()["data"]["question"]["is_required"] is False

    # 공개 조회(organizer_ref 없음) — 체크아웃 빌더 경로.
    res = await client.get(f"{_BASE}/events/{ev.id}/questions", headers=_HDR)
    labels = [q["label"] for q in res.json()["data"]["questions"]]
    assert labels == ["차량 번호", "상의 사이즈"]


@pytest.mark.asyncio
async def test_question_id_is_preserved_for_answer_keys(client, db_session):
    """문항 id 승계 — `tickets.answers` 는 문항 id 로 키잉된다(id 가 바뀌면 응답 해석 불가)."""
    acct, _org, ev = await _fixture(db_session, "qid")
    go_id = str(uuid.uuid4())

    res = await client.post(
        f"{_BASE}/events/{ev.id}/questions",
        json={
            "organizer_ref": _ref(acct),
            "question_id": go_id,
            "label": "동반자 성함",
            "question_type": "short_text",
        },
        headers=_HDR,
    )
    assert res.json()["data"]["question"]["id"] == go_id

    row = (
        await db_session.execute(
            select(EventQuestion).where(EventQuestion.id == uuid.UUID(go_id))
        )
    ).scalar_one()
    assert row.label == "동반자 성함"


@pytest.mark.asyncio
async def test_question_delete_is_soft_so_answers_stay_readable(client, db_session):
    """삭제해도 라벨이 남는다 — 이미 수집된 응답이 화면에서 통째로 사라지지 않는다."""
    acct, _org, ev = await _fixture(db_session, "qdel")
    res = await client.post(
        f"{_BASE}/events/{ev.id}/questions",
        json={"organizer_ref": _ref(acct), "label": "알러지", "question_type": "long_text"},
        headers=_HDR,
    )
    qid = res.json()["data"]["question"]["id"]

    res = await client.delete(
        f"{_BASE}/events/{ev.id}/questions/{qid}?organizer_ref={acct}", headers=_HDR
    )
    assert res.json()["data"]["deleted"] is True

    # 기본 목록에서는 사라진다(주최자 폼).
    res = await client.get(
        f"{_BASE}/events/{ev.id}/questions?organizer_ref={acct}", headers=_HDR
    )
    assert res.json()["data"]["questions"] == []

    # 투영도 비워진다(소비자 상세).
    await db_session.refresh(ev)
    assert ev.questions is None

    # 응답 라벨 해석 경로에서는 살아 있다.
    res = await client.get(
        f"{_BASE}/events/{ev.id}/questions?organizer_ref={acct}&include_archived=true",
        headers=_HDR,
    )
    archived = res.json()["data"]["questions"]
    assert len(archived) == 1
    assert archived[0]["label"] == "알러지"
    assert archived[0]["archived"] is True


@pytest.mark.asyncio
async def test_question_tenant_boundary(client, db_session):
    acct_a, _org_a, ev_a = await _fixture(db_session, "qta")
    acct_b, _org_b, _ev_b = await _fixture(db_session, "qtb")

    res = await client.post(
        f"{_BASE}/events/{ev_a.id}/questions",
        json={"organizer_ref": _ref(acct_b), "label": "침입", "question_type": "short_text"},
        headers=_HDR,
    )
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "EVENT_NOT_FOUND"


# ══════════════════════════════════════════════════════════════════════════════
# 4~7. 초대권
# ══════════════════════════════════════════════════════════════════════════════


def _reserve_body(acct: str, phone: str = "01012345678", inv_id: str | None = None) -> dict:
    return {
        "organizer_ref": _ref(acct),
        "invitation_id": inv_id or str(uuid.uuid4()),
        "recipient_name": "홍길동",
        "phone_normalized": phone,
        "phone_display": "010-1234-5678",
    }


@pytest.mark.asyncio
async def test_invitation_reserve_is_idempotent_per_seq(client, db_session):
    """🔴 발급 멱등 — **같은 순번**을 2회 호출해도 1장. 두 번째는 created=false(발권 미실행 신호).

    2026-07-30: 1인 다장 도입 후에도 이 불변식은 유지된다. 유일성 축이
    (event, phone) → (event, phone, **seq**) 로 바뀐 것이고, seq 를 안 넘기면 기본 1 이므로
    **구버전 호출자(1인 1장 전제)와 하위호환**된다. 이 테스트가 그 호환을 지킨다.
    """
    acct, _org, ev = await _fixture(db_session, "inv")

    first = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json=_reserve_body(acct),
        headers=_HDR,
    )
    assert first.json()["data"]["created"] is True

    second = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json=_reserve_body(acct),  # 다른 invitation_id, 같은 phone
        headers=_HDR,
    )
    assert second.json()["data"]["created"] is False
    assert (
        second.json()["data"]["invitation"]["id"]
        == first.json()["data"]["invitation"]["id"]
    )

    count = (
        await db_session.execute(
            select(func.count())
            .select_from(EventInvitation)
            .where(EventInvitation.event_id == ev.id)
        )
    ).scalar_one()
    assert count == 1


@pytest.mark.asyncio
async def test_invitation_reserve_allows_up_to_five_per_phone(client, db_session):
    """🔴 1인 다장 — 같은 번호에 seq 1..MAX 까지 예약된다(대회 요건).

    ⚠️ 숫자를 여기 적지 않는다. `INVITATION_MAX_PER_PHONE` 을 참조한다 —
       2026-08-09 에 5 → 50 으로 바뀌었고, 하드코딩이었으면 이 테스트가
       **상한이 안 올라간 것도 통과**시켰을 자리다.

    종전에는 UNIQUE(event_id, phone_normalized) 가 2장째를 튕겨 1장으로 강제됐다.
    이 단언이 그 제약이 seq 를 포함하도록 바뀌었음을 고정한다.
    """
    acct, _org, ev = await _fixture(db_session, "inv5")

    for seq in range(1, INVITATION_MAX_PER_PHONE + 1):
        body = {**_reserve_body(acct), "seq": seq}
        res = await client.post(
            f"{_BASE}/events/{ev.id}/invitations/reserve", json=body, headers=_HDR
        )
        assert res.status_code == 200, (seq, res.text)
        data = res.json()["data"]
        assert data["created"] is True, seq
        assert data["invitation"]["seq"] == seq

    count = (
        await db_session.execute(
            select(func.count())
            .select_from(EventInvitation)
            .where(EventInvitation.event_id == ev.id)
        )
    ).scalar_one()
    assert count == INVITATION_MAX_PER_PHONE


@pytest.mark.asyncio
async def test_invitation_reserve_rejects_sixth_with_limit(client, db_session):
    """🔴 6장째는 **409 INVITATION_LIMIT** — 상한은 이 지점이 원자 집행한다.

    호출자(go)는 seq 를 올려가며 시도하고 이 409 를 종료 조건으로 쓴다.
    상한을 호출자가 세면 동시 요청에 뚫린다(둘이 각각 4장을 세고 발급 → 6장).
    """
    acct, _org, ev = await _fixture(db_session, "inv6")

    for seq in range(1, INVITATION_MAX_PER_PHONE + 1):
        await client.post(
            f"{_BASE}/events/{ev.id}/invitations/reserve",
            json={**_reserve_body(acct), "seq": seq},
            headers=_HDR,
        )

    # 🔴 seq 6 → **409 INVITATION_LIMIT**. 422 가 아니다.
    #    호출자(go)는 seq 를 올려가며 이 409 를 만나면 멈춘다 — 상한 숫자를 go 가 모른다.
    #    ⚠️ 초안은 스키마에 le=5 를 걸어 422 를 냈고, 그 결과 409 분기가 **도달 불가한
    #       죽은 코드**가 됐다(뮤테이션 생존으로 발견). 계약이 발동하지 않는 형태였다.
    over = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json={**_reserve_body(acct), "seq": INVITATION_MAX_PER_PHONE + 1},
        headers=_HDR,
    )
    assert over.status_code == 409, over.text
    assert over.json()["error"]["code"] == "INVITATION_LIMIT"

    # 이미 존재하는 seq 재요청은 상한이 아니라 **멱등 재생**(재업로드 방어 유지).
    dup = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json={**_reserve_body(acct), "seq": INVITATION_MAX_PER_PHONE},
        headers=_HDR,
    )
    assert dup.status_code == 200
    assert dup.json()["data"]["created"] is False


@pytest.mark.asyncio
async def test_invitation_reserve_revives_revoked_slot(client, db_session):
    """🔴 회수된 순번은 **재사용된다** — 회수 후 그 번호로 재발급이 가능해야 한다.

    ⚠️ 이 테스트는 뮤테이션에서 처음 실패했다. 초안은 DB 를 직접 조회해
       `active == 4` 만 단언했고, **엔드포인트를 거치지 않아** 상한 분기를 못 잡았다
       (상한 계산에서 revoked 를 제외하는 코드를 지워도 초록이었다).
       그 과정에서 실제 결함이 드러났다: 상한은 revoked 를 빼는데 **순번 자리는
       회수된 행이 계속 점유**해서, 회수하면 그 번호로 영구히 재발급이 안 됐다.

    ⟹ 단언은 반드시 **API 응답**으로 한다. 내부 상태 조회로는 분기가 검증되지 않는다.
    """
    acct, _org, ev = await _fixture(db_session, "invrev")

    ids = []
    for seq in range(1, 6):
        res = await client.post(
            f"{_BASE}/events/{ev.id}/invitations/reserve",
            json={**_reserve_body(acct), "seq": seq},
            headers=_HDR,
        )
        ids.append(res.json()["data"]["invitation"]["id"])

    # 5장 꽉 찬 상태에서 seq=1 재요청 → 기존 행 멱등 재생(발권 안 함).
    before = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json={**_reserve_body(acct), "seq": 1},
        headers=_HDR,
    )
    assert before.json()["data"]["created"] is False

    # 주최자가 seq=1 을 회수.
    revoke = await client.post(
        f"{_BASE}/invitations/{ids[0]}/revoke",
        json={"organizer_ref": _ref(acct)},
        headers=_HDR,
    )
    assert revoke.status_code == 200, revoke.text

    # 🔴 같은 seq 로 재요청 → **created=true**(자리 재사용, 새 티켓 발권 신호).
    after = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json={**_reserve_body(acct), "seq": 1, "recipient_name": "다른사람"},
        headers=_HDR,
    )
    assert after.status_code == 200, after.text
    data = after.json()["data"]
    assert data["created"] is True, "회수된 순번이 재사용되지 않았다"
    assert data["invitation"]["seq"] == 1
    assert data["invitation"]["status"] == "issued"
    assert data["invitation"]["recipient_name"] == "다른사람"
    assert data["invitation"]["ticket_number"] is None, "옛 티켓번호가 남아 있다"

    # 행 수는 그대로 5 — 자리를 재사용했으므로 늘지 않는다.
    count = (
        await db_session.execute(
            select(func.count())
            .select_from(EventInvitation)
            .where(EventInvitation.event_id == ev.id)
        )
    ).scalar_one()
    assert count == 5


@pytest.mark.asyncio
async def test_invitation_reserve_over_range_seq_is_limit_not_conflict(client, db_session):
    """🔴 범위 밖 seq 는 **발급 수와 무관하게** 409 INVITATION_LIMIT — CONFLICT 가 아니다.

    회람 지적 A 시나리오: `issued_count < MAX` 인데 seq 가 범위 밖인 경우.
    가드가 없으면 INSERT 까지 가서 CHECK 위반 → IntegrityError 핸들러 →
    `_existing()` 이 None → **`CONFLICT`** 가 나간다. 호출자의 종료 조건이
    "INVITATION_LIMIT" 이므로 그러면 루프가 종료 신호를 못 알아본다.

    스키마가 `le` 를 걸지 않는 것은 의도다(422 대신 409 를 주기 위해). 그 대가로
    **범위 검사를 서버가 명시적으로** 해야 한다 — 이 테스트가 그 가드를 고정한다.
    """
    acct, _org, ev = await _fixture(db_session, "invrange")

    # 1장만 발급 — 상한(issued_count>=MAX) 검사로는 잡히지 않는 상태를 만든다.
    await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json={**_reserve_body(acct), "seq": 1},
        headers=_HDR,
    )

    M = INVITATION_MAX_PER_PHONE
    for bad_seq in (M + 1, M + 2, M + 949):
        res = await client.post(
            f"{_BASE}/events/{ev.id}/invitations/reserve",
            json={**_reserve_body(acct), "seq": bad_seq},
            headers=_HDR,
        )
        assert res.status_code == 409, (bad_seq, res.text)
        assert res.json()["error"]["code"] == "INVITATION_LIMIT", (
            f"seq={bad_seq} 가 INVITATION_LIMIT 이 아니라 "
            f"{res.json()['error']['code']} 로 나갔다 — 호출자 종료조건이 깨진다"
        )

    # 범위 밖 요청이 행을 만들지 않았는지 — 거부가 진짜 거부인가.
    count = (
        await db_session.execute(
            select(func.count())
            .select_from(EventInvitation)
            .where(EventInvitation.event_id == ev.id)
        )
    ).scalar_one()
    assert count == 1


@pytest.mark.asyncio
async def test_invitation_revive_clears_revoked_at(client, db_session):
    """🔴 부활 시 `revoked_at` 을 비운다 — status=issued 인데 revoked_at 이 남으면 모순 행이다.

    지금 이 필드를 판정에 쓰는 코드는 없다. 그러나 이 리포에는 `revoked_at IS NULL` 로
    유효성을 보는 관용구가 이미 있다(delegation_token 계열). 초대권에 같은 관용구를
    쓰는 순간 **부활된 초대권이 회수된 것으로 판정**된다 — 그때 이 테스트가 막는다.
    """
    acct, _org, ev = await _fixture(db_session, "invrevat")

    res = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json={**_reserve_body(acct), "seq": 1},
        headers=_HDR,
    )
    inv_id = res.json()["data"]["invitation"]["id"]

    await client.post(
        f"{_BASE}/invitations/{inv_id}/revoke",
        json={"organizer_ref": _ref(acct)},
        headers=_HDR,
    )
    revoked = (
        await db_session.execute(
            select(EventInvitation).where(EventInvitation.id == uuid.UUID(inv_id))
        )
    ).scalar_one()
    await db_session.refresh(revoked)
    assert revoked.revoked_at is not None, "회수가 revoked_at 을 채우지 않았다(전제 붕괴)"

    await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json={**_reserve_body(acct), "seq": 1},
        headers=_HDR,
    )
    await db_session.refresh(revoked)
    assert revoked.status == "issued"
    assert revoked.revoked_at is None, "부활했는데 revoked_at 이 남아 모순된 행이 됐다"


@pytest.mark.asyncio
async def test_invitation_reserve_default_seq_is_one(client, db_session):
    """seq 미지정 = 1 — 구버전 호출자 하위호환(발권 경로가 seq 를 모르던 시점)."""
    acct, _org, ev = await _fixture(db_session, "invdef")

    res = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json=_reserve_body(acct),  # seq 없음
        headers=_HDR,
    )
    assert res.json()["data"]["invitation"]["seq"] == 1


@pytest.mark.asyncio
async def test_invitation_issued_enqueues_dispatch_atomically(client, db_session):
    acct, _org, ev = await _fixture(db_session, "invq")
    res = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json=_reserve_body(acct),
        headers=_HDR,
    )
    inv_id = res.json()["data"]["invitation"]["id"]

    res = await client.post(
        f"{_BASE}/invitations/{inv_id}/issued",
        json={"organizer_ref": _ref(acct), "ticket_number": "PKT-0001"},
        headers=_HDR,
    )
    assert res.json()["data"]["queued"] is True
    assert res.json()["data"]["invitation"]["ticket_number"] == "PKT-0001"

    # 재호출은 큐를 두 번 만들지 않는다.
    res = await client.post(
        f"{_BASE}/invitations/{inv_id}/issued",
        json={"organizer_ref": _ref(acct), "ticket_number": "PKT-0001"},
        headers=_HDR,
    )
    assert res.json()["data"]["queued"] is False

    n = (
        await db_session.execute(
            select(func.count())
            .select_from(InvitationDispatch)
            .where(InvitationDispatch.invitation_id == uuid.UUID(inv_id))
        )
    ).scalar_one()
    assert n == 1


@pytest.mark.asyncio
async def test_dispatch_claim_lease_prevents_double_send(client, db_session):
    """claim-lease — 이미 선점된 항목은 두 번째 클레임에 잡히지 않는다(이중발송 차단)."""
    acct, _org, ev = await _fixture(db_session, "disp")
    res = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json=_reserve_body(acct),
        headers=_HDR,
    )
    inv_id = res.json()["data"]["invitation"]["id"]
    await client.post(
        f"{_BASE}/invitations/{inv_id}/issued",
        json={"organizer_ref": _ref(acct), "ticket_number": "PKT-0002"},
        headers=_HDR,
    )

    tok_a, tok_b = str(uuid.uuid4()), str(uuid.uuid4())
    a = await client.post(
        f"{_BASE}/invitation-dispatch/claim",
        json={"claim_token": tok_a, "limit": 50, "lease_minutes": 5},
        headers=_HDR,
    )
    assert len(a.json()["data"]["items"]) == 1
    item = a.json()["data"]["items"][0]
    assert item["ticket_number"] == "PKT-0002"
    assert item["send_epoch"] == 0

    b = await client.post(
        f"{_BASE}/invitation-dispatch/claim",
        json={"claim_token": tok_b, "limit": 50, "lease_minutes": 5},
        headers=_HDR,
    )
    assert b.json()["data"]["items"] == []

    # 늦게 돌아온 이전 워커(토큰 불일치)는 결과를 덮어쓰지 못한다.
    late = await client.post(
        f"{_BASE}/invitation-dispatch/complete",
        json={
            "claim_token": tok_b,
            "dispatch_ids": [item["dispatch_id"]],
            "invitation_ids": [inv_id],
            "sent": True,
        },
        headers=_HDR,
    )
    assert late.json()["data"]["updated"] == 0

    ok = await client.post(
        f"{_BASE}/invitation-dispatch/complete",
        json={
            "claim_token": tok_a,
            "dispatch_ids": [item["dispatch_id"]],
            "invitation_ids": [inv_id],
            "sent": True,
            "request_id": "req-1",
        },
        headers=_HDR,
    )
    assert ok.json()["data"]["updated"] == 1

    row = (
        await db_session.execute(
            select(EventInvitation).where(EventInvitation.id == uuid.UUID(inv_id))
        )
    ).scalar_one()
    assert row.status == "sent"


@pytest.mark.asyncio
async def test_send_epoch_stable_on_retry_and_bumped_on_resend(client, db_session):
    """🔴 외부 발송 멱등키 시드 계약.

    · 리스 만료 후 재클레임(= 발송 후 crash 재시도) → epoch 그대로 → 같은 멱등키 → 2통 없음.
    · 주최자의 명시적 재발송 → epoch +1 → 새 멱등키 → 실제로 다시 나간다.
    """
    acct, _org, ev = await _fixture(db_session, "epoch")
    res = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json=_reserve_body(acct),
        headers=_HDR,
    )
    inv_id = res.json()["data"]["invitation"]["id"]
    await client.post(
        f"{_BASE}/invitations/{inv_id}/issued",
        json={"organizer_ref": _ref(acct), "ticket_number": "PKT-0003"},
        headers=_HDR,
    )

    first = await client.post(
        f"{_BASE}/invitation-dispatch/claim",
        json={"claim_token": str(uuid.uuid4()), "limit": 10, "lease_minutes": 5},
        headers=_HDR,
    )
    assert first.json()["data"]["items"][0]["send_epoch"] == 0

    # 리스 강제 만료(= 워커가 발송 직후 죽어 결과를 못 남긴 상황).
    dispatch = (
        await db_session.execute(
            select(InvitationDispatch).where(
                InvitationDispatch.invitation_id == uuid.UUID(inv_id)
            )
        )
    ).scalar_one()
    dispatch.claim_expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    await db_session.commit()

    again = await client.post(
        f"{_BASE}/invitation-dispatch/claim",
        json={"claim_token": str(uuid.uuid4()), "limit": 10, "lease_minutes": 5},
        headers=_HDR,
    )
    retried = again.json()["data"]["items"][0]
    assert retried["send_epoch"] == 0  # 같은 멱등키 → NCP 가 dedup → 2통 없음
    assert retried["attempt_count"] == 2  # 시도 횟수는 늘어난다(관측용)

    # 🔴 2026-08-04 계약 변경 — 이 시점의 큐는 'sending' + **리스가 살아 있다**
    #    (바로 위 재클레임이 lease_minutes=5 로 잡았다). 종전엔 여기서 resend 가
    #    그대로 성공했는데, 그게 중복 발송 경로였다: claim_token 이 풀리면 워커 A 는
    #    그대로 보내고 워커 B 가 같은 행을 또 집는다. 이제는 409 로 막힌다.
    inflight = await client.post(
        f"{_BASE}/invitations/{inv_id}/resend",
        json={"organizer_ref": _ref(acct)},
        headers=_HDR,
    )
    assert inflight.status_code == 409, "🔴 발송 중인데 재발송이 통과했다 — 두 통 나간다"

    # 워커가 끝났거나 죽었다(리스 만료) → 그때부터 재발송이 열린다.
    dispatch = (
        await db_session.execute(
            select(InvitationDispatch).where(
                InvitationDispatch.invitation_id == uuid.UUID(inv_id)
            )
        )
    ).scalar_one()
    dispatch.claim_expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    await db_session.commit()

    # 명시적 재발송만 epoch 를 올린다.
    res = await client.post(
        f"{_BASE}/invitations/{inv_id}/resend",
        json={"organizer_ref": _ref(acct)},
        headers=_HDR,
    )
    assert res.json()["data"]["requeued"] is True
    after = await client.post(
        f"{_BASE}/invitation-dispatch/claim",
        json={"claim_token": str(uuid.uuid4()), "limit": 10, "lease_minutes": 5},
        headers=_HDR,
    )
    assert after.json()["data"]["items"][0]["send_epoch"] == 1


@pytest.mark.asyncio
async def test_invitation_revoke_bumps_nonce_and_drops_queue(client, db_session):
    acct, _org, ev = await _fixture(db_session, "rev")
    res = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json=_reserve_body(acct),
        headers=_HDR,
    )
    inv_id = res.json()["data"]["invitation"]["id"]
    await client.post(
        f"{_BASE}/invitations/{inv_id}/issued",
        json={"organizer_ref": _ref(acct), "ticket_number": "PKT-0004"},
        headers=_HDR,
    )

    res = await client.post(
        f"{_BASE}/invitations/{inv_id}/revoke",
        json={"organizer_ref": _ref(acct)},
        headers=_HDR,
    )
    data = res.json()["data"]
    assert data["revoked"] is True
    assert data["invitation"]["token_version"] == 1
    assert data["invitation"]["status"] == "revoked"

    queued = (
        await db_session.execute(
            select(func.count())
            .select_from(InvitationDispatch)
            .where(InvitationDispatch.invitation_id == uuid.UUID(inv_id))
        )
    ).scalar_one()
    assert queued == 0  # 대기 중 발송 제거 — 회수 후 알림톡이 나가지 않는다

    # 회수 재호출은 nonce 를 또 올리지 않는다(멱등).
    res = await client.post(
        f"{_BASE}/invitations/{inv_id}/revoke",
        json={"organizer_ref": _ref(acct)},
        headers=_HDR,
    )
    assert res.json()["data"]["revoked"] is False
    assert res.json()["data"]["invitation"]["token_version"] == 1


@pytest.mark.asyncio
async def test_invitation_mark_by_ticket_number(client, db_session):
    acct, _org, ev = await _fixture(db_session, "mark")
    res = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json=_reserve_body(acct),
        headers=_HDR,
    )
    inv_id = res.json()["data"]["invitation"]["id"]
    await client.post(
        f"{_BASE}/invitations/{inv_id}/issued",
        json={"organizer_ref": _ref(acct), "ticket_number": "PKT-0005"},
        headers=_HDR,
    )

    res = await client.post(
        f"{_BASE}/invitations/by-ticket-number/PKT-0005/mark",
        json={"state": "viewed"},
        headers=_HDR,
    )
    assert res.json()["data"]["updated"] == 1

    res = await client.post(
        f"{_BASE}/invitations/by-ticket-number/PKT-0005/mark",
        json={"state": "checked_in"},
        headers=_HDR,
    )
    assert res.json()["data"]["updated"] == 1

    row = (
        await db_session.execute(
            select(EventInvitation).where(EventInvitation.id == uuid.UUID(inv_id))
        )
    ).scalar_one()
    assert row.status == "checked_in"
    assert row.viewed_at is not None

    # 초대권이 아닌 티켓번호는 무매칭(무영향).
    res = await client.post(
        f"{_BASE}/invitations/by-ticket-number/PKT-NOPE/mark",
        json={"state": "viewed"},
        headers=_HDR,
    )
    assert res.json()["data"]["updated"] == 0


@pytest.mark.asyncio
async def test_invitation_tenant_boundary(client, db_session):
    acct_a, _org_a, ev_a = await _fixture(db_session, "ita")
    acct_b, _org_b, _ev_b = await _fixture(db_session, "itb")

    res = await client.post(
        f"{_BASE}/events/{ev_a.id}/invitations/reserve",
        json=_reserve_body(acct_a),
        headers=_HDR,
    )
    inv_id = res.json()["data"]["invitation"]["id"]

    res = await client.post(
        f"{_BASE}/invitations/{inv_id}/revoke",
        json={"organizer_ref": _ref(acct_b)},
        headers=_HDR,
    )
    assert res.status_code == 404
    assert res.json()["error"]["code"] == "INVITATION_NOT_FOUND"

    res = await client.get(
        f"{_BASE}/events/{ev_a.id}/invitations?organizer_ref={acct_b}", headers=_HDR
    )
    assert res.status_code == 404


# ══════════════════════════════════════════════════════════════════════════════
# 8~9. 체크인 명단 / 로그
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_check_in_list_crud_and_single_read(client, db_session):
    acct, _org, ev = await _fixture(db_session, "cil")
    product_id = str(uuid.uuid4())

    res = await client.post(
        f"{_BASE}/events/{ev.id}/check-in-lists",
        json={"organizer_ref": _ref(acct), "name": "정문 게이트", "product_ids": [product_id]},
        headers=_HDR,
    )
    assert res.status_code == 200, res.text
    lst = res.json()["data"]["list"]
    assert lst["status"] == "active"
    assert lst["product_ids"] == [product_id]

    res = await client.get(
        f"{_BASE}/events/{ev.id}/check-in-lists/{lst['id']}?organizer_ref={acct}",
        headers=_HDR,
    )
    assert res.json()["data"]["list"]["name"] == "정문 게이트"

    res = await client.patch(
        f"{_BASE}/events/{ev.id}/check-in-lists/{lst['id']}",
        json={"organizer_ref": _ref(acct), "status": "closed"},
        headers=_HDR,
    )
    assert res.json()["data"]["list"]["status"] == "closed"

    res = await client.delete(
        f"{_BASE}/events/{ev.id}/check-in-lists/{lst['id']}?organizer_ref={acct}",
        headers=_HDR,
    )
    assert res.json()["data"]["deleted"] is True

    res = await client.delete(
        f"{_BASE}/events/{ev.id}/check-in-lists/{lst['id']}?organizer_ref={acct}",
        headers=_HDR,
    )
    assert res.status_code == 404  # 멱등 흡수 금지 — 없는 것은 404 로 말한다


@pytest.mark.asyncio
async def test_check_in_log_record_is_idempotent_per_ticket_day(client, db_session):
    """🔴 하루 1행 — 같은 (티켓, 입장일) 재기록이 로그를 부풀리지 않는다(복구 가능)."""
    acct, _org, ev = await _fixture(db_session, "cilog")
    ticket_id = str(uuid.uuid4())
    day = date.today().isoformat()

    body = {
        "organizer_ref": _ref(acct),
        "ticket_id": ticket_id,
        "attended_date": day,
        "attendee_name": "김관람",
        "ticket_number": "PKT-9001",
        "method": "qr",
    }
    first = await client.post(
        f"{_BASE}/events/{ev.id}/check-in-logs", json=body, headers=_HDR
    )
    assert first.json()["data"]["created"] is True

    second = await client.post(
        f"{_BASE}/events/{ev.id}/check-in-logs", json=body, headers=_HDR
    )
    assert second.json()["data"]["created"] is False
    assert second.json()["data"]["id"] == first.json()["data"]["id"]

    n = (
        await db_session.execute(
            select(func.count())
            .select_from(CheckInLog)
            .where(CheckInLog.ticket_id == uuid.UUID(ticket_id))
        )
    ).scalar_one()
    assert n == 1

    # 목록 + 입장취소 원복.
    res = await client.get(
        f"{_BASE}/events/{ev.id}/check-in-logs?organizer_ref={acct}&ticket_id={ticket_id}",
        headers=_HDR,
    )
    assert len(res.json()["data"]["logs"]) == 1

    res = await client.delete(
        f"{_BASE}/events/{ev.id}/check-in-logs"
        f"?organizer_ref={acct}&ticket_id={ticket_id}&attended_date={day}",
        headers=_HDR,
    )
    assert res.json()["data"]["deleted"] == 1


@pytest.mark.asyncio
async def test_check_in_tenant_boundary(client, db_session):
    acct_a, _org_a, ev_a = await _fixture(db_session, "cta")
    acct_b, _org_b, _ev_b = await _fixture(db_session, "ctb")

    res = await client.post(
        f"{_BASE}/events/{ev_a.id}/check-in-lists",
        json={"organizer_ref": _ref(acct_b), "name": "침입 명단"},
        headers=_HDR,
    )
    assert res.status_code == 404

    res = await client.get(
        f"{_BASE}/events/{ev_a.id}/check-in-logs?organizer_ref={acct_b}", headers=_HDR
    )
    assert res.status_code == 404


# ══════════════════════════════════════════════════════════════════════════════
# 10. 좌석 알림(찜)
# ══════════════════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_seat_watch_upsert_claim_release(client, db_session):
    _acct, _org, ev = await _fixture(db_session, "sw")
    seat_id = str(uuid.uuid4())
    session_id = f"sess-{uuid.uuid4().hex[:12]}"

    res = await client.post(
        f"{_BASE}/events/{ev.id}/seat-watches",
        json={"seat_id": seat_id, "session_id": session_id, "target_price": 50000},
        headers=_HDR,
    )
    assert res.status_code == 200, res.text
    watch_id = res.json()["data"]["watch"]["id"]

    # 같은 좌석 재등록 = 갱신(중복 행 없음).
    res = await client.post(
        f"{_BASE}/events/{ev.id}/seat-watches",
        json={"seat_id": seat_id, "session_id": session_id, "target_price": 40000},
        headers=_HDR,
    )
    assert res.json()["data"]["watch"]["id"] == watch_id
    assert res.json()["data"]["watch"]["target_price"] == 40000

    n = (
        await db_session.execute(
            select(func.count()).select_from(SeatWatch).where(SeatWatch.event_id == ev.id)
        )
    ).scalar_one()
    assert n == 1

    # 소유자 없는 조회/등록은 400(빈 목록으로 위장 금지).
    res = await client.get(f"{_BASE}/events/{ev.id}/seat-watches", headers=_HDR)
    assert res.status_code == 400

    # cron 후보 → 선점 1회성.
    res = await client.get(f"{_BASE}/seat-watches/pending?limit=10", headers=_HDR)
    assert any(w["id"] == watch_id for w in res.json()["data"]["watches"])

    first = await client.post(f"{_BASE}/seat-watches/{watch_id}/claim", headers=_HDR)
    assert first.json()["data"]["claimed"] is True
    second = await client.post(f"{_BASE}/seat-watches/{watch_id}/claim", headers=_HDR)
    assert second.json()["data"]["claimed"] is False  # 이중발송 차단

    # 발송 실패 복구 — 선점 해제 후 다시 후보가 된다.
    res = await client.post(f"{_BASE}/seat-watches/{watch_id}/release", headers=_HDR)
    assert res.json()["data"]["released"] is True
    res = await client.post(f"{_BASE}/seat-watches/{watch_id}/claim", headers=_HDR)
    assert res.json()["data"]["claimed"] is True

    # 해제(찜 삭제).
    res = await client.delete(
        f"{_BASE}/events/{ev.id}/seat-watches?seat_id={seat_id}&session_id={session_id}",
        headers=_HDR,
    )
    assert res.json()["data"]["deleted"] == 1


# ── 🔴 전달 상태 대사 — "접수됨"과 "도달함"은 다른 사실이다 ────────────────────
#
# 실측(2026-07-28, 실계정 발송): 버튼 링크가 승인 템플릿과 어긋난 발송이 접수는
# A000(성공)으로, 전달은 3027(실패)로 돌아왔다. 접수만 보던 옛 경로에서는
# **카톡이 도착하지 않았는데 원장에 status='sent'** 로 남았다.


async def _sent_dispatch(client, db_session, tag: str):
    """발송 완료(status='sent', request_id 있음) 상태의 dispatch 1건을 만든다."""
    acct, _org, ev = await _fixture(db_session, tag)
    res = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json=_reserve_body(acct),
        headers=_HDR,
    )
    inv_id = res.json()["data"]["invitation"]["id"]
    await client.post(
        f"{_BASE}/invitations/{inv_id}/issued",
        json={"organizer_ref": _ref(acct), "ticket_number": f"PKT-{tag}"},
        headers=_HDR,
    )
    tok = str(uuid.uuid4())
    claim = await client.post(
        f"{_BASE}/invitation-dispatch/claim",
        json={"claim_token": tok, "limit": 50, "lease_minutes": 5},
        headers=_HDR,
    )
    assert claim.status_code == 200, claim.text
    item = claim.json()["data"]["items"][0]
    await client.post(
        f"{_BASE}/invitation-dispatch/complete",
        json={
            "claim_token": tok,
            "dispatch_ids": [item["dispatch_id"]],
            "invitation_ids": [inv_id],
            "sent": True,
            "request_id": f"req-{tag}",
        },
        headers=_HDR,
    )
    return inv_id, item["dispatch_id"]


@pytest.mark.asyncio
async def test_pending_delivery_check_respects_grace(client, db_session):
    """방금 발송한 건은 대사 후보가 아니다 — SENS 가 아직 전달결과를 모른다.

    유예 없이 조회하면 코드가 비어 돌아와 **정상 발송을 미도달로 오판**한다.
    """
    _inv, _disp = await _sent_dispatch(client, db_session, "grace")
    res = await client.get(f"{_BASE}/invitation-dispatch/pending-delivery-check", headers=_HDR)
    assert res.status_code == 200
    assert res.json()["data"]["items"] == [], "유예 전인데 대사 후보로 나왔다"


@pytest.mark.asyncio
async def test_pending_delivery_check_lists_after_grace(client, db_session):
    """유예가 지난 발송은 대사 후보로 나온다."""
    from app.models.go_attendee_ledger import InvitationDispatch

    _inv, disp_id = await _sent_dispatch(client, db_session, "aftergrace")
    # 발송 시각을 5분 전으로 밀어 유예 통과.
    await db_session.execute(
        update(InvitationDispatch)
        .where(InvitationDispatch.id == uuid.UUID(disp_id))
        .values(updated_at=datetime.now(timezone.utc) - timedelta(minutes=5))
    )
    await db_session.commit()

    res = await client.get(f"{_BASE}/invitation-dispatch/pending-delivery-check", headers=_HDR)
    items = res.json()["data"]["items"]
    assert [i["dispatch_id"] for i in items] == [disp_id]
    assert items[0]["request_id"] == "req-aftergrace"
    assert items[0]["phone"], "전화번호가 없으면 SENS 응답과 매칭할 수 없다"


@pytest.mark.asyncio
async def test_delivery_result_undelivered_flips_to_failed(client, db_session):
    """🔴 미도달로 확인되면 sent → failed 로 내려간다.

    이게 없으면 미도달이 영구히 '발송됨'으로 남고, 주최자는 손님이 못 받은 걸 모른다.
    """
    from app.models.go_attendee_ledger import EventInvitation, InvitationDispatch

    inv_id, disp_id = await _sent_dispatch(client, db_session, "undeliv")
    res = await client.post(
        f"{_BASE}/invitation-dispatch/delivery-result",
        json={
            "checked": [
                {
                    "dispatch_id": disp_id,
                    "invitation_id": inv_id,
                    "delivered": False,
                    "code": "3027",
                    "desc": "버튼 내용이 템플릿과 일치 하지 않음",
                }
            ]
        },
        headers=_HDR,
    )
    assert res.status_code == 200
    assert res.json()["data"]["undelivered"] == 1

    d = await db_session.get(InvitationDispatch, uuid.UUID(disp_id))
    await db_session.refresh(d)
    assert d.status == "failed"
    assert "3027" in (d.last_error or "")
    assert d.delivery_checked_at is not None

    inv = await db_session.get(EventInvitation, uuid.UUID(inv_id))
    await db_session.refresh(inv)
    assert inv.status == "failed", "초대 원장이 sent 로 남으면 화면이 계속 발송됨으로 보인다"


@pytest.mark.asyncio
async def test_delivery_result_delivered_marks_checked_only(client, db_session):
    """도달 확인은 상태를 바꾸지 않고 대사 흔적만 남긴다(재조회 대상에서 빠진다)."""
    from app.models.go_attendee_ledger import InvitationDispatch

    inv_id, disp_id = await _sent_dispatch(client, db_session, "deliv")
    await client.post(
        f"{_BASE}/invitation-dispatch/delivery-result",
        json={"checked": [{"dispatch_id": disp_id, "invitation_id": inv_id, "delivered": True, "code": "0000"}]},
        headers=_HDR,
    )
    d = await db_session.get(InvitationDispatch, uuid.UUID(disp_id))
    await db_session.refresh(d)
    assert d.status == "sent"
    assert d.delivery_checked_at is not None

    # 대사된 건은 후보로 다시 나오지 않는다.
    await db_session.execute(
        update(InvitationDispatch)
        .where(InvitationDispatch.id == uuid.UUID(disp_id))
        .values(updated_at=datetime.now(timezone.utc) - timedelta(minutes=5))
    )
    await db_session.commit()
    res = await client.get(f"{_BASE}/invitation-dispatch/pending-delivery-check", headers=_HDR)
    assert res.json()["data"]["items"] == []


@pytest.mark.asyncio
async def test_delivery_result_is_idempotent(client, db_session):
    """중복 호출·동시 2회에도 원장이 한 번만 움직인다."""
    inv_id, disp_id = await _sent_dispatch(client, db_session, "idem")
    body = {"checked": [{"dispatch_id": disp_id, "invitation_id": inv_id, "delivered": False, "code": "3027"}]}
    first = await client.post(f"{_BASE}/invitation-dispatch/delivery-result", json=body, headers=_HDR)
    second = await client.post(f"{_BASE}/invitation-dispatch/delivery-result", json=body, headers=_HDR)
    assert first.json()["data"]["marked"] == 1
    assert second.json()["data"]["marked"] == 0, "두 번째 호출이 원장을 또 움직였다"


# ── 초대권 양도 (2026-08-03 대표 확정: 제자리 갱신 + 5장 상한 유지) ──────────
#
# 🔴 왜 제자리 갱신인가
#
# `ticket_number` 는 원장 **4곳**의 키다 — v2 tickets · v2 event_invitations ·
# v2 check_in_logs · go attendees. 새 행을 만들면 같은 좌석이 명단에 두 벌이 된다
# ("양도함" 한 줄 + "유효" 한 줄). 대회 당일 입구에서 그걸 보고 판단해야 한다.
# **현장에서 헷갈리면 그게 사고다.**
#
# 옛 링크 무효화는 이미 있는 장치를 쓴다 — `token_version++` 하면 기 발송 딥링크의
# 서명 payload(`{ticketNumber, v}`)가 원장과 어긋나 즉시 죽는다(revoke 와 같은 방식).
#
# 🔴 인증 코드는 없다. 소유 증명 = 링크 소지, 게이트는 QR 만 본다.
#    SMS 2단계를 넣으면 VIP 100장 배포가 100번 인증이 된다.


async def _seed_invitation(client, acct: str, ev, phone: str = "01011112222") -> dict:
    """초대권 1장 발급하고 원장 행을 돌려준다."""
    res = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json=_reserve_body(acct, phone=phone),
        headers=_HDR,
    )
    assert res.status_code == 200, res.text
    return res.json()["data"]["invitation"]


def _transfer_body(acct: str, phone: str = "01099998888", name: str = "김철수") -> dict:
    return {
        "organizer_ref": _ref(acct),
        "to_name": name,
        "to_phone_normalized": phone,
        "to_phone_display": "010-9999-8888",
    }


@pytest.mark.asyncio
async def test_transfer_moves_owner_and_kills_old_link(client, db_session):
    """🔴 양도하면 받는 사람으로 바뀌고 **옛 링크가 죽는다**(token_version 증가).

    이것이 이 기능의 전부다 — 옛 링크가 안 죽으면 두 사람이 같은 티켓을 들고
    현장에 온다(지금 "선물하기"가 그렇다).
    """
    acct = "go_tr_1"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv = await _seed_invitation(client, acct, ev)
    before_tv = inv["token_version"]

    res = await client.post(
        f"{_BASE}/invitations/{inv['id']}/transfer",
        json=_transfer_body(acct),
        headers=_HDR,
    )
    assert res.status_code == 200, res.text
    data = res.json()["data"]
    after = data["invitation"]

    assert after["id"] == inv["id"], "행이 새로 생겼다 — 제자리 갱신이 아니다"
    assert after["recipient_name"] == "김철수"
    assert after["phone_normalized"] == "01099998888"
    assert after["token_version"] > before_tv, (
        "🔴 token_version 이 안 올랐다 — 옛 딥링크가 살아 있다"
    )
    assert data["from"]["phone_normalized"] == "01011112222"


@pytest.mark.asyncio
async def test_transfer_resets_send_markers(client, db_session):
    """다시 보내야 하므로 발송·열람 표식이 초기화된다.

    안 하면 주최자 화면에 "이미 보냄"으로 남아 재발송 대상에서 빠진다.
    """
    acct = "go_tr_2"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv = await _seed_invitation(client, acct, ev)
    await client.post(
        f"{_BASE}/invitations/{inv['id']}/issued",
        json={"organizer_ref": _ref(acct), "ticket_number": "TKT-TR-2"},
        headers=_HDR,
    )

    res = await client.post(
        f"{_BASE}/invitations/{inv['id']}/transfer",
        json=_transfer_body(acct),
        headers=_HDR,
    )
    assert res.status_code == 200, res.text
    after = res.json()["data"]["invitation"]
    assert after["sent_at"] is None, "발송 표식이 남아 재발송이 안 된다"
    assert after["status"] == "issued"


@pytest.mark.asyncio
async def test_transfer_blocked_after_checkin(client, db_session):
    """🔴 이미 입장한 초대권은 양도할 수 없다 — 쓴 티켓을 넘기는 것이다."""
    acct = "go_tr_3"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv = await _seed_invitation(client, acct, ev)
    await client.post(
        f"{_BASE}/invitations/{inv['id']}/issued",
        json={"organizer_ref": _ref(acct), "ticket_number": "TKT-TR-3"},
        headers=_HDR,
    )
    await client.post(
        f"{_BASE}/invitations/by-ticket-number/TKT-TR-3/mark",
        json={"state": "checked_in"},
        headers=_HDR,
    )

    res = await client.post(
        f"{_BASE}/invitations/{inv['id']}/transfer",
        json=_transfer_body(acct),
        headers=_HDR,
    )
    assert res.status_code == 409, res.text
    assert res.json()["error"]["code"] == "INVITATION_USED"


@pytest.mark.asyncio
async def test_transfer_blocked_when_revoked(client, db_session):
    """회수된 초대권은 양도 대상이 아니다."""
    acct = "go_tr_4"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv = await _seed_invitation(client, acct, ev)
    await client.post(
        f"{_BASE}/invitations/{inv['id']}/revoke",
        json={"organizer_ref": _ref(acct)},
        headers=_HDR,
    )

    res = await client.post(
        f"{_BASE}/invitations/{inv['id']}/transfer",
        json=_transfer_body(acct),
        headers=_HDR,
    )
    assert res.status_code == 409, res.text
    assert res.json()["error"]["code"] == "INVITATION_REVOKED"


@pytest.mark.asyncio
async def test_transfer_rejects_same_phone(client, db_session):
    """자기 자신에게 양도하면 토큰만 죽어 손님이 링크를 잃는다 — 막는다."""
    acct = "go_tr_5"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv = await _seed_invitation(client, acct, ev, phone="01011112222")

    res = await client.post(
        f"{_BASE}/invitations/{inv['id']}/transfer",
        json=_transfer_body(acct, phone="01011112222"),
        headers=_HDR,
    )
    assert res.status_code == 409, res.text
    assert res.json()["error"]["code"] == "INVITATION_SELF_TRANSFER"


@pytest.mark.asyncio
async def test_transfer_blocked_when_recipient_at_limit(client, db_session):
    """🔴 받는 분이 이미 5장이면 막고 안내한다 (2026-08-03 대표 확정: ㄱ안).

    상한을 푸는 선택지(ㄴ)도 있었으나, 한 번호에 무제한으로 쌓이면 현장에서
    누가 몇 장인지 통제가 안 된다.
    """
    acct = "go_tr_6"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    # 받는 사람 번호로 상한만큼 채운다.
    for seq in range(1, INVITATION_MAX_PER_PHONE + 1):
        body = _reserve_body(acct, phone="01099998888")
        body["seq"] = seq
        r = await client.post(
            f"{_BASE}/events/{ev.id}/invitations/reserve", json=body, headers=_HDR
        )
        assert r.status_code == 200, r.text
    inv = await _seed_invitation(client, acct, ev, phone="01011112222")

    res = await client.post(
        f"{_BASE}/invitations/{inv['id']}/transfer",
        json=_transfer_body(acct, phone="01099998888"),
        headers=_HDR,
    )
    assert res.status_code == 409, res.text
    assert res.json()["error"]["code"] == "INVITATION_LIMIT"
    assert f"{INVITATION_MAX_PER_PHONE}장" in res.json()["error"]["message"]


@pytest.mark.asyncio
async def test_transfer_can_repeat_and_return(client, db_session):
    """🔴 재양도 무제한 + 되받기(A→B→A) — 대표 확정 규정 1·5.

    제자리 갱신이라 seq 충돌이 안 난다. 새 행 방식이면 UNIQUE(event, phone, seq) 에
    계속 부딪힌다.
    """
    acct = "go_tr_7"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv = await _seed_invitation(client, acct, ev, phone="01011112222")

    hops = ["01022223333", "01033334444", "01011112222", "01044445555", "01011112222"]
    prev_tv = inv["token_version"]
    for i, phone in enumerate(hops):
        res = await client.post(
            f"{_BASE}/invitations/{inv['id']}/transfer",
            json=_transfer_body(acct, phone=phone, name=f"수령자{i}"),
            headers=_HDR,
        )
        assert res.status_code == 200, f"{i}번째 양도 실패: {res.text}"
        after = res.json()["data"]["invitation"]
        assert after["phone_normalized"] == phone
        assert after["token_version"] > prev_tv, f"{i}번째에서 옛 링크가 안 죽었다"
        prev_tv = after["token_version"]


@pytest.mark.asyncio
async def test_transfer_rejects_other_organizer(client, db_session):
    """남의 행사 초대권은 못 넘긴다 — 존재 자체를 알리지 않는다(404)."""
    acct_a, acct_b = "go_tr_8a", "go_tr_8b"
    org_a = await _seed_organizer(db_session, acct_a)
    await _seed_organizer(db_session, acct_b)
    ev = await _seed_event(db_session, org_a)
    inv = await _seed_invitation(client, acct_a, ev)

    res = await client.post(
        f"{_BASE}/invitations/{inv['id']}/transfer",
        json=_transfer_body(acct_b),
        headers=_HDR,
    )
    assert res.status_code == 404, res.text


# ── 양도 시 주문 구매자 갱신 (2026-08-04) ─────────────────────────────────────
#
# 🔴 2026-08-03 첫 실사용에서 드러났다. 양도는 `event_invitations`·`tickets` 만 바꿨는데
#    **화면 셋이 `orders.buyer_*` 를 본다**:
#
#      현장 체크인 화면    check-in/route.ts:209  `ticket.order.buyer?.name` (응답 8곳)
#      주최자 참석자 목록  AttendeeListRow.name
#      손님 차단 화면      order.buyer.name
#
#    게이트에서 스캔했는데 다른 이름이 뜨면 그 자리에서 실랑이다.
#    (초대권 앞면은 `invitation.recipient_name` 이라 이미 정상이었다.)


async def _seed_invitation_order(db_session, ev, inv_id, *, invitation_id_in_answers=None,
                                 ticket_number="TKT-TR-ORD", buyer="원소유자",
                                 phone="01011112222", extra_tickets=0):
    """초대권 주문 1건 + 티켓 발권 상태를 만든다.

    `extra_tickets` 를 주면 **같은 주문에 티켓을 더** 붙인다 — 유료 주문처럼
    다티켓인 경우 판별자가 깨졌을 때 남의 티켓까지 바뀌는지 보기 위해서다.
    """
    from app.models.event import SeatTier
    from app.models.order import Order, OrderStatus, OrderType
    from app.models.order_item import OrderItem
    from app.models.ticket import Ticket

    # ⚠️ NOT NULL·기본값 없는 컬럼을 스키마에서 뽑아 채웠다(하나씩 IntegrityError 로
    #    되짚으면 왕복이 길어진다).
    tier = SeatTier(
        id=uuid.uuid4(), event_id=ev.id, name="초대권",
        base_price=0, face_price=0, min_price=0, max_price_cap=0, resale_max_price=0,
        capacity=100, sold_count=0, sort_order=0, min_per_order=1, max_group_size=1,
        fanclub_discount_pct=0, lottery_application_hours=0, tax_rate=0,
        allow_group_tickets=False, is_active=True, resale_allowed=False,
        tax_included=True, product_type="ticket", sale_mode="fixed_fcfs",
        seating_type="free", visibility="hidden",
    )
    db_session.add(tier)
    await db_session.flush()

    order = Order(
        id=uuid.uuid4(), event_id=ev.id, user_id=ev.organizer_id,
        order_type=OrderType.PURCHASE, status=OrderStatus.CONFIRMED,
        quantity=1, unit_price=0, total_amount=0, payment_currency="KRW",
        buyer_name=buyer, buyer_phone=phone,
        buyer_email=f"invite-{inv_id}@no-reply.pickket.kr",
    )
    db_session.add(order)
    await db_session.flush()
    item = OrderItem(id=uuid.uuid4(), order_id=order.id, quantity=1,
                     unit_price=0, line_amount=0)
    db_session.add(item)
    await db_session.flush()
    db_session.add(Ticket(
        id=uuid.uuid4(), event_id=ev.id, tier_id=tier.id, order_item_id=item.id,
        purchase_price=0, sale_mode="fixed_fcfs", identity_verified=False,
        is_resalable=False, resale_max_price=0, transfer_count=0,
        ticket_number=ticket_number,
        answers={"_invitation": "true",
                 "_invitationId": str(invitation_id_in_answers or inv_id)},
    ))
    for i in range(extra_tickets):
        db_session.add(Ticket(
            id=uuid.uuid4(), event_id=ev.id, tier_id=tier.id, order_item_id=item.id,
            purchase_price=0, sale_mode="fixed_fcfs", identity_verified=False,
            is_resalable=False, resale_max_price=0, transfer_count=0,
            ticket_number=f"{ticket_number}-X{i}", answers={},
        ))
    await db_session.commit()
    return order


async def _issue(client, acct, inv_id, ticket_number):
    return await client.post(
        f"{_BASE}/invitations/{inv_id}/issued",
        json={"organizer_ref": _ref(acct), "ticket_number": ticket_number},
        headers=_HDR,
    )


@pytest.mark.asyncio
async def test_transfer_updates_order_buyer(client, db_session):
    """🔴 양도하면 주문 구매자도 새 주인이 된다 — 게이트 화면이 그걸 본다."""
    from app.models.order import Order

    acct = "go_ord_1"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv = await _seed_invitation(client, acct, ev)
    await _issue(client, acct, inv["id"], "TKT-ORD-1")
    order = await _seed_invitation_order(db_session, ev, inv["id"], ticket_number="TKT-ORD-1")

    res = await client.post(
        f"{_BASE}/invitations/{inv['id']}/transfer",
        json=_transfer_body(acct), headers=_HDR,
    )
    assert res.status_code == 200, res.text

    await db_session.refresh(order)
    assert order.buyer_name == "김철수", "게이트 화면이 옛 주인을 계속 보여준다"
    assert "9999" in (order.buyer_phone or ""), f"번호가 안 바뀌었다: {order.buyer_phone}"


@pytest.mark.asyncio
async def test_transfer_never_changes_buyer_email(client, db_session):
    """🔴 buyer_email 은 **발급 멱등 앵커**다 — 바꾸면 정당한 재시도가 409 가 된다.

    07-31 에 정확히 이 자리에서 사고가 났다.
    """
    from app.models.order import Order

    acct = "go_ord_2"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv = await _seed_invitation(client, acct, ev)
    await _issue(client, acct, inv["id"], "TKT-ORD-2")
    order = await _seed_invitation_order(db_session, ev, inv["id"], ticket_number="TKT-ORD-2")
    before = order.buyer_email

    await client.post(f"{_BASE}/invitations/{inv['id']}/transfer",
                      json=_transfer_body(acct), headers=_HDR)
    await db_session.refresh(order)
    assert order.buyer_email == before, "🔴 멱등 앵커가 바뀌었다 — 재발급이 409 로 막힌다"


@pytest.mark.asyncio
async def test_transfer_syncs_phone_lookup_hash(client, db_session, monkeypatch):
    """🔴 ORM 대입이라 `buyer_phone_lookup_hash` 가 같이 갱신된다.

    `update(Order).values(...)` 로 바꾸면 `@validates`(models/order.py:258)를 안 타서
    해시가 **옛 번호로 남는다**. 상태(buyer_phone)만 보면 그 결함이 안 잡힌다 —
    해시를 직접 단언해야 한다.
    """
    from app.core.config import settings as _settings
    from app.core.pii import phone_lookup_digest
    from app.models.order import Order

    # 🔴 키가 없으면 `phone_lookup_digest` 가 **양쪽 다 None** 을 돌려줘 단언이 헛통과한다
    #    (개발환경 평문 폴백 — `app/core/pii.py:64`). 실제로 뮤테이션 M5(bulk update)가
    #    이 테스트를 그대로 통과했다. prod 는 `PII_ENCRYPTION_KEY` 없이는 기동이 거부되므로
    #    테스트도 키가 있는 상태로 판정해야 한다.
    monkeypatch.setattr(
        _settings, "PII_ENCRYPTION_KEY",
        "Zm9vYmFyX3Rlc3Rfa2V5X2Zvcl9waWlfMzJieXRlcyE=", raising=False,
    )

    acct = "go_ord_3"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv = await _seed_invitation(client, acct, ev)
    await _issue(client, acct, inv["id"], "TKT-ORD-3")
    order = await _seed_invitation_order(db_session, ev, inv["id"], ticket_number="TKT-ORD-3")

    await client.post(f"{_BASE}/invitations/{inv['id']}/transfer",
                      json=_transfer_body(acct), headers=_HDR)
    await db_session.refresh(order)
    expected = phone_lookup_digest(order.buyer_phone)
    assert expected is not None, "🔴 키가 없어 digest 가 None 이다 — 이 단언은 헛통과한다"
    assert order.buyer_phone_lookup_hash == expected, (
        "🔴 해시가 번호와 어긋난다 — bulk update 로 validator 를 건너뛴 것이다"
    )


@pytest.mark.asyncio
async def test_transfer_skips_order_when_invitation_id_mismatch(client, db_session):
    """🔴 판별자가 안 맞으면 주문을 건드리지 않는다.

    유료 주문은 티켓이 여럿일 수 있어, 판별자가 깨지면 **남의 티켓 표시명까지** 바뀐다.
    """
    from app.models.order import Order

    acct = "go_ord_4"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv = await _seed_invitation(client, acct, ev)
    await _issue(client, acct, inv["id"], "TKT-ORD-4")
    # answers 의 _invitationId 를 **다른 값**으로 — 이 주문은 이 초대권 것이 아니다.
    order = await _seed_invitation_order(
        db_session, ev, inv["id"], ticket_number="TKT-ORD-4",
        invitation_id_in_answers=uuid.uuid4(), buyer="유료구매자", extra_tickets=2,
    )

    res = await client.post(f"{_BASE}/invitations/{inv['id']}/transfer",
                            json=_transfer_body(acct), headers=_HDR)
    assert res.status_code == 200, res.text  # 양도 자체는 성립한다
    await db_session.refresh(order)
    assert order.buyer_name == "유료구매자", "🔴 남의 주문 구매자를 바꿨다"


# ── 회수 → 재발급 시 큐 재적재 (2026-08-04) ───────────────────────────────────
#
# 🔴 prod 에서 5건이 1370분째 대기했다. 티켓은 재발권됐는데 큐는 옛 'sent' 그대로라
#    드레이너가 집지 않았다.
#
#      양도       resend_invitation 을 타서 epoch 1·attempt 2  → 나감  ✅
#      회수→재발급 아무도 큐를 안 엶 · epoch 0·attempt 1       → 🔴 안 나감
#
# 🔴 잘못 열면 **중복 발송**이다. 손님이 초대권을 두 장 받는다.
#    경계 ①(queued 는 안 건드림) ②(sent_at 있으면 안 건드림)가 그걸 막는 전부다.


async def _dispatch_of(db_session, inv_id):
    from app.models.go_attendee_ledger import InvitationDispatch
    return (
        await db_session.execute(
            select(InvitationDispatch).where(
                InvitationDispatch.invitation_id == uuid.UUID(str(inv_id))
            )
        )
    ).scalar_one_or_none()


async def _set_dispatch(db_session, inv_id, *, status, epoch=0, claim=None):
    # ⚠️ claim_token 은 UUID 컬럼이다 — 문자열을 넣으면 바인딩에서 터진다.
    claim = claim or uuid.uuid4()
    d = await _dispatch_of(db_session, inv_id)
    d.status = status
    d.send_epoch = epoch
    d.claim_token = claim
    await db_session.commit()
    return d


@pytest.mark.asyncio
async def test_reissue_requeues_terminal_dispatch(client, db_session):
    """🔴 회수→재발급: 큐가 터미널이고 아직 아무도 못 받았으면 다시 연다.

    이게 안 되면 알림톡이 **영원히** 안 나간다(prod 5건이 그랬다).
    """
    acct = "go_rq_1"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv = await _seed_invitation(client, acct, ev)
    await _issue(client, acct, inv["id"], "TKT-RQ-1")
    # 발송 완료 상태로 만든 뒤, 회수→부활을 흉내내 sent_at 을 비운다.
    await _set_dispatch(db_session, inv["id"], status="sent", epoch=0)
    from app.models.go_attendee_ledger import EventInvitation as _EI
    row = (await db_session.execute(
        select(_EI).where(_EI.id == uuid.UUID(inv["id"])))).scalar_one()
    row.sent_at = None
    await db_session.commit()

    res = await _issue(client, acct, inv["id"], "TKT-RQ-1B")
    assert res.status_code == 200, res.text

    d = await _dispatch_of(db_session, inv["id"])
    await db_session.refresh(d)
    assert d.status == "queued", "🔴 큐가 안 열렸다 — 알림톡이 영원히 안 나간다"
    assert int(d.send_epoch) == 1, (
        "🔴 send_epoch 가 안 올랐다 — NCP 가 같은 멱등키로 보고 조용히 씹는다"
    )
    assert d.claim_token is None, "옛 클레임이 남아 드레이너가 못 집는다"


@pytest.mark.asyncio
async def test_first_issue_creates_queue_unchanged(client, db_session):
    """정상 최초 발권 — 큐가 없으면 새로 만든다(기존 동작 불변)."""
    acct = "go_rq_2"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv = await _seed_invitation(client, acct, ev)

    res = await _issue(client, acct, inv["id"], "TKT-RQ-2")
    assert res.status_code == 200, res.text
    assert res.json()["data"]["queued"] is True
    d = await _dispatch_of(db_session, inv["id"])
    assert d is not None and d.status == "queued"
    assert int(d.send_epoch) == 0


@pytest.mark.asyncio
async def test_reissue_never_touches_queued_dispatch(client, db_session):
    """🔴 경계① — 이미 'queued' 면 건드리지 않는다.

    정상 최초 발권·동시 적재 경합이 여기다. 손대면 **두 번 나간다.**
    """
    acct = "go_rq_3"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv = await _seed_invitation(client, acct, ev)
    await _issue(client, acct, inv["id"], "TKT-RQ-3")
    held = uuid.uuid4()
    await _set_dispatch(db_session, inv["id"], status="queued", epoch=0, claim=held)

    await _issue(client, acct, inv["id"], "TKT-RQ-3B")
    d = await _dispatch_of(db_session, inv["id"])
    await db_session.refresh(d)
    assert int(d.send_epoch) == 0, "🔴 queued 를 건드려 epoch 를 올렸다 — 중복 발송이다"
    assert d.claim_token == held, "🔴 진행 중인 클레임을 지웠다"


@pytest.mark.asyncio
async def test_reissue_never_touches_already_sent_recipient(client, db_session):
    """🔴 경계② — 이미 받은 사람(sent_at 있음)은 건드리지 않는다."""
    acct = "go_rq_4"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv = await _seed_invitation(client, acct, ev)
    await _issue(client, acct, inv["id"], "TKT-RQ-4")
    await _set_dispatch(db_session, inv["id"], status="sent", epoch=3)
    from app.models.go_attendee_ledger import EventInvitation as _EI
    row = (await db_session.execute(
        select(_EI).where(_EI.id == uuid.UUID(inv["id"])))).scalar_one()
    row.sent_at = datetime.now(timezone.utc)
    await db_session.commit()

    await _issue(client, acct, inv["id"], "TKT-RQ-4B")
    d = await _dispatch_of(db_session, inv["id"])
    await db_session.refresh(d)
    assert d.status == "sent", "🔴 이미 받은 사람을 다시 큐에 넣었다 — 중복 발송이다"
    assert int(d.send_epoch) == 3


@pytest.mark.asyncio
async def test_invitation_list_carries_queue_state(client, db_session):
    """🔴 목록 응답에 큐 상태가 실린다 — 「대기 중」과 「누락」을 구분하려면 필요하다.

    종전엔 `status='issued'` + `sent_at=null` 뿐이라 두 상태가 같은 픽셀이었다.
    """
    acct = "go_rq_5"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv_no_queue = await _seed_invitation(client, acct, ev, phone="01055556666")
    inv_queued = await _seed_invitation(client, acct, ev, phone="01077778888")
    await _issue(client, acct, inv_queued["id"], "TKT-RQ-5")

    res = await client.get(
        f"{_BASE}/events/{ev.id}/invitations?organizer_ref={_ref(acct)['go_account_id']}",
        headers=_HDR,
    )
    assert res.status_code == 200, res.text
    by_id = {i["id"]: i for i in res.json()["data"]["invitations"]}

    assert by_id[inv_queued["id"]]["dispatch_status"] == "queued"
    assert by_id[inv_queued["id"]]["send_epoch"] == 0
    # 🔴 큐가 없는 초대권도 응답에 **남아야** 한다. inner join 으로 짜면 사라진다.
    assert inv_no_queue["id"] in by_id, "🔴 큐 없는 초대권이 목록에서 사라졌다"
    assert by_id[inv_no_queue["id"]]["dispatch_status"] is None
    assert by_id[inv_no_queue["id"]]["send_epoch"] is None

    # 🔴 큐가 마지막으로 움직인 시각 — 화면의 "몇 분째 대기" 가 이 값으로 재야 한다.
    #    초대권 생성 시각(created_at)으로 재면, 어제 발급분을 방금 재발송해도
    #    "1470분째 대기" 로 뜬다(2026-08-04 실사고).
    queued_view = by_id[inv_queued["id"]]
    assert queued_view["dispatch_updated_at"] is not None, (
        "🔴 큐 시각이 없으면 화면이 초대권 생성 시각으로 재고, 재발송해도 경보가 안 꺼진다"
    )
    assert queued_view["dispatch_updated_at"] != queued_view["created_at"], (
        "🔴 created_at 을 그대로 실으면 큐 시각을 실은 게 아니다"
    )
    # 큐 없는 행은 null — 그때만 화면이 created_at 으로 되돌아간다(옛 방어선 보존).
    assert by_id[inv_no_queue["id"]]["dispatch_updated_at"] is None

# ═══════════════════════════════════════════════════════════════════
# 재발송 in-flight 가드 (2026-08-04, 두 번째 겹)
#
# 화면 가드는 이미 배포됐다. 이건 **API 를 직접 부르는 경로**를 막는다.
#   워커 A 가 보내는 중 → 재발송이 claim_token 을 지움
#   → 워커 A 는 그대로 발송 · 풀린 행을 워커 B 가 또 집음  ⟹ 손님이 두 장
#
# 🔴 경계는 리스 만료다. 죽은 워커가 'sending' 을 박아둔 채 사라지면 그 행은
#    재발송으로도 못 푸는 영구 잠금이 된다 — 가드가 사고가 되는 자리.
# ═══════════════════════════════════════════════════════════════════


async def _resend(client, acct, inv_id):
    return await client.post(
        f"{_BASE}/invitations/{inv_id}/resend",
        json={"organizer_ref": _ref(acct)},
        headers=_HDR,
    )


async def _prepare_sending(db_session, client, acct, tag, *, lease_delta):
    """발권까지 마친 초대 1건을 'sending' + 지정한 리스 상태로 만든다."""
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv = await _seed_invitation(client, acct, ev)
    await _issue(client, acct, inv["id"], f"TKT-{tag}")
    d = await _dispatch_of(db_session, inv["id"])
    d.status = "sending"
    d.claim_token = uuid.uuid4()
    d.claim_expires_at = (
        None if lease_delta is None else datetime.now(timezone.utc) + lease_delta
    )
    d.send_epoch = 0
    await db_session.commit()
    return inv["id"], d


@pytest.mark.asyncio
async def test_resend_rejected_while_dispatch_in_flight(client, db_session):
    """🔴 발송 중(리스 살아 있음) 재발송 → 409. 뚫리면 손님이 두 장 받는다."""
    acct = "go_infl_1"
    inv_id, _ = await _prepare_sending(
        db_session, client, acct, "IF1", lease_delta=timedelta(minutes=5)
    )

    res = await _resend(client, acct, inv_id)
    assert res.status_code == 409, res.text
    assert res.json()["error"]["code"] == "DISPATCH_IN_FLIGHT"

    # 🔴 거부는 "아무것도 안 건드림" 이어야 한다. claim_token 이 풀리면 가드가 무의미하다.
    d = await _dispatch_of(db_session, inv_id)
    await db_session.refresh(d)
    assert d.status == "sending"
    assert d.claim_token is not None, "🔴 클레임이 풀렸다 — 워커 B 가 같은 행을 또 집는다"
    assert int(d.send_epoch) == 0, "거부됐는데 epoch 가 올랐다"


@pytest.mark.asyncio
async def test_resend_allowed_when_lease_expired(client, db_session):
    """🔴 리스 만료는 예외 — 죽은 워커가 행을 영구히 잠그면 안 된다."""
    acct = "go_infl_2"
    inv_id, _ = await _prepare_sending(
        db_session, client, acct, "IF2", lease_delta=timedelta(minutes=-1)
    )

    res = await _resend(client, acct, inv_id)
    assert res.status_code == 200, res.text
    assert res.json()["data"]["requeued"] is True
    d = await _dispatch_of(db_session, inv_id)
    await db_session.refresh(d)
    assert d.status == "queued"
    assert int(d.send_epoch) == 1


@pytest.mark.asyncio
async def test_resend_allowed_when_lease_absent(client, db_session):
    """리스 없이 'sending' 만 박힌 행도 풀 수 있다 — claim 쪽과 같은 판정이다.

    claim 은 `claim_expires_at IS NULL` 을 **선점 가능**으로 본다. 여기서 반대로
    읽으면 두 판정이 갈라지고, 그 틈이 영구 잠금이 된다.
    """
    acct = "go_infl_3"
    inv_id, _ = await _prepare_sending(db_session, client, acct, "IF3", lease_delta=None)

    res = await _resend(client, acct, inv_id)
    assert res.status_code == 200, res.text
    d = await _dispatch_of(db_session, inv_id)
    await db_session.refresh(d)
    assert d.status == "queued"


@pytest.mark.asyncio
async def test_resend_guard_matches_claim_staleness(client, db_session):
    """🔴 두 판정이 **같은 경계**를 쓰는가 — 한쪽만 고치면 여기서 깨진다.

    claim 은 `claim_expires_at < now` 를 죽은 것으로 본다 ⟹ 같음은 살아 있는 쪽.
    문자열 비교가 아니라 **같은 입력을 양쪽에 먹여** 답이 일치하는지 본다.
    """
    from types import SimpleNamespace

    from app.api.v1.internal_attendee_ledger import _dispatch_lease_alive

    now = datetime.now(timezone.utc)
    cases = [
        (None, False, "리스 없음 → 죽은 것(claim 이 선점 가능으로 본다)"),
        (now - timedelta(seconds=1), False, "만료 → 죽은 것"),
        (now, True, "경계값 같음 → 살아 있는 쪽(claim 은 < now 만 죽음)"),
        (now + timedelta(seconds=1), True, "미래 → 살아 있음"),
    ]
    for exp, expected, why in cases:
        got = _dispatch_lease_alive(SimpleNamespace(claim_expires_at=exp), now)
        assert got is expected, f"{why} — 기대 {expected}, 실제 {got}"

    # naive 저장(타임존 없는 DB 값)도 UTC 로 읽는다 — 여기서 터지면 운영에서 예외가 난다
    assert _dispatch_lease_alive(
        SimpleNamespace(claim_expires_at=(now + timedelta(minutes=5)).replace(tzinfo=None)),
        now,
    ) is True


@pytest.mark.asyncio
async def test_resend_still_rejects_revoked(client, db_session):
    """기존 계약 불변 — 회수된 초대는 여전히 409(새 가드가 순서를 바꾸지 않았다)."""
    acct = "go_infl_4"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv = await _seed_invitation(client, acct, ev)
    await _issue(client, acct, inv["id"], "TKT-IF4")
    res = await client.post(
        f"{_BASE}/invitations/{inv['id']}/revoke",
        json={"organizer_ref": _ref(acct)},
        headers=_HDR,
    )
    assert res.status_code == 200, res.text

    out = await _resend(client, acct, inv["id"])
    assert out.status_code == 409
    assert out.json()["error"]["code"] == "INVITATION_REVOKED"


@pytest.mark.asyncio
async def test_revoke_cancels_ticket(client, db_session):
    """🔴 회수는 **티켓까지 죽인다** (2026-07-31 대표 결정).

    종전에는 `token_version` 만 올려 **딥링크만** 막았고 `tickets` 는 건드리지 않았다.
    실측: 회수된 `TKT-50A028F727D7` 이 prod 에서 `active` 로 남아 있었다.
    회전 QR 이라 실질 입장은 막혔지만, **티켓번호로 검증하는 경로가 생기면 뚫린다.**
    """
    acct, _org, ev = await _fixture(db_session, "revtkt")
    res = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json={**_reserve_body(acct), "seq": 1},
        headers=_HDR,
    )
    inv_id = res.json()["data"]["invitation"]["id"]
    tn = "TKT-REVOKE-TEST-1"
    ticket = await _seed_ticket(db_session, ev, tn)
    await client.post(
        f"{_BASE}/invitations/{inv_id}/issued",
        json={"organizer_ref": _ref(acct), "ticket_number": tn},
        headers=_HDR,
    )

    revoke = await client.post(
        f"{_BASE}/invitations/{inv_id}/revoke",
        json={"organizer_ref": _ref(acct)},
        headers=_HDR,
    )
    assert revoke.status_code == 200, revoke.text
    assert revoke.json()["data"]["revoked"] is True

    await db_session.refresh(ticket)
    assert ticket.status == TicketStatus.CANCELLED, "회수했는데 티켓이 살아 있다"


@pytest.mark.asyncio
async def test_revoke_refuses_when_already_checked_in(client, db_session):
    """🔴 이미 입장한 초대권은 회수하지 않는다.

    `USED` 를 `CANCELLED` 로 바꾸면 입장 기록이 남은 사람이 "티켓 없음" 이 되고,
    `trg_sync_sold_count` 가 `sold_count` 를 **한 번 더** 줄인다(USED 는 자리 점유).
    """
    acct, _org, ev = await _fixture(db_session, "revused")
    res = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json={**_reserve_body(acct), "seq": 1},
        headers=_HDR,
    )
    inv_id = res.json()["data"]["invitation"]["id"]
    tn = "TKT-REVOKE-TEST-2"
    ticket = await _seed_ticket(db_session, ev, tn, status=TicketStatus.USED)
    await client.post(
        f"{_BASE}/invitations/{inv_id}/issued",
        json={"organizer_ref": _ref(acct), "ticket_number": tn},
        headers=_HDR,
    )

    revoke = await client.post(
        f"{_BASE}/invitations/{inv_id}/revoke",
        json={"organizer_ref": _ref(acct)},
        headers=_HDR,
    )
    assert revoke.status_code == 409, revoke.text
    assert revoke.json()["error"]["code"] == "INVITATION_ALREADY_CHECKED_IN"

    await db_session.refresh(ticket)
    assert ticket.status == TicketStatus.USED, "입장한 티켓이 취소됐다"


@pytest.mark.asyncio
async def test_revoke_is_idempotent_and_does_not_recancel(client, db_session):
    """이미 회수된 초대권 재회수는 멱등 — 티켓을 두 번 취소하지 않는다.

    🔴 두 번 취소하면 실 PostgreSQL 에서 `sold_count` 가 **두 번** 줄어든다.
       (트리거는 SQLite 에 없으므로 여기서는 '상태를 다시 쓰지 않는다' 까지만 고정하고,
        재고 감산 자체는 실 PG 스크립트로 검증한다.)
    """
    acct, _org, ev = await _fixture(db_session, "revidem")
    res = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json={**_reserve_body(acct), "seq": 1},
        headers=_HDR,
    )
    inv_id = res.json()["data"]["invitation"]["id"]
    tn = "TKT-REVOKE-TEST-3"
    await _seed_ticket(db_session, ev, tn)
    await client.post(
        f"{_BASE}/invitations/{inv_id}/issued",
        json={"organizer_ref": _ref(acct), "ticket_number": tn},
        headers=_HDR,
    )

    first = await client.post(
        f"{_BASE}/invitations/{inv_id}/revoke", json={"organizer_ref": _ref(acct)}, headers=_HDR
    )
    assert first.json()["data"]["revoked"] is True
    second = await client.post(
        f"{_BASE}/invitations/{inv_id}/revoke", json={"organizer_ref": _ref(acct)}, headers=_HDR
    )
    assert second.status_code == 200
    assert second.json()["data"]["revoked"] is False, "재회수가 멱등이 아니다"


@pytest.mark.asyncio
async def test_revoke_without_ticket_still_revokes(client, db_session):
    """티켓이 아직 없는 초대권(발권 전)도 회수된다 — 티켓 조회가 회수를 막으면 안 된다."""
    acct, _org, ev = await _fixture(db_session, "revnotkt")
    res = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json={**_reserve_body(acct), "seq": 1},
        headers=_HDR,
    )
    inv_id = res.json()["data"]["invitation"]["id"]

    revoke = await client.post(
        f"{_BASE}/invitations/{inv_id}/revoke", json={"organizer_ref": _ref(acct)}, headers=_HDR
    )
    assert revoke.status_code == 200, revoke.text
    assert revoke.json()["data"]["revoked"] is True


@pytest.mark.asyncio
async def test_revoke_refuses_when_ledger_says_checked_in(client, db_session):
    """🔴 원장이 `checked_in` 이면 티켓 상태와 **무관하게** 회수를 거부한다.

    ⚠️ 이 테스트는 뮤테이션 생존으로 추가됐다. 앞선 테스트는 티켓만 `USED` 로 뒀고
       원장은 `issued` 였다 — 그래서 **원장 가드를 지워도 초록**이었다(티켓 가드가
       이중으로 잡았다). 두 가드는 서로를 대신하지 못한다:
       원장이 먼저 `checked_in` 이 되는 경로(`/mark`)가 실제로 있고,
       그 시점의 티켓은 아직 `ACTIVE` 일 수 있다.
    """
    acct, _org, ev = await _fixture(db_session, "revledger")
    res = await client.post(
        f"{_BASE}/events/{ev.id}/invitations/reserve",
        json={**_reserve_body(acct), "seq": 1},
        headers=_HDR,
    )
    inv_id = res.json()["data"]["invitation"]["id"]
    tn = "TKT-REVOKE-TEST-4"
    ticket = await _seed_ticket(db_session, ev, tn)  # 티켓은 ACTIVE 그대로
    await client.post(
        f"{_BASE}/invitations/{inv_id}/issued",
        json={"organizer_ref": _ref(acct), "ticket_number": tn},
        headers=_HDR,
    )
    mark = await client.post(
        f"{_BASE}/invitations/by-ticket-number/{tn}/mark",
        json={"state": "checked_in"},
        headers=_HDR,
    )
    assert mark.status_code == 200, mark.text

    revoke = await client.post(
        f"{_BASE}/invitations/{inv_id}/revoke",
        json={"organizer_ref": _ref(acct)},
        headers=_HDR,
    )
    assert revoke.status_code == 409, revoke.text
    assert revoke.json()["error"]["code"] == "INVITATION_ALREADY_CHECKED_IN"

    await db_session.refresh(ticket)
    assert ticket.status == TicketStatus.ACTIVE, "입장한 초대권의 티켓이 취소됐다"


# ═══════════════════════════════════════════════════════════════════
# 🔴 next-seq — 대량초대 왕복 축소 (2026-08-09, 상한 5 → 50)
#
# go 는 번호마다 seq 를 1부터 올려가며 두드리고 409 에서 멈춘다. 상한이 50 이면
# 이미 40장 받은 번호에 1장 더 = **41회 왕복**이고, bulk 상한이 10,000명이라
# 최악 **50만 회**다. 상한만 올리면 대량초대가 못 쓰게 된다.
#
# 🔴 이것은 **힌트**다. 상한 집행은 여전히 reserve 의 409 다 —
#    낡은 값이 와도 go 는 거기서부터 올려가며 두드리므로 결과가 같다.
# ═══════════════════════════════════════════════════════════════════


async def _next_seq(client, acct, ev, phones):
    return await client.post(
        f"{_BASE}/events/{ev.id}/invitations/next-seq",
        json={"organizer_ref": _ref(acct), "phones": phones},
        headers=_HDR,
    )


@pytest.mark.asyncio
async def test_next_seq_empty_phone_starts_at_one(client, db_session):
    """발급 이력이 없으면 1 — 지금 go 가 쓰는 출발점과 같다."""
    acct, _org, ev = await _fixture(db_session, "ns1")
    r = await _next_seq(client, acct, ev, ["01000000001"])
    assert r.status_code == 200, r.text
    assert r.json()["data"]["next"]["01000000001"] == 1


@pytest.mark.asyncio
async def test_next_seq_skips_taken_slots(client, db_session):
    """🔴 이미 3장이면 4를 준다 — 왕복 3회가 0회로 줄어드는 자리."""
    acct, _org, ev = await _fixture(db_session, "ns2")
    for seq in (1, 2, 3):
        body = {**_reserve_body(acct), "seq": seq}
        assert (await client.post(
            f"{_BASE}/events/{ev.id}/invitations/reserve", json=body, headers=_HDR
        )).status_code == 200
    phone = _reserve_body(acct)["phone_normalized"]
    r = await _next_seq(client, acct, ev, [phone])
    assert r.json()["data"]["next"][phone] == 4


@pytest.mark.asyncio
async def test_next_seq_fills_revoked_hole(client, db_session):
    """🔴 회수된 자리를 **빈 자리로** 센다 — reserve 의 부활 분기와 짝이어야 한다.

    회수분을 점유로 세면 힌트가 그 자리를 건너뛰어, 1부터 두드릴 때와 **다른 답**을 준다.
    (양도 경로는 회수분을 점유로 본다 — 규칙이 달라서 그쪽을 참조하면 안 된다.)
    """
    acct, _org, ev = await _fixture(db_session, "ns3")
    ids = []
    for seq in (1, 2, 3):
        body = {**_reserve_body(acct), "seq": seq}
        res = await client.post(
            f"{_BASE}/events/{ev.id}/invitations/reserve", json=body, headers=_HDR
        )
        ids.append(res.json()["data"]["invitation"]["id"])
    # 가운데(seq=2)를 회수한다
    assert (await client.post(
        f"{_BASE}/invitations/{ids[1]}/revoke",
        json={"organizer_ref": _ref(acct)}, headers=_HDR,
    )).status_code == 200

    phone = _reserve_body(acct)["phone_normalized"]
    r = await _next_seq(client, acct, ev, [phone])
    assert r.json()["data"]["next"][phone] == 2, "회수 자리를 건너뛰었다"


@pytest.mark.asyncio
async def test_next_seq_at_limit_returns_over_cap(client, db_session):
    """자리가 없으면 MAX+1 — 호출자가 상한으로 읽고 두드리지 않는다."""
    acct, _org, ev = await _fixture(db_session, "ns4")
    for seq in range(1, INVITATION_MAX_PER_PHONE + 1):
        body = {**_reserve_body(acct), "seq": seq}
        assert (await client.post(
            f"{_BASE}/events/{ev.id}/invitations/reserve", json=body, headers=_HDR
        )).status_code == 200
    phone = _reserve_body(acct)["phone_normalized"]
    r = await _next_seq(client, acct, ev, [phone])
    d = r.json()["data"]
    assert d["next"][phone] == INVITATION_MAX_PER_PHONE + 1
    # 🔴 자리 없음을 명시한다 — 호출자가 상한 숫자를 몰라도 알아본다
    assert d["at_limit"] == [phone]


@pytest.mark.asyncio
async def test_next_seq_batches_many_phones_in_one_call(client, db_session):
    """🔴 여러 번호를 **한 번에** 답한다 — 이게 왕복 축소의 본체다."""
    acct, _org, ev = await _fixture(db_session, "ns5")
    for seq in (1, 2):
        body = {**_reserve_body(acct, phone="01011112222"), "seq": seq}
        await client.post(f"{_BASE}/events/{ev.id}/invitations/reserve", json=body, headers=_HDR)
    r = await _next_seq(client, acct, ev, ["01011112222", "01033334444", "01011112222"])
    d = r.json()["data"]
    nxt = d["next"]
    assert d["at_limit"] == []
    assert nxt["01011112222"] == 3
    assert nxt["01033334444"] == 1
    assert len(nxt) == 2, "중복 번호가 두 번 계산됐다"


@pytest.mark.asyncio
async def test_next_seq_matches_reserve_loop_result(client, db_session):
    """🔴 힌트가 **1부터 두드린 결과와 같은가** — 이게 어긋나면 자리를 건너뛴다.

    힌트를 믿고 그 자리에 reserve 하면 `created=True` 여야 한다. 그렇지 않으면
    go 가 힌트에서 시작했을 때 정상 자리를 놓친다.
    """
    acct, _org, ev = await _fixture(db_session, "ns6")
    phone = _reserve_body(acct)["phone_normalized"]
    for seq in (1, 2, 3, 4):
        await client.post(f"{_BASE}/events/{ev.id}/invitations/reserve",
                          json={**_reserve_body(acct), "seq": seq}, headers=_HDR)

    hint = (await _next_seq(client, acct, ev, [phone])).json()["data"]["next"][phone]
    res = await client.post(f"{_BASE}/events/{ev.id}/invitations/reserve",
                            json={**_reserve_body(acct), "seq": hint}, headers=_HDR)
    assert res.status_code == 200, res.text
    assert res.json()["data"]["created"] is True, "힌트 자리가 이미 점유돼 있었다"


@pytest.mark.asyncio
async def test_next_seq_rejects_other_organizer(client, db_session):
    """🔴 남의 행사 번호로 자리 정보를 캐가지 못한다 — reserve 와 같은 가드."""
    acct, _org, ev = await _fixture(db_session, "ns7")
    other = "go_ns_other"
    await _seed_organizer(db_session, other)
    r = await _next_seq(client, other, ev, ["01000000001"])
    assert r.status_code >= 400, r.text


async def test_cap_is_fifty_by_requirement():
    """🔴 상한 값 자체를 고정한다 — **요구사항**이지 구현 세부가 아니다.

    다른 테스트는 전부 `INVITATION_MAX_PER_PHONE` 을 **참조**하므로 상수를 바꾸면
    같이 움직인다 ⟹ 누가 5 로 되돌려도 스위트는 전부 초록이다(배포 세션이 뮤테이션으로
    실증). 앱은 5 에서 막는데 DB 제약만 50 으로 남아 **아무도 모른다**.

    ⚠️ 상수를 리터럴로 중복하는 것은 보통 나쁘지만, 여기서는 의도적이다 —
       발주처 요구("5매 → 최대 50매", 2026-08-09 대표 확정)를 이 한 줄이 지킨다.
       요구가 바뀌면 이 줄도 같이 바꾼다.
    """
    from app.models.go_attendee_ledger import INVITATION_MAX_PER_PHONE

    assert INVITATION_MAX_PER_PHONE == 50, (
        "1인 초대권 상한이 요구사항(50)과 다르다 — "
        "마이그레이션(inv50_0809)과 어긋나면 앱만 조용히 좁아진다"
    )


@pytest.mark.asyncio
async def test_transfer_then_claim_sends_to_new_owner(client, db_session):
    """🔴 양도한 뒤 재발송이 **새 주인**에게 가는가 (2026-08-12 실사고).

    ## 무슨 일이 있었나

    08-11 09:19 초대권 10장이 한 사람 앞으로 발급·발송됐고, 그 뒤 양도로 주인이
    바뀌었다. 양도는 `sent_at` 을 지워 재발송 대상으로 되돌리는데, 정작 발송이
    읽는 값은 `invitation_dispatch.phone`(발급 시점 스냅샷)이었다.

        ⟹ 재발송이 **옛 주인에게 또 갔다**. 받을 사람 셋은 끝내 못 받았고,
           원장에는 `sent` 로 남아 「보냈다」고 보였다.

    ## 왜 스냅샷 갱신만으로 안 되는가

    갱신을 빠뜨리는 경로가 또 생긴다. **읽는 쪽이 정본(초대권)을 보게** 해야
    양도가 몇 번 일어나도 안전하다. 이 테스트는 그 계약을 못박는다.
    """
    acct = "go_tr_claim"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv = await _seed_invitation(client, acct, ev)
    await client.post(
        f"{_BASE}/invitations/{inv['id']}/issued",
        json={"organizer_ref": _ref(acct), "ticket_number": "TKT-TR-CLAIM"},
        headers=_HDR,
    )

    res = await client.post(
        f"{_BASE}/invitations/{inv['id']}/transfer",
        json=_transfer_body(acct, phone="01055556666", name="새주인"),
        headers=_HDR,
    )
    assert res.status_code == 200, res.text

    claimed = await client.post(
        f"{_BASE}/invitation-dispatch/claim",
        json={"claim_token": "11111111-2222-3333-4444-555555555555", "limit": 10, "lease_minutes": 5},
        headers=_HDR,
    )
    assert claimed.status_code == 200, claimed.text
    items = [i for i in claimed.json()["data"]["items"] if i["invitation_id"] == inv["id"]]
    assert items, "양도 뒤 재발송 대상에 안 잡힌다"
    it = items[0]

    # 🔴 여기가 사고 지점이다 — 옛 주인 번호가 나가면 안 된다.
    # 🔴 여기가 사고 지점이다 — 발송 대상이 **새 주인**이어야 한다.
    #    (헬퍼가 display 를 고정하므로 양도된 display 값으로 단언한다)
    assert it["phone"] == "010-9999-8888", f"옛 주인에게 간다: {it['phone']}"
    assert it["recipient_name"] == "새주인", "이름도 옛 주인이다"
    # 스냅샷도 함께 옮겼으므로 낡음 표시가 없어야 한다(기록 정합).
    assert it["snapshot_stale"] is False, "발송 큐 스냅샷이 옛 주인인 채 남았다"


@pytest.mark.asyncio
async def test_claim_reads_invitation_not_stale_snapshot(client, db_session):
    """🔴 발송 큐 스냅샷이 **낡아도** 현재 주인에게 간다 (2026-08-12).

    ⚠️ 위 `test_transfer_then_claim_sends_to_new_owner` 로는 이 계약이 증명되지 않는다.
       양도가 스냅샷을 함께 갱신하므로 두 값이 같아져, 읽는 쪽을 `d.phone` 으로
       되돌려도 그 테스트는 **통과한다**(실측: 뮤테이션 생존).

    그래서 여기서는 스냅샷을 **일부러 낡게** 만들어 둔다. 갱신을 빠뜨리는 경로가
    하나라도 생기면 08-11 사고가 그대로 재발하기 때문이다.
    """
    acct = "go_tr_stale"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    inv = await _seed_invitation(client, acct, ev)
    await client.post(
        f"{_BASE}/invitations/{inv['id']}/issued",
        json={"organizer_ref": _ref(acct), "ticket_number": "TKT-TR-STALE"},
        headers=_HDR,
    )

    # 🔴 갱신을 빠뜨린 경로를 흉내낸다 — 초대권은 현재 주인, 스냅샷은 옛 주인.
    await db_session.execute(
        update(InvitationDispatch)
        .where(InvitationDispatch.invitation_id == uuid.UUID(inv["id"]))
        .values(phone="010-0000-0000", recipient_name="옛주인")
    )
    await db_session.commit()

    claimed = await client.post(
        f"{_BASE}/invitation-dispatch/claim",
        json={"claim_token": "22222222-3333-4444-5555-666666666666",
              "limit": 10, "lease_minutes": 5},
        headers=_HDR,
    )
    assert claimed.status_code == 200, claimed.text
    it = next(i for i in claimed.json()["data"]["items"] if i["invitation_id"] == inv["id"])

    assert it["phone"] != "010-0000-0000", "🔴 낡은 스냅샷으로 발송된다 — 08-11 사고 그대로"
    assert it["recipient_name"] != "옛주인", "이름도 옛 주인이다"
    assert it["snapshot_stale"] is True, "낡음이 기록되지 않는다"


def test_dispatch_stale_flags_wrong_recipient():
    """🔴 「보냈다」와 「그 사람에게 보냈다」를 가른다 (2026-08-12 실사고).

    양도 뒤 옛 번호로 발송되면 `sent_at` 이 다시 찍히고, 화면 정책은 "이미 받았다"로
    읽어 재발송 버튼을 감춘다 — 손님은 못 받았는데 **복구 수단이 화면에서 사라진다.**
    """
    from types import SimpleNamespace
    from app.api.v1.internal_attendee_ledger import _serialize_invitation

    inv = SimpleNamespace(
        id=uuid.uuid4(), event_id=uuid.uuid4(), recipient_name="새주인",
        phone_normalized="01055556666", phone_display="010-5555-6666", seq=1,
        ticket_number="TKT-X", admission_day=None, admission_mode="daypass",
        token_version=2, status="issued", failure_reason=None,
        sent_at=None, viewed_at=None, checked_in_at=None, revoked_at=None,
        created_at=None,
    )
    fresh = SimpleNamespace(status="sent", send_epoch=1, updated_at=None,
                            phone="010-5555-6666")
    stale = SimpleNamespace(status="sent", send_epoch=1, updated_at=None,
                            phone="010-9999-0000")

    assert _serialize_invitation(inv, fresh)["dispatch_stale"] is False
    assert _serialize_invitation(inv, stale)["dispatch_stale"] is True, (
        "옛 주인에게 보낸 것이 목록에 안 드러난다"
    )
    # 표기 차이(하이픈 없음)를 낡음으로 오해하면 전건 오탐이 되어 신호가 무의미해진다.
    same_digits = SimpleNamespace(status="sent", send_epoch=1, updated_at=None,
                                  phone="01055556666")
    assert _serialize_invitation(inv, same_digits)["dispatch_stale"] is False
    # 발송 큐가 없으면 낡음이 아니다(미발송이고, 그 판정은 dispatch_status 가 한다).
    assert _serialize_invitation(inv, None)["dispatch_stale"] is False
