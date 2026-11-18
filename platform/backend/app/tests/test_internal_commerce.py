"""go write-through 커머스 write API (Slice A) 테스트.

SPEC §2.1/2.2/2.7 + 공통규약(토큰/멱등/organizer_ref/판매창/정액 fee).
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from app.core.config import settings
from app.models.discount_code import DiscountCode, DiscountCodeType
from app.models.event import Event, EventStatus, SeatTier
from app.models.fee_schedule import FeeSchedule
from app.models.organizer import OrganizerProfile
from app.models.seat import Seat, SeatStatus
from app.models.user import User

_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SECRET}


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)


async def _seed_organizer(db_session, go_account_id="go_org_1") -> User:
    user = User(
        email=f"{go_account_id}@org.test",
        hashed_password="!x!",
        name="주최자",
        is_organizer=True,
    )
    db_session.add(user)
    await db_session.flush()
    prof = OrganizerProfile(
        user_id=user.id,
        company_name="테스트 주최",
        contact_email="org@test.com",
        go_account_id=go_account_id,
    )
    db_session.add(prof)
    await db_session.commit()
    return user


# 🔴 고정 날짜(2026-08-20)가 지나 환불 테스트가 「행사 당일 이후 수수료 100%」로 깨졌다(2026-11-18).
#    오늘 기준 90일 뒤 19시(KST)로 둔다 — 환불 수수료 0% 구간(30일+)이 유지된다.
_EVENT_DATE = (datetime.now(timezone(timedelta(hours=9))) + timedelta(days=90)).replace(
    hour=19, minute=0, second=0, microsecond=0
)


def _event_body(go_account_id="go_org_1", **over) -> dict:
    body = {
        "organizer_ref": {"go_account_id": go_account_id},
        "external_ref": "go_evt_1",
        "title": "테스트 콘서트",
        "venue": "올림픽홀",
        "category": "concert",
        "event_date": _EVENT_DATE.isoformat(),
        "sale_window": {
            "opens_at": "2026-07-01T10:00:00+09:00",
            "closes_at": "2026-07-10T23:59:59+09:00",
        },
        "sale_channels": ["self", "marketplace"],
        "status": "draft",
    }
    body.update(over)
    return body


# ── 인증/멱등 공통규약 ───────────────────────────────────────────────────


def _sign_headers(body_bytes: bytes) -> dict:
    """go commerce-client 서명 계약 재현: HMAC-SHA256(secret, f'{ts}.'+body)."""
    import hashlib
    import hmac as _hmac
    from datetime import datetime, timezone
    ts = datetime.now(timezone.utc).isoformat()
    msg = f"{ts}.".encode() + body_bytes
    sig = _hmac.new(_SECRET.encode(), msg, hashlib.sha256).hexdigest()
    return {"x-pickket-signature": sig, "x-pickket-timestamp": ts}


async def test_hmac_signed_write_accepted_without_token(client, db_session):
    """추가형 HMAC: 토큰 없이 서명만으로 write 인증 통과(go 서명 배선 검증)."""
    import json as _json
    await _seed_organizer(db_session)
    body = _event_body()
    raw = _json.dumps(body).encode()
    headers = {**_sign_headers(raw), "Idempotency-Key": str(uuid.uuid4()),
               "content-type": "application/json"}  # 토큰 헤더 없음
    r = await client.post("/api/v1/internal/events", content=raw, headers=headers)
    assert r.status_code == 200, r.text  # 401 아님 = 서명 인증 성공


async def test_hmac_bad_signature_rejected(client, db_session):
    import json as _json
    await _seed_organizer(db_session)
    raw = _json.dumps(_event_body()).encode()
    headers = _sign_headers(raw)
    headers["x-pickket-signature"] = "deadbeef" * 8  # 위조
    headers.update({"Idempotency-Key": str(uuid.uuid4()), "content-type": "application/json"})
    r = await client.post("/api/v1/internal/events", content=raw, headers=headers)
    assert r.status_code in (400, 401)  # 서명 불일치 거부


async def test_enforce_hmac_rejects_token_only(client, db_session, monkeypatch):
    """enforce=True(컷오버 flip)면 토큰만으론 거부 — 서명 필수."""
    monkeypatch.setattr(settings, "INTERNAL_COMMERCE_REQUIRE_HMAC", True)
    await _seed_organizer(db_session)
    r = await client.post("/api/v1/internal/events", json=_event_body(),
                          headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})  # 토큰만
    assert r.status_code == 401


async def test_production_blocks_token_fallback_even_if_flag_false(
    client, db_session, monkeypatch
):
    """#24 런타임 방어: production 이면 INTERNAL_COMMERCE_REQUIRE_HMAC 가 (드리프트로)
    False 여도 토큰 폴백을 차단 — 서명 필수."""
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "INTERNAL_COMMERCE_REQUIRE_HMAC", False)
    await _seed_organizer(db_session)
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},  # 토큰만
    )
    assert r.status_code == 401


async def test_create_event_requires_token(client, db_session):
    await _seed_organizer(db_session)
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(),
        headers={"Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 401


async def test_create_event_requires_idempotency_key(client, db_session):
    await _seed_organizer(db_session)
    r = await client.post("/api/v1/internal/events", json=_event_body(), headers=_HDR)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"


# ── 이벤트 생성 (§2.1) ──────────────────────────────────────────────────


async def test_create_event_success_sets_sale_window_from_go(client, db_session):
    await _seed_organizer(db_session)
    headers = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    r = await client.post("/api/v1/internal/events", json=_event_body(), headers=headers)
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["created"] is True
    assert data["status"] == "draft"
    event_id = uuid.UUID(data["event_id"])

    event = await db_session.get(Event, event_id)
    assert event is not None
    assert event.external_ref == "go_evt_1"
    assert event.status == EventStatus.DRAFT
    # 판매창은 go 입력 정본 — event_date 추정이 아니라 sale_window 그대로.
    assert event.bidding_opens_at.isoformat().startswith("2026-07-01T10:00:00")
    assert event.bidding_closes_at.isoformat().startswith("2026-07-10T23:59:59")


async def test_image_variants_roundtrip_create_patch_read(client, db_session):
    """go image_variants 렌디션 맵 + gallery_images 갤러리가 create/patch로 저장되고 read로 되돌아온다."""
    await _seed_organizer(db_session)
    variants = {
        "wide": "https://cdn.pickket.kr/e/wide.jpg",
        "portrait": "https://cdn.pickket.kr/e/portrait.jpg",
        "thumb": "https://cdn.pickket.kr/e/thumb.jpg",
        "og": "https://cdn.pickket.kr/e/og.jpg",
    }
    gallery = [
        {"url": "https://cdn.pickket.kr/e/g1.jpg", "variants": variants},
        {"url": "https://cdn.pickket.kr/e/g2.jpg", "variants": None},
    ]
    h = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(
            image_url="https://cdn.pickket.kr/e/master.jpg",
            image_variants=variants,
            gallery_images=gallery,
        ),
        headers=h,
    )
    assert r.status_code == 200, r.text
    eid = r.json()["data"]["event_id"]
    event = await db_session.get(Event, uuid.UUID(eid))
    assert event.image_variants == variants
    assert event.gallery_images == gallery

    # patch로 렌디션 맵 + 갤러리 갱신
    new_variants = {**variants, "wide": "https://cdn.pickket.kr/e/wide-v2.jpg"}
    new_gallery = [{"url": "https://cdn.pickket.kr/e/g3.jpg", "variants": None}]
    p = await client.patch(
        f"/api/v1/internal/events/{eid}",
        json={"image_variants": new_variants, "gallery_images": new_gallery},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert p.status_code == 200, p.text
    await db_session.refresh(event)
    assert event.image_variants["wide"] == "https://cdn.pickket.kr/e/wide-v2.jpg"
    assert event.gallery_images == new_gallery


async def test_admission_mode_raffle_roundtrip_create_patch(client, db_session):
    """F1/F4: go 편집 UI → admission_mode·raffle_enabled·event_date_end write-through 저장/갱신."""
    await _seed_organizer(db_session)
    h = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    # 다일 daypass + 경품 활성으로 생성.
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(
            admission_mode="daypass",
            event_date_end=(_EVENT_DATE + timedelta(days=2, hours=3)).isoformat(),
            raffle_enabled=True,
        ),
        headers=h,
    )
    assert r.status_code == 200, r.text
    eid = r.json()["data"]["event_id"]
    event = await db_session.get(Event, uuid.UUID(eid))
    assert event.admission_mode == "daypass"
    assert event.raffle_enabled is True
    assert event.event_date_end is not None

    # patch: allpass 로 변경(발권 전이라 허용), 경품 끔.
    p = await client.patch(
        f"/api/v1/internal/events/{eid}",
        json={"admission_mode": "allpass", "raffle_enabled": False},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert p.status_code == 200, p.text
    await db_session.refresh(event)
    assert event.admission_mode == "allpass"
    assert event.raffle_enabled is False


async def test_u3_gate_fields_roundtrip_create_patch_read(client, db_session):
    """U3(F5): organizer PATCH 가 밀어넣는 rsvp_enabled·group_booking_enabled·context_banner
    write-through 왕복. go events PATCH → /internal/events 가 v2 events(SoT)에 반영하고
    read-back(GET /internal/events/{id})으로 consumer 게이트 값이 노출되는지 검증."""
    await _seed_organizer(db_session)
    h = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    # 1) 게이트 전부 켜서 생성(organizer create write-through 대칭).
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(
            rsvp_enabled=True,
            group_booking_enabled=True,
            context_banner="얼리버드 판매 중",
        ),
        headers=h,
    )
    assert r.status_code == 200, r.text
    eid = r.json()["data"]["event_id"]
    event = await db_session.get(Event, uuid.UUID(eid))
    assert event.rsvp_enabled is True
    assert event.group_booking_enabled is True
    assert event.context_banner == "얼리버드 판매 중"

    # read-back — consumer 가 소비하는 게이트 값 노출 확인.
    g = await client.get(f"/api/v1/internal/events/{eid}", headers=_HDR)
    assert g.status_code == 200, g.text
    data = g.json()["data"]
    assert data["rsvp_enabled"] is True
    assert data["group_booking_enabled"] is True
    assert data["context_banner"] == "얼리버드 판매 중"

    # 2) PATCH: group_booking 끄고 배너 해제(빈문자열=NULL), rsvp 는 미전송(보존).
    p = await client.patch(
        f"/api/v1/internal/events/{eid}",
        json={"group_booking_enabled": False, "context_banner": ""},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert p.status_code == 200, p.text
    await db_session.refresh(event)
    assert event.rsvp_enabled is True  # 미전송 → 보존(model_fields_set).
    assert event.group_booking_enabled is False
    assert event.context_banner is None  # 빈문자열 → NULL(배너 해제).


async def test_admission_mode_invalid_rejected(client, db_session):
    """F1: 화이트리스트 밖 admission_mode 는 400."""
    await _seed_organizer(db_session)
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(admission_mode="bogus"),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 400, r.text


async def test_create_event_go_status_live_maps_to_bidding_open(client, db_session):
    """go P0: go status 'live' → v2 bidding_open + read 라운드트립 'live'."""
    await _seed_organizer(db_session)
    h = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    r = await client.post("/api/v1/internal/events", json=_event_body(status="live"), headers=h)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["status_v2"] == "bidding_open"  # 역매핑
    assert d["status"] == "live"             # go 투영 라운드트립
    event = await db_session.get(Event, uuid.UUID(d["event_id"]))
    assert event.status == EventStatus.BIDDING_OPEN
    assert event.sales_paused is False


async def test_create_event_go_status_archived(client, db_session):
    await _seed_organizer(db_session)
    h = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    r = await client.post("/api/v1/internal/events", json=_event_body(status="archived"), headers=h)
    assert r.json()["data"]["status_v2"] == "cancelled"
    assert r.json()["data"]["status"] == "archived"


async def test_patch_event_go_status_pause_resume(client, db_session):
    """go status 'paused' patch → status 유지 + sales_paused=True. 'live' → 재개."""
    await _seed_organizer(db_session)
    h = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    created = await client.post("/api/v1/internal/events", json=_event_body(status="live"), headers=h)
    eid = created.json()["data"]["event_id"]
    p = await client.patch(f"/api/v1/internal/events/{eid}", json={"status": "paused"},
                           headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert p.status_code == 200, p.text
    ev = await db_session.get(Event, uuid.UUID(eid))
    await db_session.refresh(ev)
    assert ev.status == EventStatus.BIDDING_OPEN and ev.sales_paused is True
    g = await client.get(f"/api/v1/internal/events/{eid}", headers=_HDR)
    assert g.json()["data"]["status"] == "paused"
    await client.patch(f"/api/v1/internal/events/{eid}", json={"status": "live"},
                       headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    await db_session.refresh(ev)
    assert ev.status == EventStatus.BIDDING_OPEN and ev.sales_paused is False


async def test_create_event_invalid_go_status(client, db_session):
    await _seed_organizer(db_session)
    r = await client.post("/api/v1/internal/events", json=_event_body(status="bogus_state"),
                          headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 400
    assert r.json()["error"]["field"] == "status"


async def test_create_event_organizer_ref_unresolved(client, db_session):
    # organizer 미시드 → go_account_id 매핑 없음 → 404.
    headers = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(go_account_id="nonexistent"),
        headers=headers,
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "ORGANIZER_REF_UNRESOLVED"


async def test_create_event_invalid_category(client, db_session):
    await _seed_organizer(db_session)
    headers = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(category="auction"),
        headers=headers,
    )
    assert r.status_code == 400
    assert r.json()["error"]["field"] == "category"


async def test_create_event_bad_sale_window(client, db_session):
    await _seed_organizer(db_session)
    headers = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    body = _event_body()
    body["sale_window"] = {
        "opens_at": "2026-07-10T10:00:00+09:00",
        "closes_at": "2026-07-01T10:00:00+09:00",  # closes < opens
    }
    r = await client.post("/api/v1/internal/events", json=body, headers=headers)
    assert r.status_code == 400
    assert r.json()["error"]["field"] == "sale_window"


async def test_create_event_idempotent_replay(client, db_session):
    await _seed_organizer(db_session)
    key = str(uuid.uuid4())
    headers = {**_HDR, "Idempotency-Key": key}
    r1 = await client.post("/api/v1/internal/events", json=_event_body(), headers=headers)
    r2 = await client.post("/api/v1/internal/events", json=_event_body(), headers=headers)
    assert r1.status_code == r2.status_code == 200
    assert r1.json()["data"]["event_id"] == r2.json()["data"]["event_id"]
    assert r1.json()["idempotent_replay"] is False
    assert r2.json()["idempotent_replay"] is True


async def test_create_event_external_ref_dedup(client, db_session):
    """동일 external_ref 재생성(다른 멱등키) → 같은 canonical id, created=False."""
    await _seed_organizer(db_session)
    h1 = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    h2 = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    r1 = await client.post("/api/v1/internal/events", json=_event_body(), headers=h1)
    r2 = await client.post("/api/v1/internal/events", json=_event_body(), headers=h2)
    assert r1.json()["data"]["event_id"] == r2.json()["data"]["event_id"]
    assert r2.json()["data"]["created"] is False


# ── 이벤트 수정 (§2.2) ──────────────────────────────────────────────────


async def test_patch_event(client, db_session):
    await _seed_organizer(db_session)
    h = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    created = await client.post("/api/v1/internal/events", json=_event_body(), headers=h)
    event_id = created.json()["data"]["event_id"]

    r = await client.patch(
        f"/api/v1/internal/events/{event_id}",
        json={"title": "수정된 제목", "status": "approved"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    event = await db_session.get(Event, uuid.UUID(event_id))
    await db_session.refresh(event)
    assert event.title == "수정된 제목"
    assert event.status == EventStatus.APPROVED


# ── 상세페이지 통합 트랙B U1 — 핵심 상세 필드 왕복(수신→저장→직렬화) ──────────


async def test_u1_core_fields_create_roundtrip(client, db_session):
    """U1: venue_address·age_rating·is_online·homepage_url·description 가 create write 로
    저장되고, 내부 getEvent read 와 공개 EventResponse 직렬화에 모두 반영된다."""
    from sqlalchemy.orm import joinedload, selectinload

    from app.schemas.event import EventResponse

    await _seed_organizer(db_session)
    h = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    body = _event_body(
        description="상세 본문입니다",
        venue_address="서울시 송파구 올림픽로 424",
        age_rating="15+",
        is_online=True,
        homepage_url="https://example.com/event",
        total_seats=500,
    )
    r = await client.post("/api/v1/internal/events", json=body, headers=h)
    assert r.status_code == 200, r.text
    event_id = r.json()["data"]["event_id"]

    # 1) 저장(DB)
    event = await db_session.get(Event, uuid.UUID(event_id))
    await db_session.refresh(event)
    assert event.description == "상세 본문입니다"
    assert event.venue_address == "서울시 송파구 올림픽로 424"
    assert event.age_rating == "15+"
    assert event.is_online is True
    assert event.homepage_url == "https://example.com/event"
    assert event.total_seats == 500

    # 2) 내부 getEvent read-after-write
    g = await client.get(f"/api/v1/internal/events/{event_id}", headers=_HDR)
    gd = g.json()["data"]
    assert gd["venue_address"] == "서울시 송파구 올림픽로 424"
    assert gd["age_rating"] == "15+"
    assert gd["is_online"] is True
    assert gd["homepage_url"] == "https://example.com/event"

    # 3) 공개 EventResponse 직렬화(소비자 상세 계약) — 관계 eager-load 후 검증.
    loaded = (
        await db_session.execute(
            select(Event)
            .where(Event.id == uuid.UUID(event_id))
            .options(joinedload(Event.organizer), selectinload(Event.seat_tiers))
        )
    ).unique().scalar_one()
    dumped = EventResponse.model_validate(loaded).model_dump(mode="json")
    assert dumped["description"] == "상세 본문입니다"
    assert dumped["venue_address"] == "서울시 송파구 올림픽로 424"
    assert dumped["age_rating"] == "15+"
    assert dumped["is_online"] is True
    assert dumped["homepage_url"] == "https://example.com/event"


async def test_u1_core_fields_defaults_when_absent(client, db_session):
    """U1: 필드 미전송 시 비파괴 — is_online=false, 나머지 NULL."""
    from sqlalchemy.orm import joinedload, selectinload

    from app.schemas.event import EventResponse

    await _seed_organizer(db_session)
    h = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    r = await client.post("/api/v1/internal/events", json=_event_body(), headers=h)
    assert r.status_code == 200, r.text
    event = await db_session.get(Event, uuid.UUID(r.json()["data"]["event_id"]))
    await db_session.refresh(event)
    assert event.venue_address is None
    assert event.age_rating is None
    assert event.is_online is False  # server_default false — 기존 행 안전
    assert event.homepage_url is None
    loaded = (
        await db_session.execute(
            select(Event)
            .where(Event.id == event.id)
            .options(joinedload(Event.organizer), selectinload(Event.seat_tiers))
        )
    ).unique().scalar_one()
    dumped = EventResponse.model_validate(loaded).model_dump(mode="json")
    assert dumped["is_online"] is False
    assert dumped["venue_address"] is None


async def test_u1_core_fields_patch_partial(client, db_session):
    """U1 PATCH: model_fields_set 로 미포함=보존/명시 변경만 반영. 정원→total_seats 재sync."""
    await _seed_organizer(db_session)
    h = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    created = await client.post(
        "/api/v1/internal/events",
        json=_event_body(
            venue_address="옛 주소",
            age_rating="all",
            is_online=False,
            homepage_url="https://old.example.com",
            total_seats=100,
        ),
        headers=h,
    )
    event_id = created.json()["data"]["event_id"]

    # venue_address·is_online·total_seats 만 변경. age_rating·homepage_url 은 미전송(보존).
    r = await client.patch(
        f"/api/v1/internal/events/{event_id}",
        json={"venue_address": "새 주소", "is_online": True, "total_seats": 300},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    event = await db_session.get(Event, uuid.UUID(event_id))
    await db_session.refresh(event)
    assert event.venue_address == "새 주소"       # 변경
    assert event.is_online is True               # 변경
    assert event.total_seats == 300              # 정원 재sync
    assert event.age_rating == "all"             # 미전송 → 보존
    assert event.homepage_url == "https://old.example.com"  # 미전송 → 보존

    # 명시 빈값 = 삭제(read-after-write 정합)
    r2 = await client.patch(
        f"/api/v1/internal/events/{event_id}",
        json={"homepage_url": "", "age_rating": ""},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r2.status_code == 200, r2.text
    await db_session.refresh(event)
    assert event.homepage_url is None
    assert event.age_rating is None


async def test_u1_total_seats_shrink_below_sold_blocked(client, db_session):
    """U1 정원 재sync: 판매/홀드된 좌석보다 작은 total_seats 축소는 409(과판매 방지)."""
    await _seed_organizer(db_session)
    h = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    created = await client.post(
        "/api/v1/internal/events", json=_event_body(total_seats=100), headers=h
    )
    event_id = uuid.UUID(created.json()["data"]["event_id"])

    # 티어 + 판매 좌석 3석 시드
    tier = SeatTier(event_id=event_id, name="R", capacity=100, base_price=10000)
    db_session.add(tier)
    await db_session.flush()
    for i in range(3):
        db_session.add(
            Seat(
                event_id=event_id, tier_id=tier.id, section="A", row_number=1,
                seat_number=i + 1, status=SeatStatus.SOLD,
            )
        )
    await db_session.commit()

    # 2석으로 축소 시도 → 409
    r = await client.patch(
        f"/api/v1/internal/events/{event_id}",
        json={"total_seats": 2},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 409, r.text


async def test_pause_resume_roundtrip(client, db_session):
    """go 'paused' = status-독립 sales_paused 플래그. 일시중지/재개가 read로 라운드트립.

    pause 시 status(approved)는 그대로 보존 → 재개=플래그 해제로 직전 상태 즉시 복원.
    """
    await _seed_organizer(db_session)
    h = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    created = await client.post(
        "/api/v1/internal/events", json=_event_body(status="approved"), headers=h
    )
    event_id = created.json()["data"]["event_id"]
    assert created.json()["data"]["status"] == "live"  # approved → live 투영

    # 일시중지: sales_paused=true, status는 안 보냄
    r = await client.patch(
        f"/api/v1/internal/events/{event_id}",
        json={"sales_paused": True},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    body = r.json()["data"]
    assert body["status"] == "paused"          # go 투영이 paused로 덮임
    assert body["status_v2"] == "approved"     # 원본 상태는 보존
    assert body["sales_paused"] is True

    # read 라운드트립
    g = await client.get(f"/api/v1/internal/events/{event_id}", headers=_HDR)
    assert g.json()["data"]["status"] == "paused"
    assert g.json()["data"]["status_v2"] == "approved"

    # 목록 필터: status=paused 는 잡히고 status=live 에선 제외
    lst_p = await client.get("/api/v1/internal/organizers/go_org_1/events?status=paused", headers=_HDR)
    assert any(e["event_id"] == event_id for e in lst_p.json()["data"]["events"])
    lst_l = await client.get("/api/v1/internal/organizers/go_org_1/events?status=live", headers=_HDR)
    assert all(e["event_id"] != event_id for e in lst_l.json()["data"]["events"])

    # 재개: 직전 상태(approved=live) 즉시 복원
    r2 = await client.patch(
        f"/api/v1/internal/events/{event_id}",
        json={"sales_paused": False},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r2.json()["data"]["status"] == "live"
    assert r2.json()["data"]["sales_paused"] is False


async def test_patch_event_not_found(client, db_session):
    r = await client.patch(
        f"/api/v1/internal/events/{uuid.uuid4()}",
        json={"title": "x"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "EVENT_NOT_FOUND"


# ── fee-plan (§2.7 정률+정액) ────────────────────────────────────────────


async def test_event_fee_plan_writes_fixed(client, db_session):
    """go 기본 3% + ₩300 정액을 FeeSchedule 에 미러."""
    await _seed_organizer(db_session)
    h = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    created = await client.post("/api/v1/internal/events", json=_event_body(), headers=h)
    event_id = created.json()["data"]["event_id"]

    r = await client.put(
        f"/api/v1/internal/events/{event_id}/fee-plan",
        json={
            "fee_type": "percentage_plus_fixed",
            "platform_fee_rate": 0.03,
            "platform_fee_fixed": 300,
            "pg_fee_rate": 0.025,
            "pg_fee_fixed": 0,
        },
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["fee_type"] == "percentage_plus_fixed"

    fs = (
        await db_session.execute(
            select(FeeSchedule).where(FeeSchedule.event_id == uuid.UUID(event_id))
        )
    ).scalar_one()
    assert fs.fee_type == "percentage_plus_fixed"
    assert float(fs.platform_fee_fixed) == 300.0
    assert float(fs.platform_fee_rate) == 0.03


async def test_fee_plan_computes_fixed_inclusive_fee():
    """compute_fees: percentage_plus_fixed = total*rate + fixed (정액 유실 방지)."""
    from app.services.finance_service import FinanceService
    from decimal import Decimal

    comp = {
        "fee_type": "percentage_plus_fixed",
        "platform_fee_rate": 0.03,
        "platform_fee_fixed": 300,
        "pg_fee_rate": 0.025,
        "pg_fee_fixed": 0,
    }
    platform, pg = FinanceService.compute_fees(10000, comp)
    assert platform == Decimal("600")  # 10000*0.03 + 300
    assert pg == Decimal("250")  # 10000*0.025 + 0


# ── 이벤트 read (§5 — 엔티티 단위 cutover, go live read) ──────────────────


async def test_get_event_projects_go_status(client, db_session):
    await _seed_organizer(db_session)
    h = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    created = await client.post(
        "/api/v1/internal/events", json=_event_body(status="approved"), headers=h
    )
    event_id = created.json()["data"]["event_id"]

    r = await client.get(f"/api/v1/internal/events/{event_id}", headers=_HDR)
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    # approved → go 4-상태 투영 = live (status_v2 는 원본).
    assert data["status"] == "live"
    assert data["status_v2"] == "approved"
    assert data["external_ref"] == "go_evt_1"
    assert data["sale_window"]["opens_at"].startswith("2026-07-01T10:00:00")
    assert "summary" in data and data["summary"]["tier_count"] == 0
    assert r.headers.get("Cache-Control") == "private, max-age=5"


async def test_get_event_not_found(client, db_session):
    r = await client.get(f"/api/v1/internal/events/{uuid.uuid4()}", headers=_HDR)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "EVENT_NOT_FOUND"


async def test_get_event_requires_token(client, db_session):
    r = await client.get(f"/api/v1/internal/events/{uuid.uuid4()}")
    assert r.status_code == 401


async def test_list_organizer_events_by_go_account(client, db_session):
    await _seed_organizer(db_session)
    for i in range(3):
        h = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
        await client.post(
            "/api/v1/internal/events",
            json=_event_body(external_ref=f"go_evt_{i}", title=f"행사{i}"),
            headers=h,
        )
    r = await client.get("/api/v1/internal/organizers/go_org_1/events", headers=_HDR)
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["total"] == 3
    assert len(data["events"]) == 3
    assert all(e["status"] == "draft" for e in data["events"])


async def test_list_organizer_events_status_filter(client, db_session):
    await _seed_organizer(db_session)
    # draft 1 + approved(=go live) 1
    h1 = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    await client.post(
        "/api/v1/internal/events", json=_event_body(external_ref="d1"), headers=h1
    )
    h2 = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    await client.post(
        "/api/v1/internal/events",
        json=_event_body(external_ref="l1", status="approved"),
        headers=h2,
    )
    r = await client.get(
        "/api/v1/internal/organizers/go_org_1/events?status=live", headers=_HDR
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["total"] == 1
    assert data["events"][0]["external_ref"] == "l1"

    # paused 는 v2 투영 없음 → 빈 목록
    r2 = await client.get(
        "/api/v1/internal/organizers/go_org_1/events?status=paused", headers=_HDR
    )
    assert r2.json()["data"]["total"] == 0


def test_event_status_projection_matches_contract():
    """v2 11-상태 투영이 contracts/event-status.ts V2_TO_GO_MAP 과 일치."""
    from app.api.v1.internal_commerce import _project_event_status, _EVENT_STATUS_V2_TO_GO

    assert len(_EVENT_STATUS_V2_TO_GO) == 11
    assert _project_event_status("approved") == "live"
    assert _project_event_status("completed") == "archived"
    assert _project_event_status("draft") == "draft"
    # 심사 상태는 보존한다(2026-07-27 실결함 — draft 로 뭉개면 주최자가 진행을 알 수 없다).
    assert _project_event_status("pending_review") == "pending_review"
    assert _project_event_status("revision_requested") == "rejected"
    assert set(_EVENT_STATUS_V2_TO_GO.values()) == {
        "draft", "pending_review", "rejected", "live", "archived",
    }


async def test_organizer_fee_plan_writes(client, db_session):
    user = await _seed_organizer(db_session)
    r = await client.put(
        "/api/v1/internal/organizers/fee-plan",
        json={
            "organizer_ref": {"go_account_id": "go_org_1"},
            "fee_type": "percentage",
            "platform_fee_rate": 0.05,
            "pg_fee_rate": 0.025,
        },
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    fs = (
        await db_session.execute(
            select(FeeSchedule).where(
                FeeSchedule.organizer_id == user.id, FeeSchedule.event_id.is_(None)
            )
        )
    ).scalar_one()
    assert fs.fee_type == "percentage"
    assert float(fs.platform_fee_rate) == 0.05


# ── helper: 이벤트 생성 → event_id ──────────────────────────────────────


async def _create_event(client, **over) -> str:
    h = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    r = await client.post("/api/v1/internal/events", json=_event_body(**over), headers=h)
    assert r.status_code == 200, r.text
    return r.json()["data"]["event_id"]


# ── Slice B: tiers / seats (write+read) ──────────────────────────────────


async def test_upsert_tiers_and_read(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [
            {"external_ref": "go_tier_vip", "name": "VIP", "capacity": 100,
             "base_price": 150000, "sale_mode": "fixed_fcfs"},
            {"external_ref": "go_tier_r", "name": "R", "capacity": 200,
             "base_price": 90000, "sale_mode": "point_lottery"},
        ]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    mapping = r.json()["data"]["tiers"]
    assert len(mapping) == 2
    assert all(m["tier_id"] for m in mapping)

    lst = await client.get(f"/api/v1/internal/events/{eid}/tiers", headers=_HDR)
    assert lst.status_code == 200
    data = lst.json()["data"]
    assert data["total"] == 2
    vip = next(t for t in data["tiers"] if t["external_ref"] == "go_tier_vip")
    assert vip["capacity"] == 100
    assert vip["fill_rate"] == 0.0
    assert lst.headers.get("Cache-Control") == "private, max-age=5"


async def test_upsert_tiers_invalid_sale_mode(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [{"external_ref": "x", "name": "X", "capacity": 10,
                         "base_price": 1000, "sale_mode": "dutch_auction"}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "INVALID_SALE_MODE"


async def test_tiers_idempotent_upsert_by_external_ref(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    # 같은 external_ref 두 번(다른 멱등키) → 한 tier 만 존재(upsert).
    for cap in (100, 150):
        await client.post(
            f"/api/v1/internal/events/{eid}/tiers",
            json={"tiers": [{"external_ref": "go_tier_a", "name": "A", "capacity": cap,
                             "base_price": 1000, "sale_mode": "fixed_fcfs"}]},
            headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
        )
    cnt = (
        await db_session.execute(
            select(func.count()).select_from(SeatTier).where(SeatTier.event_id == uuid.UUID(eid))
        )
    ).scalar()
    assert cnt == 1
    tier = (
        await db_session.execute(select(SeatTier).where(SeatTier.external_ref == "go_tier_a"))
    ).scalar_one()
    assert tier.capacity == 150  # 두 번째 값으로 갱신


async def test_upsert_seats_resolves_tier_ref_and_protects_sold(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [{"external_ref": "go_tier_vip", "name": "VIP", "capacity": 100,
                         "base_price": 150000, "sale_mode": "fixed_fcfs"}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    r = await client.post(
        f"/api/v1/internal/events/{eid}/seats",
        json={"seats": [
            {"external_ref": "go_seat_1", "tier_ref": "go_tier_vip", "section": "A",
             "row_number": 1, "seat_number": 1},
            {"external_ref": "go_seat_2", "tier_ref": "go_tier_vip", "section": "A",
             "row_number": 1, "seat_number": 2, "status": "reserved"},
        ]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["created"] == 2

    # seat_2 를 SOLD 로 만든 뒤 재 upsert → 보호되어 status 유지.
    seat2 = (
        await db_session.execute(select(Seat).where(Seat.external_ref == "go_seat_2"))
    ).scalar_one()
    seat2.status = SeatStatus.SOLD
    await db_session.commit()
    r2 = await client.post(
        f"/api/v1/internal/events/{eid}/seats",
        json={"seats": [{"external_ref": "go_seat_2", "tier_ref": "go_tier_vip",
                         "section": "A", "row_number": 1, "seat_number": 2, "status": "available"}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r2.json()["data"]["protected"] == 1
    await db_session.refresh(seat2)
    assert seat2.status == SeatStatus.SOLD  # 덮어쓰기 안 됨

    # 좌석 목록 read + 상태 집계
    lst = await client.get(f"/api/v1/internal/events/{eid}/seats", headers=_HDR)
    counts = lst.json()["data"]["status_counts"]
    assert counts.get("sold") == 1


async def test_upsert_seats_replace_prunes_scoped_and_protects_sold(client, db_session):
    """레벨2 컷오버 T1 — replace 로 레이아웃 축소를 표현한다.

    go `seats` 스테이징이 사라지면서 빌더는 "DELETE 후 재INSERT" 로 좌석 삭제를 표현할 수 없다.
    대신 replace=true + scope_prefix(맵 단위)로 v2 가 없어진 좌석을 정리한다.
    검증: ①페이로드에 없는 같은 맵 좌석은 삭제 ②SOLD 는 보호 ③scope 밖(다른 맵/레거시 ref)은 보존.
    """
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [{"external_ref": "go_tier_vip", "name": "VIP", "capacity": 100,
                         "base_price": 150000, "sale_mode": "fixed_fcfs"}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )

    def seat(ref, num):
        return {"external_ref": ref, "tier_ref": "go_tier_vip", "section": "A",
                "row_number": 1, "seat_number": num}

    # 맵A 좌석 3개 + 맵B 좌석 1개 + 레거시(prefix 없는) 좌석 1개.
    r = await client.post(
        f"/api/v1/internal/events/{eid}/seats",
        json={"seats": [
            seat("smseat:mapA:aaa1", 1),
            seat("smseat:mapA:aaa2", 2),
            seat("smseat:mapA:aaa3", 3),
            seat("smseat:mapB:bbb1", 4),
            seat("legacy-uuid-ref", 5),
        ]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["created"] == 5

    # 맵A 의 3번 좌석을 SOLD 로 → replace 대상이어도 삭제되면 안 된다.
    sold = (
        await db_session.execute(select(Seat).where(Seat.external_ref == "smseat:mapA:aaa3"))
    ).scalar_one()
    sold.status = SeatStatus.SOLD
    await db_session.commit()

    # 맵A 를 좌석 1개짜리 레이아웃으로 축소 저장(aaa1 만 남김).
    r2 = await client.post(
        f"/api/v1/internal/events/{eid}/seats",
        json={"seats": [seat("smseat:mapA:aaa1", 1)],
              "replace": True, "scope_prefix": "smseat:mapA:"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["data"]["deleted"] == 1  # aaa2 만 삭제(aaa3 은 SOLD 보호)

    refs = set(
        (await db_session.execute(select(Seat.external_ref).where(Seat.event_id == uuid.UUID(eid))))
        .scalars().all()
    )
    assert "smseat:mapA:aaa1" in refs      # 유지
    assert "smseat:mapA:aaa2" not in refs  # 정리됨
    assert "smseat:mapA:aaa3" in refs      # SOLD 보호
    assert "smseat:mapB:bbb1" in refs      # 다른 맵 — scope 밖
    assert "legacy-uuid-ref" in refs       # prefix 없는 레거시 — scope 밖


async def test_upsert_seats_replace_allows_empty_payload(client, db_session):
    """replace=true 면 빈 좌석 리스트 허용 — 배치도 삭제/스탠딩 전용 전환 시 전량 정리."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [{"external_ref": "t1", "name": "일반", "capacity": 10,
                         "base_price": 1000, "sale_mode": "fixed_fcfs"}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    await client.post(
        f"/api/v1/internal/events/{eid}/seats",
        json={"seats": [{"external_ref": "smseat:mapA:x1", "tier_ref": "t1",
                         "section": "A", "row_number": 1, "seat_number": 1}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    r = await client.post(
        f"/api/v1/internal/events/{eid}/seats",
        json={"seats": [], "replace": True, "scope_prefix": "smseat:mapA:"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["deleted"] == 1

    # replace 없이 빈 리스트는 여전히 거부(의미 없는 호출 차단).
    bad = await client.post(
        f"/api/v1/internal/events/{eid}/seats",
        json={"seats": []},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert bad.status_code == 422


async def test_upsert_seats_returns_seat_id_mapping(client, db_session):
    """flip E2E: 좌석 응답에 seat_id 매핑(go 가 v2_seat_id 앵커)."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [{"external_ref": "t", "name": "A", "capacity": 100,
                         "base_price": 1000, "sale_mode": "fixed_fcfs"}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    r = await client.post(
        f"/api/v1/internal/events/{eid}/seats",
        json={"seats": [
            {"external_ref": "s1", "tier_ref": "t", "section": "A", "row_number": 1, "seat_number": 1},
            {"external_ref": "s2", "tier_ref": "t", "section": "A", "row_number": 1, "seat_number": 2},
        ]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    seats = r.json()["data"]["seats"]
    assert len(seats) == 2
    by_ref = {s["external_ref"]: s for s in seats}
    assert by_ref["s1"]["seat_id"] and by_ref["s1"]["section"] == "A"
    # 반환된 seat_id 가 실제 DB 좌석과 일치
    sid = uuid.UUID(by_ref["s1"]["seat_id"])
    assert (await db_session.get(Seat, sid)) is not None


async def test_internal_confirm_payment(client, db_session):
    """manual/group 주문 internal 결제확정 → CONFIRMED + 티켓 ACTIVE, 멱등."""
    from app.models.order import Order, OrderStatus
    from app.models.ticket import Ticket, TicketStatus

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "manual1", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    oid = r.json()["data"]["order_id"]
    c = await client.post(f"/api/v1/internal/orders/{oid}/confirm-payment",
                          json={"source": "manual", "amount": 50000}, headers=_HDR)
    assert c.status_code == 200, c.text
    assert c.json()["data"]["status"] == "confirmed"
    order = await db_session.get(Order, uuid.UUID(oid))
    await db_session.refresh(order)
    assert order.status == OrderStatus.CONFIRMED
    assert order.captured_at is not None
    tks = (await db_session.execute(select(Ticket).where(Ticket.purchase_order_id == order.id))).scalars().all()
    assert all(t.status == TicketStatus.ACTIVE for t in tks)
    # 멱등 재호출
    c2 = await client.post(f"/api/v1/internal/orders/{oid}/confirm-payment", json={}, headers=_HDR)
    assert c2.json()["data"]["already"] is True


async def test_internal_confirm_payment_blocks_unverified_card_discount(client, db_session):
    """🔴 카드사 할인 주문은 수기/무통장 확정으로 우회될 수 없다.

    이 엔드포인트엔 PG 승인 응답이 없어 T15 카드사 재검증이 아예 돌지 않는다.
    막지 않으면 "체크아웃에서 BC 선택 → 무통장입금 완료 → 주최자 입금확정" 으로
    **카드를 한 장도 안 내고 10% 할인**을 받는다.
    """
    from app.models.order import Order, OrderStatus

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "bcbypass1", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    oid = r.json()["data"]["order_id"]
    order = await db_session.get(Order, uuid.UUID(oid))
    # 할인은 적용됐고(card_discount), 카드사 확인 기록은 없다(card_issuer 부재) = 미검증 상태.
    order.payment_metadata = {"card_discount": {"card": "BC", "card_code": "01", "rate": 10}}
    await db_session.commit()

    c = await client.post(f"/api/v1/internal/orders/{oid}/confirm-payment",
                          json={"source": "manual", "amount": 50000}, headers=_HDR)
    assert c.status_code == 422, c.text
    assert c.json()["error"]["code"] == "CARD_DISCOUNT_UNVERIFIED"
    await db_session.refresh(order)
    assert order.status != OrderStatus.CONFIRMED, "차단됐는데 주문이 확정됐다"

    # T15 가 카드사를 확인해 기록한 주문은 정상 확정된다(과잉차단 아님).
    order.payment_metadata = {**order.payment_metadata, "card_issuer": {"code": "01", "name": "비씨"}}
    await db_session.commit()
    c2 = await client.post(f"/api/v1/internal/orders/{oid}/confirm-payment",
                           json={"source": "manual", "amount": 50000}, headers=_HDR)
    assert c2.status_code == 200, c2.text
    assert c2.json()["data"]["status"] == "confirmed"


async def test_internal_refund_writes_refund_ledger(client, db_session):
    """write-through 환불도 표준 환불 원장(Refund 레코드)을 생성해야 한다 (M-3, Major #5).

    수정 전: total_refunded 만 증가하고 Refund row 가 없어 재무 대시보드 환불 합계와
    정산서 환불 합계가 불일치(대사 추적 불가). 수정 후: Refund(COMPLETED) row 생성.
    """
    from app.models.order import Order, OrderStatus
    from app.models.refund import Refund, RefundItem, RefundStatus, RefundType

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "refund1", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    oid = r.json()["data"]["order_id"]
    await client.post(f"/api/v1/internal/orders/{oid}/confirm-payment",
                      json={"source": "manual", "amount": 50000}, headers=_HDR)

    # 부분 환불(write-through)
    rf = await client.post(
        f"/api/v1/internal/orders/{oid}/refund",
        json={"amount": 20000, "reason": "고객 부분 환불"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert rf.status_code == 200, rf.text

    order = await db_session.get(Order, uuid.UUID(oid))
    await db_session.refresh(order)
    assert order.status == OrderStatus.PARTIALLY_REFUNDED
    assert float(order.total_refunded) == 20000.0

    # Refund 원장 row 존재 + 금액·상태 정합
    refunds = (
        await db_session.execute(select(Refund).where(Refund.order_id == order.id))
    ).scalars().all()
    assert len(refunds) == 1
    refund = refunds[0]
    assert refund.status == RefundStatus.COMPLETED.value or refund.status == RefundStatus.COMPLETED
    assert refund.refund_type == RefundType.PARTIAL.value or refund.refund_type == RefundType.PARTIAL
    assert float(refund.amount) == 20000.0
    assert refund.initiated_by == "system"
    assert refund.processed_at is not None

    # 이후 전액(잔여) 환불 → REFUNDED + 두 번째 Refund(full) + RefundItem(티켓단위)
    rf2 = await client.post(
        f"/api/v1/internal/orders/{oid}/refund",
        json={"full": True, "reason": "잔여 전액 환불"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert rf2.status_code == 200, rf2.text
    await db_session.refresh(order)
    assert order.status == OrderStatus.REFUNDED
    refunds = (
        await db_session.execute(select(Refund).where(Refund.order_id == order.id))
    ).scalars().all()
    assert len(refunds) == 2
    full_refund = [x for x in refunds if float(x.amount) == 30000.0][0]
    items = (
        await db_session.execute(select(RefundItem).where(RefundItem.refund_id == full_refund.id))
    ).scalars().all()
    assert len(items) == 1


async def test_internal_confirm_payment_amount_mismatch(client, db_session):
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "m2", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    oid = r.json()["data"]["order_id"]
    c = await client.post(f"/api/v1/internal/orders/{oid}/confirm-payment",
                          json={"amount": 49999}, headers=_HDR)
    assert c.status_code == 400
    assert c.json()["error"]["code"] == "AMOUNT_MISMATCH"


async def test_seats_unresolved_tier(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await client.post(
        f"/api/v1/internal/events/{eid}/seats",
        json={"seats": [{"external_ref": "s1", "tier_ref": "nonexistent",
                         "section": "A", "row_number": 1, "seat_number": 1}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "TIER_NOT_FOUND"


# ── Slice C: content (write+read) ────────────────────────────────────────


async def test_put_and_get_content(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await client.put(
        f"/api/v1/internal/events/{eid}/content",
        json={
            "participants": [{"name": "아이유", "role": "주연", "sort_order": 1}],
            "notices": [{"title": "공지", "content": "입장 안내"}],
            "facilities": [{"name": "주차장", "quantity": 100}],
        },
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["counts"] == {"participants": 1, "notices": 1, "facilities": 1}

    g = await client.get(f"/api/v1/internal/events/{eid}/content", headers=_HDR)
    data = g.json()["data"]
    assert data["participants"][0]["name"] == "아이유"
    assert data["notices"][0]["title"] == "공지"
    assert data["facilities"][0]["name"] == "주차장"


async def test_put_content_replaces(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    for names in (["A", "B"], ["C"]):
        await client.put(
            f"/api/v1/internal/events/{eid}/content",
            json={"participants": [{"name": n} for n in names]},
            headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
        )
    g = await client.get(f"/api/v1/internal/events/{eid}/content", headers=_HDR)
    parts = g.json()["data"]["participants"]
    assert [p["name"] for p in parts] == ["C"]  # 전체 교체


# ── Slice D: discount codes (write+read) ─────────────────────────────────


async def test_upsert_and_read_discount_codes(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await client.post(
        f"/api/v1/internal/events/{eid}/discount-codes",
        json={"codes": [
            {"code": "EARLY10", "discount_type": "percentage", "rate": 10, "max_uses": 100},
            {"code": "FLAT5000", "discount_type": "fixed", "amount": 5000},
        ]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    assert len(r.json()["data"]["codes"]) == 2

    g = await client.get(f"/api/v1/internal/events/{eid}/discount-codes", headers=_HDR)
    data = g.json()["data"]
    assert data["total"] == 2
    early = next(c for c in data["codes"] if c["code"] == "EARLY10")
    assert early["used_count"] == 0
    assert early["max_uses"] == 100


async def test_discount_upsert_preserves_used_count(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await client.post(
        f"/api/v1/internal/events/{eid}/discount-codes",
        json={"codes": [{"code": "X", "discount_type": "percentage", "rate": 10}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    code = (
        await db_session.execute(select(DiscountCode).where(DiscountCode.code == "X"))
    ).scalar_one()
    code.used_count = 7  # 주문으로 차감됐다고 가정
    await db_session.commit()
    # go 재push → used_count 보존(go 가 보내지 않음).
    await client.post(
        f"/api/v1/internal/events/{eid}/discount-codes",
        json={"codes": [{"code": "X", "discount_type": "percentage", "rate": 20}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    await db_session.refresh(code)
    assert code.used_count == 7
    assert code.rate == 20


# ── 1-Sync: 안정 멱등키 재편집 반영(fingerprint) ─────────────────────────
# go 는 discount(promo-code:{id})·content(content.{section}.{eventId}.patch.{itemId}) 를
# 안정 멱등키로 재PUT 한다. fingerprint 없으면 값 변경(재편집)이 옛 응답 replay 로 v2 에
# 미반영되던 갭(1-Sync). 아래 테스트는 "같은 키 + 다른 body → 재편집 반영"을 실증한다.


async def test_discount_reedit_same_idem_key_applies(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    stable_key = "promo-code:go_promo_1"  # go syncDiscountCode 의 안정 멱등키 형태
    # 1차 생성
    r1 = await client.post(
        f"/api/v1/internal/events/{eid}/discount-codes",
        json={"codes": [{"code": "SALE", "discount_type": "percentage", "rate": 10}]},
        headers={**_HDR, "Idempotency-Key": stable_key},
    )
    assert r1.status_code == 200
    assert r1.json()["idempotent_replay"] is False
    # 2차 재편집(같은 키, rate 변경) → replay 아니라 실제 반영돼야 함.
    r2 = await client.post(
        f"/api/v1/internal/events/{eid}/discount-codes",
        json={"codes": [{"code": "SALE", "discount_type": "percentage", "rate": 25}]},
        headers={**_HDR, "Idempotency-Key": stable_key},
    )
    assert r2.status_code == 200
    assert r2.json()["idempotent_replay"] is False  # fingerprint 상이 → 재실행
    code = (
        await db_session.execute(select(DiscountCode).where(DiscountCode.code == "SALE"))
    ).scalar_one()
    await db_session.refresh(code)
    assert code.rate == 25  # 재편집 반영


async def test_discount_reedit_same_body_replays(client, db_session):
    """동일 키 + 동일 body 정상 재시도는 여전히 replay(멱등 보존)."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    stable_key = "promo-code:go_promo_2"
    body = {"codes": [{"code": "KEEP", "discount_type": "fixed", "amount": 3000}]}
    r1 = await client.post(
        f"/api/v1/internal/events/{eid}/discount-codes", json=body,
        headers={**_HDR, "Idempotency-Key": stable_key},
    )
    r2 = await client.post(
        f"/api/v1/internal/events/{eid}/discount-codes", json=body,
        headers={**_HDR, "Idempotency-Key": stable_key},
    )
    assert r1.json()["idempotent_replay"] is False
    assert r2.json()["idempotent_replay"] is True  # body 동일 → 멱등 replay


async def test_content_reedit_same_idem_key_applies(client, db_session):
    """출연진 단건 재편집: 같은 안정 키로 섹션 재PUT(값 변경) → v2 반영(1-Sync)."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    stable_key = f"content.participants.{eid}.patch.go_part_1"
    # 1차: 출연진 bio 초기값
    await client.put(
        f"/api/v1/internal/events/{eid}/content",
        json={"participants": [{"name": "아이유", "role": "주연", "bio": "초안"}]},
        headers={**_HDR, "Idempotency-Key": stable_key},
    )
    # 2차: 같은 출연진 bio 재편집(같은 키) → 반영돼야 함.
    r2 = await client.put(
        f"/api/v1/internal/events/{eid}/content",
        json={"participants": [{"name": "아이유", "role": "주연", "bio": "수정본"}]},
        headers={**_HDR, "Idempotency-Key": stable_key},
    )
    assert r2.json()["idempotent_replay"] is False
    g = await client.get(f"/api/v1/internal/events/{eid}/content", headers=_HDR)
    assert g.json()["data"]["participants"][0]["bio"] == "수정본"


async def test_tiers_reedit_same_idem_key_applies(client, db_session):
    """product/tier 편집: 안정 키(product-tier:{id})로 base_price 변경 → v2 반영(1-Sync)."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    stable_key = "product-tier:go_product_1"
    await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [{"external_ref": "go_p1", "name": "일반", "capacity": 50,
                         "base_price": 30000, "sale_mode": "fixed_fcfs"}]},
        headers={**_HDR, "Idempotency-Key": stable_key},
    )
    r2 = await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [{"external_ref": "go_p1", "name": "일반", "capacity": 50,
                         "base_price": 45000, "sale_mode": "fixed_fcfs"}]},
        headers={**_HDR, "Idempotency-Key": stable_key},
    )
    assert r2.json()["idempotent_replay"] is False
    tier = (
        await db_session.execute(select(SeatTier).where(SeatTier.external_ref == "go_p1"))
    ).scalar_one()
    await db_session.refresh(tier)
    assert float(tier.base_price) == 45000  # 재편집 반영


# ── Slice A read 집계 보강 (order_count/attendee_count/revenue) ──────────


async def test_event_read_aggregates(client, db_session):
    from app.models.order import Order, OrderStatus
    from app.models.ticket import Ticket, TicketStatus

    user = await _seed_organizer(db_session)
    eid = await _create_event(client)
    euid = uuid.UUID(eid)
    tier = SeatTier(event_id=euid, name="GA", capacity=1000, base_price=100000,
                    sale_mode="fixed_fcfs")
    db_session.add(tier)
    await db_session.flush()
    # 확정주문 2건(매출 대상) + 미결제 1건(매출 제외)
    db_session.add(Order(user_id=user.id, event_id=euid, quantity=1,
                         unit_price=100000, total_amount=100000, status=OrderStatus.CONFIRMED))
    db_session.add(Order(user_id=user.id, event_id=euid, quantity=1,
                         unit_price=50000, total_amount=50000, status=OrderStatus.PAID))
    db_session.add(Order(user_id=user.id, event_id=euid, quantity=1,
                         unit_price=999, total_amount=999, status=OrderStatus.PAYMENT_REQUIRED))
    db_session.add(Ticket(event_id=euid, tier_id=tier.id, current_owner_id=user.id,
                          purchase_price=100000, sale_mode="fixed_fcfs",
                          status=TicketStatus.ACTIVE))
    await db_session.commit()

    r = await client.get(f"/api/v1/internal/events/{eid}", headers=_HDR)
    s = r.json()["data"]["summary"]
    assert s["order_count"] == 3
    assert s["attendee_count"] == 1
    assert s["total_revenue"] == 150000.0  # 미결제 999 제외

    lst = await client.get("/api/v1/internal/organizers/go_org_1/events", headers=_HDR)
    ev = lst.json()["data"]["events"][0]
    assert ev["order_count"] == 3
    assert ev["revenue"] == 150000.0
    assert ev["attendee_count"] == 1


# ── 감사 수정 회귀 방지 ──────────────────────────────────────────────────


async def test_attendee_count_excludes_cancelled(client, db_session):
    """IMPORTANT-2: 취소 티켓은 attendee_count 에서 제외."""
    from app.models.order import Order, OrderStatus
    from app.models.ticket import Ticket, TicketStatus

    user = await _seed_organizer(db_session)
    eid = await _create_event(client)
    euid = uuid.UUID(eid)
    tier = SeatTier(event_id=euid, name="GA", capacity=100, base_price=1000, sale_mode="fixed_fcfs")
    db_session.add(tier)
    await db_session.flush()
    db_session.add(Ticket(event_id=euid, tier_id=tier.id, current_owner_id=user.id,
                          purchase_price=1000, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE))
    db_session.add(Ticket(event_id=euid, tier_id=tier.id, current_owner_id=user.id,
                          purchase_price=1000, sale_mode="fixed_fcfs", status=TicketStatus.CANCELLED))
    await db_session.commit()
    r = await client.get(f"/api/v1/internal/events/{eid}", headers=_HDR)
    assert r.json()["data"]["summary"]["attendee_count"] == 1  # CANCELLED 제외


async def test_event_revenue_and_refund_separated(client, db_session):
    """CRITICAL-1 완화: revenue=gross, refund_amount 별도 노출."""
    from app.models.order import Order, OrderStatus

    user = await _seed_organizer(db_session)
    eid = await _create_event(client)
    euid = uuid.UUID(eid)
    db_session.add(Order(user_id=user.id, event_id=euid, quantity=1, unit_price=100000,
                         total_amount=100000, total_refunded=30000,
                         status=OrderStatus.PARTIALLY_REFUNDED))
    await db_session.commit()
    r = await client.get(f"/api/v1/internal/events/{eid}", headers=_HDR)
    s = r.json()["data"]["summary"]
    assert s["total_revenue"] == 100000.0  # gross
    assert s["refund_amount"] == 30000.0   # 별도 — go 가 net=70000 표시


async def test_organizer_fee_plan_idempotency_scoped(client, db_session):
    """IMPORTANT-1: 같은 Idempotency-Key 라도 organizer 다르면 각각 기록."""
    u1 = await _seed_organizer(db_session, go_account_id="org_A")
    u2 = await _seed_organizer(db_session, go_account_id="org_B")
    key = str(uuid.uuid4())
    for acc in ("org_A", "org_B"):
        r = await client.put(
            "/api/v1/internal/organizers/fee-plan",
            json={"organizer_ref": {"go_account_id": acc}, "fee_type": "percentage",
                  "platform_fee_rate": 0.05, "pg_fee_rate": 0.025},
            headers={**_HDR, "Idempotency-Key": key},  # 동일 키
        )
        assert r.status_code == 200, r.text
    # 두 organizer 모두 FeeSchedule 가 생겨야(키 충돌로 B가 누락되면 안 됨).
    for uid in (u1.id, u2.id):
        fs = (await db_session.execute(
            select(FeeSchedule).where(FeeSchedule.organizer_id == uid, FeeSchedule.event_id.is_(None))
        )).scalar_one_or_none()
        assert fs is not None


async def test_tier_capacity_shrink_below_sold_409(client, db_session):
    """SPEC §2.2 / H-1: 판매분보다 작은 capacity 축소 시 409."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [{"external_ref": "t1", "name": "A", "capacity": 100,
                         "base_price": 1000, "sale_mode": "fixed_fcfs"}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    # GA tier sold_count 를 50으로 설정
    tier = (await db_session.execute(select(SeatTier).where(SeatTier.external_ref == "t1"))).scalar_one()
    tier.sold_count = 50
    await db_session.commit()
    r = await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [{"external_ref": "t1", "name": "A", "capacity": 30,
                         "base_price": 1000, "sale_mode": "fixed_fcfs"}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "CONFLICT"


async def test_tiers_upsert_syncs_event_total_seats(client, db_session):
    """M-4: tier capacity 합으로 event.total_seats 동기화(placeholder 1 보정)."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)  # total_seats 미전송 → 1
    await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [
            {"external_ref": "a", "name": "A", "capacity": 100, "base_price": 1, "sale_mode": "fixed_fcfs"},
            {"external_ref": "b", "name": "B", "capacity": 200, "base_price": 1, "sale_mode": "fixed_fcfs"},
        ]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    ev = await db_session.get(Event, uuid.UUID(eid))
    await db_session.refresh(ev)
    assert ev.total_seats == 300


async def test_create_duplicate_slug_returns_409_not_500(client, db_session):
    """P1-2: 명시 slug 충돌은 깔끔한 409(IntegrityError→500 아님)."""
    await _seed_organizer(db_session)
    body = _event_body(external_ref=None, slug="dup-slug")
    r1 = await client.post("/api/v1/internal/events", json=body,
                           headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r1.status_code == 200, r1.text
    r2 = await client.post("/api/v1/internal/events", json=body,
                           headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r2.status_code == 409
    assert r2.json()["error"]["code"] == "CONFLICT"


async def test_patch_idempotency_distinguishes_body(client, db_session):
    """P1-1: 같은 Idempotency-Key+다른 body 는 옛 응답 재생 안 함."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    key = str(uuid.uuid4())
    await client.patch(f"/api/v1/internal/events/{eid}",
                       json={"title": "첫번째"}, headers={**_HDR, "Idempotency-Key": key})
    await client.patch(f"/api/v1/internal/events/{eid}",
                       json={"title": "두번째"}, headers={**_HDR, "Idempotency-Key": key})
    ev = await db_session.get(Event, uuid.UUID(eid))
    await db_session.refresh(ev)
    assert ev.title == "두번째"  # 다른 body 가 실제 적용됨(stale 재생 아님)


def test_finance_summary_uses_frozen_fixed_fee():
    """CRITICAL-3: finance 집계가 동결값(정액 포함)을 사용."""
    from app.services.finance_service import FinanceService
    from decimal import Decimal
    # compute_fees 가 정액 포함하는지 + 동결 우선 경로 단위 검증
    comp = {"fee_type": "percentage_plus_fixed", "platform_fee_rate": 0.03,
            "platform_fee_fixed": 300, "pg_fee_rate": 0.025, "pg_fee_fixed": 0}
    plat, pg = FinanceService.compute_fees(10000, comp)
    assert plat == Decimal("600")


async def test_seat_upsert_returns_protected_refs(client, db_session):
    """결함7: SOLD/HELD 로 재배치 무시된 좌석 external_ref 를 응답에 포함."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [{"external_ref": "t", "name": "A", "capacity": 100,
                         "base_price": 1000, "sale_mode": "fixed_fcfs"}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    await client.post(
        f"/api/v1/internal/events/{eid}/seats",
        json={"seats": [{"external_ref": "s1", "tier_ref": "t", "section": "A",
                         "row_number": 1, "seat_number": 1}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    s1 = (await db_session.execute(select(Seat).where(Seat.external_ref == "s1"))).scalar_one()
    s1.status = SeatStatus.SOLD
    await db_session.commit()
    r = await client.post(
        f"/api/v1/internal/events/{eid}/seats",
        json={"seats": [{"external_ref": "s1", "tier_ref": "t", "section": "B",
                         "row_number": 9, "seat_number": 9}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.json()["data"]["protected_refs"] == ["s1"]


# ── Wave3 W3.1: affiliates (write+read) ──────────────────────────────────


async def test_affiliates_upsert_and_read(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await client.put(
        f"/api/v1/internal/events/{eid}/affiliates",
        json={"affiliates": [
            {"external_ref": "go_aff_1", "account_id": "acc1", "name": "인플루언서A",
             "code": "INFLU_A", "commission_rate": 10.0},
        ]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["affiliates"][0]["code"] == "INFLU_A"

    g = await client.get(f"/api/v1/internal/events/{eid}/affiliates", headers=_HDR)
    data = g.json()["data"]
    assert data["total"] == 1
    assert data["affiliates"][0]["commission_rate"] == 10.0


async def test_affiliates_invalid_commission(client, db_session):
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await client.put(
        f"/api/v1/internal/events/{eid}/affiliates",
        json={"affiliates": [{"name": "X", "code": "X", "commission_rate": 150}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 400
    assert r.json()["error"]["field"] == "commission_rate"


# ── Wave3 W3.1: ticket check-in (상태=v2 SoT, 멱등) ──────────────────────


async def test_ticket_check_in_idempotent(client, db_session):
    from app.models.ticket import Ticket, TicketStatus

    user = await _seed_organizer(db_session)
    eid = await _create_event(client)
    euid = uuid.UUID(eid)
    tier = SeatTier(event_id=euid, name="GA", capacity=10, base_price=1000, sale_mode="fixed_fcfs")
    db_session.add(tier)
    await db_session.flush()
    t = Ticket(event_id=euid, tier_id=tier.id, current_owner_id=user.id,
               purchase_price=1000, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE)
    db_session.add(t)
    await db_session.commit()

    r1 = await client.post(f"/api/v1/internal/tickets/{t.id}/check-in", json={},
                           headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r1.status_code == 200, r1.text
    assert r1.json()["data"]["status"] == "used"
    assert r1.json()["data"]["already"] is False

    # 재스캔(다른 멱등키) → already=True, 시각 보존
    r2 = await client.post(f"/api/v1/internal/tickets/{t.id}/check-in", json={},
                           headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r2.json()["data"]["already"] is True
    # 같은 시각 보존(SQLite 는 tz suffix 를 떨궈 포맷만 다를 수 있어 초단위까지 비교).
    assert r2.json()["data"]["checked_in_at"][:19] == r1.json()["data"]["checked_in_at"][:19]

    await db_session.refresh(t)
    assert t.status == TicketStatus.USED
    assert t.checked_in_at is not None
    # F1: 응답에 admission_mode·attended_date 확장(cross-request).
    assert r1.json()["data"]["admission_mode"] == "single"
    assert r1.json()["data"]["attended_date"] is not None


async def test_ticket_check_in_allpass_multi_day_http(client, db_session):
    """F1 핵심: allpass 티켓이 게이트(internal check-in)에서 day2 도 입장 성공(다일 붕괴 해소)."""
    from datetime import datetime, timedelta, timezone

    from app.models.event import Event
    from app.models.ticket import Ticket, TicketStatus

    KST = timezone(timedelta(hours=9))
    user = await _seed_organizer(db_session)
    eid = await _create_event(client)
    euid = uuid.UUID(eid)

    # 이벤트를 allpass·**어제~오늘** 로 조정(게이트 유효일 판정이 KST today 기준).
    # ⚠️ 2026-07-28: 종전엔 오늘~+3일로 잡고 day2 를 `at = now + 1일`(미래)로 눌렀는데,
    #    체크인 `at` 이 미래시각을 거부하게 되면서(F-4: 입장일 조작 차단) 그 방식이 막혔다.
    #    시간축을 **과거로** 옮겨 같은 성질(allpass 는 day2 에도 입장)을 검증한다 —
    #    미래로 건너뛰는 건 실제 게이트에서 성립할 수 없는 시나리오였다.
    ev = await db_session.get(Event, euid)
    today_kst = datetime.now(KST).date()
    ev.admission_mode = "allpass"
    ev.event_date = datetime(today_kst.year, today_kst.month, today_kst.day, 9, tzinfo=KST) - timedelta(days=1)
    ev.event_date_end = ev.event_date + timedelta(days=3)

    tier = SeatTier(event_id=euid, name="ALL", capacity=10, base_price=1000, sale_mode="fixed_fcfs")
    db_session.add(tier)
    await db_session.flush()
    t = Ticket(event_id=euid, tier_id=tier.id, current_owner_id=user.id,
               purchase_price=1000, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE)
    db_session.add(t)
    await db_session.commit()

    now = datetime.now(timezone.utc)
    day1 = now - timedelta(days=1)  # 어제 = 이벤트 1일차
    # day1 입장.
    r1 = await client.post(f"/api/v1/internal/tickets/{t.id}/check-in",
                           json={"at": day1.isoformat()},
                           headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r1.status_code == 200, r1.text
    assert r1.json()["data"]["already"] is False
    assert r1.json()["data"]["admission_mode"] == "allpass"

    # day1 재스캔 → already.
    r1b = await client.post(f"/api/v1/internal/tickets/{t.id}/check-in",
                            json={"at": day1.isoformat()},
                            headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r1b.json()["data"]["already"] is True

    # day2(=오늘) 입장 → 거부 안 됨(핵심). allpass 라 status ACTIVE 유지.
    r2 = await client.post(f"/api/v1/internal/tickets/{t.id}/check-in",
                           json={"at": now.isoformat()},
                           headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r2.status_code == 200, r2.text
    assert r2.json()["data"]["already"] is False
    assert r2.json()["data"]["status"] == "active"  # allpass 소진 안 함

    await db_session.refresh(t)
    assert t.status == TicketStatus.ACTIVE


# ── Wave3 W3.2: 원자 주문생성 ────────────────────────────────────────────


async def _seed_event_with_tier(client, db_session, *, capacity=100, sale_mode="fixed_fcfs",
                                tier_ref="t1"):
    # U4(판매게이트 SSOT): 주문을 받으려면 이벤트가 **판매가능 상태 + 판매창 개방**이어야
    # 한다(evaluate_purchase_gate). 발행된 self 이벤트를 재현 — go 'live'→v2 bidding_open,
    # 판매창은 과거~미래로 개방(now 포함). draft/판매창밖 fixture 는 더 이상 주문을 받지 않음.
    _now = datetime.now(timezone.utc)
    eid = await _create_event(
        client,
        status="live",
        sale_window={
            "opens_at": (_now - timedelta(days=1)).isoformat(),
            "closes_at": (_now + timedelta(days=7)).isoformat(),
        },
    )
    await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [{"external_ref": tier_ref, "name": "VIP", "capacity": capacity,
                         "base_price": 50000, "sale_mode": sale_mode}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    tier = (await db_session.execute(
        select(SeatTier).where(SeatTier.external_ref == tier_ref)
    )).scalar_one()
    return eid, tier


async def _enable_guest_checkout(
    db_session, eid, *, channels=("fixed_fcfs", "free")
):
    """상세통합 S2b(§2.2·§6.3): 이벤트에 게스트(비회원) 체크아웃 opt-in 을 켠다.

    게스트 주문은 opt-in 게이트를 통과해야 하므로(guest_checkout_enabled=True +
    guest_checkout_channels 화이트리스트), 게스트 주문을 만드는 테스트는 이 헬퍼로
    대상 이벤트의 opt-in 을 명시적으로 켠 뒤 주문한다. 게이트를 약화시키지 않는다.
    """
    from app.models.event import Event

    ev = await db_session.get(Event, uuid.UUID(eid))
    ev.guest_checkout_enabled = True
    ev.guest_checkout_channels = list(channels) if channels is not None else None
    await db_session.commit()
    return ev


async def test_create_order_atomic_basic(client, db_session):
    from app.models.order import Order, OrderStatus
    from app.models.ticket import Ticket

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, capacity=100)
    r = await client.post(
        "/api/v1/internal/orders",
        json={
            "external_order_id": "go_order_1",
            "user_id": str(user.id),
            "event_id": eid,
            "items": [{"tier_id": str(tier.id), "quantity": 2, "unit_price": 50000}],
            "total_amount": 100000,
        },
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["created"] is True
    assert len(data["ticket_ids"]) == 2
    assert data["external_order_id"] == "go_order_1"

    order = await db_session.get(Order, uuid.UUID(data["order_id"]))
    assert order.status == OrderStatus.PAYMENT_REQUIRED
    assert float(order.total_amount) == 100000.0
    assert order.external_ref == "go_order_1"
    # 티켓 2장 생성
    tk = (await db_session.execute(
        select(Ticket).where(Ticket.purchase_order_id == order.id)
    )).scalars().all()
    assert len(tk) == 2


async def test_create_order_idempotent_dedup_by_external(client, db_session):
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    payload = {
        "external_order_id": "go_order_dup",
        "user_id": str(user.id),
        "event_id": eid,
        "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
        "total_amount": 50000,
    }
    r1 = await client.post("/api/v1/internal/orders", json=payload,
                           headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    # 다른 멱등키로 재시도 → external_ref dedup, 같은 canonical order_id, created=False
    r2 = await client.post("/api/v1/internal/orders", json=payload,
                           headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r1.json()["data"]["order_id"] == r2.json()["data"]["order_id"]
    assert r2.json()["data"]["created"] is False


async def test_create_order_fingerprint_records_on_first(client, db_session):
    """레벨2 재감사3차 P1 — 최초 주문에 external_ref 문맥 지문이 기록된다."""
    from app.models.order import Order

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "go_fp_1", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    order = await db_session.get(Order, uuid.UUID(r.json()["data"]["order_id"]))
    assert order.external_ref_fingerprint is not None
    assert len(order.external_ref_fingerprint) == 64  # sha256 hex


async def test_create_order_reused_external_id_different_amount_409(client, db_session):
    """P1 핵심: 같은 external_order_id 를 **다른 금액**으로 재사용 → 409(옛 주문 재생 차단)."""
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    base = {
        "external_order_id": "go_fp_amount",
        "user_id": str(user.id),
        "event_id": eid,
        "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
        "total_amount": 50000,
    }
    r1 = await client.post("/api/v1/internal/orders", json=base,
                           headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r1.status_code == 200, r1.text
    # 같은 external_order_id, 수량/금액만 바뀐 재사용(장바구니 변경 후 옛 토큰 재사용) → 차단.
    reused = {**base, "items": [{"tier_id": str(tier.id), "quantity": 2, "unit_price": 50000}],
              "total_amount": 100000}
    r2 = await client.post("/api/v1/internal/orders", json=reused,
                           headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r2.status_code == 409, r2.text
    assert r2.json()["error"]["code"] == "IDEMPOTENCY_KEY_MISMATCH"


async def test_create_order_reused_external_id_different_event_409(client, db_session):
    """P1: 같은 external_order_id 를 **다른 이벤트/상품**으로 재사용 → 409(잘못된 event/티켓 조합 차단)."""
    user = await _seed_organizer(db_session)
    eid_a, tier_a = await _seed_event_with_tier(client, db_session, tier_ref="fp_a")
    eid_b, tier_b = await _seed_event_with_tier(client, db_session, tier_ref="fp_b")
    r1 = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "go_fp_event", "user_id": str(user.id), "event_id": eid_a,
              "items": [{"tier_id": str(tier_a.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r1.status_code == 200, r1.text
    # 같은 external_order_id 를 다른 이벤트/티어로 재사용 → 옛 주문의 ticket_ids 재생 차단.
    r2 = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "go_fp_event", "user_id": str(user.id), "event_id": eid_b,
              "items": [{"tier_id": str(tier_b.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r2.status_code == 409, r2.text
    assert r2.json()["error"]["code"] == "IDEMPOTENCY_KEY_MISMATCH"


async def test_create_order_same_context_retry_dedup_absorbed(client, db_session):
    """P1 회귀: 같은 문맥(동일 event/상품/금액) 정상 재시도는 여전히 dedup 흡수(409 아님)."""
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    payload = {
        "external_order_id": "go_fp_same",
        "user_id": str(user.id),
        "event_id": eid,
        "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
        "total_amount": 50000,
    }
    r1 = await client.post("/api/v1/internal/orders", json=payload,
                           headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    # 다른 멱등키(Redis 캐시 우회)로 동일 문맥 재시도 → DB dedup 흡수, 같은 order, created=False.
    r2 = await client.post("/api/v1/internal/orders", json=payload,
                           headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r2.status_code == 200, r2.text
    assert r1.json()["data"]["order_id"] == r2.json()["data"]["order_id"]
    assert r2.json()["data"]["created"] is False


async def test_create_order_reused_external_id_different_member_rejected(client, db_session):
    """P1-A: 동일 문맥이어도 회원 A의 external_order_id를 회원 B가 재사용하면 409."""
    from app.models.order import Order

    user_a = await _seed_organizer(db_session)
    user_b = User(
        email="buyer-b@member.test",
        hashed_password="!x!",
        name="구매자 B",
    )
    db_session.add(user_b)
    await db_session.commit()
    eid, tier = await _seed_event_with_tier(client, db_session)
    base = {
        "external_order_id": "go_fp_member_owner",
        "user_id": str(user_a.id),
        "event_id": eid,
        "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
        "total_amount": 50000,
    }
    r1 = await client.post(
        "/api/v1/internal/orders",
        json=base,
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r1.status_code == 200, r1.text
    # 레거시(NULL fingerprint)도 명시 소유자 검사는 우회하지 않아야 한다.
    order = (
        await db_session.execute(
            select(Order).where(Order.external_ref == "go_fp_member_owner")
        )
    ).scalar_one()
    order.external_ref_fingerprint = None
    await db_session.commit()

    r2 = await client.post(
        "/api/v1/internal/orders",
        json={**base, "user_id": str(user_b.id)},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r2.status_code == 409, r2.text
    assert r2.json()["error"]["code"] == "IDEMPOTENCY_KEY_MISMATCH"


async def test_create_order_amount_mismatch(client, db_session):
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    r = await client.post(
        "/api/v1/internal/orders",
        json={"user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 2, "unit_price": 50000}],
              "total_amount": 99999},  # 틀린 합계
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "AMOUNT_MISMATCH"


async def test_create_order_blocked_when_sales_paused(client, db_session):
    """P0: sales_paused=true 행사는 원자주문(go canonical 경로)도 차단(409 SALES_PAUSED)."""
    from app.models.event import Event

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    ev = await db_session.get(Event, uuid.UUID(eid))
    ev.sales_paused = True
    await db_session.commit()

    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "go_order_paused", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "SALES_PAUSED"


async def test_create_order_blocked_when_status_not_purchasable(client, db_session):
    """U4(F4): draft(미발행) 이벤트는 원자주문(go/게스트 유일경로) 차단(409 EVENT_NOT_PURCHASABLE).

    과거엔 status·window 미검증으로 draft 에도 주문이 뚫렸다(split-brain·조기판매).
    go 폐기 후 v2 가 판매 게이트를 단독 판정.
    """
    from app.models.event import Event, EventStatus

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    ev = await db_session.get(Event, uuid.UUID(eid))
    ev.status = EventStatus.DRAFT  # 발행 취소(미발행)
    await db_session.commit()

    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "go_order_draft", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "EVENT_NOT_PURCHASABLE"


async def test_create_order_blocked_when_sales_window_closed(client, db_session):
    """U4(F4): 판매창이 지난 이벤트는 원자주문 차단(409 SALES_WINDOW_CLOSED)."""
    from app.models.event import Event

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    ev = await db_session.get(Event, uuid.UUID(eid))
    now = datetime.now(timezone.utc)
    ev.bidding_opens_at = now - timedelta(days=10)
    ev.bidding_closes_at = now - timedelta(days=1)  # 이미 종료
    await db_session.commit()

    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "go_order_closed", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "SALES_WINDOW_CLOSED"


async def test_create_order_blocked_before_sales_window_open(client, db_session):
    """U4(F4): 판매 개시 전 이벤트는 원자주문 차단(409 SALES_WINDOW_NOT_OPEN)."""
    from app.models.event import Event

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    ev = await db_session.get(Event, uuid.UUID(eid))
    now = datetime.now(timezone.utc)
    ev.bidding_opens_at = now + timedelta(hours=2)  # 아직 미개시
    ev.bidding_closes_at = now + timedelta(days=7)
    await db_session.commit()

    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "go_order_early", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "SALES_WINDOW_NOT_OPEN"


async def test_full_refund_cancels_used_ticket_and_decrements_sold_count(client, db_session):
    """P1: 전액환불이 체크인('used') 티켓도 CANCELLED + sold_count 감소(2→0).

    ⚠️ 2026-07-28: 입장 완료 티켓 환불은 이제 **기본 차단**이다
    (test_refund_blocked_when_ticket_already_admitted). 여기서 검증하는 건 별개 관심사 —
    "우천취소처럼 주최자가 입장객까지 환불하기로 결정했을 때, `used` 티켓이 해제에서
    누락돼 sold_count 가 남지 않는가"이다. 그래서 `allow_admitted` 를 켜고 확인한다.
    두 단언을 한 테스트에 섞지 말 것: 차단 여부와 해제 정확성은 다른 결함군이다.
    """
    from app.models.order import Order, OrderStatus
    from app.models.ticket import Ticket, TicketStatus

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, capacity=100)
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "go_order_used", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 2, "unit_price": 50000}],
              "total_amount": 100000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    order_id = uuid.UUID(r.json()["data"]["order_id"])

    order = await db_session.get(Order, order_id)
    tickets = (await db_session.execute(
        select(Ticket).where(Ticket.purchase_order_id == order_id)
    )).scalars().all()
    assert len(tickets) == 2
    # 결제완료 + 한 장 체크인(USED), 나머지 ACTIVE. sold_count 기준 2(SQLite 보정).
    order.status = OrderStatus.PAID
    tickets[0].status = TicketStatus.USED
    tickets[1].status = TicketStatus.ACTIVE
    t = await db_session.get(SeatTier, tier.id)
    t.sold_count = 2
    await db_session.commit()

    rf = await client.post(
        f"/api/v1/internal/orders/{order_id}/refund",
        json={"full": True, "allow_admitted": True},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert rf.status_code == 200, rf.text
    assert rf.json()["data"]["status"] == "refunded"

    for tk in tickets:
        await db_session.refresh(tk)
    assert all(tk.status == TicketStatus.CANCELLED for tk in tickets), [tk.status for tk in tickets]
    await db_session.refresh(t)
    assert t.sold_count == 0  # USED 포함 2장 모두 환원


async def test_create_order_sold_out(client, db_session):
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, capacity=1)
    r = await client.post(
        "/api/v1/internal/orders",
        json={"user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 5, "unit_price": 50000}],
              "total_amount": 250000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "SOLD_OUT"


async def test_create_order_guest_creates_guest_not_user(client, db_session):
    """상세통합 S1(§2.1 C안): 게스트 주문은 **User 를 생성하지 않고** guests 행을 만든다.

    옛 안티패턴("게스트=진짜 User 생성", users.email UNIQUE 오염·유령계정·PIPA)을 폐기한
    새 계약을 단언 — order.guest_id 세팅 / order.user_id NULL / users 미생성 / guests 생성.
    """
    from app.models.guest import Guest
    from app.models.order import Order
    from app.models.user import User

    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid)  # S2b: opt-in 게이트 통과
    # 유효한 이메일(W1 형식검증 통과) — 전화는 정규화 가능한 형태.
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "go_guest_1", "event_id": eid,
              "buyer": {"name": "게스트김", "email": "guest1@x.com", "phone": "010-1234-5678"},
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    order = await db_session.get(Order, uuid.UUID(r.json()["data"]["order_id"]))
    # buyer_* 스냅샷은 Order 행에 그대로 보존(하위호환).
    assert order.buyer_email == "guest1@x.com"
    # 새 계약: 게스트는 guest_id 로 배선, user_id 는 NULL(XOR).
    assert order.user_id is None
    assert order.guest_id is not None
    # 게스트 email 로 User 가 생성되지 **않아야** 한다(옛 안티패턴 부재 확인).
    no_user = (
        await db_session.execute(select(User).where(User.email == "guest1@x.com"))
    ).scalar_one_or_none()
    assert no_user is None
    # guests 행이 생성되고 스냅샷이 저장됐다(phone 은 EncryptedString 왕복).
    guest = await db_session.get(Guest, order.guest_id)
    assert guest is not None
    assert guest.email == "guest1@x.com"
    assert guest.name == "게스트김"
    assert guest.claimed_user_id is None
    assert guest.phone_enc == "010-1234-5678"  # 평문 폴백(테스트 env PII_ENCRYPTION_KEY 미설정)


async def test_create_order_guest_invalid_email_rejected(client, db_session):
    """W1: 게스트 buyer.email 형식 위반 → 400(임의 문자열의 guests 저장·저장형XSS 소스 차단)."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid)  # opt-in 통과 후에도 W1 이메일 검증 거부됨
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "go_guest_bademail", "event_id": eid,
              "buyer": {"name": "게스트", "email": "not-an-email", "phone": "010-1234-5678"},
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"
    assert r.json()["error"]["field"] == "buyer.email"


async def test_create_order_guest_invalid_phone_rejected(client, db_session):
    """W1: 게스트 buyer.phone 형식 위반(짧은 쓰레기 값) → 400."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid)  # opt-in 통과 후에도 W1 전화 검증 거부됨
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "go_guest_badphone", "event_id": eid,
              "buyer": {"name": "게스트", "email": "guest2@x.com", "phone": "010"},  # 옛 테스트의 "010" = 이제 거부
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"
    assert r.json()["error"]["field"] == "buyer.phone"


async def test_member_order_buyer_block_not_email_validated(client, db_session):
    """회원 경로 무영향(W1): user_id 있는 회원 주문은 buyer 블록이 형식검증 대상이 아니다.

    W1 검증은 **게스트 경로에서만** 강제된다. 회원 주문이 부가정보로 buyer 를 실어 보내도
    (여기선 buyer 없이) 정상 통과해야 한다(기존 계약 불변). member=user_id 로 배선·guest_id NULL.
    """
    from app.models.order import Order

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "go_member_1", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    order = await db_session.get(Order, uuid.UUID(r.json()["data"]["order_id"]))
    assert order.user_id == user.id
    assert order.guest_id is None


async def test_guest_order_not_visible_in_member_order_query(client, db_session):
    """W3(b): 게스트 주문이 회원 주문조회(user_id 스코프)에 새지 않는다(크로스 누수 방어)."""
    from app.models.order import Order

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid)  # S2b: opt-in 게이트 통과
    # 게스트 주문 1건.
    rg = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "go_guest_leak", "event_id": eid,
              "buyer": {"name": "게스트", "email": "leak@x.com", "phone": "010-9999-8888"},
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert rg.status_code == 200, rg.text
    guest_order_id = uuid.UUID(rg.json()["data"]["order_id"])

    # 회원 주문조회 스코프(user_id == 조직자) 에는 게스트 주문이 없어야 한다.
    member_orders = (
        await db_session.execute(select(Order.id).where(Order.user_id == user.id))
    ).scalars().all()
    assert guest_order_id not in member_orders
    # 게스트 주문은 user_id NULL 이므로 어떤 user_id 스코프 조회에도 안 잡힘.
    guest_order = await db_session.get(Order, guest_order_id)
    assert guest_order.user_id is None


async def test_orders_buyer_xor_check_rejects_both_and_neither(client, db_session):
    """W3(a): orders XOR CHECK(ck_orders_buyer_exactly_one) — user_id·guest_id 동시 세팅/동시 부재 거부.

    ⚠️ SQLite 테스트 DB 는 CHECK 의 postgres '::int' 캐스트를 파싱 못 해 제약이 강제되지 않을 수
    있다. 그 경우 이 테스트는 skip(제약 자체는 마이그·모델에 선언돼 있고 prod=postgres 에서 강제).
    """
    from sqlalchemy import text as _sql_text
    from sqlalchemy.exc import IntegrityError, OperationalError

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid)  # S2b: opt-in 게이트 통과

    # 유효 게스트 주문 1건 생성 → 참조할 guest_id 확보.
    rg = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "go_guest_xor", "event_id": eid,
              "buyer": {"name": "게스트", "email": "xor@x.com", "phone": "010-1111-2222"},
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert rg.status_code == 200, rg.text
    from app.models.order import Order
    g_order = await db_session.get(Order, uuid.UUID(rg.json()["data"]["order_id"]))
    guest_id = g_order.guest_id

    # CHECK 강제 여부 프로브(SQLite ::int 미지원 시 skip).
    try:
        await db_session.execute(
            _sql_text(
                "INSERT INTO orders (id, user_id, guest_id, event_id, order_type, status, "
                "quantity, unit_price, total_amount, payment_currency, total_refunded, created_at, updated_at) "
                "VALUES (:id, :uid, :gid, :eid, 'purchase', 'payment_required', 1, 0, 0, 'KRW', 0, "
                "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            ),
            {"id": str(uuid.uuid4()), "uid": str(user.id), "gid": str(guest_id), "eid": eid},
        )
        await db_session.commit()
    except OperationalError:
        await db_session.rollback()
        pytest.skip("SQLite 는 XOR CHECK 의 postgres '::int' 캐스트 미지원 — 제약은 prod(postgres)에서 강제")
    except IntegrityError:
        # CHECK 가 강제됨 → both-set 거부 확인.
        await db_session.rollback()
    else:
        await db_session.rollback()
        pytest.fail("both-set(user_id AND guest_id) 가 XOR CHECK 로 거부되지 않음")

    # both-neither 도 거부돼야 한다.
    with pytest.raises(IntegrityError):
        await db_session.execute(
            _sql_text(
                "INSERT INTO orders (id, user_id, guest_id, event_id, order_type, status, "
                "quantity, unit_price, total_amount, payment_currency, total_refunded, created_at, updated_at) "
                "VALUES (:id, NULL, NULL, :eid, 'purchase', 'payment_required', 1, 0, 0, 'KRW', 0, "
                "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)"
            ),
            {"id": str(uuid.uuid4()), "eid": eid},
        )
        await db_session.commit()
    await db_session.rollback()


async def test_create_order_discount_used_count_and_exhaustion(client, db_session):
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await client.post(
        f"/api/v1/internal/events/{eid}/discount-codes",
        json={"codes": [{"code": "ONCE", "discount_type": "fixed", "amount": 10000, "max_uses": 1}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    # 1회차: 50000 - 10000 = 40000
    r1 = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "o1", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "discount": {"code": "ONCE", "amount": 10000}, "total_amount": 40000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r1.status_code == 200, r1.text
    code = (await db_session.execute(select(DiscountCode).where(DiscountCode.code == "ONCE"))).scalar_one()
    await db_session.refresh(code)
    assert code.used_count == 1
    # 2회차: 한도초과 409
    r2 = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "o2", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "discount": {"code": "ONCE", "amount": 10000}, "total_amount": 40000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r2.status_code == 409
    assert r2.json()["error"]["code"] == "PROMO_EXHAUSTED"


async def test_create_order_affiliate_conversion(client, db_session):
    from app.models.affiliate import AffiliateConversion

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await client.put(
        f"/api/v1/internal/events/{eid}/affiliates",
        json={"affiliates": [{"name": "A", "code": "INFLU", "commission_rate": 10.0}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "o_aff", "user_id": str(user.id), "event_id": eid,
              "affiliate_ref": "INFLU",
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 100000}],
              "total_amount": 100000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    conv = (await db_session.execute(
        select(AffiliateConversion).where(
            AffiliateConversion.order_id == uuid.UUID(r.json()["data"]["order_id"])
        )
    )).scalar_one()
    assert float(conv.commission_amount) == 10000.0  # 100000 × 10%


async def test_create_order_fee_frozen_with_fixed(client, db_session):
    from app.models.order import Order

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    # 이벤트 fee-plan: 3% + ₩300
    await client.put(
        f"/api/v1/internal/events/{eid}/fee-plan",
        json={"fee_type": "percentage_plus_fixed", "platform_fee_rate": 0.03,
              "platform_fee_fixed": 300, "pg_fee_rate": 0.025, "pg_fee_fixed": 0},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "o_fee", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 100000}],
              "total_amount": 100000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    order = await db_session.get(Order, uuid.UUID(r.json()["data"]["order_id"]))
    assert float(order.platform_fee) == 3300.0  # 100000×0.03 + 300 (정액 포함)


# ── W3.2 라이브 감사 수정 회귀 ───────────────────────────────────────────


async def test_create_order_price_below_floor_rejected(client, db_session):
    """🔴1: unit_price 가 tier min_price(카탈로그 하한)보다 낮으면 거부(무료주문 차단)."""
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    tier.min_price = 50000
    await db_session.commit()
    r = await client.post(
        "/api/v1/internal/orders",
        json={"user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 0}],
              "total_amount": 0},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "PRICE_BELOW_FLOOR"


async def test_create_order_discount_recomputed_by_v2(client, db_session):
    """🔴1: go 가 부풀린 discount.amount 보내도 v2 가 코드 rule 로 재계산 → AMOUNT_MISMATCH."""
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await client.post(
        f"/api/v1/internal/events/{eid}/discount-codes",
        json={"codes": [{"code": "TEN", "discount_type": "percentage", "rate": 10}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    # go 가 discount.amount=49000(부정) + total=1000 보냄. v2 재계산 discount=5000 → net=45000 ≠ 1000.
    r = await client.post(
        "/api/v1/internal/orders",
        json={"user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "discount": {"code": "TEN", "amount": 49000}, "total_amount": 1000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "AMOUNT_MISMATCH"
    # 올바른 total(45000)이면 통과 — v2 재계산값과 일치
    r2 = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "ok1", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "discount": {"code": "TEN", "amount": 0}, "total_amount": 45000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r2.status_code == 200, r2.text


async def test_create_order_seat_held_by_other_rejected(client, db_session):
    """🟠2: 타 구매자가 홀드한 좌석은 탈취 불가(409 SEAT_HELD_BY_OTHER)."""
    user = await _seed_organizer(db_session)
    other = await _seed_organizer(db_session, go_account_id="other_user")
    eid, tier = await _seed_event_with_tier(client, db_session)
    await client.post(
        f"/api/v1/internal/events/{eid}/seats",
        json={"seats": [{"external_ref": "s1", "tier_ref": "t1", "section": "A",
                         "row_number": 1, "seat_number": 1}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    seat = (await db_session.execute(select(Seat).where(Seat.external_ref == "s1"))).scalar_one()
    seat.status = SeatStatus.HELD
    seat.held_by = other.id  # 타인이 홀드
    await db_session.commit()
    r = await client.post(
        "/api/v1/internal/orders",
        json={"user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000,
                         "seat_ids": [str(seat.id)]}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "SEAT_HELD_BY_OTHER"


async def test_create_order_seat_ids_quantity_mismatch(client, db_session):
    """🟠3: 지정석은 len(seat_ids)==quantity 검증."""
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    r = await client.post(
        "/api/v1/internal/orders",
        json={"user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 3, "unit_price": 50000,
                         "seat_ids": [str(uuid.uuid4()), str(uuid.uuid4())]}],
              "total_amount": 150000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 400
    assert r.json()["error"]["field"] == "seat_ids"


# ── Wave3 W3.3: 재고 hold/confirm/release/block/reaper ───────────────────


async def _seed_seat(client, db_session, eid, tier_ref="t1", ext="seat_1", section="A", row=1, num=1):
    await client.post(
        f"/api/v1/internal/events/{eid}/seats",
        json={"seats": [{"external_ref": ext, "tier_ref": tier_ref, "section": section,
                         "row_number": row, "seat_number": num}]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    return (await db_session.execute(select(Seat).where(Seat.external_ref == ext))).scalar_one()


async def test_inventory_hold_confirm_release_cycle(client, db_session):
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    seat = await _seed_seat(client, db_session, eid)

    # hold
    h = await client.post(
        "/api/v1/internal/inventory/hold",
        json={"event_id": eid, "seat_ids": [str(seat.id)], "user_id": str(user.id), "ttl_seconds": 600},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert h.status_code == 200, h.text
    hold_id = h.json()["data"]["hold_id"]
    await db_session.refresh(seat)
    assert seat.status == SeatStatus.HELD and str(seat.hold_id) == hold_id

    # confirm → SOLD
    c = await client.post("/api/v1/internal/inventory/confirm",
                          json={"hold_id": hold_id}, headers=_HDR)
    assert c.status_code == 200, c.text
    await db_session.refresh(seat)
    assert seat.status == SeatStatus.SOLD

    # refund release → AVAILABLE
    rr = await client.post("/api/v1/internal/inventory/release",
                           json={"seat_ids": [str(seat.id)], "reason": "refund"}, headers=_HDR)
    assert rr.json()["data"]["released"] == 1
    await db_session.refresh(seat)
    assert seat.status == SeatStatus.AVAILABLE


async def test_anonymous_hold_then_bearer_claim(client, db_session):
    """익명(user_id 없음) 좌석 hold → held_by NULL + hold_id bearer → 주문 시 hold_id로 claim."""
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid)  # S2b: 게스트 buyer 주문 → opt-in 필요
    seat = await _seed_seat(client, db_session, eid)
    # 익명 hold (user_id 미제공) — 이전엔 FK 500, 이제 held_by NULL
    h = await client.post(
        "/api/v1/internal/inventory/hold",
        json={"event_id": eid, "seat_ids": [str(seat.id)]},  # user_id 없음
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert h.status_code == 200, h.text
    hold_id = h.json()["data"]["hold_id"]
    await db_session.refresh(seat)
    assert seat.status == SeatStatus.HELD and seat.held_by is None  # 익명

    # 주문 시 hold_id 전달 → bearer 로 claim (게스트 buyer)
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "anon1", "event_id": eid,
              "buyer": {"name": "게스트", "email": "g@x.com"},
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000,
                         "seat_ids": [str(seat.id)], "hold_id": hold_id}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    await db_session.refresh(seat)
    assert seat.status == SeatStatus.SOLD


async def test_anonymous_held_seat_not_claimable_without_hold_id(client, db_session):
    """익명 hold 좌석은 hold_id 없이는 claim 불가(탈취 방지)."""
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    seat = await _seed_seat(client, db_session, eid)
    await client.post(
        "/api/v1/internal/inventory/hold",
        json={"event_id": eid, "seat_ids": [str(seat.id)]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "anon2", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000,
                         "seat_ids": [str(seat.id)]}],  # hold_id 없음
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "SEAT_HELD_BY_OTHER"


async def test_active_held_seat_not_rehold(client, db_session):
    """활성 HELD 좌석은 다른 hold 요청 거부(익명-간 탈취 방지)."""
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    seat = await _seed_seat(client, db_session, eid)
    await client.post(
        "/api/v1/internal/inventory/hold",
        json={"event_id": eid, "seat_ids": [str(seat.id)], "ttl_seconds": 600},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    r = await client.post(
        "/api/v1/internal/inventory/hold",
        json={"event_id": eid, "seat_ids": [str(seat.id)]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "SOLD_OUT"


async def test_inventory_hold_rejects_sold(client, db_session):
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    seat = await _seed_seat(client, db_session, eid)
    seat.status = SeatStatus.SOLD
    await db_session.commit()
    r = await client.post(
        "/api/v1/internal/inventory/hold",
        json={"event_id": eid, "seat_ids": [str(seat.id)], "user_id": str(user.id)},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "SOLD_OUT"


async def test_inventory_confirm_expired_hold(client, db_session):
    from datetime import datetime, timezone, timedelta
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    seat = await _seed_seat(client, db_session, eid)
    hid = uuid.uuid4()
    seat.status = SeatStatus.HELD
    seat.held_by = user.id
    seat.held_until = datetime.now(timezone.utc) - timedelta(minutes=1)  # 이미 만료
    seat.hold_id = hid
    await db_session.commit()
    r = await client.post("/api/v1/internal/inventory/confirm", json={"hold_id": str(hid)}, headers=_HDR)
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "HOLD_EXPIRED"


async def test_inventory_block_unblock(client, db_session):
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    seat = await _seed_seat(client, db_session, eid)
    b = await client.post("/api/v1/internal/inventory/block",
                          json={"event_id": eid, "seat_ids": [str(seat.id)]}, headers=_HDR)
    assert b.json()["data"]["affected"] == 1
    await db_session.refresh(seat)
    assert seat.status == SeatStatus.RESERVED
    u = await client.post("/api/v1/internal/inventory/unblock",
                          json={"event_id": eid, "seat_ids": [str(seat.id)]}, headers=_HDR)
    assert u.json()["data"]["affected"] == 1
    await db_session.refresh(seat)
    assert seat.status == SeatStatus.AVAILABLE


async def test_inventory_block_rejects_sold(client, db_session):
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    seat = await _seed_seat(client, db_session, eid)
    seat.status = SeatStatus.SOLD
    await db_session.commit()
    r = await client.post("/api/v1/internal/inventory/block",
                          json={"event_id": eid, "seat_ids": [str(seat.id)]}, headers=_HDR)
    assert r.status_code == 409


async def test_reaper_releases_expired_unpaid_order_seats(client, db_session):
    """🟡7 핵심: 만료 미결제 주문의 SOLD 좌석을 reaper 가 release + sold_count 복구."""
    from datetime import datetime, timezone, timedelta
    from app.models.order import Order, OrderStatus

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, capacity=10)
    seat = await _seed_seat(client, db_session, eid)
    # 주문생성: 좌석 SOLD + sold_count +1
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "exp1", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000,
                         "seat_ids": [str(seat.id)]}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    order_id = uuid.UUID(r.json()["data"]["order_id"])
    await db_session.refresh(seat)
    assert seat.status == SeatStatus.SOLD
    await db_session.refresh(tier)
    assert tier.sold_count == 1

    # 결제기한 과거로 → 만료 주문 생성
    order = await db_session.get(Order, order_id)
    order.payment_deadline = datetime.now(timezone.utc) - timedelta(minutes=1)
    await db_session.commit()

    # reap
    rp = await client.post(f"/api/v1/internal/inventory/reap?event_id={eid}", headers=_HDR)
    data = rp.json()["data"]
    assert data["orders_expired"] == 1
    assert data["seats_released"] == 1

    await db_session.refresh(order)
    await db_session.refresh(seat)
    await db_session.refresh(tier)
    assert order.status == OrderStatus.EXPIRED
    assert seat.status == SeatStatus.AVAILABLE  # 좌석 복구
    assert tier.sold_count == 0  # 재고 복구


# ── Wave3 W3.4: 상태머신 / 환불 / 결제완료 가드 ──────────────────────────


async def _create_seat_order(client, db_session, user, eid, tier, seat):
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": f"o_{uuid.uuid4().hex[:8]}", "user_id": str(user.id),
              "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000,
                         "seat_ids": [str(seat.id)]}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    return uuid.UUID(r.json()["data"]["order_id"])


async def test_refund_release_cancels_tickets_no_soldcount_leak(client, db_session):
    """🟠1: 환불 release(seat_ids+refund)가 티켓 CANCELLED → sold_count 누수 없음."""
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, capacity=10)
    seat = await _seed_seat(client, db_session, eid)
    await _create_seat_order(client, db_session, user, eid, tier, seat)
    await db_session.refresh(tier)
    assert tier.sold_count == 1

    r = await client.post("/api/v1/internal/inventory/release",
                          json={"seat_ids": [str(seat.id)], "reason": "refund", "event_id": eid},
                          headers=_HDR)
    assert r.json()["data"]["released"] == 1
    await db_session.refresh(seat)
    await db_session.refresh(tier)
    assert seat.status == SeatStatus.AVAILABLE
    assert tier.sold_count == 0  # 🟠1 누수 없음(티켓 CANCELLED → −1)


async def test_order_full_refund_atomic(client, db_session):
    from app.models.order import Order, OrderStatus

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, capacity=10)
    seat = await _seed_seat(client, db_session, eid)
    oid = await _create_seat_order(client, db_session, user, eid, tier, seat)
    # 결제확정 상태로 만들어 환불 가능하게
    order = await db_session.get(Order, oid)
    order.status = OrderStatus.CONFIRMED
    await db_session.commit()

    r = await client.post(f"/api/v1/internal/orders/{oid}/refund",
                          json={"full": True}, headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["status"] == "refunded"
    assert d["seats_released"] == 1
    await db_session.refresh(order)
    await db_session.refresh(seat)
    await db_session.refresh(tier)
    assert order.status == OrderStatus.REFUNDED
    assert float(order.total_refunded) == 50000.0
    assert seat.status == SeatStatus.AVAILABLE
    assert tier.sold_count == 0


async def test_order_partial_refund_keeps_seats(client, db_session):
    from app.models.order import Order, OrderStatus

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    seat = await _seed_seat(client, db_session, eid)
    oid = await _create_seat_order(client, db_session, user, eid, tier, seat)
    order = await db_session.get(Order, oid)
    order.status = OrderStatus.PAID
    await db_session.commit()

    r = await client.post(f"/api/v1/internal/orders/{oid}/refund",
                          json={"amount": 20000}, headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    d = r.json()["data"]
    assert d["status"] == "partially_refunded"
    assert d["seats_released"] == 0  # 부분환불은 좌석 유지
    await db_session.refresh(seat)
    assert seat.status == SeatStatus.SOLD  # 좌석 그대로


async def test_fee_deducted_whole_cancellation_releases_ticket_and_seat(client, db_session):
    """수수료로 지급액이 줄어도 주문 전체 취소면 티켓·좌석을 반드시 해제한다.

    ``amount`` 만 보면 35,000 < 50,000 이라 금액 부분환불이지만, ``cancel_all`` 은
    구매 계약 전체를 끝낸다는 별도 의사표시다. 두 개념을 섞으면 고객은 환불을 받고도
    ACTIVE 티켓과 SOLD 좌석을 계속 보유한다.
    """
    from app.models.order import Order, OrderStatus
    from app.models.ticket import Ticket, TicketStatus

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, capacity=10)
    seat = await _seed_seat(client, db_session, eid)
    oid = await _create_seat_order(client, db_session, user, eid, tier, seat)
    order = await db_session.get(Order, oid)
    order.status = OrderStatus.PAID
    await db_session.commit()

    response = await client.post(
        f"/api/v1/internal/orders/{oid}/refund",
        json={"amount": 35000, "cancel_all": True, "reason": "30% 취소 수수료"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["status"] == "refunded"
    assert data["refunded"] == 35000.0
    assert data["total_refunded"] == 35000.0
    assert data["seats_released"] == 1

    ticket = (
        await db_session.execute(select(Ticket).where(Ticket.purchase_order_id == oid))
    ).scalar_one()
    await db_session.refresh(order)
    await db_session.refresh(seat)
    assert order.status == OrderStatus.REFUNDED
    assert float(order.total_refunded) == 35000.0
    assert ticket.status == TicketStatus.CANCELLED
    assert seat.status == SeatStatus.AVAILABLE


async def test_internal_refund_items_auto_prices_and_releases_sold_seat(client, db_session):
    """go 라인취소 계약: amount 생략 시 티켓 가격으로 환불하고 SOLD 좌석을 해제한다."""
    from app.models.order import Order, OrderStatus
    from app.models.ticket import Ticket, TicketStatus

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, capacity=10)
    seat = await _seed_seat(client, db_session, eid)
    oid = await _create_seat_order(client, db_session, user, eid, tier, seat)
    order = await db_session.get(Order, oid)
    order.status = OrderStatus.PAID
    await db_session.commit()
    ticket = (
        await db_session.execute(select(Ticket).where(Ticket.purchase_order_id == oid))
    ).scalar_one()

    response = await client.post(
        f"/api/v1/internal/orders/{oid}/refund-items",
        json={"items": [{"ticket_id": str(ticket.id)}], "reason": "라인 취소"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )

    assert response.status_code == 200, response.text
    data = response.json()["data"]
    assert data["status"] == "refunded"
    assert data["refunded"] == 50000.0
    assert data["seats_released"] == 1
    assert data["cancelled_ticket_ids"] == [str(ticket.id)]

    await db_session.refresh(order)
    await db_session.refresh(ticket)
    await db_session.refresh(seat)
    assert order.status == OrderStatus.REFUNDED
    assert ticket.status == TicketStatus.CANCELLED
    assert seat.status == SeatStatus.AVAILABLE


async def test_partial_refund_twice_allowed(client, db_session):
    """§2.6 SSOT: PARTIALLY_REFUNDED → PARTIALLY_REFUNDED 자기전이 허용(부분환불 다회).

    order.py:VALID_ORDER_TRANSITIONS 단일화 후에도 부분환불을 여러 번 할 수 있어야 한다
    (기존 internal_commerce._ORDER_TRANSITIONS 자기전이를 order.py 로 흡수).
    """
    from app.models.order import Order, OrderStatus

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    seat = await _seed_seat(client, db_session, eid)
    oid = await _create_seat_order(client, db_session, user, eid, tier, seat)
    order = await db_session.get(Order, oid)
    order.status = OrderStatus.PAID
    await db_session.commit()

    r1 = await client.post(f"/api/v1/internal/orders/{oid}/refund",
                           json={"amount": 10000}, headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r1.status_code == 200, r1.text
    assert r1.json()["data"]["status"] == "partially_refunded"

    # 두 번째 부분환불 — 자기전이(PARTIALLY_REFUNDED→PARTIALLY_REFUNDED) 허용.
    r2 = await client.post(f"/api/v1/internal/orders/{oid}/refund",
                           json={"amount": 5000}, headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r2.status_code == 200, r2.text
    assert r2.json()["data"]["status"] == "partially_refunded"


async def test_refund_forbidden_on_unpaid(client, db_session):
    """전이검증: PAYMENT_REQUIRED 주문 환불 시도 → 422 STATE_TRANSITION_FORBIDDEN."""
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    seat = await _seed_seat(client, db_session, eid)
    oid = await _create_seat_order(client, db_session, user, eid, tier, seat)  # PAYMENT_REQUIRED
    r = await client.post(f"/api/v1/internal/orders/{oid}/refund",
                          json={"full": True}, headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "STATE_TRANSITION_FORBIDDEN"


async def test_cancel_paid_order_forbidden_use_refund(client, db_session):
    """H2 결제완료 가드: 결제완료 주문 cancel 금지(refund 사용) → 422."""
    from app.models.order import Order, OrderStatus

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    seat = await _seed_seat(client, db_session, eid)
    oid = await _create_seat_order(client, db_session, user, eid, tier, seat)
    order = await db_session.get(Order, oid)
    order.status = OrderStatus.CONFIRMED
    await db_session.commit()
    r = await client.post(f"/api/v1/internal/orders/{oid}/cancel",
                          json={}, headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 422


async def test_reaper_skips_confirmed_order(client, db_session):
    """🟠2/H2: reaper 는 PAYMENT_REQUIRED 만 만료 — 결제완료(CONFIRMED) 주문은 불가침."""
    from datetime import datetime, timezone, timedelta
    from app.models.order import Order, OrderStatus

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    seat = await _seed_seat(client, db_session, eid)
    oid = await _create_seat_order(client, db_session, user, eid, tier, seat)
    order = await db_session.get(Order, oid)
    order.status = OrderStatus.CONFIRMED  # 결제완료
    order.payment_deadline = datetime.now(timezone.utc) - timedelta(minutes=1)  # 기한 과거여도
    await db_session.commit()

    rp = await client.post(f"/api/v1/internal/inventory/reap?event_id={eid}", headers=_HDR)
    assert rp.json()["data"]["orders_expired"] == 0  # CONFIRMED 불가침
    await db_session.refresh(order)
    await db_session.refresh(seat)
    assert order.status == OrderStatus.CONFIRMED
    assert seat.status == SeatStatus.SOLD


async def test_cancel_unpaid_releases_inventory(client, db_session):
    from app.models.order import Order, OrderStatus

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    seat = await _seed_seat(client, db_session, eid)
    oid = await _create_seat_order(client, db_session, user, eid, tier, seat)  # PAYMENT_REQUIRED
    r = await client.post(f"/api/v1/internal/orders/{oid}/cancel",
                          json={}, headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["seats_released"] == 1
    order = await db_session.get(Order, oid)
    await db_session.refresh(order)
    await db_session.refresh(seat)
    await db_session.refresh(tier)
    assert order.status == OrderStatus.CANCELLED
    assert seat.status == SeatStatus.AVAILABLE
    assert tier.sold_count == 0


async def test_ticket_check_in_cancelled_forbidden(client, db_session):
    from app.models.ticket import Ticket, TicketStatus

    user = await _seed_organizer(db_session)
    eid = await _create_event(client)
    euid = uuid.UUID(eid)
    tier = SeatTier(event_id=euid, name="GA", capacity=10, base_price=1000, sale_mode="fixed_fcfs")
    db_session.add(tier)
    await db_session.flush()
    t = Ticket(event_id=euid, tier_id=tier.id, current_owner_id=user.id,
               purchase_price=1000, sale_mode="fixed_fcfs", status=TicketStatus.CANCELLED)
    db_session.add(t)
    await db_session.commit()
    r = await client.post(f"/api/v1/internal/tickets/{t.id}/check-in", json={},
                          headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "STATE_TRANSITION_FORBIDDEN"


# ── 이벤트 정체성 단일화 (GO_V2_COMMERCE_SYNC_AUDIT (B)) ──────────────────


async def test_create_event_uses_external_ref_uuid_as_canonical_id(client, db_session):
    """external_ref 가 UUID(=go event id)면 v2 canonical id 로 그대로 사용 → 심사요청 경로와 동일 이벤트로 수렴."""
    await _seed_organizer(db_session)
    go_id = str(uuid.uuid4())
    headers = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(external_ref=go_id),
        headers=headers,
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    # id == external_ref(go_id) — 이원화 방지 핵심
    assert data["event_id"] == go_id
    ev = await db_session.get(Event, uuid.UUID(go_id))
    assert ev is not None and ev.external_ref == go_id


async def test_create_event_reuses_event_created_by_review_path(client, db_session):
    """심사요청 경로가 id=go_id(external_ref 없이)로 먼저 만든 이벤트를 커머스 createEvent 가 재사용."""
    from datetime import datetime, timezone

    user = await _seed_organizer(db_session)
    go_id = uuid.uuid4()
    from datetime import timedelta

    dt = datetime(2026, 8, 20, 10, 0, tzinfo=timezone.utc)
    # 심사요청 경로 흉내: id=go_id, external_ref 미설정
    pre = Event(
        id=go_id,
        organizer_id=user.id,
        title="심사요청본",
        slug=f"pre-{go_id.hex[:8]}",
        venue="장소",
        event_date=dt,
        bidding_opens_at=dt - timedelta(days=7),
        bidding_closes_at=dt,
        total_seats=100,
        category="concert",
        status=EventStatus.PENDING_REVIEW,
    )
    db_session.add(pre)
    await db_session.commit()

    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(external_ref=str(go_id)),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["created"] is False          # 신규 생성 아님 — 재사용
    assert data["event_id"] == str(go_id)     # 같은 이벤트
    await db_session.refresh(pre)
    assert pre.external_ref == str(go_id)      # external_ref 보정됨

    # 중복 이벤트가 생기지 않았는지
    cnt = (await db_session.execute(
        select(func.count()).select_from(Event).where(Event.external_ref == str(go_id))
    )).scalar()
    assert cnt == 1


async def test_upsert_tiers_recomputes_event_min_max_price(client, db_session):
    """티어 upsert 시 event.min_price/max_price 를 판매가능(capacity>0) tier base_price 로 재계산."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [
            {"external_ref": "t_hi", "name": "VIP", "capacity": 100, "base_price": 150000, "sale_mode": "fixed_fcfs"},
            {"external_ref": "t_lo", "name": "일반", "capacity": 200, "base_price": 90000, "sale_mode": "fixed_fcfs"},
        ]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    db_session.expire_all()
    ev = await db_session.get(Event, uuid.UUID(eid))
    assert float(ev.min_price) == 90000      # tier base_price 최저
    assert float(ev.max_price) == 150000     # tier base_price 최고
    assert ev.total_seats == 300


async def test_tiers_replace_deletes_unsold_phantom(client, db_session):
    """replace=true: 페이로드에 없는 미판매 GA 티어를 삭제하고 min/max_price 를 재계산한다.

    resync 로 go 의 실제 상품만 재-push 하면, 앞서 잘못 만든 팬텀 티어(₩20,000)가 사라져
    min_price 오염이 회복돼야 한다(GO_V2_COMMERCE_SYNC_AUDIT — 티어 DELETE sync 갭)."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    # 1) 팬텀 포함 3티어 upsert (min=20000 오염 상태 재현)
    r = await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [
            {"external_ref": "real_4day", "name": "4일권", "capacity": 500, "base_price": 50000, "sale_mode": "fixed_fcfs"},
            {"external_ref": "phantom_2day", "name": "2일권", "capacity": 300, "base_price": 35000, "sale_mode": "fixed_fcfs"},
            {"external_ref": "phantom_1day", "name": "1일권", "capacity": 300, "base_price": 20000, "sale_mode": "fixed_fcfs"},
        ]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    db_session.expire_all()
    ev = await db_session.get(Event, uuid.UUID(eid))
    assert float(ev.min_price) == 20000  # 팬텀에 의해 오염

    # 2) replace=true 로 실제 라인업(일일권 4종)만 재-push → 팬텀 삭제, min=18000
    r2 = await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"replace": True, "tiers": [
            {"external_ref": "day_r1", "name": "1일권(1R)", "capacity": 500, "base_price": 18000, "sale_mode": "fixed_fcfs"},
            {"external_ref": "day_r2", "name": "1일권(2R)", "capacity": 500, "base_price": 18000, "sale_mode": "fixed_fcfs"},
            {"external_ref": "day_r3", "name": "1일권(3R)", "capacity": 500, "base_price": 22500, "sale_mode": "fixed_fcfs"},
            {"external_ref": "day_r4", "name": "1일권(4R)", "capacity": 500, "base_price": 22500, "sale_mode": "fixed_fcfs"},
        ]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["data"]["deleted"] == 3  # real_4day + phantom 2종 삭제(모두 미판매)

    lst = await client.get(f"/api/v1/internal/events/{eid}/tiers", headers=_HDR)
    refs = {t["external_ref"] for t in lst.json()["data"]["tiers"]}
    assert refs == {"day_r1", "day_r2", "day_r3", "day_r4"}
    db_session.expire_all()
    ev = await db_session.get(Event, uuid.UUID(eid))
    assert float(ev.min_price) == 18000
    assert float(ev.max_price) == 22500


async def test_tiers_replace_protects_sold_tier(client, db_session):
    """replace=true 라도 판매분(sold>0)이 있는 티어는 삭제하지 않는다(데이터 보호)."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [
            {"external_ref": "sold_tier", "name": "판매됨", "capacity": 100, "base_price": 30000, "sale_mode": "fixed_fcfs"},
        ]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    tier_id = r.json()["data"]["tiers"][0]["tier_id"]
    # GA sold_count 를 직접 올려 '판매분 있음' 상태로 만든다.
    from app.models.event import SeatTier
    st = await db_session.get(SeatTier, uuid.UUID(tier_id))
    st.sold_count = 5
    await db_session.commit()

    # 다른 티어만 담아 replace → sold_tier 는 보호되어야 함.
    r2 = await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"replace": True, "tiers": [
            {"external_ref": "new_tier", "name": "신규", "capacity": 50, "base_price": 10000, "sale_mode": "fixed_fcfs"},
        ]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["data"]["deleted"] == 0  # 판매분 있어 미삭제
    lst = await client.get(f"/api/v1/internal/events/{eid}/tiers", headers=_HDR)
    refs = {t["external_ref"] for t in lst.json()["data"]["tiers"]}
    assert refs == {"sold_tier", "new_tier"}


async def test_tiers_replace_empty_deletes_last_phantom(client, db_session):
    """3.2 상품삭제 정리: go 마지막 ticket 상품 삭제 시 남은 티어 0개여도 빈 tiers+replace=true 로
    유일 미판매 팬텀 티어를 정리한다(티어 DELETE sync 갭 완결). min_length=1 은 replace=false 에만 적용."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [
            {"external_ref": "only_prod", "name": "유일상품", "capacity": 100, "base_price": 30000, "sale_mode": "fixed_fcfs"},
        ]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text

    # 마지막 상품 삭제 → go 가 빈 tiers + replace=true 로 재-push
    r2 = await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"replace": True, "tiers": []},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["data"]["deleted"] == 1  # 미판매 팬텀 정리
    lst = await client.get(f"/api/v1/internal/events/{eid}/tiers", headers=_HDR)
    assert lst.json()["data"]["tiers"] == []


async def test_tiers_empty_without_replace_rejected(client, db_session):
    """replace=false 인 일반 upsert 는 빈 tiers 를 계속 422 로 거부한다(오호출 방지)."""
    await _seed_organizer(db_session)
    eid = await _create_event(client)
    r = await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": []},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 422, r.text


# ── F4: 경품번호 발권 + 추첨 (API 통합) ──────────────────────────────────────


async def _enable_raffle(db_session, eid: str) -> None:
    from app.models.event import Event as _Event
    ev = await db_session.get(_Event, uuid.UUID(eid))
    ev.raffle_enabled = True
    await db_session.commit()


async def test_f4_order_assigns_raffle_number_when_enabled(client, db_session):
    from app.models.ticket import Ticket

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, capacity=100)
    await _enable_raffle(db_session, eid)

    r = await client.post(
        "/api/v1/internal/orders",
        json={
            "external_order_id": "go_raffle_1",
            "user_id": str(user.id),
            "event_id": eid,
            "items": [{"tier_id": str(tier.id), "quantity": 3, "unit_price": 50000}],
            "total_amount": 150000,
        },
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    # 응답에 raffle_numbers(티켓id→번호) 노출.
    assert "raffle_numbers" in data
    assert len(data["raffle_numbers"]) == 3
    # 이벤트 스코프 유니크 + **6자리 코드**(2026-07-28: 순번 1,2,3 → 뒤섞은 코드).
    # 카운터는 여전히 순번을 주고, 티켓에는 그 순번의 전단사 코드가 찍힌다.
    from app.services.raffle_service import raffle_code_for_index

    tks = (await db_session.execute(
        select(Ticket).where(Ticket.event_id == uuid.UUID(eid))
    )).scalars().all()
    numbers = sorted(t.raffle_number for t in tks)
    assert len(set(numbers)) == 3
    assert all(100_000 <= n <= 999_999 for n in numbers), numbers
    assert numbers == sorted(
        raffle_code_for_index(uuid.UUID(eid), i) for i in range(1, 4)
    )


async def test_f4_order_no_number_when_disabled(client, db_session):
    """raffle_enabled=false(기본) → raffle_number 미부여·응답에 raffle_numbers 없음."""
    from app.models.ticket import Ticket

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, capacity=100)
    # raffle 미활성(기본).

    r = await client.post(
        "/api/v1/internal/orders",
        json={
            "external_order_id": "go_noraffle_1",
            "user_id": str(user.id),
            "event_id": eid,
            "items": [{"tier_id": str(tier.id), "quantity": 2, "unit_price": 50000}],
            "total_amount": 100000,
        },
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    assert "raffle_numbers" not in r.json()["data"]
    tks = (await db_session.execute(
        select(Ticket).where(Ticket.event_id == uuid.UUID(eid))
    )).scalars().all()
    assert all(t.raffle_number is None for t in tks)


async def test_f4_draw_endpoint_pool_and_record(client, db_session):
    from app.models.event_admission import EventAdmission
    from app.models.ticket import Ticket

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, capacity=100)
    await _enable_raffle(db_session, eid)
    await client.post(
        "/api/v1/internal/orders",
        json={
            "external_order_id": "go_raffle_draw",
            "user_id": str(user.id),
            "event_id": eid,
            "items": [{"tier_id": str(tier.id), "quantity": 6, "unit_price": 50000}],
            "total_amount": 300000,
        },
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    tks = (await db_session.execute(
        select(Ticket).where(Ticket.event_id == uuid.UUID(eid)).order_by(Ticket.raffle_number)
    )).scalars().all()
    # 6장 중 앞 4장만 체크인.
    from datetime import date as _date, datetime as _dt, timezone as _tz
    checked = tks[:4]
    for t in checked:
        db_session.add(EventAdmission(
            ticket_id=t.id, event_id=uuid.UUID(eid), attended_date=_date(2026, 9, 1),
            checked_in_at=_dt.now(_tz.utc), method="qr_scan",
        ))
    await db_session.commit()

    # 추첨 실행.
    r = await client.post(
        f"/api/v1/internal/events/{eid}/raffle/draw",
        json={"winner_count": 2, "seed": "public-2026", "executed_by": str(user.id)},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    draw = r.json()["data"]
    assert draw["pool_size"] == 4
    assert draw["winner_count"] == 2
    checked_numbers = {t.raffle_number for t in checked}
    assert set(draw["winning_numbers"]).issubset(checked_numbers)

    # 기록 조회.
    lst = await client.get(f"/api/v1/internal/events/{eid}/raffle/draws", headers=_HDR)
    assert lst.status_code == 200
    draws = lst.json()["data"]["draws"]
    assert len(draws) == 1
    assert draws[0]["seed"] == "public-2026"


async def test_f4_draw_rejects_disabled_event(client, db_session):
    await _seed_organizer(db_session)
    eid, _tier = await _seed_event_with_tier(client, db_session, capacity=100)
    r = await client.post(
        f"/api/v1/internal/events/{eid}/raffle/draw",
        json={"winner_count": 1, "seed": "s"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "RAFFLE_DISABLED"


# ── DELETE /events/{id} 하드삭제(테스트 이벤트 영구삭제, go write-through) ─────


async def _create_event_via_api(client, go_account_id="go_org_1", external_ref="go_evt_del"):
    """API 로 이벤트 생성 후 v2 event_id 반환(go write-through 경로 재현)."""
    headers = {**_HDR, "Idempotency-Key": str(uuid.uuid4())}
    body = _event_body(go_account_id=go_account_id, external_ref=external_ref)
    r = await client.post("/api/v1/internal/events", json=body, headers=headers)
    assert r.status_code == 200, r.text
    return uuid.UUID(r.json()["data"]["event_id"])


async def test_delete_event_zero_orders_with_authoring_children(client, db_session):
    """주문 0 이벤트 + authoring 자식(tier/seat/waitlist RESTRICT)까지 하드삭제 성공."""
    from app.models.waitlist import WaitlistEntryModel

    user = await _seed_organizer(db_session)
    event_id = await _create_event_via_api(client)

    # authoring 자식: tier(CASCADE) + seat(event RESTRICT) + waitlist(event RESTRICT).
    tier = SeatTier(event_id=event_id, name="VIP", capacity=10, base_price=100000)
    db_session.add(tier)
    await db_session.flush()
    seat = Seat(
        tier_id=tier.id, event_id=event_id, section="A", row_number=1,
        seat_number=1, status=SeatStatus.AVAILABLE,
    )
    db_session.add(seat)
    wl = WaitlistEntryModel(event_id=event_id, tier_id=tier.id, user_id=user.id)
    db_session.add(wl)
    await db_session.commit()

    r = await client.delete(
        f"/api/v1/internal/events/{event_id}",
        params={"organizer_ref": "go_org_1"},
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["deleted"] is True
    assert data["event_id"] == str(event_id)

    # 실제로 삭제됐고 자식도 사라졌는지 확인.
    db_session.expire_all()
    assert await db_session.get(Event, event_id) is None
    tier_left = (
        await db_session.execute(
            select(func.count()).select_from(SeatTier).where(SeatTier.event_id == event_id)
        )
    ).scalar()
    seat_left = (
        await db_session.execute(
            select(func.count()).select_from(Seat).where(Seat.event_id == event_id)
        )
    ).scalar()
    wl_left = (
        await db_session.execute(
            select(func.count()).select_from(WaitlistEntryModel).where(
                WaitlistEntryModel.event_id == event_id
            )
        )
    ).scalar()
    assert (tier_left, seat_left, wl_left) == (0, 0, 0)


async def test_delete_event_with_order_rejected_409(client, db_session):
    """주문이 1건이라도(pending 포함) 있으면 409 EVENT_HAS_ORDERS — 이벤트 보존."""
    from app.models.order import Order, OrderStatus

    user = await _seed_organizer(db_session)
    event_id = await _create_event_via_api(client)
    order = Order(
        user_id=user.id, event_id=event_id, quantity=1, unit_price=100000,
        total_amount=100000, status=OrderStatus.PENDING,
        buyer_name="구매자", buyer_email="b@t.com",
    )
    db_session.add(order)
    await db_session.commit()

    r = await client.delete(
        f"/api/v1/internal/events/{event_id}",
        params={"organizer_ref": "go_org_1"},
        headers=_HDR,
    )
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "EVENT_HAS_ORDERS"
    # 이벤트·주문 모두 보존.
    db_session.expire_all()
    assert await db_session.get(Event, event_id) is not None


async def test_delete_event_wrong_organizer_forbidden_403(client, db_session):
    """다른 주최자 ref 로 삭제 시도 → 403(크로스테넌트 삭제 차단)."""
    await _seed_organizer(db_session, go_account_id="go_org_1")
    await _seed_organizer(db_session, go_account_id="go_org_2")
    event_id = await _create_event_via_api(client, go_account_id="go_org_1")

    r = await client.delete(
        f"/api/v1/internal/events/{event_id}",
        params={"organizer_ref": "go_org_2"},  # 소유자 아님
        headers=_HDR,
    )
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "FORBIDDEN"
    db_session.expire_all()
    assert await db_session.get(Event, event_id) is not None


async def test_delete_event_not_found_404(client, db_session):
    """존재하지 않는 이벤트 → 404(go 가 '이미 삭제됨'으로 흡수 = 멱등)."""
    await _seed_organizer(db_session)
    r = await client.delete(
        f"/api/v1/internal/events/{uuid.uuid4()}",
        params={"organizer_ref": "go_org_1"},
        headers=_HDR,
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "EVENT_NOT_FOUND"


async def test_delete_event_idempotent_double_delete(client, db_session):
    """같은 이벤트 2회 삭제 → 1회 200, 2회 404(멱등: 없으면 이미 삭제됨)."""
    await _seed_organizer(db_session)
    event_id = await _create_event_via_api(client)

    r1 = await client.delete(
        f"/api/v1/internal/events/{event_id}",
        params={"organizer_ref": "go_org_1"}, headers=_HDR,
    )
    assert r1.status_code == 200, r1.text
    r2 = await client.delete(
        f"/api/v1/internal/events/{event_id}",
        params={"organizer_ref": "go_org_1"}, headers=_HDR,
    )
    assert r2.status_code == 404
    assert r2.json()["error"]["code"] == "EVENT_NOT_FOUND"


async def test_delete_event_requires_organizer_ref(client, db_session):
    """organizer_ref(필수 쿼리) 누락 → 422(FastAPI 검증)."""
    await _seed_organizer(db_session)
    event_id = await _create_event_via_api(client)
    r = await client.delete(f"/api/v1/internal/events/{event_id}", headers=_HDR)
    assert r.status_code == 422


# ── 입장 완료 티켓 환불 차단 (2026-07-28 prod 실측 결함) ─────────────────────────
async def test_refund_blocked_when_ticket_already_admitted(client, db_session):
    """실측: 체크인해 `used` 가 된 티켓 2장이 그대로 환불돼 `cancelled` 이 됐다.

    소비자 환불(refund_service.py:321)에는 "already checked in" 가드가 있는데
    go write-through 경로에만 없었다 — 같은 도메인 규칙이 한쪽에만 걸려 있었다.
    """
    from app.models.ticket import Ticket, TicketStatus

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "admitted-refund", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    oid = r.json()["data"]["order_id"]
    await client.post(f"/api/v1/internal/orders/{oid}/confirm-payment",
                      json={"source": "manual", "amount": 50000}, headers=_HDR)

    ticket = (
        await db_session.execute(
            select(Ticket).where(Ticket.purchase_order_id == uuid.UUID(oid))
        )
    ).scalars().first()
    assert ticket is not None
    ticket.status = TicketStatus.USED
    ticket.checked_in_at = datetime.now(timezone.utc)
    await db_session.commit()

    blocked = await client.post(
        f"/api/v1/internal/orders/{oid}/refund",
        json={"full": True, "reason": "입장 후 환불 시도"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert blocked.status_code == 422, blocked.text
    assert "TICKET_ALREADY_ADMITTED" in blocked.text

    # 주최자가 우천취소 등으로 **명시 결정**한 경우만 통과.
    allowed = await client.post(
        f"/api/v1/internal/orders/{oid}/refund",
        json={"full": True, "reason": "우천 취소 전원 환불", "allow_admitted": True},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert allowed.status_code == 200, allowed.text


# ── 체크인 `at` 미래시각 거부 (적대 감사 F-4) ─────────────────────────────────
async def test_check_in_rejects_future_timestamp(client, db_session):
    """🔴 오프라인 동기화가 실입장 시각을 싣게 되면서 열린 구멍.

    목요일에 `at=금요일`(미래)을 보내면 daypass 가 **금요일로 확정**되고 목요일 실입장은
    원장에 남지 않는다 → 금요일에 정상 스캔하면 reentry_ok → **주중권 1장으로 이틀 입장**이
    원장상 깨끗하게 성립했다. admit() 은 입장'일' 규칙만 보고 "그 시각이 실재하는가"는
    판정하지 않으므로, 미래 검사는 신뢰 경계인 이 엔드포인트가 유일한 자리다.
    """
    from datetime import datetime, timedelta, timezone

    from app.models.ticket import Ticket, TicketStatus

    user = await _seed_organizer(db_session)
    eid = await _create_event(client)
    euid = uuid.UUID(eid)
    tier = SeatTier(event_id=euid, name="GA", capacity=10, base_price=1000, sale_mode="fixed_fcfs")
    db_session.add(tier)
    await db_session.flush()
    t = Ticket(event_id=euid, tier_id=tier.id, current_owner_id=user.id,
               purchase_price=1000, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE)
    db_session.add(t)
    await db_session.commit()

    now = datetime.now(timezone.utc)

    # 하루 뒤 = 명백한 미래 → 거부.
    future = await client.post(
        f"/api/v1/internal/tickets/{t.id}/check-in",
        json={"at": (now + timedelta(days=1)).isoformat()},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert future.status_code == 400, future.text
    assert "미래" in future.text

    # 입장 원장이 생기지 않았어야 한다 — 거부가 부작용 없이 끝나야 한다.
    from app.models.event_admission import EventAdmission
    rows = (await db_session.execute(
        select(EventAdmission).where(EventAdmission.ticket_id == t.id)
    )).scalars().all()
    assert rows == []

    # 시계 드리프트(1분 앞)는 통과해야 한다 — 오프라인 기기 시계는 늘 조금 틀어진다.
    ok = await client.post(
        f"/api/v1/internal/tickets/{t.id}/check-in",
        json={"at": (now + timedelta(minutes=1)).isoformat()},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert ok.status_code == 200, ok.text

    # 과거(오프라인 큐 지연)는 계속 허용 — 정상 동작이다.
    past = await client.post(
        f"/api/v1/internal/tickets/{t.id}/check-in",
        json={"at": (now - timedelta(hours=3)).isoformat()},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert past.status_code == 200, past.text


@pytest.mark.asyncio
async def test_refund_idempotency_ignores_reason_across_two_go_paths(client, db_session):
    """🔴 T20: 두 환불 경로가 **같은 부분환불**을 넣어도 한 번만 나간다.

    go 는 환불 진입점이 둘이고, 둘 다 멱등키를 `go-refund:{orderId}:{목표 누적환불액}` 로
    쓴다. 그런데 body 의 `reason` 이 다르다:
        refund/route.ts   reason = body.reason ?? "고객 요청 환불"
        orders/[orderId]  reason = body.reason (없을 수 있음)
    멱등 캐시키가 `idem:{endpoint}:{key}:{fingerprint(body)}` 라, 지문이 갈리면
    **같은 키인데도 양쪽 다 실행**된다.

    전액환불은 `remaining <= 0` 으로 우연히 막히지만 **부분환불은 뚫린다** —
    30,000 주문에 10,000 을 두 경로로 넣으면 20,000 이 나간다. 지금은 원장 오염이고
    PG 취소가 배선되면 실돈이 두 번 나간다.

    ⚠️ 이 단언이 이번 사고의 본질이다. `_refund_fingerprint` 를 `_fingerprint(body)` 로
       되돌리면 이 테스트가 깨져야 한다(뮤테이션으로 확인함).
    """
    from app.models.order import Order, OrderStatus
    from app.models.refund import Refund

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "t20-dup", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 30000}],
              "total_amount": 30000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    oid = r.json()["data"]["order_id"]
    await client.post(f"/api/v1/internal/orders/{oid}/confirm-payment",
                      json={"source": "manual", "amount": 30000}, headers=_HDR)

    # go 두 경로가 쓰는 **동일 멱등키** — 목표 누적환불액 10,000.
    idem = f"go-refund:{oid}:10000"

    # 경로 A: refund/route.ts — reason 기본값 주입
    a = await client.post(
        f"/api/v1/internal/orders/{oid}/refund",
        json={"amount": 10000, "reason": "고객 요청 환불"},
        headers={**_HDR, "Idempotency-Key": idem},
    )
    assert a.status_code == 200, a.text

    # 경로 B: orders/[orderId] PATCH — 운영자 사유(또는 없음). **같은 작업이다.**
    b = await client.post(
        f"/api/v1/internal/orders/{oid}/refund",
        json={"amount": 10000, "reason": "운영자 조정"},
        headers={**_HDR, "Idempotency-Key": idem},
    )
    assert b.status_code == 200, b.text

    order = await db_session.get(Order, uuid.UUID(oid))
    await db_session.refresh(order)
    # 🔴 핵심: 두 번 넣었어도 누적 환불액은 10,000 이어야 한다(20,000 이면 이중환불).
    assert float(order.total_refunded) == 10000.0, (
        f"이중 환불 발생 — total_refunded={order.total_refunded} (기대 10000)"
    )
    # 원장도 1건이어야 한다.
    refunds = (
        await db_session.execute(select(Refund).where(Refund.order_id == order.id))
    ).scalars().all()
    assert len(refunds) == 1, f"Refund 원장 {len(refunds)}건 (기대 1건)"


@pytest.mark.asyncio
async def test_refund_allow_admitted_change_is_a_different_operation(client, db_session):
    """`allow_admitted` 는 fingerprint 에 **남아야** 한다 — 차단→예외승인은 다른 작업이다.

    reason 만 빼고 allow_admitted 까지 빼면, 운영자가 "입장객 포함 환불" 로 승인을 올려도
    앞선 차단 응답이 그대로 재생돼 **승인이 먹지 않는다.**
    """
    from app.api.v1.internal_commerce import InternalRefundRequest, _refund_fingerprint

    base = InternalRefundRequest(amount=10000, reason="사유 A")
    other_reason = InternalRefundRequest(amount=10000, reason="사유 B")
    admitted = InternalRefundRequest(amount=10000, reason="사유 A", allow_admitted=True)
    cancel_all = InternalRefundRequest(amount=10000, reason="사유 A", cancel_all=True)

    # reason 이 달라도 같은 작업 → 같은 지문
    assert _refund_fingerprint(base) == _refund_fingerprint(other_reason)
    # allow_admitted 가 다르면 다른 작업 → 다른 지문
    assert _refund_fingerprint(base) != _refund_fingerprint(admitted)
    # 같은 지급액이어도 순수 금액 환불과 주문 전체 취소는 다른 작업이다.
    assert _refund_fingerprint(base) != _refund_fingerprint(cancel_all)


@pytest.mark.asyncio
async def test_refund_rejects_missing_full_and_amount(client, db_session):
    """🔴 T20b: full 도 amount 도 없으면 400 — "누락 = 전액환불" 해석을 뒤집는다."""
    from app.models.order import Order, OrderStatus
    from app.models.refund import Refund

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "t20b-miss", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 30000}],
              "total_amount": 30000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    oid = r.json()["data"]["order_id"]
    await client.post(f"/api/v1/internal/orders/{oid}/confirm-payment",
                      json={"source": "manual", "amount": 30000}, headers=_HDR)

    # go PATCH 가 partially_refunded + amount 누락으로 보내는 형태 = 키가 통째로 빠진 body
    miss = await client.post(
        f"/api/v1/internal/orders/{oid}/refund",
        json={"reason": "금액 누락"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert miss.status_code == 400, miss.text

    # 전액 환불이 실행되지 않았어야 한다.
    order = await db_session.get(Order, uuid.UUID(oid))
    await db_session.refresh(order)
    assert float(order.total_refunded) == 0.0
    assert order.status == OrderStatus.CONFIRMED


@pytest.mark.asyncio
async def test_refund_rejects_when_pg_void_declined(client, db_session, monkeypatch):
    """🔴 PG 가 취소를 **거절**하면 환불을 확정하지 않는다(502).

    PG 는 거절을 예외가 아니라 **반환값**으로 알린다:
        nicepay_gateway: `voided = status_norm == "cancelled"`
        (취소불가 시간대·한도초과·이미취소 등은 HTTP 200 + 실패 ResultCode → voided=False, raise 없음)

    이 검사가 없으면 거절된 환불이 COMPLETED 로 확정되고 티켓 취소·재고 환원·
    total_refunded 증가까지 진행된다. **고객은 한 푼도 못 받는데 정산에서 주최자 매출만
    차감**되고, 원장에는 `pg_note={"pg":"voided"}` 라는 거짓 기록이 남는다.

    ⚠️ 이 테스트가 없어서 세 호출부 중 이 경로만 뮤테이션이 살아남았다(실측:
       `voided` 검사를 지워도 환불 관련 351건 전부 통과). refund_service·
       partial_refund_service 는 각각 덮여 있었다.
    """
    from app.models.order import Order, OrderStatus
    from app.models.refund import Refund

    class _Declining:
        provider_name = "toss"

        async def void_authorization(self, *_a, **_k):
            # HTTP 성공 + 거절. 예외가 아니다 — 그래서 except 만으로는 못 잡는다.
            return type(
                "R", (), {"transaction_id": None, "raw": {"ResultCode": "2999"}, "voided": False}
            )()

    monkeypatch.setattr(
        "app.services.payment_gateway.get_payment_gateway", lambda *_a, **_k: _Declining()
    )

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "pgdecline", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 30000}],
              "total_amount": 30000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    oid = r.json()["data"]["order_id"]
    await client.post(f"/api/v1/internal/orders/{oid}/confirm-payment",
                      json={"source": "manual", "amount": 30000}, headers=_HDR)
    order = await db_session.get(Order, uuid.UUID(oid))
    order.payment_id = "pay-decline"
    await db_session.commit()

    rf = await client.post(
        f"/api/v1/internal/orders/{oid}/refund",
        json={"amount": 10000, "reason": "거절되는 환불"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert rf.status_code == 502, rf.text
    assert rf.json()["error"]["code"] == "PG_REFUND_FAILED"

    # 🔴 원장이 움직이지 않았는지 — 502 만 확인하면 "돈은 안 갔는데 원장은 환불" 을 놓친다.
    await db_session.refresh(order)
    assert float(order.total_refunded or 0) == 0, "PG 거절인데 total_refunded 가 늘었다"
    refunds = (
        await db_session.execute(select(Refund).where(Refund.order_id == uuid.UUID(oid)))
    ).scalars().all()
    assert refunds == [], "PG 거절인데 환불 원장이 생겼다"
    assert order.status != OrderStatus.REFUNDED


async def test_refund_calls_pg_void_and_records_result(client, db_session, monkeypatch):
    """🔴 T16: 주최자 환불이 **PG 승인취소를 실제로 부른다**.

    그동안 이 경로는 원장만 바꾸고 카드 승인 취소를 하지 않았다. organizer 주석은
    "PG 취소도 v2 가 소유", v2 주석은 "go 가 이미 했으므로 재호출 없이 COMPLETED" —
    서로 미루는 사이 **고객 돈이 PG 에 남았다.**
    """
    from app.models.order import Order, OrderStatus
    from app.models.refund import Refund

    calls: list[dict] = []

    class _Spy:
        provider_name = "toss"

        async def void_authorization(self, payment_id, reason=None, amount=None):
            calls.append({"payment_id": payment_id, "amount": amount})
            # VoidResult 계약: `voided` 는 필수 필드다. 종전 스텁은 이를 빠뜨려
            # "PG 거절을 성공으로 확정" 결함을 테스트가 못 잡게 만들고 있었다.
            return type(
                "R", (), {"transaction_id": "pg-void-1", "raw": {"ok": True}, "voided": True}
            )()

    monkeypatch.setattr(
        "app.services.payment_gateway.get_payment_gateway", lambda *_a, **_k: _Spy()
    )

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "t16-pg", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 30000}],
              "total_amount": 30000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    oid = r.json()["data"]["order_id"]
    await client.post(f"/api/v1/internal/orders/{oid}/confirm-payment",
                      json={"source": "manual", "amount": 30000}, headers=_HDR)
    order = await db_session.get(Order, uuid.UUID(oid))
    order.payment_id = "pay-t16"
    await db_session.commit()

    rf = await client.post(
        f"/api/v1/internal/orders/{oid}/refund",
        json={"amount": 10000, "reason": "부분 환불"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert rf.status_code == 200, rf.text

    # 🔴 PG 를 실제로 불렀는가 + 부분 금액을 정확히 넘겼는가
    assert len(calls) == 1, f"PG void 호출 {len(calls)}회 (기대 1회)"
    assert calls[0]["amount"] == 10000, f"부분취소 금액 {calls[0]['amount']} (기대 10000)"

    # 원장에 PG 결과가 남아야 대사가 "돈이 나갔는지" 를 판정할 수 있다.
    refunds = (
        await db_session.execute(select(Refund).where(Refund.order_id == uuid.UUID(oid)))
    ).scalars().all()
    assert len(refunds) == 1
    assert refunds[0].pg_refund_id == "pg-void-1"


@pytest.mark.asyncio
async def test_refund_skips_pg_when_already_voided_by_caller(client, db_session, monkeypatch):
    """🔴 T16: `pg_already_voided` 면 PG 를 다시 부르지 않는다 — 이중 환불 차단.

    go compensation.ts 의 Toss 경로는 tossProvider.cancel 을 **먼저** 하고 이 엔드포인트를
    부른다. 여기서 또 부르면 실돈이 두 번 나간다.
    """
    from app.models.order import Order
    from app.models.refund import Refund

    calls: list[dict] = []

    class _Spy:
        provider_name = "toss"

        async def void_authorization(self, payment_id, reason=None, amount=None):
            calls.append({"payment_id": payment_id})
            return type("R", (), {"transaction_id": "should-not-happen", "raw": {}})()

    monkeypatch.setattr(
        "app.services.payment_gateway.get_payment_gateway", lambda *_a, **_k: _Spy()
    )

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "t16-skip", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 30000}],
              "total_amount": 30000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    oid = r.json()["data"]["order_id"]
    await client.post(f"/api/v1/internal/orders/{oid}/confirm-payment",
                      json={"source": "manual", "amount": 30000}, headers=_HDR)
    order = await db_session.get(Order, uuid.UUID(oid))
    order.payment_id = "pay-t16-skip"
    await db_session.commit()

    rf = await client.post(
        f"/api/v1/internal/orders/{oid}/refund",
        json={"full": True, "reason": "보상 드레인", "pg_already_voided": True},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert rf.status_code == 200, rf.text
    assert calls == [], "pg_already_voided 인데 PG 를 또 불렀다 — 이중 환불"

    refunds = (
        await db_session.execute(select(Refund).where(Refund.order_id == uuid.UUID(oid)))
    ).scalars().all()
    # "이미 취소됨" 과 "PG 없음" 은 구분돼 기록돼야 한다.
    assert refunds[0].pg_response == {"pg": "already_voided_by_caller"}


@pytest.mark.asyncio
async def test_refund_distinguishes_no_payment_from_pg_failure(client, db_session, monkeypatch):
    """🔴 T16: "PG 없음"(내부확정·무료·초대권) 과 "PG 호출 실패" 를 구분한다.

    뭉개면 "돈 안 나갔는데 환불 완료" 가 조용히 생긴다.
    """
    from app.models.order import Order, OrderStatus
    from app.models.refund import Refund

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)

    # (a) payment_id 없음 → PG 건너뛰되 기록, 환불은 정상 진행
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "t16-nopay", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 30000}],
              "total_amount": 30000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    oid = r.json()["data"]["order_id"]
    await client.post(f"/api/v1/internal/orders/{oid}/confirm-payment",
                      json={"source": "manual", "amount": 30000}, headers=_HDR)
    rf = await client.post(
        f"/api/v1/internal/orders/{oid}/refund",
        json={"full": True, "reason": "무료 주문 환불"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert rf.status_code == 200, rf.text
    refunds = (
        await db_session.execute(select(Refund).where(Refund.order_id == uuid.UUID(oid)))
    ).scalars().all()
    assert refunds[0].pg_response.get("pg") == "absent"

    # (b) PG 호출 실패 → 502 + **원장 미변경**(부분 성공 금지)
    class _Boom:
        provider_name = "toss"

        async def void_authorization(self, *a, **k):
            raise RuntimeError("PG down")

    monkeypatch.setattr(
        "app.services.payment_gateway.get_payment_gateway", lambda *_a, **_k: _Boom()
    )
    r2 = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "t16-fail", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 30000}],
              "total_amount": 30000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    oid2 = r2.json()["data"]["order_id"]
    await client.post(f"/api/v1/internal/orders/{oid2}/confirm-payment",
                      json={"source": "manual", "amount": 30000}, headers=_HDR)
    o2 = await db_session.get(Order, uuid.UUID(oid2))
    o2.payment_id = "pay-boom"
    await db_session.commit()

    bad = await client.post(
        f"/api/v1/internal/orders/{oid2}/refund",
        json={"full": True, "reason": "PG 장애"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert bad.status_code == 502, bad.text
    await db_session.refresh(o2)
    # 🔴 원장이 그대로여야 한다 — "원장은 환불인데 돈은 안 나감" 금지.
    assert float(o2.total_refunded) == 0.0
    assert o2.status == OrderStatus.CONFIRMED


@pytest.mark.asyncio
async def test_card_discount_survives_prepare_metadata_rewrite(client, db_session, monkeypatch):
    """🔴 실 흐름 회귀 — prepare 가 payment_metadata 를 통째로 재할당해도
    `card_discount` 가 살아남아야 한다.

    자체검수에서 실제로 이 결함이 있었다:
        order.payment_metadata = meta0          # card_discount 기록
        ...
        order.payment_metadata = { "prepare": ... }   # ← 12줄 뒤 전체 재할당(소실)
    T15 는 이 키를 읽어 "할인 걸린 주문인가" 를 판정하므로, 소실되면 **T15 가 실전에서
    무조건 무력화**된다. 스텁에 메타를 직접 넣는 단위테스트로는 원리적으로 못 잡는다 —
    그래서 실제 주문 + 실제 initiate_payment 로 태운다.
    """
    from app.models.discount_code import DiscountCode, DiscountCodeType
    from app.models.event import Event
    from app.models.order import Order
    from app.services.payment_service import PaymentService

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)

    # 이벤트에 BC 카드 할인 설정 + 할인코드
    code = DiscountCode(
        event_id=uuid.UUID(eid), code="BC-AUTO-TEST", discount_type=DiscountCodeType.PERCENTAGE,
        rate=10, is_active=True,
    )
    db_session.add(code)
    await db_session.flush()
    event = await db_session.get(Event, uuid.UUID(eid))
    event.card_discounts = {"BC": {"rate": 10, "card_code": "01", "discount_code": "BC-AUTO-TEST"}}
    await db_session.commit()

    # 할인코드를 적용한 주문 — v2 가 재계산해 50,000 → 45,000
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": "bc-meta", "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 45000, "discount": {"code": "BC-AUTO-TEST"}},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    oid = r.json()["data"]["order_id"]
    order = await db_session.get(Order, uuid.UUID(oid))
    # 🔴 go 가 금액을 깎아 보낸 게 아니라 **v2 가 코드로 재계산**했다는 것 자체가 계약이다.
    assert float(order.total_amount) == 45000.0

    # 나이스 게이트웨이로 prepare 실행(mock 모드)
    svc = PaymentService(db_session)
    from app.services.nicepay_gateway import NicepayGateway

    monkeypatch.setattr(svc, "gateway", NicepayGateway(), raising=False)
    monkeypatch.setattr(
        PaymentService, "_gateway_for", lambda self, o: svc.gateway, raising=False
    )
    await svc.initiate_payment(
        order_id=order.id,
        success_url="https://go.pickket.kr/ok",
        fail_url="https://go.pickket.kr/no",
    )
    await db_session.refresh(order)

    meta = order.payment_metadata or {}
    # 🔴 핵심: prepare 결과와 **함께** 살아 있어야 한다.
    assert "prepare" in meta, "prepare 메타가 없다 — 테스트 전제가 깨졌다"
    assert meta.get("card_discount"), (
        "card_discount 가 소실됐다 — T15 가 실전에서 무력화된다"
    )
    assert meta["card_discount"]["card_code"] == "01"

    # 결제창도 BC 전용으로 열려야 한다.
    assert meta["prepare"].get("SelectCardCode") == "01", (
        "SelectCardCode 미주입 — 결제창이 전 카드사로 열린다"
    )
# ── 좌석 판매 방식(seat_type) — go 운영 콘솔 배치도 노출 분기의 정본 ──────────────


@pytest.mark.asyncio
async def test_seat_type_create_roundtrip_and_default(client, db_session):
    """생성 시 seat_type 저장 / 미전송이면 모델 default(assigned)."""
    await _seed_organizer(db_session)
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(seat_type="unassigned"),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    eid = r.json()["data"]["event_id"]
    event = await db_session.get(Event, uuid.UUID(eid))
    assert event.seat_type == "unassigned"

    # 미전송 → 현행 유지(assigned). 기존 행사 회귀 방지.
    r2 = await client.post(
        "/api/v1/internal/events",
        json=_event_body(external_ref="go_evt_seat_default"),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r2.status_code == 200, r2.text
    ev2 = await db_session.get(Event, uuid.UUID(r2.json()["data"]["event_id"]))
    assert ev2.seat_type == "assigned"


@pytest.mark.asyncio
async def test_seat_type_invalid_rejected(client, db_session):
    """화이트리스트 밖 seat_type 은 400 — 오타가 조용히 저장되지 않는다."""
    await _seed_organizer(db_session)
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(seat_type="freestyle"),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 400, r.text


@pytest.mark.asyncio
async def test_seat_type_patch_allowed_without_assigned_seats(client, db_session):
    """좌석 배정 티켓이 없으면 판매 중이라도 unassigned 로 전환된다.

    🔴 갤러리 입장권처럼 좌석을 안 쓰는 행사는 판매 개시 후에야 이 문제를 발견한다 —
    '판매 개시 후 잠금' 으로 막으면 정작 전환이 필요한 행사가 영영 못 바꾼다.
    """
    from app.models.ticket import Ticket, TicketStatus

    await _seed_organizer(db_session)
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(status="bidding_open"),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    eid = r.json()["data"]["event_id"]
    euid = uuid.UUID(eid)
    event = await db_session.get(Event, euid)
    tier = SeatTier(event_id=euid, name="주말권", capacity=1000, base_price=25000, sale_mode="fixed_fcfs")
    db_session.add(tier)
    await db_session.flush()
    user = (await db_session.execute(select(User).limit(1))).scalar_one()
    # 좌석 없는(seat_id=None) 티켓은 이미 팔렸어도 전환을 막지 않는다.
    db_session.add(
        Ticket(
            event_id=euid, tier_id=tier.id, current_owner_id=user.id,
            purchase_price=25000, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE,
        )
    )
    await db_session.commit()

    p = await client.patch(
        f"/api/v1/internal/events/{eid}",
        json={"seat_type": "unassigned"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert p.status_code == 200, p.text
    await db_session.refresh(event)
    assert event.seat_type == "unassigned"


@pytest.mark.asyncio
async def test_seat_type_patch_blocked_when_seats_assigned(client, db_session):
    """좌석이 배정된 티켓이 있으면 unassigned 전환을 409 로 막는다."""
    from app.models.ticket import Ticket, TicketStatus

    await _seed_organizer(db_session)
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    eid = r.json()["data"]["event_id"]
    euid = uuid.UUID(eid)
    event = await db_session.get(Event, euid)
    tier = SeatTier(event_id=euid, name="R석", capacity=10, base_price=50000, sale_mode="fixed_fcfs")
    db_session.add(tier)
    await db_session.flush()
    seat = Seat(
        tier_id=tier.id, event_id=euid, section="A", row_number=1, seat_number=1,
        status=SeatStatus.SOLD,
    )
    db_session.add(seat)
    await db_session.flush()
    user = (await db_session.execute(select(User).limit(1))).scalar_one()
    db_session.add(
        Ticket(
            event_id=euid, tier_id=tier.id, seat_id=seat.id, current_owner_id=user.id,
            purchase_price=50000, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE,
        )
    )
    await db_session.commit()

    p = await client.patch(
        f"/api/v1/internal/events/{eid}",
        json={"seat_type": "unassigned"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert p.status_code == 409, p.text
    await db_session.refresh(event)
    assert event.seat_type == "assigned"  # 거부 시 값이 바뀌지 않는다


@pytest.mark.asyncio
async def test_seat_type_cancelled_seat_ticket_does_not_block(client, db_session):
    """취소/만료된 좌석 티켓은 전환을 막지 않는다 — 그 좌석은 이미 의미가 없다."""
    from app.models.ticket import Ticket, TicketStatus

    await _seed_organizer(db_session)
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    eid = r.json()["data"]["event_id"]
    euid = uuid.UUID(eid)
    event = await db_session.get(Event, euid)
    tier = SeatTier(event_id=euid, name="R석", capacity=10, base_price=50000, sale_mode="fixed_fcfs")
    db_session.add(tier)
    await db_session.flush()
    seat = Seat(
        tier_id=tier.id, event_id=euid, section="A", row_number=1, seat_number=2,
        status=SeatStatus.AVAILABLE,
    )
    db_session.add(seat)
    await db_session.flush()
    user = (await db_session.execute(select(User).limit(1))).scalar_one()
    db_session.add(
        Ticket(
            event_id=euid, tier_id=tier.id, seat_id=seat.id, current_owner_id=user.id,
            purchase_price=50000, sale_mode="fixed_fcfs", status=TicketStatus.CANCELLED,
        )
    )
    await db_session.commit()

    p = await client.patch(
        f"/api/v1/internal/events/{eid}",
        json={"seat_type": "unassigned"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert p.status_code == 200, p.text
    await db_session.refresh(event)
    assert event.seat_type == "unassigned"


@pytest.mark.asyncio
async def test_seat_type_exposed_in_event_detail(client, db_session):
    """이벤트 상세 응답에 seat_type 이 실린다 — go 가 이 값으로 화면을 가른다."""
    await _seed_organizer(db_session)
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(seat_type="unassigned"),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    eid = r.json()["data"]["event_id"]
    d = await client.get(f"/api/v1/internal/events/{eid}", headers=_HDR)
    assert d.status_code == 200, d.text
    assert d.json()["data"]["seat_type"] == "unassigned"


@pytest.mark.asyncio
async def test_order_detail_exposes_has_pg_payment(client, db_session):
    """주문 상세가 `has_pg_payment` 를 내려준다 — go 무통장 입금확정 게이트의 유일한 판정 근거.

    🔴 go `orders.payment_method` 는 소비자 체크아웃 주문도 'offline' 로 적어
    "진짜 무통장" 과 "카드 결제하다 이탈" 을 구분하지 못한다. 이 필드가 없으면
    카드 이탈 주문에 입금확정 버튼이 떠서 **돈을 안 받고 티켓이 발권**된다.
    """
    from app.models.order import Order, OrderStatus

    await _seed_organizer(db_session)
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    euid = uuid.UUID(r.json()["data"]["event_id"])
    user = (await db_session.execute(select(User).limit(1))).scalar_one()

    # PG 결제가 걸리지 않은 주문(무통장·내부확정) → False
    plain = Order(
        user_id=user.id, event_id=euid, quantity=1, unit_price=1000, total_amount=1000,
        status=OrderStatus.PAYMENT_REQUIRED, external_ref="go_ord_plain",
    )
    # 결제창을 거친 주문(payment_id 존재) → True
    with_pg = Order(
        user_id=user.id, event_id=euid, quantity=1, unit_price=1000, total_amount=1000,
        status=OrderStatus.PAYMENT_REQUIRED, external_ref="go_ord_pg",
        payment_id="ord_deadbeef_a1",
    )
    db_session.add_all([plain, with_pg])
    await db_session.commit()

    d1 = await client.get(f"/api/v1/internal/orders/{plain.id}", headers=_HDR)
    assert d1.status_code == 200, d1.text
    assert d1.json()["data"]["has_pg_payment"] is False

    d2 = await client.get(f"/api/v1/internal/orders/{with_pg.id}", headers=_HDR)
    assert d2.status_code == 200, d2.text
    assert d2.json()["data"]["has_pg_payment"] is True


# ─────────────────────────────────────────────────────────────────────────────
# 🔴 부분 PATCH 의미론 — "안 보냄"(보존) vs "null 로 보냄"(삭제)   (2026-08-01)
#
# 구 필드군(`description`·`venue`)이 `if body.X is not None:` 이라 **삭제만 안 됐다**.
# 주최자가 설명을 지우고 저장하면 200 과 성공 토스트를 받지만 다시 열면 옛 값이 남았다.
#
# ⚠️ 이 테스트들은 반드시 **read-after-write** 로 본다. 응답 200 만 보면 결함이 안 잡힌다
#    (종전 코드도 200 을 돌려줬다).
# ─────────────────────────────────────────────────────────────────────────────


async def test_patch_event_description_can_be_cleared(client, db_session):
    """🔴 명시 null 로 설명을 지울 수 있다(신고 결함)."""
    await _seed_organizer(db_session)
    created = await client.post(
        "/api/v1/internal/events",
        json=_event_body(description="옛 설명", external_ref=f"go_evt_{uuid.uuid4().hex[:8]}"),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    event_id = created.json()["data"]["event_id"]
    event = await db_session.get(Event, uuid.UUID(event_id))
    await db_session.refresh(event)
    assert event.description == "옛 설명"

    r = await client.patch(
        f"/api/v1/internal/events/{event_id}",
        json={"description": None},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    await db_session.refresh(event)
    assert event.description is None          # 🔴 종전엔 "옛 설명" 이 남았다


async def test_patch_event_description_blank_string_also_clears(client, db_session):
    """빈 문자열도 삭제로 본다(go 가 `|| null` 이지만 다른 호출자 대비)."""
    await _seed_organizer(db_session)
    created = await client.post(
        "/api/v1/internal/events",
        json=_event_body(description="옛 설명", external_ref=f"go_evt_{uuid.uuid4().hex[:8]}"),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    event_id = created.json()["data"]["event_id"]
    event = await db_session.get(Event, uuid.UUID(event_id))

    r = await client.patch(
        f"/api/v1/internal/events/{event_id}",
        json={"description": ""},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    await db_session.refresh(event)
    assert event.description is None


async def test_patch_event_unsent_description_is_preserved(client, db_session):
    """🔴 무회귀: 안 보낸 필드는 보존된다(삭제로 오해하면 안 된다)."""
    await _seed_organizer(db_session)
    created = await client.post(
        "/api/v1/internal/events",
        json=_event_body(description="지키자", external_ref=f"go_evt_{uuid.uuid4().hex[:8]}"),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    event_id = created.json()["data"]["event_id"]
    event = await db_session.get(Event, uuid.UUID(event_id))

    r = await client.patch(
        f"/api/v1/internal/events/{event_id}",
        json={"title": "제목만 변경"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    await db_session.refresh(event)
    assert event.title == "제목만 변경"
    assert event.description == "지키자"       # 보존


async def test_patch_event_venue_null_falls_back_to_sentinel(client, db_session):
    """🔴 venue 는 NOT NULL — null 을 보내도 **500 이 아니라** 생성과 같은 sentinel.

    빈 문자열로 저장하면 알림톡 본문(`?? "장소 미정"` nullish 폴백)이 `""` 를 못 걸러내
    "장소: " 공란이 실고객에게 발송된다. 생성 경로와 같은 값으로 통일한다.
    """
    await _seed_organizer(db_session)
    created = await client.post(
        "/api/v1/internal/events",
        json=_event_body(venue="올림픽CC", external_ref=f"go_evt_{uuid.uuid4().hex[:8]}"),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    event_id = created.json()["data"]["event_id"]
    event = await db_session.get(Event, uuid.UUID(event_id))

    r = await client.patch(
        f"/api/v1/internal/events/{event_id}",
        json={"venue": None},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text        # 🔴 IntegrityError 500 이면 실패
    await db_session.refresh(event)
    assert event.venue == "장소 미정"           # NOT NULL 이므로 sentinel
    assert event.venue != ""                   # 빈 문자열 금지(알림톡 공란 방지)


async def test_patch_event_venue_change_still_works(client, db_session):
    """무회귀: 장소 변경은 그대로 동작한다."""
    await _seed_organizer(db_session)
    created = await client.post(
        "/api/v1/internal/events",
        json=_event_body(venue="옛 장소", external_ref=f"go_evt_{uuid.uuid4().hex[:8]}"),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    event_id = created.json()["data"]["event_id"]
    event = await db_session.get(Event, uuid.UUID(event_id))

    r = await client.patch(
        f"/api/v1/internal/events/{event_id}",
        json={"venue": "새 장소"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    await db_session.refresh(event)
    assert event.venue == "새 장소"


# ── BC카드 자동할인 — 광고와 실제의 일치 (2026-08-02) ─────────────────────────
#
# 🔴 왜 이 검증이 필요한가
#
# 주문 생성(`_do_create_order` 3단계)은 할인코드가 없거나 비활성·기간경과·소진이면
# `PROMO_INVALID`(400) / `PROMO_EXHAUSTED`(409) 로 **주문 자체를 거절**한다.
# 그런데 이벤트 상세 응답은 `card_discounts` 를 `rate` 유무만 보고 내려보냈다.
#
# ⟹ 코드가 못 쓰는 상태여도 화면에는 "BC카드 10% 할인" 이 뜨고, 그걸 고른 손님은
#    할인이 아니라 **결제 실패**를 만난다. max_uses 소진이 특히 위험하다 —
#    어느 순간부터 BC 카드 손님 전원이 결제에 실패한다.
#
# 광고를 실제 사용 가능성에 묶어, 못 쓰는 코드는 애초에 광고하지 않는다.

async def _seed_card_discount(client, db_session, **code_kwargs):
    """이벤트 + BC 카드할인 매핑 + 할인코드를 심고 (event_id, code) 를 돌려준다."""
    await _seed_organizer(db_session)
    eid, _tier = await _seed_event_with_tier(client, db_session)
    code_str = code_kwargs.pop("code", "BCCARD10")
    row = DiscountCode(
        event_id=uuid.UUID(eid),
        code=code_str,
        discount_type=DiscountCodeType.PERCENTAGE,
        rate=10,
        is_active=code_kwargs.pop("is_active", True),
        **code_kwargs,
    )
    db_session.add(row)
    await db_session.flush()
    event = await db_session.get(Event, uuid.UUID(eid))
    event.card_discounts = {
        "BC": {"rate": 10, "card_code": "01", "discount_code": code_str}
    }
    await db_session.commit()
    return eid


async def _card_discounts_of(client, eid):
    r = await client.get(f"/api/v1/internal/events/{eid}", headers=_HDR)
    assert r.status_code == 200, r.text
    return r.json()["data"]["card_discounts"]


@pytest.mark.asyncio
async def test_card_discount_advertised_when_code_usable(client, db_session):
    """정상 코드면 광고된다 — 가드가 전부를 막아버리는 헛통과를 방지한다."""
    eid = await _seed_card_discount(client, db_session)
    cd = await _card_discounts_of(client, eid)
    assert cd and "BC" in cd, "쓸 수 있는 코드인데 광고되지 않았다"
    assert cd["BC"]["rate"] == 10
    assert cd["BC"]["discount_code"] == "BCCARD10"


@pytest.mark.asyncio
async def test_card_discount_hidden_when_code_missing(client, db_session):
    """매핑이 가리키는 코드가 **존재하지 않으면** 광고하지 않는다."""
    await _seed_organizer(db_session)
    eid, _tier = await _seed_event_with_tier(client, db_session)
    event = await db_session.get(Event, uuid.UUID(eid))
    event.card_discounts = {
        "BC": {"rate": 10, "card_code": "01", "discount_code": "존재하지않는코드"}
    }
    await db_session.commit()
    assert await _card_discounts_of(client, eid) is None, (
        "없는 코드를 광고했다 — 손님이 결제 단계에서 400 을 맞는다"
    )


@pytest.mark.asyncio
async def test_card_discount_hidden_when_code_inactive(client, db_session):
    """비활성 코드는 광고하지 않는다."""
    eid = await _seed_card_discount(client, db_session, is_active=False)
    assert await _card_discounts_of(client, eid) is None


@pytest.mark.asyncio
async def test_card_discount_hidden_when_code_expired(client, db_session):
    """기간이 지난 코드는 광고하지 않는다."""
    eid = await _seed_card_discount(
        client, db_session,
        valid_until=datetime.now(timezone.utc) - timedelta(hours=1),
    )
    assert await _card_discounts_of(client, eid) is None


@pytest.mark.asyncio
async def test_card_discount_hidden_when_code_exhausted(client, db_session):
    """🔴 사용 한도가 찬 코드는 광고하지 않는다.

    가장 위험한 경우다 — 판매 도중 어느 순간부터 BC 손님 전원이 409 를 맞는다.
    """
    eid = await _seed_card_discount(client, db_session, max_uses=5, used_count=5)
    assert await _card_discounts_of(client, eid) is None


@pytest.mark.asyncio
async def test_card_discount_matches_code_case_insensitively(client, db_session):
    """설정에 소문자를 써도 성립해야 한다.

    v2 는 코드를 대문자로 저장한다(`create: body.code.upper()`). 설정 오타 하나가
    광고 누락으로 이어지면 안 된다 — 결제 경로도 같은 이유로 정규화한다
    (`payment_service._resolve_order_card_discount`).
    """
    await _seed_organizer(db_session)
    eid, _tier = await _seed_event_with_tier(client, db_session)
    db_session.add(DiscountCode(
        event_id=uuid.UUID(eid), code="BCCARD10",
        discount_type=DiscountCodeType.PERCENTAGE, rate=10, is_active=True,
    ))
    await db_session.flush()
    event = await db_session.get(Event, uuid.UUID(eid))
    event.card_discounts = {
        "BC": {"rate": 10, "card_code": "01", "discount_code": "bccard10"}  # 소문자
    }
    await db_session.commit()
    cd = await _card_discounts_of(client, eid)
    assert cd and "BC" in cd, "소문자 설정이 광고에서 누락됐다"


@pytest.mark.asyncio
async def test_card_discount_hidden_when_no_discount_code_configured(client, db_session):
    """적용할 코드가 없는 매핑은 광고하지 않는다 — 고르면 깎일 것이 없다."""
    await _seed_organizer(db_session)
    eid, _tier = await _seed_event_with_tier(client, db_session)
    event = await db_session.get(Event, uuid.UUID(eid))
    event.card_discounts = {"BC": {"rate": 10, "card_code": "01"}}
    await db_session.commit()
    assert await _card_discounts_of(client, eid) is None


# ═══════════════════════════════════════════════════════════════════
# 🔴 만료 주문 재생 (2026-08-08 실장애 — 손님이 영구히 결제 불가)
#
# 체크아웃 토큰은 localStorage 에 **영구** 저장된다. 결제창을 열기 전에 주문이 만들어지고,
# 이탈하면 PENDING 으로 남았다가 30분 뒤 EXPIRED 가 된다. 같은 브라우저로 다시 오면
# 같은 토큰 → dedup 이 **그 만료 주문을 그대로 돌려줬다** → prepare 거절 → 502.
# 🔴 새로고침해도 그대로. 같은 브라우저에서는 영영 결제 못 한다.
#
# prod 로그(08-08 06:15·08:13, 같은 주문으로 5회):
#   ValueError: Cannot initiate payment for order in status 'expired'
#
# ⚠️ 이 결함은 **주문이 만료될 만큼 시간이 지나야** 드러난다 — 단위·E2E 에서 안 나온다.
#    그래서 상태를 직접 만들어 재현한다.
#
# 🔴 가장 중요한 것은 **고치다가 이중과금 방지를 깨지 않는 것**이다. 그쪽이 훨씬 비싸다.
# ═══════════════════════════════════════════════════════════════════


async def _order_with_status(client, db_session, user, eid, tier, *, ext, status,
                             payment_id=None, pg_transaction_id=None):
    """dedup 대상 주문 1건을 만들고 지정한 상태로 옮긴다."""
    r = await client.post(
        "/api/v1/internal/orders",
        json={"external_order_id": ext, "user_id": str(user.id), "event_id": eid,
              "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
              "total_amount": 50000},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    from app.models.order import Order

    assert r.status_code == 200, r.text
    o = await db_session.get(Order, uuid.UUID(r.json()["data"]["order_id"]))
    o.status = status
    if payment_id is not None:
        o.payment_id = payment_id
    if pg_transaction_id is not None:
        o.pg_transaction_id = pg_transaction_id
    await db_session.commit()
    return o


def _replay_body(user, eid, tier, ext):
    return {"external_order_id": ext, "user_id": str(user.id), "event_id": eid,
            "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
            "total_amount": 50000}


async def test_expired_order_is_not_replayed(client, db_session):
    """🔴 만료 주문은 재생되지 않는다 — 이게 안 되면 손님이 영구히 결제 불가다."""
    from app.models.order import OrderStatus as OS

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _order_with_status(client, db_session, user, eid, tier,
                             ext="go_exp_1", status=OS.EXPIRED)

    r = await client.post("/api/v1/internal/orders",
                          json=_replay_body(user, eid, tier, "go_exp_1"),
                          headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 409, r.text
    err = r.json()["error"]
    assert err["code"] == "ORDER_NOT_REPLAYABLE"
    # 🔴 어떤 상태였는지를 실어야 운영이 원인을 안다(문구 파싱 금지)
    assert err["details"]["order_status"] == "expired"


async def test_cancelled_order_is_not_replayed(client, db_session):
    """취소 주문도 되살릴 길이 없다."""
    from app.models.order import OrderStatus as OS

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _order_with_status(client, db_session, user, eid, tier,
                             ext="go_can_1", status=OS.CANCELLED)
    r = await client.post("/api/v1/internal/orders",
                          json=_replay_body(user, eid, tier, "go_can_1"),
                          headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 409
    assert r.json()["error"]["details"]["order_status"] == "cancelled"


async def test_paid_order_is_still_replayed(client, db_session):
    """🔴 **이중과금 방지의 본체** — 결제 완료 주문은 반드시 재생된다.

    이 수정의 가장 큰 위험은 고치다가 여기를 깨는 것이다. 만료 주문이 재생되는 것보다
    결제된 주문이 **다시 결제되는 것**이 훨씬 비싸다.
    """
    from app.models.order import OrderStatus as OS

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    for i, st in enumerate((OS.PAID, OS.CONFIRMED, OS.AUTHORIZED,
                            OS.REFUNDED, OS.PARTIALLY_REFUNDED)):
        ext = f"go_paid_{i}"
        first = await _order_with_status(client, db_session, user, eid, tier,
                                         ext=ext, status=st)
        r = await client.post("/api/v1/internal/orders",
                              json=_replay_body(user, eid, tier, ext),
                              headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
        assert r.status_code == 200, f"{st}: {r.text}"
        # 🔴 같은 주문이 돌아와야 한다 — 새 주문이 생기면 그게 이중과금이다
        assert r.json()["data"]["order_id"] == str(first.id), st


async def test_pending_order_is_still_replayed(client, db_session):
    """아직 결제 가능한 주문은 지금 그대로 재생된다(정상 재시도)."""
    from app.models.order import OrderStatus as OS

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    for i, st in enumerate((OS.PENDING, OS.PAYMENT_REQUIRED)):
        ext = f"go_pend_{i}"
        first = await _order_with_status(client, db_session, user, eid, tier,
                                         ext=ext, status=st)
        r = await client.post("/api/v1/internal/orders",
                              json=_replay_body(user, eid, tier, ext),
                              headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
        assert r.status_code == 200, f"{st}: {r.text}"
        assert r.json()["data"]["order_id"] == str(first.id)


async def test_cancelled_order_with_captured_payment_is_replayed(client, db_session):
    """🔴 **승인이 성립한** 주문은 상태가 무엇이든 재생한다 — 숨기면 이중과금이 된다.

    승인의 증거는 `pg_transaction_id`(PG 거래번호)다. 승인 검증을 통과한 뒤에만 박힌다.
    """
    from app.models.order import OrderStatus as OS

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    first = await _order_with_status(client, db_session, user, eid, tier,
                                     ext="go_can_pay", status=OS.CANCELLED,
                                     payment_id="pay_real_1",
                                     pg_transaction_id="tid_real_1")
    r = await client.post("/api/v1/internal/orders",
                          json=_replay_body(user, eid, tier, "go_can_pay"),
                          headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text
    assert r.json()["data"]["order_id"] == str(first.id)


async def test_expired_order_that_only_opened_the_window_is_not_replayed(client, db_session):
    """🔴 2026-08-09 실장애 — 결제창만 열고 이탈해 만료된 주문이 계속 재생됐다.

    `payment_id` 는 **결제창을 열었다**는 표시일 뿐이다(prepare 시점에 박힌다).
    그것을 "돈이 걸렸다" 로 읽으면, 아침에 결제하다 만 손님이 저녁에 다시 와도
    같은 만료 주문이 돌아오고 prepare 가 거절해 **영영 못 산다**(prod 실측: 같은
    주문이 5회 이상 반복 실패).

    ⚠️ 판정은 `pg_transaction_id` 로 한다. 이 테스트가 그 경계를 고정한다.
    """
    from app.models.order import OrderStatus as OS

    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _order_with_status(client, db_session, user, eid, tier,
                             ext="go_exp_window", status=OS.EXPIRED,
                             payment_id="ord_openedwindow_a1")  # TID 없음 = 승인 안 됨

    r = await client.post("/api/v1/internal/orders",
                          json=_replay_body(user, eid, tier, "go_exp_window"),
                          headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "ORDER_NOT_REPLAYABLE"
    assert r.json()["error"]["details"]["order_status"] == "expired"


async def test_payable_statuses_share_one_source(client, db_session):
    """🔴 dedup 과 prepare 가 **같은 출처**를 본다.

    두 곳에 목록을 따로 적으면 다음에 한쪽만 바뀐다 — 이 결함이 정확히 그렇게 생겼다
    (dedup 은 "이 주문 줄게", prepare 는 "이 주문엔 결제 못 걸어").
    """
    import inspect

    from app.api.v1 import internal_commerce as ic
    from app.services.payment_service import PAYABLE_ORDER_STATUSES
    from app.models.order import OrderStatus as OS

    assert PAYABLE_ORDER_STATUSES == (OS.PENDING, OS.PAYMENT_REQUIRED)
    src = inspect.getsource(ic._assert_order_replayable)
    assert "PAYABLE_ORDER_STATUSES" in src, "dedup 이 목록을 따로 적고 있다"


async def test_new_tier_inherits_lottery_sale_plan(client, db_session):
    """판매 계획(공정 추첨)을 세운 뒤 새로 추가한 입장권 등급은 point_lottery 로 시작한다.

    등급 추가 화면은 판매 방식을 묻지 않아 기본값 fixed_fcfs 가 오는데, 그대로 두면 추첨 계획
    아래에서 선착순 등급이 섞여 가중치 추첨이 적용되지 않는다. 명시한 방식은 그대로 둔다.
    """
    from datetime import datetime, timedelta, timezone

    from app.models.phase_config import PhaseConfig

    await _seed_organizer(db_session)
    eid = await _create_event(client)
    now = datetime.now(timezone.utc)
    db_session.add(
        PhaseConfig(
            event_id=uuid.UUID(eid), phase="lottery", starts_at=now + timedelta(days=1),
            ends_at=now + timedelta(days=2), sort_order=0, status="scheduled", config={},
        )
    )
    await db_session.flush()
    r = await client.post(
        f"/api/v1/internal/events/{eid}/tiers",
        json={"tiers": [
            {"external_ref": "t_new", "name": "갤러리", "capacity": 20, "base_price": 30000, "sale_mode": "fixed_fcfs"},
            {"external_ref": "t_addon", "name": "주차", "capacity": 20, "base_price": 5000, "sale_mode": "fixed_fcfs", "product_type": "addon"},
            {"external_ref": "t_queue", "name": "대기열", "capacity": 20, "base_price": 1000, "sale_mode": "queue"},
        ]},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    lst = (await client.get(f"/api/v1/internal/events/{eid}/tiers", headers=_HDR)).json()["data"]["tiers"]
    mode = {t["external_ref"]: t["sale_mode"] for t in lst}
    assert mode == {"t_new": "point_lottery", "t_addon": "fixed_fcfs", "t_queue": "queue"}
