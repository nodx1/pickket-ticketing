/**
 * 트랙 2.16 — 빌더 협업 presence (in-memory)
 *
 * SSE 로 같은 좌석맵을 편집 중인 다른 사용자의 커서/선택 정보를 broadcast.
 * 단순 in-memory broadcast (multi-process 환경에서는 Redis pub/sub 으로 확장 가능).
 *
 * 메시지 타입:
 *  - "join":    { userId, displayName, color }
 *  - "leave":   { userId }
 *  - "cursor":  { userId, x, y }
 *  - "select":  { userId, seatIds }
 */

export interface PresencePayload {
  type: "join" | "leave" | "cursor" | "select";
  userId: string;
  displayName?: string;
  color?: string;
  x?: number;
  y?: number;
  seatIds?: string[];
  ts: number;
}

type Listener = (msg: PresencePayload) => void;

const channels = new Map<string, Set<Listener>>();

export function subscribePresence(
  mapId: string,
  listener: Listener,
): () => void {
  let set = channels.get(mapId);
  if (!set) {
    set = new Set();
    channels.set(mapId, set);
  }
  set.add(listener);
  return () => {
    const s = channels.get(mapId);
    if (!s) return;
    s.delete(listener);
    if (s.size === 0) channels.delete(mapId);
  };
}

export function publishPresence(
  mapId: string,
  msg: Omit<PresencePayload, "ts">,
): void {
  const set = channels.get(mapId);
  if (!set || set.size === 0) return;
  const enriched: PresencePayload = { ...msg, ts: Date.now() };
  for (const listener of set) {
    try {
      listener(enriched);
    } catch {
      // 개별 listener 실패 무시
    }
  }
}

export function activeUserCount(mapId: string): number {
  return channels.get(mapId)?.size ?? 0;
}
