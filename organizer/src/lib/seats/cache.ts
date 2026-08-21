/**
 * 트랙 7.16 — 좌석맵 IndexedDB 캐시
 *
 * ⚠️ 현재 caller 없음 (lib 만 존재). 다음 caller 가 통합 시 활성화:
 *   1. (dashboard)/events/[eventId]/check-in 페이지 → 마운트 시 saveSeatMapToCache,
 *      offline 발생 시 recordOfflineCheckIn, 온라인 복구 시 syncPendingCheckIns
 *   2. public/sw.js Service Worker 추가 → PWA 모드 정식 활성화
 *
 * 현장 체크인이 네트워크 끊겨도 동작하도록 좌석맵 + 체크인 상태를 IndexedDB 에 캐싱.
 * Service Worker 와 함께 사용 시 완전 오프라인 가능 (PWA 모드).
 *
 * Store:
 *  - "seat-maps": { mapId, eventId, name, seats[], landmarks[], cachedAt }
 *  - "check-in-states": { seatId, attendeeStatus, checkedInAt, syncedAt }
 *
 * 동기화: 온라인 복구 시 pending check-in 을 서버로 push.
 */

const DB_NAME = "pickket-seats";
const DB_VERSION = 1;

interface CachedSeatMap {
  mapId: string;
  eventId: string;
  name: string;
  seats: unknown[];
  landmarks: unknown[];
  cachedAt: number;
}

interface CachedCheckIn {
  seatId: string;
  ticketNumber: string;
  attendeeStatus: string;
  checkedInAt: string | null;
  syncedAt: number | null;
  /** offline 발생한 체크인 (서버 sync 대기) */
  pending?: boolean;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB 지원 안 됨"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("seat-maps")) {
        db.createObjectStore("seat-maps", { keyPath: "mapId" });
      }
      if (!db.objectStoreNames.contains("check-in-states")) {
        const store = db.createObjectStore("check-in-states", { keyPath: "seatId" });
        store.createIndex("pending", "pending", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSeatMapToCache(
  payload: CachedSeatMap,
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("seat-maps", "readwrite");
    tx.objectStore("seat-maps").put(payload);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadSeatMapFromCache(
  mapId: string,
): Promise<CachedSeatMap | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("seat-maps", "readonly");
    const req = tx.objectStore("seat-maps").get(mapId);
    req.onsuccess = () =>
      resolve((req.result as CachedSeatMap | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function recordOfflineCheckIn(
  state: CachedCheckIn,
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("check-in-states", "readwrite");
    tx.objectStore("check-in-states").put({
      ...state,
      pending: true,
      syncedAt: null,
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function listPendingCheckIns(): Promise<CachedCheckIn[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("check-in-states", "readonly");
    const req = tx.objectStore("check-in-states").getAll();
    req.onsuccess = () => {
      const all = (req.result as CachedCheckIn[] | undefined) ?? [];
      resolve(all.filter((s) => s.pending === true));
    };
    req.onerror = () => reject(req.error);
  });
}

export async function markCheckInSynced(seatId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("check-in-states", "readwrite");
    const store = tx.objectStore("check-in-states");
    const req = store.get(seatId);
    req.onsuccess = () => {
      const existing = req.result as CachedCheckIn | undefined;
      if (existing) {
        store.put({ ...existing, pending: false, syncedAt: Date.now() });
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 온라인 복구 시 호출 — pending 체크인 일괄 sync.
 * 부르는 측에서 fetch 로 서버 PATCH.
 */
export async function syncPendingCheckIns(
  syncFn: (state: CachedCheckIn) => Promise<boolean>,
): Promise<{ synced: number; failed: number }> {
  const pending = await listPendingCheckIns();
  let synced = 0;
  let failed = 0;
  for (const state of pending) {
    try {
      const ok = await syncFn(state);
      if (ok) {
        await markCheckInSynced(state.seatId);
        synced += 1;
      } else {
        failed += 1;
      }
    } catch {
      failed += 1;
    }
  }
  return { synced, failed };
}
