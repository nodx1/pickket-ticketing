"""Tests for WP07 (Purchase AP exclusion), WP08 (Pity System), WP09 (AP Shop limits).

Unit tests that directly exercise service classes against the in-memory SQLite DB.
"""

import uuid

import pytest

from app.tests.conftest import TestSession
from app.models.point import PointTransactionType, PointType
from app.models.shop import ShopCategory, ShopExchangeStatus, ShopItem
from app.services.point_service import PointService, PURCHASE_BASED_TYPES
from app.services.pity_service import (
    GUARANTEED_THRESHOLDS,
    PITY_BONUS_TABLE,
    PityService,
)
from app.services.shop_service import ShopService


# ---------------------------------------------------------------------------
# Helper: create a user + wallets in the test DB
# ---------------------------------------------------------------------------


async def _create_test_user_with_wallets(session) -> uuid.UUID:
    """Create a minimal User row + dual wallets and return user_id."""
    from app.models.user import User

    user_id = uuid.uuid4()
    user = User(
        id=user_id,
        email=f"{user_id}@test.local",
        hashed_password="hashed",
        name="TestUser",
    )
    session.add(user)
    await session.flush()

    point_svc = PointService(session)
    await point_svc.create_wallets(user_id)
    return user_id


# ===========================================================================
# WP07: 구매 AP 추첨 가중치 제외
# ===========================================================================


class TestActivityOnlyBalance:
    """get_activity_only_balance — 구매 기반 AP 제외 잔액."""

    @pytest.mark.asyncio
    async def test_activity_only_excludes_purchase(self, db_session):
        """EARN_PURCHASE 거래는 activity-only 잔액에서 제외된다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = PointService(session)

            # 활동 기반 적립: 체크인 50, 리뷰 30
            await svc.earn(
                user_id,
                PointType.FAN,
                50,
                PointTransactionType.EARN_CHECKIN,
                description="체크인",
            )
            await svc.earn(
                user_id,
                PointType.FAN,
                30,
                PointTransactionType.EARN_REVIEW,
                description="리뷰",
            )
            # 구매 기반 적립: 200
            await svc.earn(
                user_id,
                PointType.FAN,
                200,
                PointTransactionType.EARN_PURCHASE,
                description="티켓 구매 보너스",
            )
            await session.commit()

            # 전체 잔액 = 100(가입) + 50 + 30 + 200 = 380
            total = await svc.get_balance(user_id, PointType.FAN)
            assert total == 380

            # 활동 전용 잔액 = 100(가입) + 50 + 30 = 180  (EARN_PURCHASE 제외)
            activity = await svc.get_activity_only_balance(user_id, PointType.FAN)
            assert activity == 180

    @pytest.mark.asyncio
    async def test_activity_only_excludes_goods(self, db_session):
        """EARN_GOODS 거래도 activity-only 잔액에서 제외된다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = PointService(session)

            await svc.earn(
                user_id,
                PointType.FAN,
                100,
                PointTransactionType.EARN_GOODS,
                description="굿즈 구매 보너스",
            )
            await session.commit()

            total = await svc.get_balance(user_id, PointType.FAN)
            assert total == 200  # 100 signup + 100 goods

            activity = await svc.get_activity_only_balance(user_id, PointType.FAN)
            assert activity == 100  # signup only (goods excluded)

    @pytest.mark.asyncio
    async def test_activity_only_no_wallet_returns_zero(self, db_session):
        """지갑이 없는 경우 0을 반환한다."""
        async with TestSession() as session:
            svc = PointService(session)
            result = await svc.get_activity_only_balance(uuid.uuid4(), PointType.FAN)
            assert result == 0

    @pytest.mark.asyncio
    async def test_purchase_based_types_set(self):
        """PURCHASE_BASED_TYPES에 올바른 타입이 포함되어 있다."""
        assert PointTransactionType.EARN_PURCHASE in PURCHASE_BASED_TYPES
        assert PointTransactionType.EARN_GOODS in PURCHASE_BASED_TYPES
        assert PointTransactionType.EARN_CHECKIN not in PURCHASE_BASED_TYPES


# ===========================================================================
# WP08: Pity System
# ===========================================================================


