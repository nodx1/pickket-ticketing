/**
 * §13 오프라인/열화 체크인 모드 — 게스트 명단 프리캐시 + 오프라인 체크인 큐 (IndexedDB).
 *
 * 야외 골프장 등 LTE 불안정 현장에서 게이트가 마비되지 않도록:
 *  1) 온라인일 때 이벤트 참석자 명단(ticketNumber→name·admissionMode·status)을 로컬 캐시.
 *  2) 오프라인일 때 스캔/명단검색으로 게스트를 확인 → 로컬 큐(pending)에 체크인 기록.
 *  3) 온라인 복귀 시 큐를 서버로 배치 전송 → 서버가 v2 admit() 로 검증·기록(멱등).
 *
 * ⚠️ 보안 트레이드오프(수용): 오프라인 시엔 회전 QR 을 서버검증할 수 없다(캡처방지 무력).
 *    스태프가 명단의 이름으로 육안 대조 후 기록하며, 모든 오프라인 기록은 mode="offline" 로
 *    표시된다. 온라인 동기화 시 서버가 취소/중복/무효를 잡아내어 충돌 목록으로 표면화한다.
 *
 * 스코프: eventId 단위 store 키잉. 서버 sync 는 세션 accountId 로 소유 재검증(로컬은 신뢰 안 함).
 * store 는 브랜치 격리를 위해 seats/cache.ts(pickket-seats)와 별도 DB(pickket-checkin) 사용.
 */

const DB_NAME = "pickket-checkin";
const DB_VERSION = 1;

const ROSTER_STORE = "roster"; // keyPath: rowKey = `${eventId}:${ticketNumber}`
const QUEUE_STORE = "queue"; // keyPath: localId (오프라인 체크인 큐)

/** 캐시된 게스트 명단 1행. 오프라인 육안 대조용. */
export interface CachedGuest {
  /** IndexedDB 복합키 `${eventId}:${ticketNumber}` */
  rowKey: string;
  eventId: string;
  ticketNumber: string;
  name: string;
  productName: string | null;
  /** F1 입장방식(single|daypass|allpass) — 표시용. */
  admissionMode: string | null;
  /** 캐시 시점 서버 상태(confirmed|checked_in|pending|cancelled) — 육안 판단 보조. */
  status: string;
  cachedAt: number;
}

/** 오프라인 큐 1건 — 온라인 복귀 시 서버로 배치 전송. */
export interface OfflineCheckIn {
  /** 로컬 고유 ID(멱등 dedup·재전송 안전). */
  localId: string;
  eventId: string;
  checkInListId: string;
  ticketNumber: string;
  /** 명단에서 확인된 이름(스냅샷 — 육안 대조 근거·감사). */
  guestName: string;
  /** 스태프가 입력/확인한 시각(ISO). 서버 기록 시각과 별개(현장 실입장 시각). */
  checkedInAt: string;
  /** 기록한 스태프 식별(표시·감사). */
  staffLabel: string;
  /** 항상 "offline" — 회전 QR 미검증 명시. */
  mode: "offline";
  /** 동기화 상태. */
  syncState: "pending" | "synced" | "conflict";
  /** 충돌/실패 사유(표면화). */
  syncMessage: string | null;
  createdAt: number;
}

function isSupported(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isSupported()) {
      reject(new Error("이 브라우저는 오프라인 캐시(IndexedDB)를 지원하지 않습니다"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(ROSTER_STORE)) {
        const store = db.createObjectStore(ROSTER_STORE, { keyPath: "rowKey" });
        store.createIndex("eventId", "eventId", { unique: false });
        store.createIndex("ticketNumber", "ticketNumber", { unique: false });
      }
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        const store = db.createObjectStore(QUEUE_STORE, { keyPath: "localId" });
        store.createIndex("eventId", "eventId", { unique: false });
        store.createIndex("syncState", "syncState", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function rosterKey(eventId: string, ticketNumber: string): string {
  return `${eventId}:${ticketNumber}`;
}

// ── 게스트 명단 캐시 ──────────────────────────────────────────────────────────

/** 온라인일 때 이벤트 명단 전체를 캐시(기존 이벤트 행 교체). */
export async function saveRoster(
  eventId: string,
  guests: Array<{ ticketNumber: string; name: string; productName?: string | null; admissionMode?: string | null; status: string }>,
): Promise<void> {
  const db = await openDb();
  const cachedAt = Date.now();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROSTER_STORE, "readwrite");
    const store = tx.objectStore(ROSTER_STORE);
    // 해당 이벤트의 기존 캐시 제거 후 재기록(삭제된 참석자 잔존 방지).
    const idx = store.index("eventId");
    const range = IDBKeyRange.only(eventId);
    const cursorReq = idx.openCursor(range);
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
        return;
      }
      // 삭제 완료 후 신규 기록.
      for (const g of guests) {
        if (!g.ticketNumber) continue;
        const row: CachedGuest = {
          rowKey: rosterKey(eventId, g.ticketNumber),
          eventId,
          ticketNumber: g.ticketNumber,
          name: g.name,
          productName: g.productName ?? null,
          admissionMode: g.admissionMode ?? null,
          status: g.status,
          cachedAt,
        };
        store.put(row);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 캐시된 이벤트 명단 전체 로드(오프라인 검색용). */
export async function loadRoster(eventId: string): Promise<CachedGuest[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROSTER_STORE, "readonly");
    const idx = tx.objectStore(ROSTER_STORE).index("eventId");
    const req = idx.getAll(IDBKeyRange.only(eventId));
    req.onsuccess = () => resolve((req.result as CachedGuest[] | undefined) ?? []);
    req.onerror = () => reject(req.error);
  });
}

