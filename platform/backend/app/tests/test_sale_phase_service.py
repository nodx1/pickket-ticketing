"""레벨2 컷오버 T2-PHASE — 판매 단계(sale plan) 정본 이전 회귀.

검증 축:
  1. go `sale-plan/service.ts` 시간 정책이 v2 로 정확히 이식됐는가
     (24h 간격·72h 결제창·168h 대기자·24h 승격결제창·비율합 100·모드중복 금지·
      이벤트 시작 이전 종료).
  2. **현존 P0 #1** — 승인 이후 판매계획 변경이 phase_configs 에 반영되는가
     (정본 write 경로 존재 + 재적용 시 갱신).
  3. **현존 P0 #2** — payment_window_hours / waitlist_payment_window_hours /
     fanclub_id 가 Redis 가 아니라 DB(config JSONB)에 영속되는가.
  4. delete-then-insert 안전 — 빈 입력·검증 실패가 기존 phase 를 지우지 못하는가.
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.api.v1.internal_sync import _upsert_phase_configs
from app.models.event import Event, EventStatus
from app.models.phase_config import PhaseConfig
from app.models.user import User
from app.services import sale_phase_service as sps

UTC = timezone.utc


async def _mk_user(db) -> User:
    u = User(
        id=uuid.uuid4(),
        email=f"org_{uuid.uuid4().hex[:8]}@test.io",
        name="주최자",
        hashed_password="x",
    )
    db.add(u)
    await db.flush()
    return u


async def _mk_event(db, *, days_ahead: int = 60) -> Event:
    start = datetime.now(UTC) + timedelta(days=days_ahead)
    ev = Event(
        id=uuid.uuid4(),
        organizer_id=(await _mk_user(db)).id,
        title="T2 판매단계 이벤트",
        slug=f"t2-phase-{uuid.uuid4().hex[:8]}",
        venue="테스트홀",
        event_date=start,
        bidding_opens_at=start - timedelta(days=30),
        bidding_closes_at=start - timedelta(days=1),
        total_seats=100,
        status=EventStatus.APPROVED,
    )
    db.add(ev)
    await db.flush()
    return ev


def _policy() -> sps.PhaseTimingPolicy:
    return sps.PhaseTimingPolicy(
        gap_hours=24,
        primary_payment_window_hours=72,
        waitlist_duration_hours=168,
        waitlist_payment_window_hours=24,
    )


def _lottery_spec(opens: datetime, *, hours: int = 24 * 7, ratio: float = 100.0):
    return sps.PhaseSpec(
        mode="lottery",
        ratio_pct=ratio,
        opens_at=opens,
        closes_at=opens + timedelta(hours=hours),
    )


# ── 1. 시간 정책 이식 ────────────────────────────────────────────────────


def test_default_policy_matches_go_constants():
    p = sps.resolve_timing_policy()
    assert p.gap_hours == 24
    assert p.primary_payment_window_hours == 72
    assert p.waitlist_duration_hours == 168
    assert p.waitlist_payment_window_hours == 24
    # 주 단계 사이 최소 간격 = 결제창 + 간격 = 96h (go MIN_BETWEEN_MAIN_PHASES_HOURS)
    assert p.min_between_main_phases_hours == 96


def test_empty_phases_requires_fcfs_opens_at():
    with pytest.raises(sps.SalePlanError):
        sps.validate_phase_specs([], None, _policy())
    # fcfs 시작 시각만 있으면 통과(선착순 단독 이벤트)
    sps.validate_phase_specs([], datetime.now(UTC), _policy())


def test_ratio_sum_must_be_100():
    now = datetime.now(UTC)
    phases = [
        sps.PhaseSpec("lottery", 40, now, now + timedelta(days=1)),
        sps.PhaseSpec("queue_sale", 40, now + timedelta(days=6), now + timedelta(days=7)),
    ]
    with pytest.raises(sps.SalePlanError, match="100%"):
        sps.validate_phase_specs(phases, None, _policy())


def test_duplicate_mode_rejected():
    now = datetime.now(UTC)
    phases = [
        sps.PhaseSpec("lottery", 50, now, now + timedelta(days=1)),
        sps.PhaseSpec("lottery", 50, now + timedelta(days=6), now + timedelta(days=7)),
    ]
    with pytest.raises(sps.SalePlanError, match="중복"):
        sps.validate_phase_specs(phases, None, _policy())


def test_more_than_three_phases_rejected():
    now = datetime.now(UTC)
    phases = [
        sps.PhaseSpec("lottery", 25, now, now + timedelta(days=1)),
        sps.PhaseSpec("queue_sale", 25, now + timedelta(days=6), now + timedelta(days=7)),
        sps.PhaseSpec("membership_presale", 25, now + timedelta(days=12), now + timedelta(days=13), "fc"),
        sps.PhaseSpec("lottery", 25, now + timedelta(days=18), now + timedelta(days=19)),
    ]
    with pytest.raises(sps.SalePlanError, match="최대 3개"):
        sps.validate_phase_specs(phases, None, _policy())


def test_gap_between_main_phases_must_be_at_least_96h():
    now = datetime.now(UTC)
    first_closes = now + timedelta(days=1)
    # 95h 간격 → 거부
    too_close = [
        sps.PhaseSpec("lottery", 50, now, first_closes),
        sps.PhaseSpec("queue_sale", 50, first_closes + timedelta(hours=95), first_closes + timedelta(hours=120)),
    ]
    with pytest.raises(sps.SalePlanError, match="96"):
        sps.validate_phase_specs(too_close, None, _policy())
    # 96h 정확히 → 통과
    ok = [
        sps.PhaseSpec("lottery", 50, now, first_closes),
        sps.PhaseSpec("queue_sale", 50, first_closes + timedelta(hours=96), first_closes + timedelta(hours=120)),
    ]
    sps.validate_phase_specs(ok, None, _policy())


def test_membership_requires_fanclub():
    now = datetime.now(UTC)
    phases = [sps.PhaseSpec("membership_presale", 100, now, now + timedelta(days=1))]
    with pytest.raises(sps.SalePlanError, match="팬클럽"):
        sps.validate_phase_specs(phases, None, _policy())
    phases[0].fanclub_id = str(uuid.uuid4())
    sps.validate_phase_specs(phases, None, _policy())


def test_closes_must_be_after_opens():
    now = datetime.now(UTC)
    phases = [sps.PhaseSpec("lottery", 100, now, now)]
    with pytest.raises(sps.SalePlanError, match="이후"):
        sps.validate_phase_specs(phases, None, _policy())


def test_event_start_must_leave_room_for_waitlist_and_payment():
    now = datetime.now(UTC)
    phases = [_lottery_spec(now)]
    last_close = phases[-1].closes_at
    # 결제창 72h + 대기자 168h = 240h 이내에 공연이 시작되면 거부
    with pytest.raises(sps.SalePlanError, match="너무 빠릅니다"):
        sps.validate_against_event(
            phases, None, last_close + timedelta(hours=239), _policy()
        )
    sps.validate_against_event(phases, None, last_close + timedelta(hours=241), _policy())


def test_fcfs_only_must_open_before_event_start():
    now = datetime.now(UTC)
    with pytest.raises(sps.SalePlanError, match="선착순 시작"):
        sps.validate_against_event([], now, now - timedelta(hours=1), _policy())


# ── 2. 시퀀스 구성 + config 영속 (현존 버그 #2) ──────────────────────────


def test_fcfs_only_sequence():
    opens = datetime.now(UTC)
    event_start = opens + timedelta(days=30)
    rows = sps.build_phase_rows([], opens, 100, event_start, _policy())
    assert [r.phase for r in rows] == ["fcfs_residual"]
    assert rows[0].ends_at == event_start
    assert rows[0].target_quantity is None


def test_lottery_sequence_appends_waitlist_and_fcfs_with_persisted_config():
    opens = datetime.now(UTC)
    spec = _lottery_spec(opens)
    event_start = spec.closes_at + timedelta(hours=400)
    rows = sps.build_phase_rows([spec], None, 200, event_start, _policy())

    assert [r.phase for r in rows] == ["lottery", "waitlist_promotion", "fcfs_residual"]
    assert [r.sort_order for r in rows] == [1, 2, 3]

    # 주 단계: 좌석 비율 배정 + 결제창 72h 가 config 에 **영속**된다 (Redis 아님)
    assert rows[0].target_quantity == 200
    assert rows[0].config["payment_window_hours"] == 72

    # 대기자 승격: 마지막 주 단계 마감 + 72h 에 열리고 168h 지속, 승격 결제창 24h 영속
    assert rows[1].starts_at == spec.closes_at + timedelta(hours=72)
    assert rows[1].ends_at == rows[1].starts_at + timedelta(hours=168)
    assert rows[1].config["waitlist_payment_window_hours"] == 24
    assert rows[1].target_quantity is None

    # 잔여 선착순: 대기자 종료 ~ 공연 시작
    assert rows[2].starts_at == rows[1].ends_at
    assert rows[2].ends_at == event_start


def test_membership_fanclub_id_persisted_in_config():
    opens = datetime.now(UTC)
    fanclub_id = str(uuid.uuid4())
    spec = sps.PhaseSpec(
        "membership_presale", 100, opens, opens + timedelta(days=3), fanclub_id
    )
    rows = sps.build_phase_rows(
        [spec], None, 50, spec.closes_at + timedelta(hours=400), _policy()
    )
    assert rows[0].config["fanclub_id"] == fanclub_id


def test_ratio_split_quota():
    opens = datetime.now(UTC)
    second_opens = opens + timedelta(days=1, hours=96)
    phases = [
        sps.PhaseSpec("lottery", 30, opens, opens + timedelta(days=1)),
        sps.PhaseSpec("queue_sale", 70, second_opens, second_opens + timedelta(days=1)),
    ]
    rows = sps.build_phase_rows(
        phases, None, 100, phases[-1].closes_at + timedelta(hours=400), _policy()
    )
    assert rows[0].target_quantity == 30
    assert rows[1].target_quantity == 70


# ── 3. apply_sale_plan — 정본 write 경로 (현존 버그 #1) ──────────────────


@pytest.mark.asyncio
async def test_apply_sale_plan_persists_and_is_reapplicable(db_session):
    """승인 후 판매계획을 다시 바꿔도 phase_configs 가 갱신된다(현존 버그 #1의 반례)."""
    event = await _mk_event(db_session, days_ahead=90)
    fcfs_opens = datetime.now(UTC) + timedelta(days=1)

    await sps.apply_sale_plan(db_session, event, [], fcfs_opens)
    rows = await sps.list_phases(db_session, event.id)
    assert [r.phase for r in rows] == ["fcfs_residual"]
    assert rows[0].starts_at.replace(tzinfo=UTC) == fcfs_opens.replace(microsecond=fcfs_opens.microsecond)

    # 판매창이 단계에서 파생된다 — 심사요청 웹훅에 의존하지 않는다.
    assert event.bidding_opens_at is not None

    # 재적용(주최자가 마음을 바꿈) → 새 시퀀스로 완전 교체.
    # 주 단계는 정원이 필요하므로 published 스탠딩 섹션으로 200석 부여.
    event.seat_map_data = {
        "maps": [
            {
                "id": "m1",
                "status": "published",
                "map_data": {"figmaLayout": {"sections": [{"kind": "standing", "capacity": 200}]}},
            }
        ]
    }
    await db_session.flush()
    assert await sps.compute_total_capacity(db_session, event) == 200

    new_opens = datetime.now(UTC) + timedelta(days=2)
    spec = _lottery_spec(new_opens)
    await sps.apply_sale_plan(db_session, event, [spec], None)
    rows = await sps.list_phases(db_session, event.id)
    assert [r.phase for r in rows] == ["lottery", "waitlist_promotion", "fcfs_residual"]
    assert rows[0].config["payment_window_hours"] == 72
    assert rows[1].config["waitlist_payment_window_hours"] == 24


@pytest.mark.asyncio
async def test_apply_sale_plan_rejected_when_phase_already_running(db_session):
    event = await _mk_event(db_session, days_ahead=90)
    await sps.apply_sale_plan(db_session, event, [], datetime.now(UTC) + timedelta(days=1))
    rows = await sps.list_phases(db_session, event.id)
    rows[0].status = "open"
    await db_session.flush()

    with pytest.raises(sps.SalePlanError) as exc:
        await sps.apply_sale_plan(db_session, event, [], datetime.now(UTC) + timedelta(days=3))
    assert exc.value.code == "PHASE_LOCKED"
    # 진행중 단계는 그대로 살아있다
    still = await sps.list_phases(db_session, event.id)
    assert len(still) == 1 and still[0].status == "open"


@pytest.mark.asyncio
async def test_validation_failure_does_not_delete_existing_phases(db_session):
    """검증 실패는 delete-then-insert 를 시작조차 하지 않는다(빈 시퀀스 사고 방지)."""
    event = await _mk_event(db_session, days_ahead=90)
    await sps.apply_sale_plan(db_session, event, [], datetime.now(UTC) + timedelta(days=1))
    before = await sps.list_phases(db_session, event.id)
    assert len(before) == 1

    # 비율 합이 100 이 아닌 잘못된 계획
    bad = [sps.PhaseSpec("lottery", 50, datetime.now(UTC), datetime.now(UTC) + timedelta(days=1))]
    with pytest.raises(sps.SalePlanError):
        await sps.apply_sale_plan(db_session, event, bad, None)

    after = await sps.list_phases(db_session, event.id)
    assert len(after) == 1, "검증 실패가 기존 판매 단계를 삭제하면 안 된다"


@pytest.mark.asyncio
async def test_current_phase_prefers_open_then_earliest_scheduled(db_session):
    event = await _mk_event(db_session, days_ahead=90)
    now = datetime.now(UTC)
    db_session.add_all(
        [
            PhaseConfig(
                event_id=event.id, phase="lottery", starts_at=now, ends_at=now + timedelta(days=1),
                sort_order=1, status="closed",
            ),
            PhaseConfig(
                event_id=event.id, phase="waitlist_promotion", starts_at=now, ends_at=None,
                sort_order=2, status="scheduled",
            ),
            PhaseConfig(
                event_id=event.id, phase="fcfs_residual", starts_at=now, ends_at=now + timedelta(days=5),
                sort_order=3, status="open",
            ),
        ]
    )
    await db_session.flush()

    current = await sps.get_current_phase(db_session, event.id)
    assert current is not None and current.phase == "fcfs_residual"  # open 우선

    current.status = "closed"
    await db_session.flush()
    current2 = await sps.get_current_phase(db_session, event.id)
    assert current2 is not None and current2.phase == "waitlist_promotion"  # 가장 이른 scheduled


@pytest.mark.asyncio
async def test_get_phase_config_value_reads_durable_db_not_redis(db_session):
    """결제창이 Redis 만료와 무관하게 DB 에서 조회된다(현존 버그 #2의 반례)."""
    event = await _mk_event(db_session, days_ahead=90)
    now = datetime.now(UTC)
    db_session.add(
        PhaseConfig(
            event_id=event.id, phase="lottery", starts_at=now, ends_at=now + timedelta(days=1),
            sort_order=1, status="scheduled", config={"payment_window_hours": 48},
        )
    )
    db_session.add(
        PhaseConfig(
            event_id=event.id, phase="waitlist_promotion", starts_at=now, ends_at=None,
            sort_order=2, status="scheduled", config={"waitlist_payment_window_hours": 12},
        )
    )
    await db_session.flush()

    assert await sps.get_phase_config_value(
        db_session, event.id, "payment_window_hours", phases=("lottery", "membership_presale")
    ) == 48
    assert await sps.get_phase_config_value(
        db_session, event.id, "waitlist_payment_window_hours", phases=("waitlist_promotion",)
    ) == 12
    assert await sps.get_phase_config_value(db_session, event.id, "does_not_exist") is None


@pytest.mark.asyncio
async def test_ends_at_is_nullable(db_session):
    """go `closes_at NULL`(무기한 단계) 표현력이 보존된다."""
    event = await _mk_event(db_session, days_ahead=90)
    db_session.add(
        PhaseConfig(
            event_id=event.id, phase="fcfs_residual", starts_at=datetime.now(UTC),
            ends_at=None, sort_order=1,
        )
    )
    await db_session.flush()
    row = (
        await db_session.execute(
            select(PhaseConfig).where(PhaseConfig.event_id == event.id)
        )
    ).scalar_one()
    assert row.ends_at is None
    assert row.status == "scheduled"
    assert row.allocated_quantity == 0
    assert row.config == {}


# ── 4. 심사요청 웹훅(보조 경로)이 정본을 파괴하지 못한다 ────────────────


@pytest.mark.asyncio
async def test_review_request_upsert_with_empty_schedules_does_not_wipe(db_session):
    """빈 phaseSchedules 가 와도 phase_configs 가 통째로 날아가지 않는다."""
    event = await _mk_event(db_session, days_ahead=90)
    await sps.apply_sale_plan(db_session, event, [], datetime.now(UTC) + timedelta(days=1))
    before = await sps.list_phases(db_session, event.id)
    assert len(before) == 1

    opens, closes = await _upsert_phase_configs(db_session, event.id, [])

    after = await sps.list_phases(db_session, event.id)
    assert len(after) == 1, "빈 배열은 기존 판매 단계를 삭제하면 안 된다"
    # 판매창은 DB 의 기존 단계에서 계산돼야 한다(웹훅이 되돌리지 않도록)
    assert opens is not None and closes is not None


@pytest.mark.asyncio
async def test_review_request_upsert_preserves_status_and_config(db_session):
    """보조 경로 재수신이 status/target/config 를 리셋하지 않는다."""
    from app.api.v1.internal_sync import PhaseSchedulePayload

    event = await _mk_event(db_session, days_ahead=90)
    now = datetime.now(UTC)
    db_session.add(
        PhaseConfig(
            event_id=event.id, phase="lottery", starts_at=now, ends_at=now + timedelta(days=1),
            sort_order=1, status="open", target_quantity=77,
            config={"payment_window_hours": 48},
        )
    )
    await db_session.flush()

    await _upsert_phase_configs(
        db_session,
        event.id,
        [
            PhaseSchedulePayload(
                mode="lottery",
                phaseOrder=1,
                opensAt=(now + timedelta(days=10)).isoformat(),
                closesAt=(now + timedelta(days=11)).isoformat(),
            )
        ],
    )

    row = (
        await db_session.execute(select(PhaseConfig).where(PhaseConfig.event_id == event.id))
    ).scalar_one()
    assert row.status == "open"
    assert row.target_quantity == 77
    assert row.config["payment_window_hours"] == 48
    # 이미 open 인 단계의 시각은 사후 변경되지 않는다
    assert row.starts_at.replace(tzinfo=UTC) < (now + timedelta(days=5))


# ── 자유 입장(좌석 지정 없음) 이벤트: 정원 = 판매 중인 입장권 등급 수량 합 ──────────
#    좌석 배치도가 없는 자유 입장 행사(골프대회 갤러리권 등)에서 공정 추첨 판매 단계를
#    저장하면 "좌석이 하나도 없는 이벤트"로 거부되던 결함의 회귀 테스트.


@pytest.mark.asyncio
async def test_unassigned_event_capacity_counts_ticket_tiers(db_session):
    from app.models.event import SeatTier

    event = await _mk_event(db_session, days_ahead=90)
    event.seat_type = "unassigned"
    db_session.add_all(
        [
            SeatTier(event_id=event.id, name="갤러리 입장권", capacity=20, base_price=30000),
            SeatTier(event_id=event.id, name="주말권", capacity=30, base_price=50000),
            # 부가상품·판매 중지 등급·무제한 등급은 추첨 정원에 넣지 않는다
            SeatTier(event_id=event.id, name="주차권", capacity=100, base_price=5000, product_type="addon"),
            SeatTier(event_id=event.id, name="중지된 등급", capacity=40, base_price=1000, is_active=False),
            SeatTier(event_id=event.id, name="무제한", capacity=1_000_000, base_price=0),
        ]
    )
    await db_session.flush()
    assert await sps.compute_total_capacity(db_session, event) == 50

    opens = datetime.now(UTC) + timedelta(days=1)
    await sps.apply_sale_plan(db_session, event, [_lottery_spec(opens)], None)
    rows = await sps.list_phases(db_session, event.id)
    assert rows[0].phase == "lottery"
    assert rows[0].target_quantity == 50


@pytest.mark.asyncio
async def test_assigned_event_without_seats_still_rejected(db_session):
    """지정석 행사는 기존 규칙 그대로 — 좌석·스탠딩이 없으면 주 단계를 거부한다."""
    from app.models.event import SeatTier

    event = await _mk_event(db_session, days_ahead=90)
    db_session.add(SeatTier(event_id=event.id, name="R석", capacity=20, base_price=30000))
    await db_session.flush()
    assert await sps.compute_total_capacity(db_session, event) == 0
    with pytest.raises(sps.SalePlanError):
        await sps.apply_sale_plan(db_session, event, [_lottery_spec(datetime.now(UTC) + timedelta(days=1))], None)


# ── 판매 단계 ↔ 등급 판매 방식 일치 ─────────────────────────────────────────
#    주최자가 「판매 방식: 공정 추첨」을 저장해도 등급이 fixed_fcfs 로 남아 가중치 추첨 설정
#    화면·응모 기간 가드·팬 가중치가 적용되지 않던 결함의 회귀 테스트. 등급은 첫 주 단계의
#    방식으로 시작하고(추첨 종료 뒤 FCFS 전환은 기존 작업이 담당) 계획이 없으면 선착순이다.


async def _unassigned_event_with_tiers(db_session):
    from app.models.event import SeatTier

    event = await _mk_event(db_session, days_ahead=90)
    event.seat_type = "unassigned"
    t1 = SeatTier(event_id=event.id, name="갤러리 입장권", capacity=20, base_price=30000)
    addon = SeatTier(event_id=event.id, name="주차권", capacity=50, base_price=5000, product_type="addon")
    db_session.add_all([t1, addon])
    await db_session.flush()
    return event, t1, addon


@pytest.mark.asyncio
async def test_lottery_plan_marks_ticket_tiers_point_lottery(db_session):
    event, t1, addon = await _unassigned_event_with_tiers(db_session)
    await sps.apply_sale_plan(db_session, event, [_lottery_spec(datetime.now(UTC) + timedelta(days=1))], None)
    assert t1.sale_mode == "point_lottery"
    assert addon.sale_mode == "fixed_fcfs"  # 부가상품은 추첨 대상이 아니다

    # 계획을 선착순 단독으로 바꾸면 다시 선착순
    await sps.apply_sale_plan(db_session, event, [], datetime.now(UTC) + timedelta(days=1))
    assert t1.sale_mode == "fixed_fcfs"


@pytest.mark.asyncio
async def test_plan_tier_mode_follows_first_main_phase(db_session):
    event, t1, _ = await _unassigned_event_with_tiers(db_session)
    assert await sps.plan_tier_sale_mode(db_session, event.id) is None
    await sps.apply_sale_plan(db_session, event, [_lottery_spec(datetime.now(UTC) + timedelta(days=1))], None)
    assert await sps.plan_tier_sale_mode(db_session, event.id) == "point_lottery"


def test_phase_to_tier_sale_mode_mapping():
    assert sps.tier_sale_mode_for_phase("lottery") == "point_lottery"
    assert sps.tier_sale_mode_for_phase("membership_presale") == "fanclub_presale"
    assert sps.tier_sale_mode_for_phase("queue_sale") == "queue"
    assert sps.tier_sale_mode_for_phase("fcfs_residual") == "fixed_fcfs"
