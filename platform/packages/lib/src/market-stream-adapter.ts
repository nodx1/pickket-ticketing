/**
 * Market Stream Adapter — platform-agnostic interface for real-time
 * order book / market data streaming.
 *
 * The web implementation will use browser EventSource (SSE).
 * Mobile (Expo/RN) can provide a WebSocket or polling-based adapter.
 *
 * Usage:
 *   1. Call `registerMarketStreamAdapter(factory)` once at app bootstrap.
 *   2. Call `createMarketStream(baseURL)` wherever a stream is needed.
 */

export interface MarketStreamData {
  ask_levels: Array<{ price: number; quantity: number }>;
  bid_levels: Array<{ price: number; quantity: number }>;
  last_price: number | null;
  last_quantity: number | null;
  high_24h: number | null;
  low_24h: number | null;
  volume_24h: number;
  price_change_pct: number;
  total_listings: number;
  total_buy_orders: number;
}

export type StreamStatus =
  | "connected"
  | "connecting"
  | "disconnected"
  | "error";

export interface MarketStreamAdapter {
  connect(eventId: string, tierId: string): void;
  disconnect(): void;
  reconnect(): void;
  onData(callback: (data: MarketStreamData) => void): void;
  onStatusChange(callback: (status: StreamStatus) => void): void;
}

type AdapterFactory = (baseURL: string) => MarketStreamAdapter;

let _factory: AdapterFactory | null = null;

export function registerMarketStreamAdapter(factory: AdapterFactory): void {
  _factory = factory;
}

export function createMarketStream(baseURL: string): MarketStreamAdapter {
  if (!_factory) {
    throw new Error(
      "MarketStreamAdapter not registered. Call registerMarketStreamAdapter() first.",
    );
  }
  return _factory(baseURL);
}
