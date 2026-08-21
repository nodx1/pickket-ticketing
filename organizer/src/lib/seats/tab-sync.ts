"use client";

/**
 * P0-U3 — 다중 탭 BroadcastChannel 동기화.
 *
 * 같은 브라우저의 다른 탭에서 좌석을 홀드하면 이 탭에서도 즉시 반영하도록
 * BroadcastChannel 로 이벤트를 전파한다. 지원 안 되는 브라우저에서는 no-op.
 */

const CHANNEL_NAME = "pickket-seat-sync";

export interface TabMessage {
  type: "hold-created" | "hold-released" | "hold-expired";
  holdId: string;
  seatIds: string[];
  ts: string;
}

export function broadcastHold(message: Omit<TabMessage, "ts">): void {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) return;
  try {
    const ch = new BroadcastChannel(CHANNEL_NAME);
    ch.postMessage({ ...message, ts: new Date().toISOString() });
    ch.close();
  } catch {}
}

export function subscribeToHoldChanges(
  handler: (msg: TabMessage) => void,
): () => void {
  if (typeof window === "undefined" || !("BroadcastChannel" in window)) {
    return () => {};
  }
  const ch = new BroadcastChannel(CHANNEL_NAME);
  ch.onmessage = (e) => {
    try {
      handler(e.data as TabMessage);
    } catch {}
  };
  return () => ch.close();
}
