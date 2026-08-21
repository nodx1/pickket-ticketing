"""레벨2 W5-SUPPORT — go 지원 계열 원장 흡수분 회귀 테스트.

커버 범위:
- 조직자 알림: 생성 → 목록/미읽음수 → 단건읽음 → 전체읽음 → 삭제 왕복
- 🔴 알림 크로스테넌트 차단(목록·총계·읽음·삭제 전부 account_id 경계)
- 🔴 go 146 이 넓혔던 type(event_approved 등) + seat_* 이 CHECK 를 통과하는지
- 게시 심사 원장: 기록 → 조회, 🔴 크로스테넌트 404, 🔴 v2 `reviews`(후기)와 분리 확인
- 문의: 공개 접수(organizer_ref 없음) → 주최자 조회/회신, 🔴 크로스테넌트 404
- 용량 배정: upsert 멱등((event, product_ref) 유니크) + tier 미동기화 행도 목록에 남는지
- 파이널콜 규칙: 미설정 기본값(configured:false) → upsert → 재조회
- 제휴 원자 생성: 중복 코드 409(경합 시 덮어쓰기 금지)
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from app.core.config import settings
from app.models.event import Event, EventStatus, SeatTier
from app.models.organizer import OrganizerProfile
from app.models.organizer_messaging import OrganizerNotification
from app.models.organizer_support import (
    CapacityAssignment,
    EventInquiry,
    EventPublicationReview,
    FinalCallRule,
)
from app.models.review import Review
from app.models.user import User

_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SECRET}


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)


async def _organizer(db_session, go_account_id: str) -> User:
    user = User(
        email=f"{go_account_id}@o.test", hashed_password="!x!", name="주최", is_organizer=True
    )
    db_session.add(user)
    await db_session.flush()
    db_session.add(
        OrganizerProfile(
            user_id=user.id, company_name="C", contact_email="c@t.com", go_account_id=go_account_id
        )
    )
    await db_session.commit()
    return user


async def _event(db_session, user: User, *, title="E") -> Event:
    now = datetime.now(timezone.utc)
    ev = Event(
        organizer_id=user.id,
        title=title,
        slug=f"e-{uuid.uuid4().hex[:8]}",
        venue="V",
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


# ═════════════════════════════════════════════════════════════════════════════
# A. 조직자 알림
# ═════════════════════════════════════════════════════════════════════════════


async def _make_notification(client, account_id: str, **over) -> str:
    body = {
        "account_id": account_id,
        "type": "new_order",
        "title": "새 주문",
        "message": "주문 1건이 접수되었습니다",
    }
    body.update(over)
    r = await client.post("/api/v1/internal/organizer-notifications", json=body, headers=_HDR)
    assert r.status_code == 200, r.text
    return r.json()["data"]["id"]


async def test_organizer_notification_roundtrip(client, db_session):
    acc = str(uuid.uuid4())
    nid = await _make_notification(client, acc, metadata={"orderNumber": "A-1"})

    r = await client.get(
        "/api/v1/internal/organizer-notifications", params={"account_id": acc}, headers=_HDR
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["total"] == 1
    assert data["items"][0]["id"] == nid
    assert data["items"][0]["metadata"] == {"orderNumber": "A-1"}
    assert data["items"][0]["is_read"] is False

    r = await client.get(
        "/api/v1/internal/organizer-notifications/unread-count",
        params={"account_id": acc},
        headers=_HDR,
    )
    assert r.json()["data"]["count"] == 1

    r = await client.patch(
        f"/api/v1/internal/organizer-notifications/{nid}/read",
        json={"account_id": acc},
        headers=_HDR,
    )
    assert r.status_code == 200 and r.json()["data"]["updated"] is True

    r = await client.get(
        "/api/v1/internal/organizer-notifications/unread-count",
        params={"account_id": acc},
        headers=_HDR,
    )
    assert r.json()["data"]["count"] == 0

    r = await client.delete(
        f"/api/v1/internal/organizer-notifications/{nid}",
        params={"account_id": acc},
        headers=_HDR,
    )
    assert r.status_code == 200 and r.json()["data"]["deleted"] is True

    left = (
        await db_session.execute(select(func.count()).select_from(OrganizerNotification))
    ).scalar_one()
    assert left == 0


async def test_organizer_notification_cross_tenant_blocked(client):
    """🔴 account_id 는 유일한 테넌트 경계다 — 목록·총계·읽음·삭제 전부에서 강제돼야 한다."""
    mine, theirs = str(uuid.uuid4()), str(uuid.uuid4())
    nid = await _make_notification(client, mine)
    await _make_notification(client, theirs)

    # 목록/총계: 남의 알림이 섞이지 않는다.
    r = await client.get(
        "/api/v1/internal/organizer-notifications", params={"account_id": mine}, headers=_HDR
    )
    data = r.json()["data"]
    assert data["total"] == 1
    assert {i["account_id"] for i in data["items"]} == {mine}

    r = await client.get(
        "/api/v1/internal/organizer-notifications/unread-count",
        params={"account_id": mine},
        headers=_HDR,
    )
    assert r.json()["data"]["count"] == 1

    # 남의 알림을 내 account_id 로 읽음 처리/삭제 시도 → 404(존재 노출 금지).
    r = await client.patch(
        f"/api/v1/internal/organizer-notifications/{nid}/read",
        json={"account_id": theirs},
        headers=_HDR,
    )
    assert r.status_code == 404

    r = await client.delete(
        f"/api/v1/internal/organizer-notifications/{nid}",
        params={"account_id": theirs},
        headers=_HDR,
    )
    assert r.status_code == 404


async def test_organizer_notification_read_all_scoped(client):
    mine, theirs = str(uuid.uuid4()), str(uuid.uuid4())
    await _make_notification(client, mine)
    await _make_notification(client, mine)
    await _make_notification(client, theirs)

    r = await client.patch(
        "/api/v1/internal/organizer-notifications/read-all",
        json={"account_id": mine},
        headers=_HDR,
    )
    assert r.status_code == 200 and r.json()["data"]["updated"] == 2

    # 남의 알림은 그대로 미읽음.
    r = await client.get(
        "/api/v1/internal/organizer-notifications/unread-count",
        params={"account_id": theirs},
        headers=_HDR,
    )
    assert r.json()["data"]["count"] == 1


@pytest.mark.parametrize(
    "notif_type",
    [
        # go 146 이 넓혔던 값 — v2 흡수 시 누락돼 있었다(무음 유실 원인).
        "ai_review",
        "ai_complete",
        "event_approved",
        "event_rejected",
        # 좌석 알림 채널(seat-channels.ts `seat_${kind}`).
        "seat_watch_available",
        "seat_watch_price_drop",
        "seat_companion_invite",
        "seat_hold_expiring",
        "seat_seat_assigned",
        "seat_refund_released",
    ],
)
async def test_organizer_notification_widened_types_accepted(client, notif_type):
    """🔴 go 146 동등 CHECK 확장 회귀 — 좁아지면 승인/반려 알림이 통째로 사라진다."""
    acc = str(uuid.uuid4())
    r = await client.post(
        "/api/v1/internal/organizer-notifications",
        json={
            "account_id": acc,
            "type": notif_type,
            "title": "제목",
            "message": "본문",
        },
        headers=_HDR,
    )
    assert r.status_code == 200, f"{notif_type}: {r.text}"


async def test_organizer_notification_unknown_type_rejected_as_400(client):
    """알 수 없는 type 은 DB CHECK 500 이 아니라 명시적 400 으로 되돌린다."""
    r = await client.post(
        "/api/v1/internal/organizer-notifications",
        json={
            "account_id": str(uuid.uuid4()),
            "type": "totally_unknown",
            "title": "t",
            "message": "m",
        },
        headers=_HDR,
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"


# ═════════════════════════════════════════════════════════════════════════════
# B. 게시 심사 원장
# ═════════════════════════════════════════════════════════════════════════════


async def test_publication_review_record_and_list(client, db_session):
    user = await _organizer(db_session, "acc-rev")
    ev = await _event(db_session, user)

    # 주최자 submit (organizer_ref 있음).
    r = await client.post(
        f"/api/v1/internal/events/{ev.id}/publication-reviews",
        json={"organizer_ref": "acc-rev", "action": "submit", "reviewer_ref": "user-1"},
        headers=_HDR,
    )
    assert r.status_code == 200, r.text

    # 어드민 approve (organizer_ref 없음 — admin 발신 경로).
    r = await client.post(
        f"/api/v1/internal/events/{ev.id}/publication-reviews",
        json={
            "action": "approve",
            "reason": None,
            "checklist": {"reviewer": "admin-9"},
            "reviewer_ref": "admin-9",
            "reviewer_name": "심사자",
        },
        headers=_HDR,
    )
    assert r.status_code == 200, r.text

    r = await client.get(
        f"/api/v1/internal/events/{ev.id}/publication-reviews",
        params={"organizer_ref": "acc-rev"},
        headers=_HDR,
    )
    assert r.status_code == 200
    data = r.json()["data"]
    assert data["total"] == 2
    # 최신순.
    assert data["reviews"][0]["action"] == "approve"
    assert data["reviews"][0]["reviewer_name"] == "심사자"
    assert data["reviews"][1]["action"] == "submit"


async def test_publication_review_is_separate_from_visitor_reviews(client, db_session):
    """🔴 v2 `reviews`(관람객 후기)와 절대 섞이면 안 된다.

    후기가 심사 이력으로 읽히면 **미심사 이벤트가 공개**된다. 두 테이블이 물리적으로
    분리돼 있고 서로의 행 수에 영향을 주지 않음을 고정한다.
    """
    user = await _organizer(db_session, "acc-sep")
    ev = await _event(db_session, user)

    # 관람객 후기 1건을 직접 심는다.
    db_session.add(
        Review(
            event_id=ev.id, user_id=user.id, rating=5, title="관람 후기", content="최고였어요"
        )
    )
    await db_session.commit()

    r = await client.get(
        f"/api/v1/internal/events/{ev.id}/publication-reviews",
        params={"organizer_ref": "acc-sep"},
        headers=_HDR,
    )
    # 후기가 있어도 심사 이력은 0 이다.
    assert r.status_code == 200 and r.json()["data"]["total"] == 0

    # 심사 이력을 1건 기록해도 후기 수는 그대로다.
    await client.post(
        f"/api/v1/internal/events/{ev.id}/publication-reviews",
        json={"organizer_ref": "acc-sep", "action": "submit"},
        headers=_HDR,
    )
    review_count = (await db_session.execute(select(func.count()).select_from(Review))).scalar_one()
    pub_count = (
        await db_session.execute(select(func.count()).select_from(EventPublicationReview))
    ).scalar_one()
    assert (review_count, pub_count) == (1, 1)


async def test_publication_review_cross_tenant_blocked(client, db_session):
    """🔴 go `event_reviews` 에는 account_id 가 없었다 — 경계는 events.organizer_id 뿐이다."""
    owner = await _organizer(db_session, "acc-own")
    await _organizer(db_session, "acc-other")
    ev = await _event(db_session, owner)
    await client.post(
        f"/api/v1/internal/events/{ev.id}/publication-reviews",
        json={"organizer_ref": "acc-own", "action": "reject", "reason": "서류 미비"},
        headers=_HDR,
    )

    # 남의 이벤트 심사 이력(반려 사유!) 조회 시도 → 404.
    r = await client.get(
        f"/api/v1/internal/events/{ev.id}/publication-reviews",
        params={"organizer_ref": "acc-other"},
        headers=_HDR,
    )
    assert r.status_code == 404
    assert "서류 미비" not in r.text

    # 남의 이벤트에 심사 이력 기록 시도 → 404.
    r = await client.post(
        f"/api/v1/internal/events/{ev.id}/publication-reviews",
        json={"organizer_ref": "acc-other", "action": "approve"},
        headers=_HDR,
    )
    assert r.status_code == 404


async def test_publication_review_unknown_action_rejected(client, db_session):
    user = await _organizer(db_session, "acc-act")
    ev = await _event(db_session, user)
    r = await client.post(
        f"/api/v1/internal/events/{ev.id}/publication-reviews",
        json={"organizer_ref": "acc-act", "action": "approve_maybe"},
        headers=_HDR,
    )
    assert r.status_code == 400


# ═════════════════════════════════════════════════════════════════════════════
# C. 문의
# ═════════════════════════════════════════════════════════════════════════════


async def test_inquiry_public_intake_then_organizer_answer(client, db_session):
    user = await _organizer(db_session, "acc-inq")
    ev = await _event(db_session, user)

    # 공개 접수 — organizer_ref 없음(제출자는 소비자).
    r = await client.post(
        f"/api/v1/internal/events/{ev.id}/inquiries",
        json={"question": "  주차 되나요?  ", "contact": "  a@b.test ", "source": "web"},
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    inq_id = r.json()["data"]["id"]

    r = await client.get(
        f"/api/v1/internal/events/{ev.id}/inquiries",
        params={"organizer_ref": "acc-inq"},
        headers=_HDR,
    )
    data = r.json()["data"]
    assert data["total"] == 1
    assert data["inquiries"][0]["question"] == "주차 되나요?"
    assert data["inquiries"][0]["contact"] == "a@b.test"  # 원문(마스킹은 go 표시 계층)
    assert data["inquiries"][0]["status"] == "open"

    r = await client.patch(
        f"/api/v1/internal/events/{ev.id}/inquiries/{inq_id}",
        json={"organizer_ref": "acc-inq", "status": "answered", "answer": "가능합니다"},
        headers=_HDR,
    )
    assert r.status_code == 200
    # 회신 통지 발송에 필요한 원문을 그대로 돌려준다.
    assert r.json()["data"]["inquiry"]["answer"] == "가능합니다"
    assert r.json()["data"]["inquiry"]["contact"] == "a@b.test"

    # status 필터.
    r = await client.get(
        f"/api/v1/internal/events/{ev.id}/inquiries",
        params={"organizer_ref": "acc-inq", "status": "open"},
        headers=_HDR,
    )
    assert r.json()["data"]["total"] == 0


async def test_inquiry_cross_tenant_blocked(client, db_session):
    owner = await _organizer(db_session, "acc-io")
    await _organizer(db_session, "acc-ix")
    ev = await _event(db_session, owner)
    r = await client.post(
        f"/api/v1/internal/events/{ev.id}/inquiries",
        json={"question": "민감한 문의 내용"},
        headers=_HDR,
    )
    inq_id = r.json()["data"]["id"]

    r = await client.get(
        f"/api/v1/internal/events/{ev.id}/inquiries",
        params={"organizer_ref": "acc-ix"},
        headers=_HDR,
    )
    assert r.status_code == 404
    assert "민감한 문의 내용" not in r.text

    r = await client.patch(
        f"/api/v1/internal/events/{ev.id}/inquiries/{inq_id}",
        json={"organizer_ref": "acc-ix", "answer": "가로채기"},
        headers=_HDR,
    )
    assert r.status_code == 404


async def test_inquiry_intake_on_missing_event_is_404_not_silent_success(client):
    """🔴 공개 접수는 조용히 성공하면 안 된다 — 저장할 곳이 없으면 명확히 실패한다."""
    r = await client.post(
        f"/api/v1/internal/events/{uuid.uuid4()}/inquiries",
        json={"question": "없는 이벤트 문의"},
        headers=_HDR,
    )
    assert r.status_code == 404
    assert r.json()["ok"] is False


async def test_inquiry_patch_wrong_event_is_404(client, db_session):
    """inquiry_id 만으로 갱신되면 타 이벤트 문의를 건드릴 수 있다 — event_id 조건 회귀."""
    user = await _organizer(db_session, "acc-iw")
    ev_a = await _event(db_session, user, title="A")
    ev_b = await _event(db_session, user, title="B")
    r = await client.post(
        f"/api/v1/internal/events/{ev_a.id}/inquiries", json={"question": "A 문의"}, headers=_HDR
    )
    inq_id = r.json()["data"]["id"]

    r = await client.patch(
        f"/api/v1/internal/events/{ev_b.id}/inquiries/{inq_id}",
        json={"organizer_ref": "acc-iw", "answer": "엉뚱한 이벤트"},
        headers=_HDR,
    )
    assert r.status_code == 404


# ═════════════════════════════════════════════════════════════════════════════
# D. 용량 배정
# ═════════════════════════════════════════════════════════════════════════════


async def test_capacity_upsert_is_idempotent_per_product(client, db_session):
    user = await _organizer(db_session, "acc-cap")
    ev = await _event(db_session, user)

    for capacity, used in ((50, 5), (80, 9)):
        r = await client.put(
            f"/api/v1/internal/events/{ev.id}/capacity-assignments",
            json={
                "organizer_ref": "acc-cap",
                "product_ref": "prod-1",
                "capacity": capacity,
                "used_capacity": used,
            },
            headers=_HDR,
        )
        assert r.status_code == 200, r.text

    rows = (
        await db_session.execute(select(func.count()).select_from(CapacityAssignment))
    ).scalar_one()
    assert rows == 1  # (event_id, product_ref) 유니크 — 중복 행 금지

    r = await client.get(
        f"/api/v1/internal/events/{ev.id}/capacity-assignments",
        params={"organizer_ref": "acc-cap"},
        headers=_HDR,
    )
    a = r.json()["data"]["assignments"][0]
    assert (a["capacity"], a["used_capacity"]) == (80, 9)


async def test_capacity_list_keeps_rows_without_synced_tier(client, db_session):
    """🔴 옛 `INNER JOIN products` 를 그대로 옮기면 미동기화 상품의 배정이 사라진다.

    주최자 눈에는 "배정이 지워졌다"로 보이고, 다시 배정해 덮어쓰게 된다 → OUTER 조인.
    """
    user = await _organizer(db_session, "acc-cap2")
    ev = await _event(db_session, user)

    tier = SeatTier(
        event_id=ev.id, external_ref="prod-synced", name="일반석", capacity=10, base_price=1000
    )
    db_session.add(tier)
    await db_session.commit()

    for ref in ("prod-synced", "prod-orphan"):
        r = await client.put(
            f"/api/v1/internal/events/{ev.id}/capacity-assignments",
            json={
                "organizer_ref": "acc-cap2",
                "product_ref": ref,
                "capacity": 10,
                "used_capacity": 0,
            },
            headers=_HDR,
        )
        assert r.status_code == 200

    r = await client.get(
        f"/api/v1/internal/events/{ev.id}/capacity-assignments",
        params={"organizer_ref": "acc-cap2"},
        headers=_HDR,
    )
    assignments = {a["product_ref"]: a for a in r.json()["data"]["assignments"]}
    assert set(assignments) == {"prod-synced", "prod-orphan"}
    assert assignments["prod-synced"]["product_name"] == "일반석"
    assert assignments["prod-orphan"]["product_name"] is None


async def test_capacity_cross_tenant_blocked(client, db_session):
    owner = await _organizer(db_session, "acc-co")
    await _organizer(db_session, "acc-cx")
    ev = await _event(db_session, owner)

    r = await client.put(
        f"/api/v1/internal/events/{ev.id}/capacity-assignments",
        json={"organizer_ref": "acc-cx", "product_ref": "p", "capacity": 1, "used_capacity": 0},
        headers=_HDR,
    )
    assert r.status_code == 404

    r = await client.get(
        f"/api/v1/internal/events/{ev.id}/capacity-assignments",
        params={"organizer_ref": "acc-cx"},
        headers=_HDR,
    )
    assert r.status_code == 404


# ═════════════════════════════════════════════════════════════════════════════
# E. 파이널콜 규칙
# ═════════════════════════════════════════════════════════════════════════════


async def test_final_call_rule_defaults_then_upsert(client, db_session):
    user = await _organizer(db_session, "acc-fc")
    ev = await _event(db_session, user)

    r = await client.get(
        f"/api/v1/internal/events/{ev.id}/final-call-rule",
        params={"organizer_ref": "acc-fc"},
        headers=_HDR,
    )
    assert r.status_code == 200
    data = r.json()["data"]
    # 🔴 "설정 없음"은 확정 사실이므로 configured:false 로 구분해 알린다(장애와 다르다).
    assert data["configured"] is False
    assert data["rule"] == {
        "is_active": False,
        "trigger_hours_before": 24,
        "discount_percent": 30,
        "min_remaining_percent": 20,
        "max_discount_tickets": None,
        "notify_buyers": True,
    }

    for pct in (40, 55):
        r = await client.put(
            f"/api/v1/internal/events/{ev.id}/final-call-rule",
            json={
                "organizer_ref": "acc-fc",
                "is_active": True,
                "trigger_hours_before": 12,
                "discount_percent": pct,
                "min_remaining_percent": 15,
                "max_discount_tickets": 30,
                "notify_buyers": False,
            },
            headers=_HDR,
        )
        assert r.status_code == 200, r.text

    rows = (await db_session.execute(select(func.count()).select_from(FinalCallRule))).scalar_one()
    assert rows == 1  # 이벤트당 1행

    r = await client.get(
        f"/api/v1/internal/events/{ev.id}/final-call-rule",
        params={"organizer_ref": "acc-fc"},
        headers=_HDR,
    )
    data = r.json()["data"]
    assert data["configured"] is True
    assert data["rule"]["discount_percent"] == 55
    assert data["rule"]["notify_buyers"] is False


async def test_final_call_rule_out_of_range_rejected(client, db_session):
    user = await _organizer(db_session, "acc-fc2")
    ev = await _event(db_session, user)
    r = await client.put(
        f"/api/v1/internal/events/{ev.id}/final-call-rule",
        json={"organizer_ref": "acc-fc2", "discount_percent": 95},
        headers=_HDR,
    )
    assert r.status_code == 422  # pydantic 경계(5~80)


async def test_final_call_rule_cross_tenant_blocked(client, db_session):
    owner = await _organizer(db_session, "acc-fo")
    await _organizer(db_session, "acc-fx")
    ev = await _event(db_session, owner)
    r = await client.get(
        f"/api/v1/internal/events/{ev.id}/final-call-rule",
        params={"organizer_ref": "acc-fx"},
        headers=_HDR,
    )
    assert r.status_code == 404


# ═════════════════════════════════════════════════════════════════════════════
# F. 제휴 원자 생성
# ═════════════════════════════════════════════════════════════════════════════


async def test_affiliate_create_duplicate_code_is_409_not_overwrite(client, db_session):
    """🔴 배치 upsert 는 code 매칭 덮어쓰기라 경합 시 남의 제휴 정의를 가로챈다.

    생성 전용 경로는 유니크 제약으로 원자적으로 409 를 내고, 기존 행을 **건드리지 않는다**.
    """
    user = await _organizer(db_session, "acc-aff")
    ev = await _event(db_session, user)

    r = await client.post(
        f"/api/v1/internal/events/{ev.id}/affiliates",
        json={
            "organizer_ref": "acc-aff",
            "external_ref": "go-aff-1",
            "name": "파트너A",
            "code": "PARTNER_A",
            "commission_rate": 10,
        },
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    first_id = r.json()["data"]["affiliate_id"]

    # 같은 code 로 다른 external_ref → 409, 원본 무변경.
    r = await client.post(
        f"/api/v1/internal/events/{ev.id}/affiliates",
        json={
            "organizer_ref": "acc-aff",
            "external_ref": "go-aff-2",
            "name": "가로채기",
            "code": "PARTNER_A",
            "commission_rate": 90,
        },
        headers=_HDR,
    )
    assert r.status_code == 409, r.text

    r = await client.get(
        f"/api/v1/internal/events/{ev.id}/affiliates/go-aff-1", headers=_HDR
    )
    assert r.status_code == 200
    aff = r.json()["data"]["affiliate"]
    assert aff["affiliate_id"] == first_id
    assert aff["name"] == "파트너A"
    assert float(aff["commission_rate"]) == 10.0


async def test_affiliate_create_cross_tenant_blocked(client, db_session):
    owner = await _organizer(db_session, "acc-ao")
    await _organizer(db_session, "acc-ax")
    ev = await _event(db_session, owner)
    r = await client.post(
        f"/api/v1/internal/events/{ev.id}/affiliates",
        json={
            "organizer_ref": "acc-ax",
            "external_ref": "go-aff-x",
            "name": "남의 이벤트",
            "code": "X",
            "commission_rate": 5,
        },
        headers=_HDR,
    )
    assert r.status_code == 404


async def test_support_endpoints_require_internal_auth(client, db_session):
    """인증 헤더 없이는 어떤 지원 원장도 노출되지 않는다."""
    user = await _organizer(db_session, "acc-auth")
    ev = await _event(db_session, user)
    for method, path, kwargs in (
        ("get", "/api/v1/internal/organizer-notifications", {"params": {"account_id": str(uuid.uuid4())}}),
        ("get", f"/api/v1/internal/events/{ev.id}/publication-reviews", {"params": {"organizer_ref": "acc-auth"}}),
        ("get", f"/api/v1/internal/events/{ev.id}/inquiries", {"params": {"organizer_ref": "acc-auth"}}),
        ("get", f"/api/v1/internal/events/{ev.id}/capacity-assignments", {"params": {"organizer_ref": "acc-auth"}}),
        ("get", f"/api/v1/internal/events/{ev.id}/final-call-rule", {"params": {"organizer_ref": "acc-auth"}}),
    ):
        r = await getattr(client, method)(path, **kwargs)
        assert r.status_code in (401, 403), f"{path} -> {r.status_code}"


async def test_inquiry_and_notification_models_are_distinct_tables(db_session):
    """모델 레지스트리 회귀 — 동명 다개념 테이블이 실수로 합쳐지지 않았는지 고정."""
    assert EventPublicationReview.__tablename__ == "event_publication_reviews"
    assert Review.__tablename__ == "reviews"
    assert FinalCallRule.__tablename__ == "final_call_rules"
    assert EventInquiry.__tablename__ == "event_inquiries"
    assert OrganizerNotification.__tablename__ == "organizer_notifications"
    from app.models.final_call import FinalCall
    from app.models.notification import NotificationModel

    assert FinalCall.__tablename__ == "final_calls"
    assert NotificationModel.__tablename__ == "notifications"
