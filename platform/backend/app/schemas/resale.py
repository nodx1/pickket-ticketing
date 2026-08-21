"""Pydantic schemas for the resale marketplace."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class ResaleListingCreate(BaseModel):
    ticket_id: uuid.UUID
    asking_price: float = Field(..., gt=0, le=1_000_000)


class ResaleListingResponse(BaseModel):
    id: uuid.UUID
    ticket_id: uuid.UUID
    seller_id: uuid.UUID
    asking_price: float
    status: str
    seller_receives: float
    platform_fee: float
    artist_royalty: float
    created_at: datetime

    model_config = {"from_attributes": True}


class ResaleListingDetailResponse(BaseModel):
    """Enriched listing with event details for browse/sell page."""

    id: uuid.UUID
    ticket_id: uuid.UUID
    seller_id: uuid.UUID
    asking_price: float
    status: str
    seller_receives: float
    artist_royalty: float
    created_at: datetime
    # Event details (joined)
    event_id: uuid.UUID
    event_title: str
    event_date: datetime
    venue: str
    category: str
    image_url: str | None = None
    artist_name: str | None = None
    # Ticket details
    original_price: float
    section: str | None = None
    tier_name: str | None = None
    # Seller details
    seller_name: str

    model_config = {"from_attributes": True}


class ResaleListingBrowseResponse(BaseModel):
    """Paginated response for browsing resale listings."""

    listings: list[ResaleListingDetailResponse] = []
    total: int = 0


class ResaleBuyOrderCreate(BaseModel):
    event_id: uuid.UUID
    tier_id: uuid.UUID
    max_price: float = Field(..., gt=0, le=1_000_000)


class ResaleBuyOrderResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    tier_id: uuid.UUID
    buyer_id: uuid.UUID
    max_price: float
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}


class ResaleMarketResponse(BaseModel):
    asks: list[ResaleListingResponse] = []
    bids: list[ResaleBuyOrderResponse] = []
    recent_trades: list[dict] = []
    lowest_ask: float | None = None
    highest_bid: float | None = None


class OrderBookLevel(BaseModel):
    """A single price level in the order book."""

    price: float
    quantity: int
    total_volume: float


class TradeRecord(BaseModel):
    """A single executed trade."""

    ticket_id: str
    price: float
    seller_amount: float
    platform_fee: float
    artist_royalty: float
    transferred_at: datetime | None = None


class MarketSummary(BaseModel):
    """Aggregated market statistics for the header."""

    current_price: float | None = None
    price_change: float = 0.0
    price_change_pct: float = 0.0
    day_high: float | None = None
    day_low: float | None = None
    day_volume: int = 0
    total_listings: int = 0
    total_buy_orders: int = 0


class PriceCandle(BaseModel):
    """OHLCV candle for price charting."""

    timestamp: datetime
    open: float
    high: float
    low: float
    close: float
    volume: int


class TradingDataResponse(BaseModel):
    """Combined trading data for the trading UI."""

    summary: MarketSummary
    ask_levels: list[OrderBookLevel] = []
    bid_levels: list[OrderBookLevel] = []
    recent_trades: list[TradeRecord] = []
    candles: list[PriceCandle] = []
