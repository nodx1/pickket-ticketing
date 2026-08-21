from datetime import datetime, timezone, timedelta

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

import app.services.public_data_service as public_data_module
from app.models.event import Event, EventStatus
from app.models.order import Order, OrderStatus
from app.models.user import User
from app.services.public_data_service import PublicDataService


async def _create_user(
    db_session: AsyncSession,
    *,
    email: str,
    name: str = "Test User",
    is_organizer: bool = True,
) -> User:
    user = User(
        email=email,
        hashed_password="hashed-password",
        name=name,
        is_active=True,
        is_organizer=is_organizer,
    )
    db_session.add(user)
    await db_session.commit()
    await db_session.refresh(user)
    return user


@pytest.mark.asyncio
async def test_fetch_festivals_falls_back_without_api_key(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.delenv("DATA_GO_KR_API_KEY", raising=False)
    service = PublicDataService(db_session)

    festivals = await service.fetch_festivals(region="서울", year=2026)

    assert len(festivals) == 2
    assert all(item["source"] == "data.go.kr-stub" for item in festivals)
    assert all(item["region"] == "서울특별시" for item in festivals)
    assert all(item["description"] for item in festivals)


@pytest.mark.asyncio
async def test_fetch_festivals_maps_api_response(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("DATA_GO_KR_API_KEY", "test-api-key")
    captured: dict[str, object] = {}

    payload = {
        "data": [
            {
                "축제명": "서울 빛축제",
                "개최장소": "서울광장",
                "축제시작일자": "2026-12-01",
                "축제종료일자": "2026-12-03",
                "축제내용": "도심 야간 문화축제",
                "관할지자체명": "서울특별시 중구",
            },
            {
                "축제명": "지난 해 행사",
                "개최장소": "부산항",
                "축제시작일자": "2025-10-01",
                "축제종료일자": "2025-10-02",
                "축제내용": "필터링 대상",
                "관할지자체명": "부산광역시",
            },
            {
                "축제명": "",
                "개최장소": "무효",
                "축제시작일자": "2026-01-01",
                "축제종료일자": "2026-01-02",
                "축제내용": "제목 없음",
                "관할지자체명": "서울특별시",
            },
        ]
    }

    class FakeResponse:
        def raise_for_status(self) -> None:
            return None

        def json(self) -> dict:
            return payload

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            captured["timeout"] = kwargs.get("timeout")

        async def __aenter__(self):
            return self

        async def __aexit__(self, exc_type, exc, tb):
            return False

        async def get(self, url: str, params: dict) -> FakeResponse:
            captured["url"] = url
            captured["params"] = params
            return FakeResponse()

    monkeypatch.setattr(public_data_module.httpx, "AsyncClient", FakeAsyncClient)
    service = PublicDataService(db_session)

    festivals = await service.fetch_festivals(
        region="서울",
        year=2026,
        page=2,
        per_page=10,
    )

    assert captured["url"] == public_data_module.DATA_GO_KR_FESTIVAL_URL
    assert captured["params"] == {
        "serviceKey": "test-api-key",
        "page": 2,
        "perPage": 10,
        "returnType": "JSON",
    }
    assert festivals == [
        {
            "title": "서울 빛축제",
            "venue": "서울광장",
            "start_date": "2026-12-01",
            "end_date": "2026-12-03",
            "description": "도심 야간 문화축제",
            "region": "서울특별시 중구",
            "source": "data.go.kr",
            "year": 2026,
        }
    ]


@pytest.mark.asyncio
async def test_sync_to_events_upserts_duplicate_festival(
    db_session: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
):
    organizer = await _create_user(
        db_session,
        email="festival-organizer@example.com",
        name="Festival Organizer",
    )
    service = PublicDataService(db_session)
    festivals = [
        {
            "title": "서울 문화축제 2026",
            "venue": "서울 시민광장",
            "start_date": "2026-05-01",
            "end_date": "2026-05-03",
            "description": "초기 설명",
            "region": "서울특별시",
            "source": "data.go.kr",
            "year": 2026,
        }
    ]

    async def fake_fetch_festivals(
        db: AsyncSession | None = None,
        region: str | None = None,
        year: int = 2026,
        page: int = 1,
        per_page: int = 50,
    ) -> list[dict]:
        _ = (db, region, year, page, per_page)
        return festivals

    monkeypatch.setattr(service, "fetch_festivals", fake_fetch_festivals)

    first_sync = await service.sync_to_events(organizer.id, region="서울", year=2026)
    await db_session.commit()

    festivals[0]["description"] = "갱신된 설명"
    second_sync = await service.sync_to_events(organizer.id, region="서울", year=2026)
    await db_session.commit()

    count = await db_session.scalar(select(func.count(Event.id)))
    event = await db_session.scalar(select(Event))

    assert len(first_sync) == 1
    assert len(second_sync) == 1
    assert count == 1
    assert event is not None
    assert event.description == "갱신된 설명"
    assert event.category == "festival"
    assert event.sub_category == "지역축제"
    assert event.status == EventStatus.DRAFT
    assert event.is_public_sector is True
    assert event.is_free is True
    assert event.event_date_end is not None


@pytest.mark.asyncio
async def test_public_data_festivals_endpoint_returns_payload(
    client,
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.delenv("DATA_GO_KR_API_KEY", raising=False)

    response = await client.get(
        "/api/v1/public-data/festivals",
        params={"region": "서울", "year": 2026},
    )

    assert response.status_code == 200
    body = response.json()
    assert len(body) == 2
    assert body[0]["region"] == "서울특별시"
    assert body[0]["source"] == "data.go.kr-stub"


@pytest.mark.asyncio
async def test_time_slots_endpoint_returns_daily_availability(
    client,
    db_session: AsyncSession,
):
    organizer = await _create_user(
        db_session,
        email="timeslot-organizer@example.com",
        name="Timed Entry Organizer",
    )
    attendee = await _create_user(
        db_session,
        email="timeslot-attendee@example.com",
        name="Timed Entry Attendee",
        is_organizer=False,
    )

    now = datetime.now(timezone.utc)
    event = Event(
        organizer_id=organizer.id,
        title="Timed Entry Exhibition",
        slug="test-public-data-timed-entry",
        description="Timed entry test event",
        venue="Seoul Museum",
        event_date=datetime(2026, 3, 15, 9, 0, tzinfo=timezone.utc),
        event_date_end=datetime(2026, 3, 15, 18, 0, tzinfo=timezone.utc),
        bidding_opens_at=now - timedelta(days=1),
        bidding_closes_at=now + timedelta(days=1),
        total_seats=30,
        min_price=0,
        max_price=0,
        category="exhibition",
        status=EventStatus.APPROVED,
        time_slot_enabled=True,
        time_slot_capacity=10,
        time_slot_duration_minutes=180,
    )
    db_session.add(event)
    await db_session.flush()

    db_session.add(
        Order(
            user_id=attendee.id,
            event_id=event.id,
            status=OrderStatus.CONFIRMED,
            quantity=4,
            unit_price=0,
            total_amount=0,
            time_slot_start=datetime(2026, 3, 15, 9, 0, tzinfo=timezone.utc),
            time_slot_end=datetime(2026, 3, 15, 12, 0, tzinfo=timezone.utc),
        )
    )
    await db_session.commit()

    response = await client.get(
        f"/api/v1/events/{event.id}/time-slots",
        params={"date": "2026-03-15"},
    )

    assert response.status_code == 200
    body = response.json()
    assert len(body["slots"]) == 3
    assert body["slots"][0]["available"] == 6
    assert body["slots"][0]["total"] == 10
    assert body["slots"][1]["available"] == 10
    assert body["slots"][2]["available"] == 10