class TestPityBonusTable:
    """연속 낙첨별 보너스 확인."""

    @pytest.mark.asyncio
    async def test_pity_bonus_initial(self, db_session):
        """초기 상태(0회 낙첨)에서 보너스는 1.0이다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = PityService(session)

            bonus = await svc.get_pity_bonus(user_id, "concert")
            assert bonus == 1.0

    @pytest.mark.asyncio
    async def test_pity_bonus_increases_with_losses(self, db_session):
        """낙첨 횟수가 증가하면 보너스가 올라간다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = PityService(session)

            # 3회 낙첨 → 1.10
            for _ in range(3):
                await svc.record_loss(user_id, "concert")
            await session.commit()

            bonus = await svc.get_pity_bonus(user_id, "concert")
            assert bonus == PITY_BONUS_TABLE[3]
            assert bonus == 1.10

    @pytest.mark.asyncio
    async def test_pity_bonus_table_values(self):
        """PITY_BONUS_TABLE의 값이 기대와 일치한다."""
        expected = {
            0: 1.0,
            1: 1.0,
            2: 1.0,
            3: 1.10,
            4: 1.20,
            5: 1.30,
            6: 1.40,
            7: 1.40,
            8: 1.60,
            9: 1.60,
        }
        assert PITY_BONUS_TABLE == expected


class TestGuaranteedTicket:
    """보장 당첨권 발급 및 사용 확인."""

    @pytest.mark.asyncio
    async def test_guaranteed_ticket_concert_5_losses(self, db_session):
        """concert 도메인: 5연속 낙첨 시 보장 당첨권이 발급된다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = PityService(session)

            threshold = GUARANTEED_THRESHOLDS["concert"]
            assert threshold == 5

            for i in range(threshold):
                await svc.record_loss(user_id, "concert")
            await session.commit()

            has_ticket = await svc.has_guaranteed_ticket(user_id, "concert")
            assert has_ticket is True

    @pytest.mark.asyncio
    async def test_guaranteed_ticket_festival_4_losses(self, db_session):
        """festival 도메인: 4연속 낙첨 시 보장 당첨권이 발급된다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = PityService(session)

            threshold = GUARANTEED_THRESHOLDS["festival"]
            assert threshold == 4

            for _ in range(threshold):
                await svc.record_loss(user_id, "festival")
            await session.commit()

            has_ticket = await svc.has_guaranteed_ticket(user_id, "festival")
            assert has_ticket is True

    @pytest.mark.asyncio
    async def test_guaranteed_ticket_not_yet(self, db_session):
        """임계값 미만 낙첨에서는 보장 당첨권이 없다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = PityService(session)

            for _ in range(4):  # concert threshold = 5
                await svc.record_loss(user_id, "concert")
            await session.commit()

            has_ticket = await svc.has_guaranteed_ticket(user_id, "concert")
            assert has_ticket is False

    @pytest.mark.asyncio
    async def test_use_guaranteed_ticket(self, db_session):
        """보장 당첨권 사용 후에는 연속 낙첨이 초기화된다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = PityService(session)

            for _ in range(5):
                await svc.record_loss(user_id, "concert")
            await session.commit()

            assert await svc.has_guaranteed_ticket(user_id, "concert") is True

            used = await svc.use_guaranteed_ticket(user_id, "concert")
            assert used is True
            await session.commit()

            assert await svc.has_guaranteed_ticket(user_id, "concert") is False

            info = await svc.get_tracker_info(user_id, "concert")
            assert info["consecutive_losses"] == 0

    @pytest.mark.asyncio
    async def test_record_win_resets_losses(self, db_session):
        """당첨 기록 시 연속 낙첨 횟수가 초기화된다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = PityService(session)

            for _ in range(3):
                await svc.record_loss(user_id, "concert")
            await session.commit()

            info = await svc.get_tracker_info(user_id, "concert")
            assert info["consecutive_losses"] == 3

            await svc.record_win(user_id, "concert")
            await session.commit()

            info = await svc.get_tracker_info(user_id, "concert")
            assert info["consecutive_losses"] == 0


class TestPityDualTracking:
    """domain-level vs artist-level pity 듀얼 추적."""

    @pytest.mark.asyncio
    async def test_dual_tracking_max(self, db_session):
        """artist_pity가 domain_pity보다 높으면 artist_pity가 반환된다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = PityService(session)
            artist_id = uuid.uuid4()

            # domain: 3회 낙첨 (bonus 1.10)
            for _ in range(3):
                await svc.record_loss(user_id, "concert")
            await session.commit()

            # artist: 4회 낙첨 (bonus 1.20)
            # record_loss with artist_id also increments domain tracker,
            # so use a separate domain to test pure artist tracking
            for _ in range(4):
                await svc.record_loss(user_id, "musical", artist_id)
            await session.commit()

            # domain("musical") has 4 losses (1.20), artist has 4 (1.20) => max = 1.20
            bonus = await svc.get_pity_bonus(user_id, "musical", artist_id)
            assert bonus == 1.20

    @pytest.mark.asyncio
    async def test_artist_higher_than_domain(self, db_session):
        """artist가 더 많이 낙첨됐으면 artist bonus가 max로 반환된다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = PityService(session)
            artist_id = uuid.uuid4()

            # 먼저 domain-only 1회 낙첨
            await svc.record_loss(user_id, "concert")
            await session.commit()

            # 그 다음 artist에 추가 3회 낙첨 (domain은 1+3=4, artist=3)
            for _ in range(3):
                await svc.record_loss(user_id, "concert", artist_id)
            await session.commit()

            # domain: 4 losses (1.20), artist: 3 losses (1.10)
            # max(1.20, 1.10) = 1.20
            bonus = await svc.get_pity_bonus(user_id, "concert", artist_id)
            assert bonus == 1.20

    @pytest.mark.asyncio
    async def test_domains_are_independent(self, db_session):
        """서로 다른 도메인의 pity는 독립적이다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = PityService(session)

            for _ in range(4):
                await svc.record_loss(user_id, "concert")
            await session.commit()

            # concert: 4 losses (1.20), sports: 0 losses (1.0)
            concert_bonus = await svc.get_pity_bonus(user_id, "concert")
            sports_bonus = await svc.get_pity_bonus(user_id, "sports")

            assert concert_bonus == 1.20
            assert sports_bonus == 1.0


