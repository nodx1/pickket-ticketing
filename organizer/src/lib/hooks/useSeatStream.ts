"use client";

/**
 * useSeatStream — 실시간 좌석 상태 스트림 (Phase 4 연결)
 *
 * Phase 4 SSE 엔드포인트: `/api/public/events/[slug]/seats/stream?mapId=...`
 *
 * 두 가지 호출 시그니처 지원:
 *   1) 단일 좌석 업데이트 콜백 (legacy, SeatMap 컴포넌트 호환):
 *      useSeatStream(eventId, (update: SeatUpdate) => void)
 *      - BroadcastChannel 로 로컬 브로드캐스트만 수신 (mapId 없이 사용)
 *
 *   2) 서버 SSE 구독 (신규):
 *      useSeatStream(eventId, mapId, (msg: StreamMessage) => void)
 *      - EventSource 로 서버 SSE 구독, 메시지 원문 전달
 */

import { useEffect, useRef } from "react";
import type { SeatUpdateMessage } from "@/lib/seats/event-bus";

export interface SeatUpdate {
  seatId: string;
  status: "available" | "held" | "reserved" | "sold" | "blocked";
  heldUntil?: string | null;
  userId?: string | null;
}

export type SeatStreamHandler = (update: SeatUpdate) => void;

export type StreamMessage =
  | { type: "connected"; mapId: string }
  | SeatUpdateMessage;

export type StreamMessageHandler = (msg: StreamMessage) => void;

// Overloads
export function useSeatStream(eventId: string, onUpdate: SeatStreamHandler): void;
export function useSeatStream(
  eventId: string,
  mapId: string | null,
  onUpdate: StreamMessageHandler,
): void;
export function useSeatStream(
  eventId: string,
  second: SeatStreamHandler | string | null,
  third?: StreamMessageHandler,
): void {
  const broadcastHandlerRef = useRef<SeatStreamHandler | null>(null);
  const sseHandlerRef = useRef<StreamMessageHandler | null>(null);

  // 두 번째 인자 타입에 따라 분기
  const isLegacy = typeof second === "function";
  const mapId = isLegacy ? null : (second as string | null);

  // ref 업데이트는 effect 안에서 (React 19 refs-during-render 위반 방지)
  useEffect(() => {
    if (isLegacy) {
      broadcastHandlerRef.current = second as SeatStreamHandler;
      sseHandlerRef.current = null;
    } else {
      broadcastHandlerRef.current = null;
      sseHandlerRef.current = third ?? null;
    }
  }, [isLegacy, second, third]);

  // 1) Legacy BroadcastChannel 수신 (mapId 없는 호출)
  useEffect(() => {
    if (!isLegacy) return;
    if (!eventId) return;
    if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
      return;
    }
    const channel = new BroadcastChannel(`seat-stream:${eventId}`);
    const listener = (evt: MessageEvent) => {
      const data = evt.data as SeatUpdate | undefined;
      if (data && typeof data.seatId === "string") {
        broadcastHandlerRef.current?.(data);
      }
    };
    channel.addEventListener("message", listener);
    return () => {
      channel.removeEventListener("message", listener);
      channel.close();
    };
  }, [eventId, isLegacy]);

  // 2) SSE 구독 (mapId 있는 호출)
  useEffect(() => {
    if (isLegacy) return;
    if (!eventId || !mapId) return;
    if (typeof window === "undefined" || typeof EventSource === "undefined") {
      return;
    }
    const url = `/api/public/events/${eventId}/seats/stream?mapId=${encodeURIComponent(mapId)}`;
    const es = new EventSource(url, { withCredentials: true });

    es.onmessage = (e: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(e.data) as StreamMessage;
        sseHandlerRef.current?.(parsed);
      } catch {
        // 파싱 실패 — 무시
      }
    };

    es.onerror = () => {
      // 브라우저 EventSource 가 자동 재접속 처리
    };

    return () => {
      es.close();
    };
  }, [eventId, mapId, isLegacy]);
}
