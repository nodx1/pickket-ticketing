"""정산 생성 태스크 — 클로백(블로커 #4) + 재판매 분리(블로커 #6) 단위 테스트."""

import importlib.util
import inspect
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

import pytest


def _load_migration():
    """alembic/versions/stl_uniq_0611_settlement_unique.py 를 파일 경로로 직접 로드.

    versions 디렉터리는 패키지(__init__.py)가 아니고 설치된 `alembic` 패키지와도
    이름이 겹치므로, importlib 로 파일을 직접 모듈화한다."""
    path = (
        Path(__file__).resolve().parents[2]
        / "alembic"
        / "versions"
        / "stl_uniq_0611_settlement_unique.py"
    )
    spec = importlib.util.spec_from_file_location("stl_uniq_0611_settlement_unique", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


stl_uniq_0611_settlement_unique = _load_migration()
from sqlalchemy import create_engine, select
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import *  # noqa: F401,F403
from app.models.event import Event, EventStatus
from app.models.order import Order, OrderStatus, OrderType
from app.models.settlement import (
    OrganizerSettlement,
    SettlementAdjustment,
    SettlementType,
)
from app.models.user import User
from app.tasks.settlement_generate import (
    _add_settlement_idempotent,
    generate_settlements,
)


@compiles(PG_UUID, "sqlite")
def _compile_pg_uuid_sqlite(type_, compiler, **kw):
    return "CHAR(32)"


sync_engine = create_engine("sqlite://", echo=False)
TestSyncSession = sessionmaker(sync_engine)

# 정산 기간: [5월 1일, 6월 1일) / 다음 기간: [6월 1일, 7월 1일)
PERIOD_M_START = datetime(2026, 5, 1, tzinfo=timezone.utc)
PERIOD_M_END = datetime(2026, 6, 1, tzinfo=timezone.utc)
PERIOD_M1_END = datetime(2026, 7, 1, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _reset_db(monkeypatch):
    monkeypatch.setattr("app.tasks.settlement_generate.SyncSession", TestSyncSession)
    Base.metadata.drop_all(sync_engine)
    Base.metadata.create_all(sync_engine)
    yield
    Base.metadata.drop_all(sync_engine)


def _create_user(session, email: str, *, is_organizer: bool = False) -> User:
    user = User(email=email, hashed_password="x", name=email.split("@")[0], is_organizer=is_organizer)
    session.add(user)
    session.flush()
    return user


def _create_event(session, organizer_id) -> Event:
    event = Event(
        organizer_id=organizer_id,
        title="Settlement Event",
        slug=f"settle-{uuid.uuid4().hex[:8]}",
        venue="Arena",
        event_date=PERIOD_M_END + timedelta(days=30),
        bidding_opens_at=PERIOD_M_START - timedelta(days=10),
        bidding_closes_at=PERIOD_M_START - timedelta(days=1),
        total_seats=100,
        min_price=10.0,
        max_price=100.0,
        status=EventStatus.APPROVED,
    )
    session.add(event)
    session.flush()
    return event


def _create_order(
    session,
    *,
    user_id,
    event_id,
    total: str,
    created_at: datetime,
    status: OrderStatus = OrderStatus.CONFIRMED,
    order_type: OrderType = OrderType.PURCHASE,
    platform_fee: str = "0",
    pg_fee: str = "0",
    total_refunded: str = "0",
    payment_metadata: dict | None = None,
) -> Order:
    order = Order(
        user_id=user_id,
        event_id=event_id,
        order_type=order_type,
        status=status,
        quantity=1,
        unit_price=Decimal(total),
        total_amount=Decimal(total),
        platform_fee=Decimal(platform_fee),
        pg_fee=Decimal(pg_fee),
        total_refunded=Decimal(total_refunded),
        created_at=created_at,
        payment_metadata=payment_metadata,
    )
    session.add(order)
    session.flush()
    return order


def _run(period_start: datetime, period_end: datetime) -> dict:
    return generate_settlements.run(
        period_start_iso=period_start.isoformat(),
        period_end_iso=period_end.isoformat(),
    )


def _setup_primary_order(total="100000", **kwargs):
    with TestSyncSession() as session:
        organizer = _create_user(session, f"org_{uuid.uuid4().hex[:6]}@test.com", is_organizer=True)
        buyer = _create_user(session, f"buyer_{uuid.uuid4().hex[:6]}@test.com")
        event = _create_event(session, organizer.id)
        order = _create_order(
            session,
            user_id=buyer.id,
            event_id=event.id,
            total=total,
            created_at=PERIOD_M_START + timedelta(days=5),
            **kwargs,
        )
        session.commit()
        return organizer.id, buyer.id, event.id, order.id


def test_primary_settlement_generated():
    org_id, _, _, _ = _setup_primary_order(
        total="100000", platform_fee="5000", pg_fee="2500"
    )

    result = _run(PERIOD_M_START, PERIOD_M_END)
    assert result["created"] == 1

    with TestSyncSession() as session:
        settlement = session.execute(
            select(OrganizerSettlement).where(OrganizerSettlement.organizer_id == org_id)
        ).scalar_one()
        assert settlement.settlement_type == SettlementType.ORGANIZER.value
        assert Decimal(str(settlement.gross_revenue)) == Decimal("100000")
        assert Decimal(str(settlement.net_payout)) == Decimal("92500")
        assert Decimal(str(settlement.refunds_clawed)) == Decimal("0")

    # 멱등: 재실행 시 중복 생성 없음
    rerun = _run(PERIOD_M_START, PERIOD_M_END)
    assert rerun["created"] == 0


def test_clawback_after_settlement_refund():
    """블로커 #4: 정산 생성 이후 발생한 환불이 다음 주기에 클로백으로 차감된다."""
    org_id, _, _, order_id = _setup_primary_order(
        total="100000", platform_fee="5000", pg_fee="2500"
    )
    _run(PERIOD_M_START, PERIOD_M_END)

    # 정산 생성 "이후" 전액 환불 발생 (M+1월 중순 시뮬레이션)
    with TestSyncSession() as session:
        order = session.execute(select(Order).where(Order.id == order_id)).scalar_one()
        order.total_refunded = Decimal("100000")
        order.status = OrderStatus.REFUNDED
        session.commit()

    result = _run(PERIOD_M_END, PERIOD_M1_END)
    assert result["clawbacks_applied"] == 1
    assert result["clawback_total"] == pytest.approx(100000.0)

    with TestSyncSession() as session:
        settlements = session.execute(
            select(OrganizerSettlement)
            .where(OrganizerSettlement.organizer_id == org_id)
            .order_by(OrganizerSettlement.period_start)
        ).scalars().all()
        assert len(settlements) == 2
        prior, current = settlements
        # 원 정산에 클로백 누계 기록
        assert Decimal(str(prior.refunds_clawed)) == Decimal("100000")
        # 현재 기간 정산(활동 없음 → 0원 row)에서 차감
        assert Decimal(str(current.net_payout)) == Decimal("-100000")

        adjustment = session.execute(
            select(SettlementAdjustment).where(
                SettlementAdjustment.settlement_id == current.id
            )
        ).scalar_one()
        assert adjustment.adjustment_type == "clawback"
        assert Decimal(str(adjustment.amount)) == Decimal("-100000")
        assert adjustment.created_by is None

    # 멱등: 재실행해도 클로백이 중복 적용되지 않음
    rerun = _run(PERIOD_M_END, PERIOD_M1_END)
    assert rerun["clawbacks_applied"] == 0


def test_clawback_skips_legacy_settlements():
    """refunds_clawed IS NULL(legacy) 정산은 클로백 스캔에서 제외된다."""
    org_id, _, _, order_id = _setup_primary_order(total="50000")

    with TestSyncSession() as session:
        session.add(
            OrganizerSettlement(
                organizer_id=org_id,
                period_start=PERIOD_M_START,
                period_end=PERIOD_M_END,
                gross_revenue=Decimal("50000"),
                total_refunds=Decimal("0"),
                platform_fee=Decimal("0"),
                pg_fee=Decimal("0"),
                net_payout=Decimal("50000"),
                refunds_clawed=None,  # legacy
                status="paid",
            )
        )
        order = session.execute(select(Order).where(Order.id == order_id)).scalar_one()
        order.total_refunded = Decimal("50000")
        order.status = OrderStatus.REFUNDED
        session.commit()

    result = _run(PERIOD_M_END, PERIOD_M1_END)
    assert result["clawbacks_applied"] == 0


def test_resale_order_separated_from_organizer_settlement():
    """블로커 #6: RESALE_BUY 는 주최자 gross 에서 제외, 판매자/로열티 정산 라인 생성."""
    with TestSyncSession() as session:
        organizer = _create_user(session, "resale_org@test.com", is_organizer=True)
        seller = _create_user(session, "resale_seller@test.com")
        buyer = _create_user(session, "resale_buyer@test.com")
        event = _create_event(session, organizer.id)
        # 12만원 재판매: seller 10.8만 + 로열티 1만 + 플랫폼 0.2만
        _create_order(
            session,
            user_id=buyer.id,
            event_id=event.id,
            total="120000",
            created_at=PERIOD_M_START + timedelta(days=10),
            order_type=OrderType.RESALE_BUY,
            payment_metadata={
                "resale": {
                    "listing_id": str(uuid.uuid4()),
                    "ticket_id": str(uuid.uuid4()),
                    "seller_id": str(seller.id),
                    "seller_receives": 108000.0,
                    "platform_fee": 2000.0,
                    "artist_royalty": 10000.0,
                }
            },
        )
        session.commit()
        organizer_id, seller_id = organizer.id, seller.id

    result = _run(PERIOD_M_START, PERIOD_M_END)
    assert result["created"] == 1  # organizer (로열티 귀속)
    assert result["resale_seller_created"] == 1

    with TestSyncSession() as session:
        org_settlement = session.execute(
            select(OrganizerSettlement).where(
                OrganizerSettlement.organizer_id == organizer_id,
                OrganizerSettlement.settlement_type == SettlementType.ORGANIZER.value,
            )
        ).scalar_one()
        # 재판매 매출은 주최자 gross 에 포함되지 않음 (오귀속 차단)
        assert Decimal(str(org_settlement.gross_revenue)) == Decimal("0")
        # 로열티만 귀속
        assert Decimal(str(org_settlement.net_payout)) == Decimal("10000")
        royalty_adj = session.execute(
            select(SettlementAdjustment).where(
                SettlementAdjustment.settlement_id == org_settlement.id
            )
        ).scalar_one()
        assert royalty_adj.adjustment_type == "resale_royalty"
        assert Decimal(str(royalty_adj.amount)) == Decimal("10000")

        seller_settlement = session.execute(
            select(OrganizerSettlement).where(
                OrganizerSettlement.organizer_id == seller_id,
                OrganizerSettlement.settlement_type == SettlementType.RESALE_SELLER.value,
            )
        ).scalar_one()
        assert Decimal(str(seller_settlement.gross_revenue)) == Decimal("108000")
        assert Decimal(str(seller_settlement.net_payout)) == Decimal("108000")


def test_resale_refund_clawback_split():
    """재판매 주문 환불 클로백: seller_receives 는 판매자, royalty 는 주최자에서 차감."""
    with TestSyncSession() as session:
        organizer = _create_user(session, "rsc_org@test.com", is_organizer=True)
        seller = _create_user(session, "rsc_seller@test.com")
        buyer = _create_user(session, "rsc_buyer@test.com")
        event = _create_event(session, organizer.id)
        order = _create_order(
            session,
            user_id=buyer.id,
            event_id=event.id,
            total="120000",
            created_at=PERIOD_M_START + timedelta(days=10),
            order_type=OrderType.RESALE_BUY,
            payment_metadata={
                "resale": {
                    "seller_id": str(seller.id),
                    "seller_receives": 108000.0,
                    "platform_fee": 2000.0,
                    "artist_royalty": 10000.0,
                }
            },
        )
        session.commit()
        organizer_id, seller_id, order_id = organizer.id, seller.id, order.id

    _run(PERIOD_M_START, PERIOD_M_END)

    # 정산 후 전액 환불(차지백 lost 동치)
    with TestSyncSession() as session:
        order = session.execute(select(Order).where(Order.id == order_id)).scalar_one()
        order.total_refunded = Decimal("120000")
        order.status = OrderStatus.REFUNDED
        session.commit()

    result = _run(PERIOD_M_END, PERIOD_M1_END)
    assert result["clawbacks_applied"] == 2  # seller + organizer(royalty)
    assert result["clawback_total"] == pytest.approx(118000.0)

    with TestSyncSession() as session:
        seller_prior = session.execute(
            select(OrganizerSettlement).where(
                OrganizerSettlement.organizer_id == seller_id,
                OrganizerSettlement.period_start == PERIOD_M_START,
            )
        ).scalar_one()
        assert Decimal(str(seller_prior.refunds_clawed)) == Decimal("108000")

        org_prior = session.execute(
            select(OrganizerSettlement).where(
                OrganizerSettlement.organizer_id == organizer_id,
                OrganizerSettlement.period_start == PERIOD_M_START,
            )
        ).scalar_one()
        assert Decimal(str(org_prior.refunds_clawed)) == Decimal("10000")


# ---------------------------------------------------------------------------
# 마이그레이션 stl_uniq_0611 중복정리 — 보존 우선순위 CASE 검증
#   disputed(분쟁 이력)가 단순 draft 보다 우선 보존되어야 한다.
# ---------------------------------------------------------------------------


def test_migration_dedup_keep_score_disputed_over_draft():
    """stl_uniq_0611 sqlite 중복정리 CASE 식: disputed > draft (분쟁 이력 우선 보존).

    동일 (organizer, period, type) 중복 정산에서 disputed 행과 draft 행이 함께 있을 때,
    보존 점수가 더 높은 disputed 가 살아남고 draft 가 삭제 대상(loser)이 되어야 한다.
    disputed 행은 settlement_adjustments(dispute_reason 등) 자식을 가지므로,
    draft 보다 낮게 채점되면 분쟁 이력이 영구 삭제된다(결함 2)."""
    import re

    src = inspect.getsource(stl_uniq_0611_settlement_unique.upgrade)
    # sqlite 분기의 keep_o CASE 식 추출
    m = re.search(r'keep_o = \(\s*(.*?)\s*\)', src, re.S)
    assert m, "keep_o CASE 식을 마이그레이션에서 찾지 못함"
    case_src = m.group(1)

    def _score(status: str) -> int:
        scores: dict[str, int] = {}
        # "WHEN 'paid' THEN 7 ..." 토큰 파싱
        for st, val in re.findall(r"WHEN '(\w+)' THEN (\d+)", case_src):
            scores[st] = int(val)
        return scores.get(status, 0)

    assert _score("disputed") > _score("draft"), (
        f"disputed({_score('disputed')}) 는 draft({_score('draft')}) 보다 높아야 함 "
        "(분쟁 이력 우선 보존)"
    )
    # 진척 상태 전체 순서도 유지: paid > approved > reviewed > pending_review > disputed > draft
    order = ["paid", "approved", "reviewed", "pending_review", "disputed", "draft"]
    scores = [_score(s) for s in order]
    assert scores == sorted(scores, reverse=True), f"보존 우선순위 단조 감소 위반: {dict(zip(order, scores))}"


def test_migration_dedup_removes_draft_keeps_disputed_on_sqlite():
    """실제 sqlite 중복정리 SQL 실행: disputed 행이 살아남고 draft 가 삭제된다."""
    from sqlalchemy import text

    eng = create_engine("sqlite://", echo=False)
    Base.metadata.create_all(eng)
    # 마이그레이션 적용 "전" 상태 재현: UNIQUE 인덱스가 없어서 중복 활성 row 가 존재할 수 있다.
    with eng.begin() as conn:
        conn.execute(text("DROP INDEX IF EXISTS uq_settlement_org_period_type"))
    org_id = uuid.uuid4()
    with sessionmaker(eng)() as session:
        draft = _new_settlement(org_id, status="draft", net_payout=Decimal("100"))
        disputed = _new_settlement(org_id, status="disputed", net_payout=Decimal("200"))
        session.add_all([draft, disputed])
        session.flush()
        draft_id, disputed_id = draft.id, disputed.id
        # disputed 에 분쟁 조정 라인 부착
        session.add(
            SettlementAdjustment(
                settlement_id=disputed_id,
                adjustment_type="dispute",
                amount=Decimal("-50"),
                reason="dispute_reason: chargeback",
            )
        )
        session.commit()

    # 마이그레이션 sqlite 분기의 loser 정리 SQL 재현
    keep_o = (
        "CASE o.status WHEN 'paid' THEN 7 WHEN 'approved' THEN 6 "
        "WHEN 'reviewed' THEN 5 WHEN 'pending_review' THEN 4 "
        "WHEN 'disputed' THEN 3 WHEN 'draft' THEN 2 ELSE 0 END"
    )
    keep_s = keep_o.replace("o.status", "s.status")
    loser_subquery = f"""
        SELECT s.id
        FROM organizer_settlements s
        WHERE s.deleted_at IS NULL
          AND EXISTS (
              SELECT 1 FROM organizer_settlements o
              WHERE o.deleted_at IS NULL
                AND o.organizer_id = s.organizer_id
                AND o.period_start = s.period_start
                AND o.period_end = s.period_end
                AND o.settlement_type = s.settlement_type
                AND o.id <> s.id
                AND ({keep_o} > {keep_s}
                     OR ({keep_o} = {keep_s}
                         AND (o.created_at > s.created_at
                              OR (o.created_at = s.created_at AND o.id > s.id))))
          )
    """
    with eng.begin() as conn:
        conn.execute(
            text(
                f"DELETE FROM settlement_adjustments "
                f"WHERE settlement_id IN ({loser_subquery})"
            )
        )
        conn.execute(text(f"DELETE FROM organizer_settlements WHERE id IN ({loser_subquery})"))

    with sessionmaker(eng)() as session:
        survivors = session.execute(
            select(OrganizerSettlement.id).where(OrganizerSettlement.organizer_id == org_id)
        ).scalars().all()
        assert survivors == [disputed_id], "disputed 가 보존되고 draft 가 삭제되어야 함"
        # 분쟁 조정 라인도 함께 보존
        adj = session.execute(
            select(SettlementAdjustment).where(
                SettlementAdjustment.settlement_id == disputed_id
            )
        ).scalars().all()
        assert len(adj) == 1


# ---------------------------------------------------------------------------
# 동시성 결함 방어 — (organizer, period, type) UNIQUE 제약 + insert-or-get backstop
# ---------------------------------------------------------------------------


def _new_settlement(org_id, **overrides) -> OrganizerSettlement:
    base = dict(
        organizer_id=org_id,
        settlement_type=SettlementType.ORGANIZER.value,
        period_start=PERIOD_M_START,
        period_end=PERIOD_M_END,
        gross_revenue=Decimal("100000"),
        total_refunds=Decimal("0"),
        platform_fee=Decimal("0"),
        pg_fee=Decimal("0"),
        net_payout=Decimal("100000"),
        refunds_clawed=Decimal("0"),
        status="draft",
    )
    base.update(overrides)
    return OrganizerSettlement(**base)


def test_duplicate_settlement_blocked_by_unique_index():
    """같은 (organizer, period, type) 활성 정산 2건 INSERT 는 UNIQUE 인덱스가 차단."""
    org_id = uuid.uuid4()
    with TestSyncSession() as session:
        session.add(_new_settlement(org_id))
        session.commit()

    with TestSyncSession() as session:
        session.add(_new_settlement(org_id, net_payout=Decimal("999")))
        with pytest.raises(IntegrityError):
            session.commit()


def test_soft_deleted_does_not_block_recreate():
    """소프트 삭제된 정산은 부분 UNIQUE(deleted_at IS NULL)에서 제외 — 동일 키 재생성 허용."""
    org_id = uuid.uuid4()
    with TestSyncSession() as session:
        session.add(_new_settlement(org_id, deleted_at=datetime.now(timezone.utc)))
        session.commit()

    with TestSyncSession() as session:
        session.add(_new_settlement(org_id))  # 활성 row 재생성 — 충돌 없어야 함
        session.commit()  # raises 면 실패


def test_add_settlement_idempotent_reuses_existing_on_conflict():
    """insert-or-get: UNIQUE 충돌 시 IntegrityError 를 잡아 기존 활성 row 를 재사용."""
    org_id = uuid.uuid4()
    with TestSyncSession() as session:
        first = _new_settlement(org_id, net_payout=Decimal("100000"))
        session.add(first)
        session.commit()
        first_id = first.id

    with TestSyncSession() as session:
        key = (org_id, SettlementType.ORGANIZER.value)
        # "동시 실행 B" 가 만든 새 row — 첫 row 를 못 본 상태로 INSERT 시도
        racer = _new_settlement(org_id, net_payout=Decimal("777"))
        result, is_new = _add_settlement_idempotent(session, racer, key)
        assert is_new is False
        assert result.id == first_id  # 새 row 대신 기존 row 로 수렴
        assert Decimal(str(result.net_payout)) == Decimal("100000")
        session.commit()

    # DB 에 활성 정산은 여전히 1건뿐
    with TestSyncSession() as session:
        rows = session.execute(
            select(OrganizerSettlement).where(
                OrganizerSettlement.organizer_id == org_id,
                OrganizerSettlement.deleted_at.is_(None),
            )
        ).scalars().all()
        assert len(rows) == 1


def test_concurrent_generate_no_double_clawback():
    """동시 generate 시뮬레이션: 같은 organizer/period 정산이 이미 존재하는 상태에서
    두 번째 generate 가 돌면 중복 row 없이 클로백이 1회만 적용된다."""
    org_id, _, _, order_id = _setup_primary_order(
        total="100000", platform_fee="5000", pg_fee="2500"
    )
    _run(PERIOD_M_START, PERIOD_M_END)

    with TestSyncSession() as session:
        order = session.execute(select(Order).where(Order.id == order_id)).scalar_one()
        order.total_refunded = Decimal("100000")
        order.status = OrderStatus.REFUNDED
        session.commit()

    # "실행 A": 다음 주기 클로백 적용
    r1 = _run(PERIOD_M_END, PERIOD_M1_END)
    assert r1["clawbacks_applied"] == 1
    # "실행 B"(beat/재시도 중복): 같은 기간 재실행 — 멱등 skip, 이중 클로백 없음
    r2 = _run(PERIOD_M_END, PERIOD_M1_END)
    assert r2["clawbacks_applied"] == 0

    with TestSyncSession() as session:
        settlements = session.execute(
            select(OrganizerSettlement)
            .where(OrganizerSettlement.organizer_id == org_id)
            .order_by(OrganizerSettlement.period_start)
        ).scalars().all()
        # 기간별 1건씩, 총 2건 — 중복 row 없음
        assert len(settlements) == 2
        prior, current = settlements
        assert Decimal(str(prior.refunds_clawed)) == Decimal("100000")  # 1회만 누적
        clawbacks = session.execute(
            select(SettlementAdjustment).where(
                SettlementAdjustment.settlement_id == current.id,
                SettlementAdjustment.adjustment_type == "clawback",
            )
        ).scalars().all()
        assert len(clawbacks) == 1  # 클로백 조정 1건만
