"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { API_URL } from "@pickket/lib";

interface LiveStats {
  viewCount: number;
  bidCount: number;
}

/**
 * Hook that connects to SSE endpoint for real-time event stats.
 * Falls back to initial values if SSE is unavailable.
 *
 * Supports Last-Event-ID for seamless reconnection — the server
 * includes monotonic `id:` fields so clients can resume where they
 * left off.
 */
export function useLiveStats(
  eventId: string,
  initialStats: LiveStats,
): LiveStats {
  const [stats, setStats] = useState<LiveStats>(initialStats);
  const eventSourceRef = useRef<EventSource | null>(null);
  const retryCountRef = useRef(0);
  const lastEventIdRef = useRef<string | null>(null);
  const connectRef = useRef<(() => void) | null>(null);
  const MAX_RETRIES = 10;

  const connect = useCallback(() => {
    if (typeof window === "undefined") return;
    if (!eventId) return;
    if (retryCountRef.current >= MAX_RETRIES) return;

    try {
      const base = `${API_URL}/api/v1/events/${eventId}/live-stats`;
      // Pass last event ID as query param for manual reconnections
      // (native EventSource auto-sends the header only for its own retries)
      const url = lastEventIdRef.current
        ? `${base}?lastEventId=${encodeURIComponent(lastEventIdRef.current)}`
        : base;
      const es = new EventSource(url);
      eventSourceRef.current = es;

      // Listen for typed events from enhanced SSE
      const handleEvent = (event: MessageEvent) => {
        try {
          // Track event ID for reconnection
          if (event.lastEventId) {
            lastEventIdRef.current = event.lastEventId;
          }
          const data = JSON.parse(event.data);
          if (data.error || data.__truncated) {
            if (data.error) es.close();
            return;
          }
          setStats({
            viewCount: data.view_count ?? initialStats.viewCount,
            bidCount: data.bid_count ?? initialStats.bidCount,
          });
          retryCountRef.current = 0; // Reset on success
        } catch {
          // Ignore parse errors (keepalive comments)
        }
      };

      // Listen for named event type from server
      es.addEventListener("stats_update", handleEvent);
      // Also listen to generic message for backward compatibility
      es.onmessage = handleEvent;

      es.onerror = () => {
        es.close();
        eventSourceRef.current = null;
        retryCountRef.current += 1;
        // Retry with exponential backoff
        if (retryCountRef.current < MAX_RETRIES) {
          const delay = Math.min(1000 * 2 ** retryCountRef.current, 30000);
          setTimeout(() => connectRef.current?.(), delay);
        }
      };
    } catch {
      // SSE not supported — stay with initial stats
    }
  }, [eventId, initialStats]);

  useEffect(() => {
    connectRef.current = connect;
  });

  useEffect(() => {
    connect();
    return () => {
      eventSourceRef.current?.close();
      eventSourceRef.current = null;
    };
  }, [connect]);

  return stats;
}