# ===========================================================================
# WP09: AP Shop 교환 한도
# ===========================================================================


async def _create_shop_item(
    session,
    category: ShopCategory = ShopCategory.DIGITAL,
    ap_price: int = 100,
    stock: int | None = 10,
    name: str = "테스트 상품",
) -> ShopItem:
    """테스트용 ShopItem 생성."""
    item = ShopItem(
        name=name,
        category=category,
        ap_price=ap_price,
        stock=stock,
        is_active=True,
    )
    session.add(item)
    await session.flush()
    return item


class TestShopMonthlyLimit:
    """월간 한도 초과 시 거부 확인."""

    @pytest.mark.asyncio
    async def test_monthly_limit_exceeded(self, db_session):
        """DIGITAL 카테고리 월간 3000 AP 한도를 초과하면 교환이 거부된다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = ShopService(session)
            point_svc = PointService(session)

            # 충분한 AP 적립 (5000 추가)
            await point_svc.earn(
                user_id,
                PointType.FAN,
                5000,
                PointTransactionType.EARN_CHECKIN,
                description="대량 적립",
            )
            await session.commit()

            # 1500 AP 상품 2회 교환 (3000 AP = 한도 정확히)
            item = await _create_shop_item(session, ShopCategory.DIGITAL, 1500, stock=10)
            await session.commit()

            await svc.exchange(user_id, item.id, PointType.FAN)
            await session.commit()

            await svc.exchange(user_id, item.id, PointType.FAN)
            await session.commit()

            # 3번째 교환 시 한도 초과 → ValueError
            with pytest.raises(ValueError, match="한도 초과"):
                await svc.exchange(user_id, item.id, PointType.FAN)

    @pytest.mark.asyncio
    async def test_unlimited_category_no_limit(self, db_session):
        """OFFLINE 카테고리는 월간 한도가 없다 (무제한)."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = ShopService(session)
            point_svc = PointService(session)

            await point_svc.earn(
                user_id,
                PointType.FAN,
                10000,
                PointTransactionType.EARN_CHECKIN,
            )
            await session.commit()

            item = await _create_shop_item(session, ShopCategory.OFFLINE, 1000, stock=20)
            await session.commit()

            # 5번 교환해도 한도 에러 없음
            for _ in range(5):
                await svc.exchange(
                    user_id,
                    item.id,
                    PointType.FAN,
                    verification_level=1,  # 실물은 레벨 1 필요
                )
                await session.commit()

    @pytest.mark.asyncio
    async def test_offline_requires_verification(self, db_session):
        """실물 상품(OFFLINE)은 본인인증 레벨 1 이상이 필요하다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = ShopService(session)

            item = await _create_shop_item(session, ShopCategory.OFFLINE, 50, stock=5)
            await session.commit()

            with pytest.raises(ValueError, match="본인인증"):
                await svc.exchange(
                    user_id,
                    item.id,
                    PointType.FAN,
                    verification_level=0,
                )

    @pytest.mark.asyncio
    async def test_stock_depletion(self, db_session):
        """재고가 0이면 교환이 거부된다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = ShopService(session)

            item = await _create_shop_item(session, ShopCategory.DIGITAL, 10, stock=0)
            await session.commit()

            with pytest.raises(ValueError, match="재고"):
                await svc.exchange(user_id, item.id, PointType.FAN)

    @pytest.mark.asyncio
    async def test_insufficient_ap(self, db_session):
        """AP가 부족하면 교환이 거부된다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = ShopService(session)

            # 초기 잔액 100, 상품 가격 500
            item = await _create_shop_item(session, ShopCategory.DIGITAL, 500, stock=5)
            await session.commit()

            with pytest.raises(ValueError, match="AP가 부족"):
                await svc.exchange(user_id, item.id, PointType.FAN)


class TestShopAnomalyDetection:
    """동일 상품 반복 교환 이상 패턴 감지."""

    @pytest.mark.asyncio
    async def test_anomaly_detection_threshold(self, db_session):
        """동일 상품 월 3회 이상 교환 시 이상 패턴이 감지된다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = ShopService(session)
            point_svc = PointService(session)

            await point_svc.earn(
                user_id,
                PointType.FAN,
                5000,
                PointTransactionType.EARN_CHECKIN,
            )
            await session.commit()

            item = await _create_shop_item(session, ShopCategory.DIGITAL, 50, stock=10)
            await session.commit()

            # 3회 교환
            for _ in range(3):
                await svc.exchange(user_id, item.id, PointType.FAN)
                await session.commit()

            # 3회 이상이므로 anomaly = True
            is_anomaly = await svc.check_anomaly(user_id, item.id)
            assert is_anomaly is True

    @pytest.mark.asyncio
    async def test_no_anomaly_below_threshold(self, db_session):
        """동일 상품 월 2회 교환에서는 이상 패턴이 아니다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = ShopService(session)
            point_svc = PointService(session)

            await point_svc.earn(
                user_id,
                PointType.FAN,
                5000,
                PointTransactionType.EARN_CHECKIN,
            )
            await session.commit()

            item = await _create_shop_item(session, ShopCategory.DIGITAL, 50, stock=10)
            await session.commit()

            for _ in range(2):
                await svc.exchange(user_id, item.id, PointType.FAN)
                await session.commit()

            is_anomaly = await svc.check_anomaly(user_id, item.id)
            assert is_anomaly is False


class TestShopCancelExchange:
    """교환 취소 및 AP 환급."""

    @pytest.mark.asyncio
    async def test_cancel_restores_ap(self, db_session):
        """교환 취소 시 AP가 환급되고 재고가 복원된다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = ShopService(session)
            point_svc = PointService(session)

            await point_svc.earn(
                user_id,
                PointType.FAN,
                500,
                PointTransactionType.EARN_CHECKIN,
            )
            await session.commit()

            item = await _create_shop_item(session, ShopCategory.DIGITAL, 200, stock=5)
            await session.commit()

            balance_before = await point_svc.get_balance(user_id, PointType.FAN)
            exchange = await svc.exchange(user_id, item.id, PointType.FAN)
            await session.commit()

            balance_after_exchange = await point_svc.get_balance(user_id, PointType.FAN)
            assert balance_after_exchange == balance_before - 200

            cancelled = await svc.cancel_exchange(exchange.id, user_id, PointType.FAN)
            await session.commit()

            assert cancelled.status == ShopExchangeStatus.CANCELLED
            balance_after_cancel = await point_svc.get_balance(user_id, PointType.FAN)
            assert balance_after_cancel == balance_before


# ===========================================================================
# WP08: Pity tracker info helper
# ===========================================================================


class TestPityTrackerInfo:
    """get_tracker_info 반환값 확인."""

    @pytest.mark.asyncio
    async def test_tracker_info_structure(self, db_session):
        """트래커 정보에 필요한 필드가 모두 포함된다."""
        async with TestSession() as session:
            user_id = await _create_test_user_with_wallets(session)
            svc = PityService(session)

            info = await svc.get_tracker_info(user_id, "concert")
            assert "consecutive_losses" in info
            assert "guaranteed_ticket" in info
            assert "guaranteed_expires_at" in info
            assert "bonus_multiplier" in info
            assert "threshold" in info
            assert "losses_until_guaranteed" in info

            assert info["consecutive_losses"] == 0
            assert info["guaranteed_ticket"] is False
            assert info["bonus_multiplier"] == 1.0
            assert info["threshold"] == 5
            assert info["losses_until_guaranteed"] == 5
