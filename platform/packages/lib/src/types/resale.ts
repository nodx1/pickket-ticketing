/**
 * Resale/trading type definitions for mobile app integration.
 * Pure TypeScript -- no runtime imports allowed.
 */

export interface OrderBookLevel {
  price: number;
  quantity: number;
  total_volume: number;
}

export interface TradeRecord {
  ticket_id: string;
  price: number;
  seller_amount: number;
  platform_fee: number;
  artist_royalty: number;
  transferred_at: string | null;
}

export interface MarketSummary {
  current_price: number | null;
  price_change: number;
  price_change_pct: number;
  day_high: number | null;
  day_low: number | null;
  day_volume: number;
  total_listings: number;
  total_buy_orders: number;
}

export interface PriceCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TradingData {
  summary: MarketSummary;
  ask_levels: OrderBookLevel[];
  bid_levels: OrderBookLevel[];
  recent_trades: TradeRecord[];
  candles: PriceCandle[];
}

export interface MyResaleListing {
  id: string;
  ticket_id: string;
  event_id?: string;
  event_title?: string;
  tier_id?: string;
  tier_name?: string;
  seller_id: string;
  asking_price: number;
  status: "active" | "sold" | "cancelled" | "expired" | string;
  seller_receives: number;
  platform_fee: number;
  artist_royalty: number;
  created_at: string;
}

export interface MyResaleBuyOrder {
  id: string;
  event_id: string;
  tier_id: string;
  event_title?: string;
  tier_name?: string;
  buyer_id: string;
  max_price: number;
  status: "active" | "matched" | "cancelled" | "expired" | string;
  created_at: string;
}

export interface ResaleListingDetail {
  id: string;
  ticket_id: string;
  seller_id: string;
  asking_price: number;
  status: string;
  seller_receives: number;
  artist_royalty: number;
  created_at: string;
  event_id: string;
  event_title: string;
  event_date: string;
  venue: string;
  category: string;
  image_url: string | null;
  artist_name: string | null;
  original_price: number;
  section: string | null;
  tier_name: string | null;
  seller_name: string;
}

export interface ResaleListingBrowseResponse {
  listings: ResaleListingDetail[];
  total: number;
}

export interface ResaleTierInfo {
  tier_id: string;
  tier_name: string;
  base_price: number;
  listing_count: number;
  lowest_ask: number | null;
  buy_order_count: number;
}
