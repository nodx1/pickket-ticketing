/**
 * 오프라인 티켓 캐시
 * v2의 @pickket/lib/offline-tickets.ts 참조
 *
 * 티켓 상세 진입 시 → 최신 QR 데이터 SecureStore 캐시
 * 오프라인 감지 시 → 캐시된 QR 표시
 * 캐시 만료: 24시간
 */
import { storage } from "@/lib/storage";
import type { TicketQrResponse } from "@/config/api";

const CACHE_PREFIX = "offline_qr_";
const CACHE_INDEX_KEY = "offline_qr_index";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24시간

interface CachedQr {
  data: TicketQrResponse;
  cachedAt: number;
}

export async function cacheTicketQr(ticketId: string, qr: TicketQrResponse): Promise<void> {
  const key = CACHE_PREFIX + ticketId;
  const cached: CachedQr = { data: qr, cachedAt: Date.now() };
  await storage.setSecure(key, JSON.stringify(cached));
  // 인덱스에 ticketId 추가 (삭제 시 전체 순회용)
  await addToIndex(ticketId);
}

async function addToIndex(ticketId: string): Promise<void> {
  const raw = await storage.get(CACHE_INDEX_KEY);
  const ids: string[] = raw ? JSON.parse(raw) : [];
  if (!ids.includes(ticketId)) {
    ids.push(ticketId);
    await storage.set(CACHE_INDEX_KEY, JSON.stringify(ids));
  }
}

async function removeFromIndex(ticketId: string): Promise<void> {
  const raw = await storage.get(CACHE_INDEX_KEY);
  if (!raw) return;
  const ids: string[] = JSON.parse(raw);
  const filtered = ids.filter((id) => id !== ticketId);
  await storage.set(CACHE_INDEX_KEY, JSON.stringify(filtered));
}

export async function getCachedTicketQr(ticketId: string): Promise<TicketQrResponse | null> {
  const key = CACHE_PREFIX + ticketId;
  const raw = await storage.getSecure(key);
  if (!raw) return null;

  try {
    const cached: CachedQr = JSON.parse(raw);
    if (Date.now() - cached.cachedAt > CACHE_TTL_MS) {
      await storage.removeSecure(key);
      await removeFromIndex(ticketId);
      return null;
    }
    return cached.data;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
    await storage.removeSecure(key);
    await removeFromIndex(ticketId);
    return null;
  }
}

export async function clearOfflineQrCache(): Promise<void> {
  const raw = await storage.get(CACHE_INDEX_KEY);
  if (!raw) return;

  try {
    const ids: string[] = JSON.parse(raw);
    await Promise.all(ids.map((id) => storage.removeSecure(CACHE_PREFIX + id)));
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
    // 파싱 실패 시 무시
  }
  await storage.remove(CACHE_INDEX_KEY);
}
