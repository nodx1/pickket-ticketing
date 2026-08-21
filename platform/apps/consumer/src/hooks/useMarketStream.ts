"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { API_URL } from "@pickket/lib";

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

const THROTTLE_MS = 500;
const MAX_RETRY_DELAY = 30000;
const MAX_RETRIES = 10;

export function useMarketStream(eventId: string, tierId: string) {
  const [data, setData] = useState<TradingData | null>(null);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const retryCountRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestDataRef = useRef<TradingData | null>(null);
  const throttleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectRef = useRef<() => void>(undefined);
  const lastEventIdRef = useRef<string | null>(null);

  const disconnect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (throttleTimerRef.current) {
      clearTimeout(throttleTimerRef.current);
      throttleTimerRef.current = null;
    }
    setConnected(false);
  }, []);

  const connect = useCallback(() => {
    if (esRef.current) {
      esRef.current.close();
      esRef.current = null;
    }
    if (retryTimerRef.current) {
      clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }

    const base = `${API_URL}/api/v1/resale/stream/${eventId}/${tierId}`;
    // Include last event ID for reconnection resume
    const url = lastEventIdRef.current
      ? `${base}?lastEventId=${encodeURIComponent(lastEventIdRef.current)}`
      : base;
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => {
      setConnected(true);
      retryCountRef.current = 0;
    };

    const handleData = (event: MessageEvent) => {
      // Track event ID for reconnection
      if (event.lastEventId) {
        lastEventIdRef.current = event.lastEventId;
      }
      try {
        const parsed = JSON.parse(event.data);
        if (parsed && parsed.summary) {
          latestDataRef.current = parsed;
          if (!throttleTimerRef.current) {
            throttleTimerRef.current = setTimeout(() => {
              if (latestDataRef.current) {
                setData(latestDataRef.current);
              }
              throttleTimerRef.current = null;
            }, THROTTLE_MS);
          }
        }
      } catch {
        // ignore parse errors
      }
    };

    // Listen for typed event from enhanced SSE
    es.addEventListener("market_update", handleData);
    // Also listen on generic message for backward compatibility
    es.onmessage = handleData;

    es.onerror = () => {
      setConnected(false);
      es.close();
      esRef.current = null;
      if (retryCountRef.current >= MAX_RETRIES) return;
      const delay = Math.min(
        1000 * Math.pow(2, retryCountRef.current),
        MAX_RETRY_DELAY,
      );
      retryCountRef.current++;
      retryTimerRef.current = setTimeout(() => {
        if (document.visibilityState === "visible") {
          connectRef.current?.();
        }
      }, delay);
    };
  }, [eventId, tierId]);

  useEffect(() => {
    connectRef.current = connect;
  }, [connect]);

  useEffect(() => {
    connect();
    return () => disconnect();
  }, [connect, disconnect, eventId]);

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === "hidden") {
        disconnect();
      } else {
        connect();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [connect, disconnect, eventId]);

  // B3: 수동 재연결 — 현재 연결을 닫고 새로 연결
  const reconnect = useCallback(() => {
    disconnect();
    retryCountRef.current = 0;
    connect();
  }, [connect, disconnect]);

  return { data, connected, disconnect, reconnect };
}
