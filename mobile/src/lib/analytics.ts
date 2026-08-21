/**
 * 트래킹/분석 유틸리티
 * 핵심 퍼널 이벤트 + 화면 조회 트래킹
 */
import { trackEvents, type TrackingEvent } from "@/config/api";
import { storage } from "@/lib/storage";

let consentGranted = false;

const eventBuffer: TrackingEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL = 5_000;
const MAX_BUFFER = 50;

function scheduleFlush() {
  if (flushTimer) return;
  flushTimer = setTimeout(flush, FLUSH_INTERVAL);
}

async function flush() {
  flushTimer = null;
  if (eventBuffer.length === 0) return;

  const batch = eventBuffer.splice(0, MAX_BUFFER);
  try {
    await trackEvents(batch);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
    // 실패 시 버퍼에 다시 넣지 않음 — 트래킹은 best-effort
  }

  if (eventBuffer.length > 0) scheduleFlush();
}

function push(event: TrackingEvent) {
  if (!consentGranted) return;
  eventBuffer.push({ ...event, timestamp: new Date().toISOString() });
  if (eventBuffer.length >= MAX_BUFFER) {
    flush();
  } else {
    scheduleFlush();
  }
}

/** 화면 조회 트래킹 */
export function trackScreenView(screenName: string) {
  push({ event_type: "page_view", metadata: { screen: screenName } });
}

/** 이벤트 상세 조회 */
export function trackEventView(eventId: string) {
  push({ event_type: "event_view", target_type: "event", target_id: eventId });
}

/** 검색 트래킹 */
export function trackSearch(query: string, resultCount: number) {
  push({ event_type: "search", metadata: { query, result_count: resultCount } });
}

/** 즐겨찾기 트래킹 */
export function trackFavorite(eventId: string) {
  push({ event_type: "favorite", target_type: "event", target_id: eventId });
}

/** 공유 트래킹 */
export function trackShare(eventId: string, method: string) {
  push({ event_type: "share", target_type: "event", target_id: eventId, metadata: { method } });
}

/** 구매 트래킹 (레거시) */
export function trackPurchase(eventId: string, tierId: string, amount: number) {
  push({
    event_type: "purchase",
    target_type: "event",
    target_id: eventId,
    metadata: { tier_id: tierId, amount },
  });
}

/** 구매 퍼널 — 예매/결제 화면 진입 시 */
export function trackPurchaseStart(
  eventId: string,
  tierId: string | null,
  amount: number,
) {
  push({
    event_type: "purchase_start",
    target_type: "event",
    target_id: eventId,
    metadata: { tier_id: tierId ?? "", amount },
  });
}

/** 구매 퍼널 — 결제 confirm 성공 직후 */
export function trackPurchaseComplete(
  eventId: string,
  tierId: string | null,
  amount: number,
  orderId: string,
) {
  push({
    event_type: "purchase_complete",
    target_type: "event",
    target_id: eventId,
    metadata: { tier_id: tierId ?? "", amount, order_id: orderId },
  });
}

/** Discover 피드 카드 노출 트래킹 */
export function trackDiscoverCardView(eventId: string) {
  push({
    event_type: "discover_card_view",
    target_type: "event",
    target_id: eventId,
  });
}

/** 클릭 트래킹 */
export function trackClick(targetType: "event" | "tier" | "artist" | "category", targetId: string) {
  push({ event_type: "click", target_type: targetType, target_id: targetId });
}

/** 앱 종료/백그라운드 시 버퍼 즉시 전송 */
export function flushAnalytics() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  flush();
}

/** 앱 초기화 시 호출 — AsyncStorage에서 동의 상태 로드 */
export async function initAnalyticsConsent(): Promise<void> {
  const value = await storage.get("analytics_consent");
  consentGranted = value === "true";
}

/** 동의 화면에서 호출 — 동의 상태 변경 */
export async function setAnalyticsConsent(granted: boolean): Promise<void> {
  consentGranted = granted;
  await storage.set("analytics_consent", granted ? "true" : "false");
}
