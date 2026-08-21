/**
 * 트랙 7.9 — 좌석 funnel 추적 헬퍼
 *
 * 클라이언트가 호출하기 쉽게 단순한 fetch wrapper.
 * 서버 측은 별도 lightweight INSERT API.
 */

export type FunnelStep =
  | "view"
  | "hover"
  | "select"
  | "hold"
  | "checkout"
  | "complete"
  | "abandon";

export interface FunnelEvent {
  eventId: string;
  seatMapId?: string | null;
  step: FunnelStep;
  seatCount?: number;
  metadata?: Record<string, unknown>;
}

/**
 * 클라이언트 → 서버로 funnel 이벤트 발송 (fire-and-forget).
 * navigator.sendBeacon 우선 사용하여 페이지 unload 시에도 전송 보장.
 */
export function trackFunnel(eventId: string, event: Omit<FunnelEvent, "eventId">): void {
  if (typeof window === "undefined") return;
  const payload = JSON.stringify({ eventId, ...event });
  try {
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: "application/json" });
      navigator.sendBeacon(`/api/public/seat-funnel`, blob);
      return;
    }
    void fetch(`/api/public/seat-funnel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload,
      keepalive: true,
    }).catch(() => {
      /* fire and forget */
    });
  } catch {
    /* analytics 실패는 무시 */
  }
}
