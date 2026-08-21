/**
 * Offline Ticket Storage (P2-5)
 *
 * IndexedDB 기반 오프라인 티켓 캐시.
 * 네트워크 없이도 QR 코드와 이벤트 정보를 표시할 수 있도록 한다.
 *
 * Usage:
 *   import { cacheTicketForOffline, getOfflineTickets, removeOfflineTicket } from "@pickket/lib/offline-tickets";
 */

// ── Types ───────────────────────────────────────────────────────────────────

export interface OfflineTicket {
  ticketId: string;
  qrData: string;
  eventInfo: {
    eventId: string;
    title: string;
    date: string | null;
    venue: string | null;
    category?: string;
    tierName?: string;
    purchasePrice: number;
    saleMode: string;
  };
  cachedAt: number; // Date.now()
}

// ── Constants ───────────────────────────────────────────────────────────────

const DB_NAME = "pickket-offline-tickets";
const DB_VERSION = 1;
const STORE_NAME = "tickets";

// ── IndexedDB Helpers ───────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available"));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "ticketId" });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * 티켓을 오프라인 캐시에 저장한다.
 * 동일한 ticketId가 이미 있으면 덮어쓴다.
 */
export async function cacheTicketForOffline(
  ticketId: string,
  qrData: string,
  eventInfo: OfflineTicket["eventInfo"],
): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);

    const record: OfflineTicket = {
      ticketId,
      qrData,
      eventInfo,
      cachedAt: Date.now(),
    };

    const request = store.put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

/**
 * 캐시된 모든 오프라인 티켓을 반환한다.
 * 가장 최근 캐시된 순서로 정렬된다.
 */
export async function getOfflineTickets(): Promise<OfflineTicket[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      const tickets = (request.result as OfflineTicket[]).sort(
        (a, b) => b.cachedAt - a.cachedAt,
      );
      resolve(tickets);
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

/**
 * 특정 티켓을 오프라인 캐시에서 제거한다.
 * 이벤트가 끝났거나 티켓이 사용된 경우 호출.
 */
export async function removeOfflineTicket(ticketId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.delete(ticketId);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

/**
 * 특정 티켓이 오프라인 캐시에 있는지 확인한다.
 */
export async function hasOfflineTicket(ticketId: string): Promise<boolean> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(ticketId);

    request.onsuccess = () => resolve(!!request.result);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

/**
 * 모든 오프라인 캐시를 제거한다.
 */
export async function clearOfflineTickets(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.clear();

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}
