"""AP Shop Service — 상품 교환, 월간 한도, 이상 패턴 감지.

WP09: AP Shop 교환 한도 시스템.
- 카테고리별 월간 AP 사용 한도 체크
- 실물 상품 교환 시 본인인증 레벨 확인
- 재고 관리
- 동일 상품 월 3회 이상 교환 이상 패턴 감지
"""

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import extract, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.point import PointTransactionType, PointType
from app.models.shop import (
    MONTHLY_LIMITS,
    ShopCategory,
    ShopExchange,
    ShopExchangeStatus,
    ShopItem,
)
from app.services.point_service import PointService

logger = logging.getLogger(__name__)

# 이상 패턴 감지 기준: 동일 상품 월간 교환 횟수
ANOMALY_SAME_ITEM_MONTHLY_THRESHOLD = 3


class ShopService:
    """AP Shop 교환 서비스."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.point_service = PointService(session)

    async def get_item(self, item_id: uuid.UUID) -> ShopItem | None:
        """상품 조회."""
        result = await self.session.execute(select(ShopItem).where(ShopItem.id == item_id))
        return result.scalar_one_or_none()

    async def get_monthly_usage(
        self,
        user_id: uuid.UUID,
        category: ShopCategory,
    ) -> int:
        """이번 달 해당 카테고리 사용 AP 합산."""
        now = datetime.now(timezone.utc)
        result = await self.session.execute(
            select(func.coalesce(func.sum(ShopExchange.ap_spent), 0)).where(
                ShopExchange.user_id == user_id,
                ShopExchange.category == category,
                ShopExchange.status != ShopExchangeStatus.CANCELLED,
                extract("year", ShopExchange.created_at) == now.year,
                extract("month", ShopExchange.created_at) == now.month,
            )
        )
        return result.scalar_one()

    async def check_anomaly(
        self,
        user_id: uuid.UUID,
        item_id: uuid.UUID,
    ) -> bool:
        """동일 상품 월 3회 이상 교환 여부 확인.

        Returns:
            True if anomaly detected (same item exchanged >= 3 times this month).
        """
        now = datetime.now(timezone.utc)
        result = await self.session.execute(
            select(func.count(ShopExchange.id)).where(
                ShopExchange.user_id == user_id,
                ShopExchange.item_id == item_id,
                ShopExchange.status != ShopExchangeStatus.CANCELLED,
                extract("year", ShopExchange.created_at) == now.year,
                extract("month", ShopExchange.created_at) == now.month,
            )
        )
        count = result.scalar_one()
        return count >= ANOMALY_SAME_ITEM_MONTHLY_THRESHOLD

    async def exchange(
        self,
        user_id: uuid.UUID,
        item_id: uuid.UUID,
        point_type: PointType = PointType.FAN,
        shipping_address: str | None = None,
        verification_level: int = 0,
    ) -> ShopExchange:
        """AP Shop 상품 교환.

        1. 월간 한도 체크 (해당 카테고리 이번 달 사용량)
        2. 실물 상품이면 verification_level >= 1 체크
        3. 재고 확인 및 차감
        4. AP 차감 (point_service.deduct)
        5. ShopExchange 생성
        6. 이상 패턴 체크: 동일 상품 월 3회 이상 → 로그 플래그

        Args:
            user_id: 사용자 UUID.
            item_id: 상품 UUID.
            point_type: 사용할 포인트 유형 (기본 FAN).
            shipping_address: 실물 상품 배송 주소.
            verification_level: 사용자 본인인증 레벨.

        Returns:
            생성된 ShopExchange.

        Raises:
            ValueError: 상품 없음, 비활성, 재고 부족, 한도 초과, 인증 미달.
        """
        # 1. 상품 조회
        item = await self.get_item(item_id)
        if not item:
            raise ValueError(f"상품을 찾을 수 없습니다: {item_id}")
        if not item.is_active:
            raise ValueError("비활성화된 상품입니다")

        # 2. 월간 한도 체크
        monthly_limit = MONTHLY_LIMITS.get(item.category)
        if monthly_limit is not None:
            current_usage = await self.get_monthly_usage(user_id, item.category)
            if current_usage + item.ap_price > monthly_limit:
                raise ValueError(
                    f"월간 {item.category.value} 카테고리 한도 초과 "
                    f"(현재 {current_usage}/{monthly_limit} AP, "
                    f"요청 {item.ap_price} AP)"
                )

        # 3. 실물 상품 본인인증 체크
        if item.category == ShopCategory.OFFLINE and verification_level < 1:
            raise ValueError("실물 상품 교환에는 본인인증(레벨 1 이상)이 필요합니다")

        # 4. 재고 확인 및 차감
        if item.stock is not None:
            if item.stock <= 0:
                raise ValueError("재고가 부족합니다")
            item.stock -= 1

        # 5. AP 차감
        balance = await self.point_service.get_balance(user_id, point_type)
        if balance < item.ap_price:
            raise ValueError(f"AP가 부족합니다 (보유: {balance}, 필요: {item.ap_price})")
        await self.point_service.deduct(
            user_id=user_id,
            point_type=point_type,
            amount=item.ap_price,
            tx_type=PointTransactionType.DEDUCT_SHOP,
            reference_id=item.id,
            description=f"AP Shop 교환: {item.name}",
        )

        # 6. 교환 기록 생성
        exchange = ShopExchange(
            user_id=user_id,
            item_id=item.id,
            ap_spent=item.ap_price,
            category=item.category,
            status=ShopExchangeStatus.COMPLETED,
            shipping_address=shipping_address,
        )
        self.session.add(exchange)
        await self.session.flush()

        # 7. 이상 패턴 체크 (로그 + 플래그, 교환 자체는 차단하지 않음)
        is_anomaly = await self.check_anomaly(user_id, item_id)
        if is_anomaly:
            logger.warning(
                "AP Shop 이상 패턴 감지: user=%s, item=%s — 동일 상품 월 %d회 이상 교환",
                user_id,
                item_id,
                ANOMALY_SAME_ITEM_MONTHLY_THRESHOLD,
            )

        return exchange

    async def cancel_exchange(
        self,
        exchange_id: uuid.UUID,
        user_id: uuid.UUID,
        point_type: PointType = PointType.FAN,
    ) -> ShopExchange:
        """교환 취소 및 AP 환급.

        Args:
            exchange_id: 교환 기록 UUID.
            user_id: 사용자 UUID.
            point_type: 환급할 포인트 유형.

        Returns:
            취소된 ShopExchange.

        Raises:
            ValueError: 교환 기록 없음, 이미 취소됨, 권한 없음.
        """
        result = await self.session.execute(
            select(ShopExchange).where(ShopExchange.id == exchange_id)
        )
        exchange = result.scalar_one_or_none()
        if not exchange:
            raise ValueError(f"교환 기록을 찾을 수 없습니다: {exchange_id}")
        if exchange.user_id != user_id:
            raise ValueError("권한이 없습니다")
        if exchange.status == ShopExchangeStatus.CANCELLED:
            raise ValueError("이미 취소된 교환입니다")
        if exchange.status == ShopExchangeStatus.SHIPPED:
            raise ValueError("배송 완료된 교환은 취소할 수 없습니다")

        # 상태 변경
        exchange.status = ShopExchangeStatus.CANCELLED

        # 재고 복원
        item = await self.get_item(exchange.item_id)
        if item and item.stock is not None:
            item.stock += 1

        # AP 환급
        await self.point_service.earn(
            user_id=user_id,
            point_type=point_type,
            amount=exchange.ap_spent,
            tx_type=PointTransactionType.REFUND_SHOP,
            reference_id=exchange.id,
            description=f"AP Shop 교환 취소 환급: {item.name if item else '알 수 없음'}",
        )

        await self.session.flush()
        return exchange

    async def list_items(
        self,
        category: ShopCategory | None = None,
        active_only: bool = True,
        limit: int = 50,
        offset: int = 0,
    ) -> list[ShopItem]:
        """상품 목록 조회."""
        query = select(ShopItem)
        if category is not None:
            query = query.where(ShopItem.category == category)
        if active_only:
            query = query.where(ShopItem.is_active.is_(True))
        query = query.order_by(ShopItem.created_at.desc()).limit(limit).offset(offset)
        result = await self.session.execute(query)
        return list(result.scalars().all())

    async def count_items(
        self,
        category: ShopCategory | None = None,
        active_only: bool = True,
    ) -> int:
        """상품 총 개수 조회."""
        query = select(func.count(ShopItem.id))
        if category is not None:
            query = query.where(ShopItem.category == category)
        if active_only:
            query = query.where(ShopItem.is_active.is_(True))
        result = await self.session.execute(query)
        return result.scalar_one()

    async def get_user_exchanges(
        self,
        user_id: uuid.UUID,
        limit: int = 20,
        offset: int = 0,
    ) -> list[ShopExchange]:
        """사용자 교환 이력 조회."""
        result = await self.session.execute(
            select(ShopExchange)
            .where(ShopExchange.user_id == user_id)
            .order_by(ShopExchange.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        return list(result.scalars().all())

    async def count_user_exchanges(
        self,
        user_id: uuid.UUID,
    ) -> int:
        """사용자 교환 이력 총 개수 조회."""
        result = await self.session.execute(
            select(func.count(ShopExchange.id)).where(ShopExchange.user_id == user_id)
        )
        return result.scalar_one()