/** 티켓번호 단건 조회(스캔/입력 시 명단 매칭). */
export async function findGuest(eventId: string, ticketNumber: string): Promise<CachedGuest | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(ROSTER_STORE, "readonly");
    const req = tx.objectStore(ROSTER_STORE).get(rosterKey(eventId, ticketNumber));
    req.onsuccess = () => resolve((req.result as CachedGuest | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

/** 이름/티켓번호 부분검색(오프라인 명단검색). 최대 limit 건. */
export async function searchRoster(eventId: string, query: string, limit = 30): Promise<CachedGuest[]> {
  const all = await loadRoster(eventId);
  const q = query.trim().toLowerCase();
  if (!q) return all.slice(0, limit);
  return all
    .filter((g) => g.name.toLowerCase().includes(q) || g.ticketNumber.toLowerCase().includes(q))
    .slice(0, limit);
}

// ── 오프라인 체크인 큐 ────────────────────────────────────────────────────────

function makeLocalId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `off-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 오프라인 체크인 1건 큐잉(mode=offline·pending). */
export async function enqueueOfflineCheckIn(input: {
  eventId: string;
  checkInListId: string;
  ticketNumber: string;
  guestName: string;
  staffLabel: string;
  checkedInAt?: string;
}): Promise<OfflineCheckIn> {
  const db = await openDb();
  const record: OfflineCheckIn = {
    localId: makeLocalId(),
    eventId: input.eventId,
    checkInListId: input.checkInListId,
    ticketNumber: input.ticketNumber,
    guestName: input.guestName,
    checkedInAt: input.checkedInAt ?? new Date().toISOString(),
    staffLabel: input.staffLabel,
    mode: "offline",
    syncState: "pending",
    syncMessage: null,
    createdAt: Date.now(),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    tx.objectStore(QUEUE_STORE).put(record);
    tx.oncomplete = () => resolve(record);
    tx.onerror = () => reject(tx.error);
  });
}

/** 이벤트의 큐 전체(모든 syncState). 최신순. */
export async function listQueue(eventId: string): Promise<OfflineCheckIn[]> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readonly");
    const idx = tx.objectStore(QUEUE_STORE).index("eventId");
    const req = idx.getAll(IDBKeyRange.only(eventId));
    req.onsuccess = () => {
      const all = (req.result as OfflineCheckIn[] | undefined) ?? [];
      all.sort((a, b) => b.createdAt - a.createdAt);
      resolve(all);
    };
    req.onerror = () => reject(req.error);
  });
}

/** pending 항목만(동기화 대상). */
export async function listPending(eventId: string): Promise<OfflineCheckIn[]> {
  const all = await listQueue(eventId);
  return all.filter((r) => r.syncState === "pending");
}

/** 큐 항목 상태 갱신(동기화 결과 반영). */
export async function updateQueueItem(
  localId: string,
  patch: Partial<Pick<OfflineCheckIn, "syncState" | "syncMessage">>,
): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    const store = tx.objectStore(QUEUE_STORE);
    const req = store.get(localId);
    req.onsuccess = () => {
      const existing = req.result as OfflineCheckIn | undefined;
      if (existing) {
        store.put({ ...existing, ...patch });
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 큐 항목 삭제(동기화 완료분 정리). */
export async function deleteQueueItem(localId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(QUEUE_STORE, "readwrite");
    tx.objectStore(QUEUE_STORE).delete(localId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 이벤트의 synced 항목 일괄 정리(동기화 후 큐 청소). */
export async function clearSynced(eventId: string): Promise<number> {
  const all = await listQueue(eventId);
  const synced = all.filter((r) => r.syncState === "synced");
  await Promise.all(synced.map((r) => deleteQueueItem(r.localId)));
  return synced.length;
}
