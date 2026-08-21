"""
Resale Marketplace Service
===========================
Handles listing creation, buy orders, order matching, and trade execution
for the secondary ticket marketplace.
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, func, select
from sqlalchemy.ext.asyncio import AsyncSession

logger = logging.getLogger(__name__)

from app.core.config import settings
from app.core.redis import redis_lock
from app.models.event import Event, SeatTier
from app.models.order import Order, OrderStatus, OrderType
from app.models.ticket import Ticket, TicketStatus
from app.models.resale import (
    ResaleListingModel,
    ResaleListingStatus,
    ResaleBuyOrderModel,
    ResaleBuyOrderStatus,
)
from app.models.ownership_transfer import OwnershipTransfer, TransferType
from app.core.audit import write_audit_log
from app.repositories.resale_repo import ResaleListingRepo, ResaleBuyOrderRepo
from app.repositories.ticket_repo import TicketRepository
from app.repositories.event_repo import EventRepository
from app.repositories.order_repo import OrderRepository
from app.schemas.resale import (
    ResaleListingResponse,
    ResaleBuyOrderResponse,
    ResaleMarketResponse,
    OrderBookLevel,
    TradeRecord,
    MarketSummary,
    PriceCandle,
    TradingDataResponse,
)


class MarketManipulationDetector:
    """실시간 시장 조작 탐지 — 워시트레이딩, 스푸핑, 가격 이상치 3중 검증.

    Real-time market manipulation detection using three independent detectors:
    1. Wash trading: Circular trading between related accounts
    2. Spoofing: High cancel-rate order placement to manipulate prices
    3. Price outlier: Statistical outlier detection via IQR method
    """

    WASH_TRADE_WINDOW_HOURS = 24
    SPOOFING_CANCEL_THRESHOLD = 0.8

    @staticmethod
    def detect_wash_trading(
        buyer_id: str,
        seller_id: str,
        recent_trades: list[dict],
    ) -> bool:
        """Detect wash trading (circular A↔B trades within 24h window).

        Returns True if manipulation detected.
        """
        if str(buyer_id) == str(seller_id):
            return True  # Self-trading

        # Check for reverse trades in recent history
        for trade in recent_trades:
            if str(trade.get("buyer_id")) == str(seller_id) and str(trade.get("seller_id")) == str(
                buyer_id
            ):
                return True
        return False

    @staticmethod
    def detect_spoofing(
        user_id: str,
        order_history: list[dict],
    ) -> bool:
        """Detect spoofing (>80% cancel rate in recent orders).

        Returns True if spoofing pattern detected.
        """
        if not order_history:
            return False

        user_orders = [o for o in order_history if str(o.get("user_id")) == str(user_id)]
        if len(user_orders) < 5:  # Minimum sample size
            return False

        cancelled = sum(1 for o in user_orders if o.get("status") == "CANCELLED")
        cancel_rate = cancelled / len(user_orders)
        return cancel_rate > MarketManipulationDetector.SPOOFING_CANCEL_THRESHOLD

    @staticmethod
    def detect_price_outlier(
        price: float,
        recent_prices: list[float],
    ) -> bool:
        """Detect price outlier using IQR method.

        Returns True if price is outside Q1 - 1.5*IQR or Q3 + 1.5*IQR.
        """
        if len(recent_prices) < 4:
            return False

        sorted_prices = sorted(recent_prices)
        n = len(sorted_prices)
        q1 = sorted_prices[n // 4]
        q3 = sorted_prices[3 * n // 4]
        iqr = q3 - q1

        lower_bound = q1 - 1.5 * iqr
        upper_bound = q3 + 1.5 * iqr
        return price < lower_bound or price > upper_bound


class DynamicFeeEngine:
    """시장 상황 기반 수수료 자동 조정 — 다변수 함수.

    Dynamically adjusts transaction fees based on:
    - Market heat (trade volume relative to listing count)
    - Bid-ask spread ratio
    - Market liquidity (order book depth)

    Fee = clip(base + heat_adj + spread_adj + liquidity_adj, 0.05, 0.20)
    """

    BASE_RATE = 0.10
    MIN_RATE = 0.05
    MAX_RATE = 0.20

    @staticmethod
    def compute_fee_rate(
        trade_count_24h: int = 0,
        listing_count: int = 1,
        bid_ask_spread: float = 0.0,
        order_book_depth: int = 1,
    ) -> dict:
        """Compute dynamic fee rate based on market conditions.

        Returns:
            Dict with fee_rate and component breakdown.
        """
        # Market heat: high volume relative to listings = hot market
        heat_index = trade_count_24h / max(1, listing_count)
        heat_adj = min(0.05, heat_index * 0.01)

        # Spread adjustment: wide spread = illiquid → reduce fees
        spread_adj = max(-0.03, -bid_ask_spread * 0.02)

        # Liquidity adjustment: thin book → reduce fees to attract orders
        liquidity_adj = max(-0.02, -(1.0 / max(1, order_book_depth)) * 0.01)

        final_rate = max(
            DynamicFeeEngine.MIN_RATE,
            min(
                DynamicFeeEngine.MAX_RATE,
                DynamicFeeEngine.BASE_RATE + heat_adj + spread_adj + liquidity_adj,
            ),
        )

        return {
            "fee_rate": round(final_rate, 4),
            "base_rate": DynamicFeeEngine.BASE_RATE,
            "heat_adj": round(heat_adj, 4),
            "spread_adj": round(spread_adj, 4),
            "liquidity_adj": round(liquidity_adj, 4),
        }


class CircuitBreaker:
    """가격 급변 시 매칭 중단 — 서킷브레이커 상태 머신.

    Implements a financial-style circuit breaker for digital asset trading:
    - NORMAL: Trading proceeds normally
    - HALTED: Trading suspended due to price volatility
    - COOLDOWN: Post-halt recovery period

    State transitions:
    NORMAL → HALTED: When |price_change/reference| > threshold (30%)
    HALTED → COOLDOWN: After halt_duration (300s) expires
    COOLDOWN → NORMAL: After cooldown_duration (300s) expires
    """

    PRICE_CHANGE_THRESHOLD = 0.30
    HALT_DURATION = 300  # seconds
    COOLDOWN_DURATION = 300  # seconds

    def __init__(self):
        self.state = "NORMAL"
        self._state_changed_at: float = 0.0

    def check_price_movement(
        self,
        current_price: float,
        reference_price: float,
        current_time: float | None = None,
    ) -> dict:
        """Check if price movement triggers circuit breaker.

        Returns:
            Dict with 'allow_trading' bool and 'state' string.
        """
        import time as _time

        now = current_time or _time.time()

        # Handle state transitions based on time
        if self.state == "HALTED":
            if now - self._state_changed_at >= self.HALT_DURATION:
                self.state = "COOLDOWN"
                self._state_changed_at = now
        elif self.state == "COOLDOWN":
            if now - self._state_changed_at >= self.COOLDOWN_DURATION:
                self.state = "NORMAL"
                self._state_changed_at = now

        # Check for new circuit breaker trigger
        if self.state == "NORMAL" and reference_price > 0:
            price_change = abs(current_price - reference_price) / reference_price
            if price_change > self.PRICE_CHANGE_THRESHOLD:
                self.state = "HALTED"
                self._state_changed_at = now

        return {
            "allow_trading": self.state == "NORMAL",
            "state": self.state,
            "threshold": self.PRICE_CHANGE_THRESHOLD,
        }


class ResaleService:
    """Service for the secondary ticket marketplace."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.listing_repo = ResaleListingRepo(session)
        self.buy_order_repo = ResaleBuyOrderRepo(session)
        self.ticket_repo = TicketRepository(session)
        self.event_repo = EventRepository(session)
        self.order_repo = OrderRepository(session)
        self.detector = MarketManipulationDetector()

    # ------------------------------------------------------------------
    # Listings
    # ------------------------------------------------------------------

    async def create_listing(
        self,
        seller_id: uuid.UUID,
        ticket_id: uuid.UUID,
        asking_price: float,
    ) -> ResaleListingResponse:
        """Create a new resale listing for a ticket.

        Validates ownership, resale eligibility, price caps, and
        computes the fee split before persisting the listing.

        Args:
            seller_id: The current owner of the ticket.
            ticket_id: The ticket to list for resale.
            asking_price: The seller's requested price.

        Returns:
            ResaleListingResponse with the created listing details.

        Raises:
            ValueError: If any validation check fails.
        """
        # 1. Load ticket with FOR UPDATE — 환불/양도와의 동시 접근 차단
        ticket = await self.ticket_repo.get_for_update(ticket_id)
        if not ticket:
            raise ValueError("Ticket not found")
        if ticket.current_owner_id != seller_id:
            raise PermissionError("You do not own this ticket")
        if not ticket.is_resalable:
            raise ValueError("This ticket is not resalable")
        if ticket.status != TicketStatus.ACTIVE:
            raise ValueError("Ticket must be in ACTIVE status to list for resale")
        # F1: 최초 입장 후 재판매 차단(allpass 는 입장해도 ACTIVE 유지 → 별도 가드 필요).
        if getattr(ticket, "first_checked_in_at", None) is not None:
            raise ValueError("이미 입장한 티켓은 재판매할 수 없습니다.")

        # 2. Check for existing active listing on this ticket
        existing = await self.listing_repo.get_active_for_ticket(ticket_id)
        if existing:
            raise ValueError("This ticket already has an active listing")

        # 3. Load event and check resale settings
        event = await self.event_repo.get(ticket.event_id)
        if not event:
            raise ValueError("Event not found")
        if not event.resale_enabled:
            raise ValueError("Resale is not enabled for this event")

        now = datetime.now(timezone.utc)
        # Ensure timezone-aware comparison (SQLite stores naive datetimes)
        opens_at = event.resale_opens_at
        if opens_at and opens_at.tzinfo is None:
            opens_at = opens_at.replace(tzinfo=timezone.utc)
        closes_at = event.resale_closes_at
        if closes_at and closes_at.tzinfo is None:
            closes_at = closes_at.replace(tzinfo=timezone.utc)
        if opens_at and now < opens_at:
            raise ValueError("Resale window has not opened yet")
        if closes_at and now > closes_at:
            raise ValueError("Resale window has closed")

        if asking_price > settings.RESALE_ABSOLUTE_PRICE_CEILING:
            raise ValueError(
                f"Asking price cannot exceed {settings.RESALE_ABSOLUTE_PRICE_CEILING:,.0f} KRW"
            )

        # 4. Price validation: asking_price <= original_price * (1 + markup_pct/100)
        max_markup_pct = event.resale_max_markup_pct or 0.0
        purchase_price_f = float(ticket.purchase_price)
        max_allowed_price = purchase_price_f * (1.0 + max_markup_pct / 100.0)
        if asking_price > max_allowed_price:
            raise ValueError(
                f"Asking price {asking_price} exceeds maximum allowed price "
                f"{max_allowed_price:.2f} ({max_markup_pct}% markup cap)"
            )

        # 5. Compute fee split — surplus-based recapture model
        #
        # If selling at or below face value: no fees, seller keeps full amount.
        # If selling above face value (premium > 0):
        #   - seller_payout  = original_price + premium * 40%
        #   - organizer_payout (artist_royalty) = premium * 50%
        #   - platform_payout (platform_fee)    = premium * 10%
        #
        original_price = purchase_price_f
        premium = asking_price - original_price

        if premium <= 0:
            # Selling at or below face value — no fees
            platform_fee = 0.0
            artist_royalty = 0.0
            seller_receives = round(asking_price, 2)
        else:
            # Surplus-based recapture on the markup
            seller_receives = round(
                original_price + premium * settings.RESALE_SELLER_PREMIUM_RATE, 2
            )
            artist_royalty = round(premium * settings.RESALE_ARTIST_ROYALTY_RATE, 2)
            platform_fee = round(premium * settings.RESALE_PLATFORM_FEE_RATE, 2)

        # 6. Create listing
        listing = await self.listing_repo.create(
            ticket_id=ticket_id,
            seller_id=seller_id,
            asking_price=asking_price,
            status=ResaleListingStatus.ACTIVE,
            seller_receives=seller_receives,
            platform_fee=platform_fee,
            artist_royalty=artist_royalty,
        )

        # 7. Audit log
        await write_audit_log(
            self.session,
            actor_id=seller_id,
            action="resale_listing_created",
            resource_type="resale_listing",
            resource_id=str(listing.id),
            event_id=ticket.event_id,
            tier_id=ticket.tier_id,
            sale_mode="resale",
            new_value={
                "listing_id": str(listing.id),
                "ticket_id": str(ticket_id),
                "asking_price": asking_price,
                "seller_receives": seller_receives,
                "platform_fee": platform_fee,
                "artist_royalty": artist_royalty,
                "result": "success",
            },
        )

        return ResaleListingResponse.model_validate(listing)

    async def cancel_listing(self, seller_id: uuid.UUID, listing_id: uuid.UUID) -> None:
        """Cancel an active resale listing. Only the seller can cancel.

        Args:
            seller_id: The user requesting cancellation.
            listing_id: The listing to cancel.

        Raises:
            ValueError: If the listing is not found or not active.
            PermissionError: If the caller is not the seller.
        """
        # FOR UPDATE: 동시 매칭(get_lowest_ask)·결제확정(payment_service의 listing
        # 락)과 직렬화한다. 비락 SELECT면 매칭이 MATCHED를 커밋한 직후 취소가 stale
        # ACTIVE 검사 결과로 CANCELLED를 덮어써 lost-update가 발생한다 (M-2).
        listing = await self.listing_repo.get_for_update(listing_id)
        if not listing:
            raise ValueError("Listing not found")
        if listing.seller_id != seller_id:
            raise PermissionError("You do not own this listing")
        if listing.status != ResaleListingStatus.ACTIVE:
            raise ValueError("Listing is not active")

        listing.status = ResaleListingStatus.CANCELLED
        await self.session.flush()

    # ------------------------------------------------------------------
    # Buy orders
    # ------------------------------------------------------------------

    async def create_buy_order(
        self,
        buyer_id: uuid.UUID,
        event_id: uuid.UUID,
        tier_id: uuid.UUID,
        max_price: float,
    ) -> ResaleBuyOrderResponse:
        """Create a buy order (bid) on the resale market.

        Args:
            buyer_id: The buyer placing the order.
            event_id: The event UUID.
            tier_id: The seat tier UUID.
            max_price: Maximum price the buyer is willing to pay.

        Returns:
            ResaleBuyOrderResponse with the created buy order.

        Raises:
            ValueError: If the event does not exist or resale is disabled.
        """
        event = await self.event_repo.get(event_id)
        if not event:
            raise ValueError("Event not found")
        if not event.resale_enabled:
            raise ValueError("Resale is not enabled for this event")
        if max_price > settings.RESALE_ABSOLUTE_PRICE_CEILING:
            raise ValueError(
                f"Max price cannot exceed {settings.RESALE_ABSOLUTE_PRICE_CEILING:,.0f} KRW"
            )

        active_orders = await self.buy_order_repo.count_active_by_user_event(buyer_id, event_id)
        if active_orders >= settings.RESALE_MAX_BUY_ORDERS_PER_USER_EVENT:
            raise ValueError(
                f"You can only keep {settings.RESALE_MAX_BUY_ORDERS_PER_USER_EVENT} active buy orders per event"
            )

        buy_order = await self.buy_order_repo.create(
            event_id=event_id,
            tier_id=tier_id,
            buyer_id=buyer_id,
            max_price=max_price,
            status=ResaleBuyOrderStatus.ACTIVE,
        )

        # Audit log
        await write_audit_log(
            self.session,
            actor_id=buyer_id,
            action="resale_buy_order_created",
            resource_type="resale_buy_order",
            resource_id=str(buy_order.id),
            event_id=event_id,
            tier_id=tier_id,
            sale_mode="resale",
            new_value={
                "buy_order_id": str(buy_order.id),
                "max_price": max_price,
                "result": "success",
            },
        )

        return ResaleBuyOrderResponse.model_validate(buy_order)

    async def cancel_buy_order(self, buyer_id: uuid.UUID, order_id: uuid.UUID) -> None:
        """Cancel an active buy order. Only the buyer can cancel.

        Args:
            buyer_id: The user requesting cancellation.
            order_id: The buy order to cancel.

        Raises:
            ValueError: If the buy order is not found or not active.
            PermissionError: If the caller is not the buyer.
        """
        buy_order = await self.buy_order_repo.get(order_id)
        if not buy_order:
            raise ValueError("Buy order not found")
        if buy_order.buyer_id != buyer_id:
            raise PermissionError("You do not own this buy order")
        if buy_order.status != ResaleBuyOrderStatus.ACTIVE:
            raise ValueError("Buy order is not active")

        buy_order.status = ResaleBuyOrderStatus.CANCELLED
        await self.session.flush()

    # ------------------------------------------------------------------
    # Matching & execution
    # ------------------------------------------------------------------

    async def match_and_execute(self, event_id: uuid.UUID, tier_id: uuid.UUID) -> list[dict]:
        """Match the lowest ask with the highest bid and execute trades.

        Uses a Redis distributed lock to prevent concurrent matching
        for the same event/tier combination.

        Args:
            event_id: The event UUID.
            tier_id: The seat tier UUID.

        Returns:
            A list of trade dicts with details of each executed trade.
        """
        trades = []
        async with redis_lock(f"v2:resale:match:{{{event_id}}}:{tier_id}", ttl=10):
            # 최근 거래 내역 조회 (워시 트레이딩 탐지용)
            recent_transfers = await self.session.execute(
                select(OwnershipTransfer)
                .join(Ticket, Ticket.id == OwnershipTransfer.ticket_id)
                .where(
                    Ticket.event_id == event_id,
                    Ticket.tier_id == tier_id,
                    OwnershipTransfer.transfer_type == TransferType.RESALE,
                )
                .order_by(OwnershipTransfer.transferred_at.desc())
                .limit(50)
            )
            recent_trade_history = [
                {
                    "buyer_id": str(t.to_user_id),
                    "seller_id": str(t.from_user_id),
                }
                for t in recent_transfers.scalars().all()
            ]

            while True:
                lowest_ask = await self.listing_repo.get_lowest_ask(event_id, tier_id)
                highest_bid = await self.buy_order_repo.get_highest_bid(event_id, tier_id)

                if not lowest_ask or not highest_bid:
                    break
                if lowest_ask.asking_price > highest_bid.max_price:
                    break

                # M-2: 환불(CANCELLED)·체크인(USED)·양도된 티켓의 잔존 리스팅은
                # 매칭 전에 제거 — 환불/체크인은 current_owner_id를 바꾸지 않으므로
                # 소유자 검증만으로는 잡히지 않는다. 결제 확정 시점의 재검증
                # (payment_service._resale_ticket_unsellable_reason)과 이중 방어.
                ask_ticket = await self.ticket_repo.get(lowest_ask.ticket_id)
                if ask_ticket and ask_ticket.status != TicketStatus.ACTIVE:
                    logger.warning(
                        "Unsellable ticket listing removed from matching: "
                        "listing=%s ticket=%s status=%s",
                        lowest_ask.id, lowest_ask.ticket_id, ask_ticket.status.value,
                    )
                    lowest_ask.status = ResaleListingStatus.CANCELLED
                    await self.session.flush()
                    continue  # 다음 최저가 리스팅으로 재매칭 시도

                # Self-trade prevention: 동일 유저의 매도-매수 매칭 차단
                if str(lowest_ask.seller_id) == str(highest_bid.buyer_id):
                    logger.warning("Self-trade prevented: user=%s", lowest_ask.seller_id)
                    highest_bid.status = ResaleBuyOrderStatus.CANCELLED
                    await self.session.flush()
                    continue  # 다음 최고가 매수 주문으로 재매칭 시도

                # Wash trading detection: 순환 거래 패턴 탐지
                try:
                    is_wash = self.detector.detect_wash_trading(
                        seller_id=str(lowest_ask.seller_id),
                        buyer_id=str(highest_bid.buyer_id),
                        recent_trades=recent_trade_history,
                    )
                    if is_wash:
                        logger.warning(
                            "Wash trading detected: seller=%s buyer=%s",
                            lowest_ask.seller_id,
                            highest_bid.buyer_id,
                        )
                        highest_bid.status = ResaleBuyOrderStatus.CANCELLED
                        await self.session.flush()
                        continue
                except Exception:
                    pass  # 탐지 오류로 거래를 차단하지 않음

                trade = await self._execute_trade(lowest_ask, highest_bid)
                trades.append(trade)

        return trades

    async def _execute_trade(
        self,
        listing: ResaleListingModel,
        buy_order: ResaleBuyOrderModel,
    ) -> dict:
        """Match a resale listing with a buy order and create a payment-required order.

        Does NOT transfer ticket ownership yet. The actual transfer happens
        only when payment is confirmed (via webhook or payment verification).

        Args:
            listing: The matched resale listing (ask side).
            buy_order: The matched buy order (bid side).

        Returns:
            A dict summarising the matched trade.
        """
        # Load ticket
        ticket = await self.ticket_repo.get(listing.ticket_id)
        if not ticket:
            raise ValueError("Ticket not found for matched listing")
        if ticket.current_owner_id != listing.seller_id:
            raise ValueError("Ticket owner does not match listing seller")

        seller_id = listing.seller_id
        buyer_id = buy_order.buyer_id

        # 1. Mark listing and buy order as MATCHED (do NOT transfer ownership yet)
        listing.status = ResaleListingStatus.MATCHED
        buy_order.status = ResaleBuyOrderStatus.MATCHED

        # 2. Create Order record for buyer with PAYMENT_REQUIRED
        buy_order_record = Order(
            user_id=buyer_id,
            event_id=ticket.event_id,
            tier_id=ticket.tier_id,
            order_type=OrderType.RESALE_BUY,
            status=OrderStatus.PAYMENT_REQUIRED,
            quantity=1,
            unit_price=listing.asking_price,
            total_amount=listing.asking_price,
            payment_deadline=datetime.now(timezone.utc) + timedelta(minutes=15),
            payment_metadata={
                "resale": {
                    "listing_id": str(listing.id),
                    "buy_order_id": str(buy_order.id),
                    "ticket_id": str(ticket.id),
                    "seller_id": str(seller_id),
                    "seller_receives": float(listing.seller_receives),
                    "platform_fee": float(listing.platform_fee),
                    "artist_royalty": float(listing.artist_royalty),
                }
            },
        )
        self.session.add(buy_order_record)

        # 3. Audit log
        await write_audit_log(
            self.session,
            actor_id=buyer_id,
            action="resale_trade_matched",
            resource_type="resale_trade",
            resource_id=str(listing.id),
            event_id=ticket.event_id,
            tier_id=ticket.tier_id,
            sale_mode="resale",
            new_value={
                "listing_id": str(listing.id),
                "buy_order_id": str(buy_order.id),
                "ticket_id": str(ticket.id),
                "seller_id": str(seller_id),
                "buyer_id": str(buyer_id),
                "price": float(listing.asking_price),
                "seller_receives": float(listing.seller_receives),
                "platform_fee": float(listing.platform_fee),
                "artist_royalty": float(listing.artist_royalty),
                "result": "success",
            },
        )

        return {
            "listing_id": str(listing.id),
            "buy_order_id": str(buy_order.id),
            "ticket_id": str(ticket.id),
            "seller_id": str(seller_id),
            "buyer_id": str(buyer_id),
            "price": float(listing.asking_price),
            "seller_receives": float(listing.seller_receives),
            "platform_fee": float(listing.platform_fee),
            "artist_royalty": float(listing.artist_royalty),
        }

    # ------------------------------------------------------------------
    # Market data & browsing
    # ------------------------------------------------------------------

    async def get_market_data(
        self, event_id: uuid.UUID, tier_id: uuid.UUID
    ) -> ResaleMarketResponse:
        """Aggregate market data for an event/tier: asks, bids, and recent trades.

        Args:
            event_id: The event UUID.
            tier_id: The seat tier UUID.

        Returns:
            ResaleMarketResponse with asks, bids, recent trades, and
            the lowest ask / highest bid prices.
        """
        asks = await self.listing_repo.get_active_by_event_tier(event_id, tier_id, limit=20)
        bids = await self.buy_order_repo.get_active_by_event_tier(event_id, tier_id, limit=20)

        # Recent trades: completed ownership transfers for this event/tier
        from sqlalchemy import select as sa_select

        recent_result = await self.session.execute(
            sa_select(OwnershipTransfer)
            .join(Ticket, Ticket.id == OwnershipTransfer.ticket_id)
            .where(
                Ticket.event_id == event_id,
                Ticket.tier_id == tier_id,
                OwnershipTransfer.transfer_type == TransferType.RESALE,
            )
            .order_by(OwnershipTransfer.transferred_at.desc())
            .limit(20)
        )
        recent_transfers = recent_result.scalars().all()

        recent_trades = [
            {
                "ticket_id": str(t.ticket_id),
                "price": t.price,
                "seller_amount": t.seller_amount,
                "platform_fee": t.platform_fee,
                "artist_royalty": t.artist_royalty,
                "transferred_at": t.transferred_at.isoformat() if t.transferred_at else None,
            }
            for t in recent_transfers
        ]

        lowest_ask = asks[0].asking_price if asks else None
        highest_bid = bids[0].max_price if bids else None

        return ResaleMarketResponse(
            asks=[ResaleListingResponse.model_validate(a) for a in asks],
            bids=[ResaleBuyOrderResponse.model_validate(b) for b in bids],
            recent_trades=recent_trades,
            lowest_ask=lowest_ask,
            highest_bid=highest_bid,
        )

    async def browse_listings(
        self,
        event_id: uuid.UUID,
        tier_id: uuid.UUID,
        skip: int = 0,
        limit: int = 50,
    ) -> list[ResaleListingResponse]:
        """Browse active resale listings for a given event/tier.

        Args:
            event_id: The event UUID.
            tier_id: The seat tier UUID.
            skip: Pagination offset.
            limit: Maximum number of listings to return.

        Returns:
            A list of ResaleListingResponse objects.
        """
        listings = await self.listing_repo.get_active_by_event_tier(
            event_id, tier_id, skip=skip, limit=limit
        )
        return [ResaleListingResponse.model_validate(listing) for listing in listings]

    async def browse_all_listings(
        self,
        category: str | None = None,
        skip: int = 0,
        limit: int = 20,
    ) -> dict:
        """Browse all active resale listings with enriched event data."""
        from app.schemas.resale import ResaleListingDetailResponse, ResaleListingBrowseResponse

        rows, total = await self.listing_repo.browse_all_active(
            category=category, skip=skip, limit=limit
        )

        listings = []
        for listing, ticket, event, tier, seller in rows:
            listings.append(
                ResaleListingDetailResponse(
                    id=listing.id,
                    ticket_id=listing.ticket_id,
                    seller_id=listing.seller_id,
                    asking_price=listing.asking_price,
                    status=listing.status.value
                    if hasattr(listing.status, "value")
                    else listing.status,
                    seller_receives=listing.seller_receives,
                    artist_royalty=listing.artist_royalty,
                    created_at=listing.created_at,
                    event_id=event.id,
                    event_title=event.title,
                    event_date=event.event_date,
                    venue=event.venue,
                    category=event.category,
                    image_url=event.image_url,
                    artist_name=event.artist_name,
                    original_price=ticket.purchase_price,
                    section=None,  # Could be added via seat join if needed
                    tier_name=tier.name,
                    seller_name=seller.name,
                )
            )

        return ResaleListingBrowseResponse(listings=listings, total=total)

    async def get_resale_events(
        self, category: str | None = None, skip: int = 0, limit: int = 20
    ) -> list[dict]:
        """Return events that have active resale listings, with summary stats."""

        listing_stats = (
            select(Ticket.event_id)
            .add_columns(
                Ticket.tier_id.label("tier_id"),
                func.count(ResaleListingModel.id).label("listing_count"),
                func.min(ResaleListingModel.asking_price).label("lowest_ask"),
            )
            .join(
                ResaleListingModel,
                ResaleListingModel.ticket_id == Ticket.id,
            )
            .where(ResaleListingModel.status == ResaleListingStatus.ACTIVE)
            .group_by(Ticket.event_id, Ticket.tier_id)
            .subquery()
        )

        buy_stats = (
            select(
                ResaleBuyOrderModel.event_id.label("event_id"),
                ResaleBuyOrderModel.tier_id.label("tier_id"),
                func.count(ResaleBuyOrderModel.id).label("buy_order_count"),
            )
            .where(ResaleBuyOrderModel.status == ResaleBuyOrderStatus.ACTIVE)
            .group_by(ResaleBuyOrderModel.event_id, ResaleBuyOrderModel.tier_id)
            .subquery()
        )

        event_ids_query = (
            select(Event.id)
            .join(listing_stats, listing_stats.c.event_id == Event.id)
            .where(Event.resale_enabled.is_(True))
            .group_by(Event.id, Event.bid_count)
            .order_by(Event.bid_count.desc())
            .offset(skip)
            .limit(limit)
        )
        if category:
            event_ids_query = event_ids_query.where(func.upper(Event.category) == category.upper())

        event_ids = [row[0] for row in (await self.session.execute(event_ids_query)).all()]
        if not event_ids:
            return []

        rows = (
            await self.session.execute(
                select(
                    Event,
                    SeatTier,
                    listing_stats.c.listing_count,
                    listing_stats.c.lowest_ask,
                    func.coalesce(buy_stats.c.buy_order_count, 0).label("buy_order_count"),
                )
                .join(SeatTier, SeatTier.event_id == Event.id)
                .join(
                    listing_stats,
                    and_(
                        listing_stats.c.event_id == Event.id,
                        listing_stats.c.tier_id == SeatTier.id,
                    ),
                )
                .outerjoin(
                    buy_stats,
                    and_(
                        buy_stats.c.event_id == Event.id,
                        buy_stats.c.tier_id == SeatTier.id,
                    ),
                )
                .where(Event.id.in_(event_ids))
                .order_by(Event.bid_count.desc(), SeatTier.base_price.asc())
            )
        ).all()

        event_map: dict[uuid.UUID, dict] = {}
        for event, tier, listing_count, lowest_ask, buy_order_count in rows:
            listing_count = int(listing_count or 0)
            if listing_count <= 0:
                continue

            if event.id not in event_map:
                event_map[event.id] = {
                    "event_id": str(event.id),
                    "title": event.title,
                    "venue": event.venue,
                    "event_date": event.event_date.isoformat() if event.event_date else None,
                    "category": event.category,
                    "sub_category": event.sub_category,
                    "image_url": event.image_url,
                    "thumbnail_url": event.thumbnail_url,
                    "location_city": event.location_city,
                    "artist_name": event.artist_name,
                    "age_restriction": event.age_restriction,
                    "bid_count": event.bid_count,
                    "view_count": event.view_count,
                    "tiers": [],
                }

            event_map[event.id]["tiers"].append(
                {
                    "tier_id": str(tier.id),
                    "tier_name": tier.name,
                    "base_price": tier.base_price,
                    "listing_count": listing_count,
                    "lowest_ask": lowest_ask,
                    "buy_order_count": int(buy_order_count or 0),
                }
            )

        output = []
        for event_id in event_ids:
            payload = event_map.get(event_id)
            if payload and payload["tiers"]:
                output.append(payload)

        return output

    # ------------------------------------------------------------------
    # Trading data (stock-style UI)
    # ------------------------------------------------------------------

    async def get_order_book_depth(
        self, event_id: uuid.UUID, tier_id: uuid.UUID
    ) -> tuple[list[OrderBookLevel], list[OrderBookLevel]]:
        """Aggregate order book by price level.

        Returns:
            Tuple of (ask_levels sorted price ASC, bid_levels sorted price DESC).
        """
        # Ask levels: group active listings by asking_price
        ask_result = await self.session.execute(
            select(
                ResaleListingModel.asking_price,
                func.count().label("quantity"),
            )
            .join(Ticket, Ticket.id == ResaleListingModel.ticket_id)
            .where(
                Ticket.event_id == event_id,
                Ticket.tier_id == tier_id,
                ResaleListingModel.status == ResaleListingStatus.ACTIVE,
            )
            .group_by(ResaleListingModel.asking_price)
            .order_by(ResaleListingModel.asking_price.asc())
            .limit(15)
        )
        ask_levels = [
            OrderBookLevel(
                price=row.asking_price,
                quantity=row.quantity,
                total_volume=round(row.asking_price * row.quantity, 2),
            )
            for row in ask_result.all()
        ]

        # Bid levels: group active buy orders by max_price
        bid_result = await self.session.execute(
            select(
                ResaleBuyOrderModel.max_price,
                func.count().label("quantity"),
            )
            .where(
                ResaleBuyOrderModel.event_id == event_id,
                ResaleBuyOrderModel.tier_id == tier_id,
                ResaleBuyOrderModel.status == ResaleBuyOrderStatus.ACTIVE,
            )
            .group_by(ResaleBuyOrderModel.max_price)
            .order_by(ResaleBuyOrderModel.max_price.desc())
            .limit(15)
        )
        bid_levels = [
            OrderBookLevel(
                price=row.max_price,
                quantity=row.quantity,
                total_volume=round(row.max_price * row.quantity, 2),
            )
            for row in bid_result.all()
        ]

        return ask_levels, bid_levels

    async def get_trade_history(
        self, event_id: uuid.UUID, tier_id: uuid.UUID, limit: int = 50
    ) -> list[TradeRecord]:
        """Get recent executed trades for an event/tier."""
        result = await self.session.execute(
            select(OwnershipTransfer)
            .join(Ticket, Ticket.id == OwnershipTransfer.ticket_id)
            .where(
                Ticket.event_id == event_id,
                Ticket.tier_id == tier_id,
                OwnershipTransfer.transfer_type == TransferType.RESALE,
            )
            .order_by(OwnershipTransfer.transferred_at.desc())
            .limit(limit)
        )
        transfers = result.scalars().all()
        return [
            TradeRecord(
                ticket_id=str(t.ticket_id),
                price=t.price,
                seller_amount=t.seller_amount,
                platform_fee=t.platform_fee,
                artist_royalty=t.artist_royalty,
                transferred_at=t.transferred_at,
            )
            for t in transfers
        ]

    async def get_market_summary(self, event_id: uuid.UUID, tier_id: uuid.UUID) -> MarketSummary:
        """Compute market summary: current price, 24h change, high/low, volume."""
        now = datetime.now(timezone.utc)
        day_ago = now - timedelta(hours=24)

        # Recent trades in the last 24h
        result = await self.session.execute(
            select(OwnershipTransfer.price, OwnershipTransfer.transferred_at)
            .join(Ticket, Ticket.id == OwnershipTransfer.ticket_id)
            .where(
                Ticket.event_id == event_id,
                Ticket.tier_id == tier_id,
                OwnershipTransfer.transfer_type == TransferType.RESALE,
            )
            .order_by(OwnershipTransfer.transferred_at.desc())
            .limit(200)
        )
        all_trades = result.all()

        if not all_trades:
            # Count active listings and buy orders
            listing_count = (
                await self.session.scalar(
                    select(func.count())
                    .select_from(ResaleListingModel)
                    .join(Ticket, Ticket.id == ResaleListingModel.ticket_id)
                    .where(
                        Ticket.event_id == event_id,
                        Ticket.tier_id == tier_id,
                        ResaleListingModel.status == ResaleListingStatus.ACTIVE,
                    )
                )
                or 0
            )
            order_count = (
                await self.session.scalar(
                    select(func.count())
                    .select_from(ResaleBuyOrderModel)
                    .where(
                        ResaleBuyOrderModel.event_id == event_id,
                        ResaleBuyOrderModel.tier_id == tier_id,
                        ResaleBuyOrderModel.status == ResaleBuyOrderStatus.ACTIVE,
                    )
                )
                or 0
            )
            return MarketSummary(total_listings=listing_count, total_buy_orders=order_count)

        current_price = all_trades[0].price

        # Filter 24h trades for stats
        day_trades = []
        older_price = None
        for t in all_trades:
            t_at = t.transferred_at
            if t_at and t_at.tzinfo is None:
                t_at = t_at.replace(tzinfo=timezone.utc)
            if t_at and t_at >= day_ago:
                day_trades.append(t.price)
            elif older_price is None:
                older_price = t.price

        day_high = max(day_trades) if day_trades else current_price
        day_low = min(day_trades) if day_trades else current_price
        day_volume = len(day_trades)

        # Price change vs first trade before 24h window or oldest trade
        reference = (
            older_price if older_price else (day_trades[-1] if day_trades else current_price)
        )
        price_change = round(current_price - reference, 2)
        price_change_pct = round((price_change / reference) * 100, 2) if reference else 0.0

        listing_count = (
            await self.session.scalar(
                select(func.count())
                .select_from(ResaleListingModel)
                .join(Ticket, Ticket.id == ResaleListingModel.ticket_id)
                .where(
                    Ticket.event_id == event_id,
                    Ticket.tier_id == tier_id,
                    ResaleListingModel.status == ResaleListingStatus.ACTIVE,
                )
            )
            or 0
        )
        order_count = (
            await self.session.scalar(
                select(func.count())
                .select_from(ResaleBuyOrderModel)
                .where(
                    ResaleBuyOrderModel.event_id == event_id,
                    ResaleBuyOrderModel.tier_id == tier_id,
                    ResaleBuyOrderModel.status == ResaleBuyOrderStatus.ACTIVE,
                )
            )
            or 0
        )

        return MarketSummary(
            current_price=current_price,
            price_change=price_change,
            price_change_pct=price_change_pct,
            day_high=day_high,
            day_low=day_low,
            day_volume=day_volume,
            total_listings=listing_count,
            total_buy_orders=order_count,
        )

    async def get_price_candles(
        self,
        event_id: uuid.UUID,
        tier_id: uuid.UUID,
        interval_hours: int = 1,
        limit: int = 48,
    ) -> list[PriceCandle]:
        """Build OHLCV candles from trade history."""
        now = datetime.now(timezone.utc)
        start = now - timedelta(hours=interval_hours * limit)

        result = await self.session.execute(
            select(OwnershipTransfer.price, OwnershipTransfer.transferred_at)
            .join(Ticket, Ticket.id == OwnershipTransfer.ticket_id)
            .where(
                Ticket.event_id == event_id,
                Ticket.tier_id == tier_id,
                OwnershipTransfer.transfer_type == TransferType.RESALE,
                OwnershipTransfer.transferred_at >= start,
            )
            .order_by(OwnershipTransfer.transferred_at.asc())
        )
        trades = result.all()

        if not trades:
            return []

        # Bucket trades into intervals
        interval = timedelta(hours=interval_hours)
        candles: list[PriceCandle] = []
        bucket_start = start
        trade_idx = 0

        last_close = trades[0].price if trades else 0

        while bucket_start < now and len(candles) < limit:
            bucket_end = bucket_start + interval
            bucket_prices: list[float] = []

            while trade_idx < len(trades):
                t_at = trades[trade_idx].transferred_at
                if t_at and t_at.tzinfo is None:
                    t_at = t_at.replace(tzinfo=timezone.utc)
                if t_at and t_at < bucket_end:
                    bucket_prices.append(trades[trade_idx].price)
                    trade_idx += 1
                else:
                    break

            if bucket_prices:
                candles.append(
                    PriceCandle(
                        timestamp=bucket_start,
                        open=bucket_prices[0],
                        high=max(bucket_prices),
                        low=min(bucket_prices),
                        close=bucket_prices[-1],
                        volume=len(bucket_prices),
                    )
                )
                last_close = bucket_prices[-1]
            else:
                # Empty candle — carry forward last close
                candles.append(
                    PriceCandle(
                        timestamp=bucket_start,
                        open=last_close,
                        high=last_close,
                        low=last_close,
                        close=last_close,
                        volume=0,
                    )
                )

            bucket_start = bucket_end

        return candles

    async def get_trading_data(
        self, event_id: uuid.UUID, tier_id: uuid.UUID
    ) -> TradingDataResponse:
        """Combined trading data for the stock-style trading UI."""
        ask_levels, bid_levels = await self.get_order_book_depth(event_id, tier_id)
        recent_trades = await self.get_trade_history(event_id, tier_id, limit=50)
        summary = await self.get_market_summary(event_id, tier_id)
        candles = await self.get_price_candles(event_id, tier_id)

        return TradingDataResponse(
            summary=summary,
            ask_levels=ask_levels,
            bid_levels=bid_levels,
            recent_trades=recent_trades,
            candles=candles,
        )
