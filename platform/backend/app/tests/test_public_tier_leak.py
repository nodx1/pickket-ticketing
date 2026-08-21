"""공개 표면에서 숨김 티어가 새지 않는가 — 커밋된 회귀.

적대 검증이 두 번 같은 부류를 잡았다:

    1차   `/events/{id}`·`/tiers/remaining`·`/transparency` 가 숨김 티어 id 를 흘림
    2차   `get_event` 만 고쳤더니 **같은 직렬화를 하는 4곳**이 그대로였음
          (`/sessions`·`/public-events`·`/me/favorites` · 그리고 캐시)

⚠️ 그래서 판정을 `events.public_seat_tier_ids` **한 곳**에 두고, 이 파일이 표면별로
   그 결과를 확인한다. 표면을 새로 만들면 여기에 한 줄 추가하는 것이 규칙이다.

🔴 그리고 **캐시가 필터를 무력화한다.** 옛 키에 숨김이 들어 있거나 무효화가 빠지면
   최대 TTL 동안 옛 값이 나간다 — 숨기는 조치가 5분 늦게 먹는다는 뜻이다.
"""
import uuid

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.event import Event
from app.tests.test_internal_commerce import (
    _seed_event_with_tier,
    _seed_organizer,
)

pytestmark = pytest.mark.asyncio

_SVC_SECRET = "test-go-webhook-secret"


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    """시드 헬퍼가 내부 API 를 타므로 서비스 토큰이 필요하다."""
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SVC_SECRET)


async def _hide_tier(db_session, tier):
    tier.visibility = "hidden"
    await db_session.commit()


async def test_public_event_detail_hides_hidden_tier(client, db_session):
    """`GET /events/{id}` 응답의 seat_tiers 에 숨김 티어가 없어야 한다.

    🔴 처음 구현은 응답 dict 의 `visibility` 로 걸렀는데 `SeatTierResponse` 가 그
       필드를 **안 내보내서** 아무것도 안 걸러졌다. ORM 기준 판정 + id 필터가 정답.
    """
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _hide_tier(db_session, tier)

    ev = (await db_session.execute(select(Event).where(Event.id == uuid.UUID(eid)))).scalar_one()
    r = await client.get(f"/api/v1/events/{ev.id}")
    assert r.status_code == 200, r.text
    ids = [str(t["id"]) for t in (r.json().get("seat_tiers") or [])]
    assert str(tier.id) not in ids, "공개 상세가 숨김 티어를 흘린다"


async def test_public_tiers_list_hides_hidden_tier(client, db_session):
    """`GET /events/{id}/tiers` — consumer 상세가 쓰는 표면."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _hide_tier(db_session, tier)

    ev = (await db_session.execute(select(Event).where(Event.id == uuid.UUID(eid)))).scalar_one()
    r = await client.get(f"/api/v1/events/{ev.id}/tiers")
    assert r.status_code == 200, r.text
    assert str(tier.id) not in [str(t["id"]) for t in r.json()]


async def test_tiers_remaining_hides_hidden_tier(client, db_session):
    """`GET /events/{id}/tiers/remaining` — 🔴 응답의 **키가 티어 id** 라 그 자체가 유출."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _hide_tier(db_session, tier)

    ev = (await db_session.execute(select(Event).where(Event.id == uuid.UUID(eid)))).scalar_one()
    r = await client.get(f"/api/v1/events/{ev.id}/tiers/remaining")
    assert r.status_code in (200, 404), r.text
    if r.status_code == 200:
        assert str(tier.id) not in r.json(), "잔여석 응답 키로 숨김 티어 id 가 샌다"


async def test_public_seat_tier_ids_is_single_source(db_session):
    """판정이 한 곳인지 — 표면이 늘어도 여기만 고치면 되게."""
    from app.api.v1.events import public_seat_tier_ids

    class _T:
        def __init__(self, tid, vis, active):
            self.id, self.visibility, self.is_active = tid, vis, active

    class _E:
        seat_tiers = [
            _T("a", "public", True),
            _T("b", "hidden", True),
            _T("c", "public", False),
            _T("d", "private", True),
        ]

    assert public_seat_tier_ids(_E()) == {"a"}
