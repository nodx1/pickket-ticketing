/**
 * 모바일 API 클라이언트
 *
 * v2 백엔드 (:8021)에 대한 HTTP 클라이언트.
 * 웹의 @pickket/lib/api.ts와 동일한 엔드포인트를 호출하되,
 * 쿠키 대신 Authorization: Bearer 헤더 사용.
 */
import axios, { type AxiosError, type InternalAxiosRequestConfig } from "axios";
import { Dimensions, Platform } from "react-native";
import { env } from "./env";
import { storage } from "@/lib/storage";
import { assertTrustedHost } from "@/lib/ssl-pinning";
import { getDeviceIdSync } from "@/lib/device-id";

// ── v2 공유 타입 (Single Source of Truth) ──
import type {
  SeatTierCompact as V2SeatTierCompact,
  SeatTier as V2SeatTier,
  Event as V2Event,
  PriceAdvice as V2PriceAdvice,
  MyEventStatus as V2MyEventStatus,
  PurchaseResult as V2PurchaseResult,
} from "@pickket/lib/types/event";
import type {
  OrderDetail as V2OrderDetail,
  PaymentPrepareResponse as V2PaymentPrepareResponse,
} from "@pickket/lib/types/order";
import type {
  TicketDetail as V2TicketDetail,
  TicketQrResponse as V2TicketQrResponse,
} from "@pickket/lib/types/ticket";
import type {
  PointBalance,
  PointTransaction,
  PointHistoryResponse,
} from "@pickket/lib/types/point";
import type {
  QueueJoinResponse,
  QueueStatusResponse,
  QueueLeaveResponse,
  QueueStatsResponse,
} from "@pickket/lib/types/queue";
import type {
  WaitlistEntryResponse,
  WaitlistStatusResponse,
} from "@pickket/lib/types/waitlist";
import type {
  ReviewData,
  ReviewSummaryData,
} from "@pickket/lib/types/review";

// 순환 의존 방지: 인터셉터에서 auth store 리셋 시 lazy import
let _resetAuthState: (() => void) | null = null;

/** API 인터셉터가 refresh 실패 시 auth 상태를 리셋할 수 있도록 연결 */
export function setAuthStateResetter(fn: () => void) {
  _resetAuthState = fn;
}

// ── 상수 ──
const MAX_RETRIES = 3;
const RETRY_STATUS = [429, 502, 503, 504];

// ── HTTPS 강제 (프로덕션) ──
function getSecureBaseUrl(): string {
  const base = `${env.API_URL}/api/v1`;
  if (!env.IS_DEV && !base.startsWith("https://")) {
    throw new Error("[Security] Production API must use HTTPS");
  }
  return base;
}

// ── Axios 인스턴스 ──
export const api = axios.create({
  baseURL: getSecureBaseUrl(),
  headers: { "Content-Type": "application/json" },
  timeout: 30000,
});

// ── 토큰 리프레시 큐 ──
let isRefreshing = false;
let refreshAttemptId = 0;
// AUDIT 2026-04-20 §3 P0: refresh 큐 promise hang 방지.
// 기존 구현은 success 경로만 콜백 호출 → 실패 시 대기자 Promise 영구 hang.
// resolve/reject 쌍 + 타임아웃으로 완전히 대칭화.
interface RefreshSubscriber {
  resolve: (token: string) => void;
  reject: (err: unknown) => void;
}
let refreshSubscribers: RefreshSubscriber[] = [];

function onRefreshed(token: string) {
  const subs = refreshSubscribers;
  refreshSubscribers = [];
  subs.forEach((s) => s.resolve(token));
}

function onRefreshFailed(err: unknown) {
  const subs = refreshSubscribers;
  refreshSubscribers = [];
  subs.forEach((s) => s.reject(err));
}

function addRefreshSubscriber(sub: RefreshSubscriber) {
  refreshSubscribers.push(sub);
}

const REFRESH_TIMEOUT_MS = 10_000;

// ── Request Interceptor ──
api.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  // SSL Pinning: 프로덕션에서 비허용 호스트 차단
  const fullUrl = config.baseURL && config.url
    ? new URL(config.url, config.baseURL).toString()
    : (config.url ?? config.baseURL);
  await assertTrustedHost(fullUrl);

  // Bearer 토큰 주입
  const token = await storage.getAccessToken();
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  // 모바일 클라이언트 식별
  config.headers["X-Client-Type"] = "mobile";

  // AUDIT §13 P0: 디바이스 ID 헤더 (티켓 바인딩 검증용)
  const deviceId = getDeviceIdSync();
  if (deviceId) {
    config.headers["X-Device-Id"] = deviceId;
  }

  // 디바이스 정보
  const { width, height } = Dimensions.get("screen");
  config.headers["X-Screen-Info"] = `${width}x${height}`;
  config.headers["X-Timezone"] = Intl.DateTimeFormat().resolvedOptions().timeZone;
  config.headers["User-Agent"] = `Pickket-Mobile/${env.APP_VERSION} (${Platform.OS})`;

  return config;
});

// ── Response Interceptor ──
api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const originalRequest = error.config;
    if (!originalRequest) return Promise.reject(error);

    const status = error.response?.status;

    // 401 → 토큰 리프레시 시도 (Authorization 헤더가 있는 요청만)
    // _retry 플래그로 1회만 재시도 (WORK_ORDER §5.3 — 재시도된 요청이 다시 401을 받아도 refresh 재호출 금지)
    const retryFlag = (originalRequest as unknown as { _retry?: boolean })._retry;
    if (
      status === 401 &&
      !originalRequest.url?.includes("/auth/") &&
      originalRequest.headers.Authorization &&
      !retryFlag
    ) {
      if (isRefreshing) {
        // 리프레시 진행 중 → 큐에 추가 (resolve + reject + timeout)
        return new Promise((resolve, reject) => {
          const timeoutId = setTimeout(() => {
            reject(new Error("Token refresh timeout"));
          }, REFRESH_TIMEOUT_MS);

          addRefreshSubscriber({
            resolve: (newToken: string) => {
              clearTimeout(timeoutId);
              (originalRequest as unknown as { _retry?: boolean })._retry = true;
              originalRequest.headers.Authorization = `Bearer ${newToken}`;
              resolve(api(originalRequest));
            },
            reject: (err: unknown) => {
              clearTimeout(timeoutId);
              reject(err);
            },
          });
        });
      }

      isRefreshing = true;
      const currentAttemptId = ++refreshAttemptId;

      try {
        const refreshToken = await storage.getRefreshToken();
        if (!refreshToken) throw new Error("No refresh token");
        const refreshUrl = `${env.API_URL}/api/v1/auth/refresh`;
        await assertTrustedHost(refreshUrl);

        const { data } = await axios.post(
          refreshUrl,
          { refresh_token: refreshToken },
          {
            headers: {
              "Content-Type": "application/json",
              "User-Agent": `Pickket-Mobile/${env.APP_VERSION} (${Platform.OS})`,
              // ⚠️ V7: 이 raw 호출은 api 인터셉터를 안 타 X-Client-Type 누락 + iOS는 커스텀 UA를
              //   네이티브에서 떨굼 → v2가 모바일 미인지 → refresh_token 본문 미발급 → 2차 refresh 로그아웃.
              //   iOS가 안 떨구는 X-Client-Type 으로 모바일 신호(v2 V3가 신뢰, Origin 없을 때만).
              "X-Client-Type": "mobile",
            },
          },
        );

        const newAccessToken = data.access_token;
        await storage.setAccessToken(newAccessToken);

        if (data.refresh_token) {
          await storage.setRefreshToken(data.refresh_token);
        }

        onRefreshed(newAccessToken);
        (originalRequest as unknown as { _retry?: boolean })._retry = true;
        originalRequest.headers.Authorization = `Bearer ${newAccessToken}`;
        return api(originalRequest);
      } catch (refreshError: unknown) {
        // 리프레시 실패 → 대기자 전원 reject + 로그아웃 (동시 리프레시 성공 시 토큰 보호)
        if (__DEV__) console.warn("[API] Token refresh failed");
        if (currentAttemptId === refreshAttemptId) {
          await storage.clearAuth();
          _resetAuthState?.();
        }
        onRefreshFailed(refreshError);
        return Promise.reject(error);
      } finally {
        isRefreshing = false;
      }
    }

    // 429/5xx/offline → 지수 백오프 재시도 (GET/HEAD/OPTIONS만 — 비멱등 메서드는 중복 실행 위험)
    const method = (originalRequest.method ?? "get").toLowerCase();
    const isIdempotent = ["get", "head", "options"].includes(method);
    const isRetryableStatus = status != null && RETRY_STATUS.includes(status);
    const isOffline = !error.response && (error.code === "ECONNABORTED" || error.code === "ERR_NETWORK" || error.message === "Network Error");
    if (isIdempotent && (isRetryableStatus || isOffline)) {
      const retryCount = ((originalRequest as unknown as Record<string, unknown>).__retryCount as number) ?? 0;
      if (retryCount < MAX_RETRIES) {
        (originalRequest as unknown as Record<string, unknown>).__retryCount = retryCount + 1;
        const retryAfter = error.response?.headers?.["retry-after"];
        const retryAfterMs = retryAfter ? (Number(retryAfter) > 0 ? Number(retryAfter) * 1000 : 0) : 0;
        const delay = retryAfterMs || Math.min(100 * Math.pow(4, retryCount) + Math.random() * 100, 5000);
        await new Promise((r) => setTimeout(r, delay));
        return api(originalRequest);
      }
    }

    return Promise.reject(error);
  },
);

// ── User 타입 (v2 backend UserResponse + UserProfile schema) ──
export interface User {
  id: string;
  email: string;
  name: string;
  phone?: string;
  is_organizer: boolean;
  is_admin?: boolean;
  admin_role?: string | null;
  is_verified: boolean;
  verification_level: number;
  loyalty_score: number;
  avatar_url?: string;
  bio?: string;
  preferred_language?: string;
  timezone?: string;
  created_at: string;
}

/** GET /users/me 응답 — fan_weight 포함 확장 프��필 */
export interface UserProfile extends User {
  history_score: number;
  is_fanclub_member: boolean;
  no_show_rate: number;
  cancel_rate: number;
  dispute_rate: number;
  fan_weight: number;
  fan_weight_breakdown: Record<string, unknown>;
}

/** PATCH /users/me 요청 */
export interface UserUpdate {
  name?: string;
  phone?: string;
  avatar_url?: string;
  bio?: string;
  preferred_language?: string;
  timezone?: string;
}

/** GET /users/me/stats 응답 */
export interface UserStats {
  total_bids: number;
  total_wins: number;
  total_losses: number;
  win_rate: number;
  avg_savings: number;
  total_savings: number;
}

// ── Auth API ──
export async function login(email: string, password: string) {
  const { data } = await api.post<{ access_token: string; refresh_token: string | null; user: User }>(
    "/auth/login",
    { email, password },
  );
  return data;
}

export async function register(params: { email: string; password: string; name: string }) {
  const { data } = await api.post<{ access_token: string; refresh_token: string | null; user: User }>(
    "/auth/register",
    params,
  );
  return data;
}

export async function logout() {
  try {
    await api.post("/auth/logout");
  } finally {
    await storage.clearAuth();
  }
}

export async function getCurrentUser() {
  const { data } = await api.get<UserProfile>("/users/me");
  return data;
}

export async function updateProfile(params: UserUpdate) {
  const { data } = await api.patch<UserProfile>("/users/me", params);
  return data;
}

export async function getUserStats() {
  const { data } = await api.get<UserStats>("/users/me/stats");
  return data;
}

export async function deleteAccount() {
  const { data } = await api.delete<{ message: string }>("/users/me");
  return data;
}

// ── OAuth API ──
export type OAuthProvider = "kakao" | "google" | "naver" | "apple";

export async function getOAuthRedirectUrl(provider: OAuthProvider, redirectUri: string) {
  const { data } = await api.get<{ authorization_url: string; state: string }>(
    `/auth/${provider}/redirect`,
    { params: { redirect_uri: redirectUri } },
  );
  return data;
}

/**
 * OAuth callback 응답.
 *
 * 백엔드는 관리자(is_mfa_required) 계정에 대해 토큰 대신
 * `{ mfa_required: true, mfa_token, access_token: "", user }`를 반환한다.
 * 모바일에는 MFA 검증 플로우가 없으므로 useOAuth에서 명시적 에러로 surface한다.
 */
export interface OAuthCallbackResponse {
  access_token: string;
  refresh_token: string | null;
  user: User;
  mfa_required?: boolean;
  mfa_token?: string;
}

export async function oauthCallback(provider: OAuthProvider, code: string, state?: string) {
  const { data } = await api.post<OAuthCallbackResponse>(
    `/auth/${provider}/callback`,
    { code, state },
  );
  return data;
}

// ── Events API (v2 field names: event_date, location_city, total_seats) ──
export interface Event extends Omit<V2Event,
  | "venue" | "total_seats" | "min_price" | "max_price"
  | "bidding_opens_at" | "bidding_closes_at"
  | "category" | "is_featured" | "bid_count" | "view_count"
> {
  // v2 필수 → 모바일 optional (API 응답 부분 로딩 허용)
  venue?: string;
  total_seats?: number;
  min_price?: number;
  max_price?: number | null;
  bidding_opens_at?: string | null;
  bidding_closes_at?: string | null;
  category?: string;
  is_featured?: boolean;
  bid_count?: number;
  view_count?: number;
  // 모바일 전용 UI 필드
  video_url?: string;
  hero_video_url?: string;
  recommendation_reason?: string;
  friends_interested?: Array<{ id: string; name: string; avatar_url?: string }>;
  sale_status?: string;
  waitlist_enabled?: boolean;
  is_favorited?: boolean;
  organizer_name?: string;
}

/** v2 SeatTier — 전체 필드 (티어 상세/예매 화면용) */
export type SeatTier = V2SeatTier;

/** v2 SeatTierCompact — 이벤트 상세 인라인 요약용 */
export type SeatTierCompact = V2SeatTierCompact;

export interface EventDetail extends Event {
  seat_tiers?: SeatTierCompact[];
  review_count?: number;
  average_rating?: number;
}

export async function getEventDetail(id: string) {
  const { data } = await api.get<EventDetail>(`/events/${id}`);
  return data;
}

export async function getEventTiers(eventId: string) {
  const { data } = await api.get<SeatTier[]>(`/events/${eventId}/tiers`);
  return data;
}

export interface EventSearchParams {
  q?: string;
  category?: string;
  city?: string;
  date_from?: string;
  date_to?: string;
  price_min?: number;
  price_max?: number;
  sort?: string;
  skip?: number;
  limit?: number;
}

export async function searchEvents(params: EventSearchParams) {
  const { data } = await api.get<{ events: Event[]; total: number }>("/events/search", { params });
  return data;
}

export async function getFeaturedEvents() {
  const { data } = await api.get<{ events: Event[]; total: number }>("/events/search", {
    params: { limit: 10, sort: "trending" },
  });
  return data.events;
}

export async function getTrendingEvents(limit = 10) {
  const { data } = await api.get<Event[]>("/events/ranking", { params: { limit } });
  return data;
}

export async function getSimilarEvents(eventId: string) {
  const { data } = await api.get<Event[]>(`/events/${eventId}/similar`);
  return data;
}

// ── Discover Feed (Phase A) ──
// 백엔드 /events/feed 미배포 시 /events/search?sort=trending 으로 폴백
export interface DiscoverFeedPage {
  events: Event[];
  next_cursor: string | null;
}

export async function getDiscoverFeed(cursor?: string, limit = 10, category?: string): Promise<DiscoverFeedPage> {
  try {
    const { data } = await api.get<DiscoverFeedPage>("/events/feed", {
      params: { cursor, limit, ...(category ? { category } : {}) },
    });
    return data;
  } catch (err: unknown) {
    // AUDIT §5 P0: /events/feed 미구현 시 fallback, 그 외는 관측 후 rethrow.
    // 404 + 422(라우트 부재로 /events/{event_id}가 'feed'를 UUID 파싱 시도 → 422) 둘 다 미구현 신호.
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status && status !== 404 && status !== 422) throw err;

    // AUDIT 2026-05-28 §5 P1: 에러 무시 방지 — 폴백 전 경고 로그
    console.warn(
      "[getDiscoverFeed] /events/feed 실패, /events/search 폴백",
      status ?? "no-status",
      err instanceof Error ? err.message : err,
    );

    const skip = cursor ? Number(cursor) : 0;
    const { data } = await api.get<{ events: Event[]; total: number }>("/events/search", {
      params: { limit, skip, sort: "trending", ...(category ? { category } : {}) },
    });
    const nextSkip = skip + data.events.length;
    return {
      events: data.events,
      next_cursor: nextSkip < data.total ? String(nextSkip) : null,
    };
  }
}

// ── Recommendations API (v2 aligned) ──
export interface RecommendedEvent {
  id: string;
  title: string;
  image_url: string | null;
  thumbnail_url: string | null;
  venue: string | null;
  event_date: string;
  category: string | null;
  status: string;
  min_price: number | null;
  bid_count: number;
  location_city: string | null;
  artist_name: string | null;
  score: number;
  reason: string;
}

export interface RecommendationResponse {
  recommendations: RecommendedEvent[];
  total: number;
}

export async function getRecommendations(limit = 10) {
  const { data } = await api.get<RecommendationResponse>("/recommendations", { params: { limit } });
  return data;
}

export async function getSimilarRecommendations(eventId: string, limit = 5) {
  const { data } = await api.get<RecommendationResponse>(`/recommendations/similar/${eventId}`, { params: { limit } });
  return data;
}

// ── Tickets API (v2 aligned) ──
export interface Ticket extends V2TicketDetail {
  // 모바일 전용 denormalized 필드
  event_title?: string | null;
  event_date?: string | null;
  event_category?: string | null;
  seat_label?: string | null;
  checked_in?: boolean;
}

export interface TicketListResponse {
  tickets: Ticket[];
  total: number;
}

export type TicketQrResponse = V2TicketQrResponse;

export async function getMyTickets(skip = 0, limit = 50) {
  const { data } = await api.get<TicketListResponse>("/tickets/my", { params: { skip, limit } });
  return data;
}

export async function getTicket(id: string) {
  const { data } = await api.get<Ticket>(`/tickets/${id}`);
  return data;
}

export async function bindTicketDevice(id: string) {
  const { data } = await api.post(`/tickets/${id}/bind-device`, {});
  return data;
}

export async function getTicketQr(id: string) {
  try {
    const { data } = await api.get<TicketQrResponse>(`/tickets/${id}/qr`);
    return data;
  } catch (err: unknown) {
    // 409: 다른 디바이스에 바인딩됨 — rebind 불가 (보안상 1회 바인딩)
    // 첫 요청 시 자동 바인딩되므로 정상 플로우에서는 발생하지 않음
    throw err;
  }
}

// ── Orders API (v2 aligned: backend OrderResponse schema) ──
export interface OrderDetail extends V2OrderDetail {
  // 모바일 전용: 타임슬롯 필드
  time_slot_start: string | null;
  time_slot_end: string | null;
}

/** v2 backend RefundResponse schema */
export interface RefundResponse {
  refund_id: string;
  order_id: string;
  status: string;
  refund_status: string;
  refund_amount: number;
  original_amount: number;
  reason: string;
  requires_approval: boolean;
  ticket_ids: string[];
  refunded_at: string;
}

export async function getMyOrders(params?: { status?: string; event_id?: string; skip?: number; limit?: number }) {
  const { data } = await api.get<OrderDetail[]>("/orders/my", { params });
  return data;
}

export async function getOrder(id: string) {
  const { data } = await api.get<OrderDetail>(`/orders/${id}`);
  return data;
}

export async function cancelOrder(id: string) {
  const { data } = await api.post<OrderDetail>(`/orders/${id}/cancel`);
  return data;
}

export async function refundOrder(
  id: string,
  params: { reason: string; amount?: number; ticket_ids?: string[]; idempotency_key?: string },
) {
  const { data } = await api.post<RefundResponse>(`/orders/${id}/refund`, params);
  return data;
}

// ── Purchase API (v2 aligned: per-tier endpoint) ──
export interface PurchaseRequest {
  quantity: number;
  group_id?: string;
  seat_ids?: string[];
  queue_token?: string;
  idempotency_key: string;
  time_slot_start?: string;
  time_slot_end?: string;
}

export interface PurchaseResult extends V2PurchaseResult {
  // 모바일 전용: SQS 비동기 처리 상태
  processing: boolean;
}

export async function purchaseTicket(
  eventId: string,
  tierId: string,
  params: PurchaseRequest,
) {
  const { data } = await api.post<PurchaseResult>(
    `/events/${eventId}/tiers/${tierId}/purchase`,
    params,
  );
  return data;
}

export async function purchaseFanclub(
  eventId: string,
  tierId: string,
  params: PurchaseRequest,
) {
  const { data } = await api.post<PurchaseResult>(
    `/events/${eventId}/tiers/${tierId}/purchase/fanclub`,
    params,
  );
  return data;
}

// ── Payment API (v2 aligned: prepare → redirect → confirm) ──
export type PaymentPrepareResponse = V2PaymentPrepareResponse;

export async function prepareOrderPayment(
  orderId: string,
  params?: { idempotency_key?: string; success_url?: string; fail_url?: string },
) {
  const { data } = await api.post<PaymentPrepareResponse>(
    `/orders/${orderId}/payment/prepare`,
    params ?? {},
  );
  return data;
}

export async function confirmOrderPayment(
  orderId: string,
  params: {
    pg_provider: string;
    pg_transaction_id: string;
    payment_id?: string;
    amount?: number;
  },
  idempotencyKey?: string,
) {
  const headers: Record<string, string> = {};
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  const { data } = await api.post<OrderDetail>(`/orders/${orderId}/pay`, params, { headers });
  return data;
}

// ── Favorites API ──
export interface FavoriteResponse {
  event_id: string;
  is_favorited: boolean;
}

export async function toggleFavorite(eventId: string) {
  const { data } = await api.post<FavoriteResponse>(`/events/${eventId}/favorite`);
  return data;
}

export async function checkFavorite(eventId: string) {
  const { data } = await api.get<FavoriteResponse>(`/events/${eventId}/favorite/check`);
  return data;
}

export async function getMyFavorites() {
  const { data } = await api.get<Event[]>("/users/me/favorites");
  return data;
}

// ── Discover API ──
export interface ParsedIntent {
  date_from?: string;
  date_to?: string;
  location?: string;
  category?: string;
  budget_max?: number;
  artist_name?: string;
  keywords?: string[];
  confidence?: number;
  source?: string;
}

export interface DiscoverResponse {
  parsed_intent: ParsedIntent;
  events: Event[];
  total: number;
  suggestion?: string;
}

export async function discover(
  query: string,
  options?: {
    budget_max?: number;
    limit?: number;
    skip?: number;
    user_context?: unknown;
  },
) {
  const { data } = await api.post<DiscoverResponse>("/discover", { query, ...options });
  return data;
}

// ── Queue API (v2 aligned: per-tier endpoints) ──
export type { QueueJoinResponse, QueueStatusResponse, QueueLeaveResponse, QueueStatsResponse };

export async function joinQueue(eventId: string) {
  const { data } = await api.post<QueueJoinResponse>(`/events/${eventId}/queue/join`);
  return data;
}

export async function getQueueStatus(eventId: string) {
  const { data } = await api.get<QueueStatusResponse>(`/events/${eventId}/queue/status`);
  return data;
}

export async function leaveQueue(eventId: string) {
  const { data } = await api.post<QueueLeaveResponse>(`/events/${eventId}/queue/leave`);
  return data;
}

export async function getQueueStats(eventId: string) {
  const { data } = await api.get<QueueStatsResponse>(`/events/${eventId}/queue/stats`);
  return data;
}

// ── Notifications API (v2 backend NotificationResponse schema) ──
export interface NotificationItem {
  id: string;
  type: string;
  message: string;
  data: Record<string, unknown> | null;
  is_read: boolean;
  created_at: string;
}

export interface NotificationListResponse {
  notifications: NotificationItem[];
  unread_count: number;
}

export interface NotificationPreferences {
  allocation_result: boolean;
  payment_reminder: boolean;
  event_update: boolean;
  price_alert: boolean;
  marketing: boolean;
  email_enabled: boolean;
  sms_enabled: boolean;
  push_enabled: boolean;
  // Phase E: 능동 알림 (opt-in, 기본 OFF)
  location_based: boolean;
  price_watch: boolean;
  weekly_curation: boolean;
  friend_activity: boolean;
}

export async function getNotifications(params?: { unread_only?: boolean; skip?: number; limit?: number }) {
  const { data } = await api.get<NotificationListResponse>("/notifications", { params });
  return data;
}

export async function getUnreadNotificationCount() {
  const { data } = await api.get<{ count: number }>("/notifications/unread-count");
  return data.count;
}

export async function markNotificationRead(notificationId: string) {
  const { data } = await api.post<{ ok: boolean }>(`/notifications/${notificationId}/read`);
  return data;
}

export async function markAllNotificationsRead() {
  const { data } = await api.post<{ ok: boolean; updated: number }>("/notifications/read-all");
  return data;
}

export async function getNotificationPreferences() {
  const { data } = await api.get<NotificationPreferences>("/notifications/preferences");
  return data;
}

export async function updateNotificationPreferences(prefs: Partial<NotificationPreferences>) {
  const { data } = await api.put<NotificationPreferences>("/notifications/preferences", prefs);
  return data;
}

// ── Reviews API (v2 backend ReviewResponse schema) ──
export type { ReviewData };

export type ReviewSummary = ReviewSummaryData;

export async function getEventReviews(eventId: string, skip = 0, limit = 20) {
  const { data } = await api.get<ReviewData[]>(`/events/${eventId}/reviews`, { params: { skip, limit } });
  return data;
}

export async function getReviewSummary(eventId: string) {
  const { data } = await api.get<ReviewSummary>(`/events/${eventId}/reviews/summary`);
  return data;
}

export async function createReview(eventId: string, params: { rating: number; title: string; content: string }) {
  const { data } = await api.post<ReviewData>(`/events/${eventId}/reviews`, params);
  return data;
}

export async function markReviewHelpful(eventId: string, reviewId: string) {
  const { data } = await api.post<{ helpful_count: number }>(`/events/${eventId}/reviews/${reviewId}/helpful`);
  return data;
}

export async function deleteReview(eventId: string, reviewId: string) {
  await api.delete(`/events/${eventId}/reviews/${reviewId}`);
}

// ── Friends API (Phase C.1) ──
// backend: app/api/v1/friendships.py (root prefix, no mount prefix)
//   GET    /friends                       → list[FriendUserRead]  (status_filter 쿼리)
//   POST   /friends/request {friend_id}    → FriendshipRead
//   POST   /friends/{friendship_id}/accept → FriendshipRead
//   DELETE /friends/{friendship_id}        → 204
// 에러는 더 이상 삼키지 않는다(404-swallow 제거) — 실패는 호출부로 전파.

export type FriendStatus = "pending" | "accepted" | "blocked";

// backend FriendUserRead (snake_case 그대로)
export interface Friend {
  id: string;
  name: string | null;
  profile_image_url?: string | null;
  friendship_status: FriendStatus;
}

export interface FriendsListResponse {
  friends: Friend[];
  pending: Friend[];
}

/**
 * 백엔드에 대응 엔드포인트가 아예 없는 기능 표지.
 * 404를 빈 결과로 삼키면(실패 무증상) 모니터링이 불가하므로,
 * 미구현 기능은 호출 시점에 명시적으로 던져 UI가 "준비 중"을 분기하게 한다.
 */
export class FeatureNotImplementedError extends Error {
  readonly feature: string;
  constructor(feature: string) {
    super(`기능 미구현: ${feature} (백엔드 엔드포인트 없음)`);
    this.name = "FeatureNotImplementedError";
    this.feature = feature;
  }
}

/**
 * 친구 목록 + 받은 친구요청을 한 번에 조회.
 * backend는 status_filter별로 분리 조회하므로 두 호출을 병합한다.
 */
export async function getFriendsList(): Promise<FriendsListResponse> {
  const [accepted, pending] = await Promise.all([
    api.get<Friend[]>("/friends", { params: { status_filter: "accepted" } }),
    api.get<Friend[]>("/friends", { params: { status_filter: "pending_incoming" } }),
  ]);
  return { friends: accepted.data ?? [], pending: pending.data ?? [] };
}

/**
 * 유저 검색 — backend에 `/users/search` 엔드포인트가 존재하지 않는다.
 * 404를 빈 배열로 삼키던 동작을 제거하고 명시적으로 미구현을 알린다.
 * (backend에 검색 라우트가 추가되면 여기서 호출하도록 교체)
 */
export async function searchUsers(q: string): Promise<User[]> {
  if (!q.trim()) return [];
  throw new FeatureNotImplementedError("유저 검색(/users/search)");
}

export async function requestFriend(friendId: string): Promise<Friend> {
  const { data } = await api.post<{ friend_id: string; status: string }>(
    "/friends/request",
    { friend_id: friendId },
  );
  // FriendshipRead → Friend 정규화
  return {
    id: data.friend_id,
    name: null,
    friendship_status: (data.status as FriendStatus) ?? "pending",
  };
}

/** friendshipId(친구관계 ID, 상대 user id 아님)로 수락 */
export async function acceptFriend(friendshipId: string): Promise<{ ok: boolean }> {
  await api.post(`/friends/${friendshipId}/accept`, {});
  return { ok: true };
}

/** friendshipId(친구관계 ID)로 거절/삭제 */
export async function removeFriend(friendshipId: string): Promise<{ ok: boolean }> {
  await api.delete(`/friends/${friendshipId}`);
  return { ok: true };
}

// ── Group Booking API (Phase C.3) ──
export type GroupOrderStatus = "pending" | "filling" | "completed" | "cancelled" | "expired";

export interface GroupMember {
  user_id: string;
  name: string;
  avatar_url?: string;
  joined_at: string;
  paid: boolean;
}

export interface GroupOrder {
  id: string;
  event_id: string;
  tier_id: string;
  host_user_id: string;
  capacity: number;
  members: GroupMember[];
  invite_code: string;
  invite_url: string;
  status: GroupOrderStatus;
  expires_at: string;
  created_at: string;
}

export interface CreateGroupOrderInput {
  event_id: string;
  tier_id: string;
  capacity: number;
}

// 그룹 예매(GroupOrder)는 backend에 대응 엔드포인트가 없다.
//   - `/orders/group/*` : 존재하지 않음
//   - `/groups/*`       : "그룹 입찰(group bidding)"용이라 스키마/의미가 다름
//     (group_code/leader_user_id/max_size + join-by-code, capacity/invite_url/expires_at 없음)
// 의미가 다른 엔드포인트로 무리하게 매핑하지 않고, 404-swallow를 제거해
// 미구현 상태를 호출부로 명시 전파한다. UI는 이 에러로 "준비 중"을 분기한다.
export async function createGroupOrder(_input: CreateGroupOrderInput): Promise<GroupOrder | null> {
  throw new FeatureNotImplementedError("그룹 예매 생성(/orders/group/create)");
}

export async function joinGroupOrder(_groupId: string): Promise<{ ok: boolean }> {
  throw new FeatureNotImplementedError("그룹 예매 참여(/orders/group/{id}/join)");
}

export async function getGroupOrder(_groupId: string): Promise<GroupOrder | null> {
  throw new FeatureNotImplementedError("그룹 예매 조회(/orders/group/{id})");
}

// ── Push API (mobile: Expo Push Token) ──
export async function registerPushToken(expoPushToken: string) {
  // Phase E.0: 백엔드가 token_type="expo" 분기 — p256dh/auth 는 null 허용
  const { data } = await api.post<{ ok: boolean }>("/push/subscribe", {
    endpoint: expoPushToken,
    token_type: "expo",
  });
  return data;
}

export async function unregisterPushToken(expoPushToken: string) {
  const { data } = await api.delete<{ ok: boolean }>("/push/subscribe", {
    data: { endpoint: expoPushToken },
  });
  return data;
}

// ── Geofence API (Phase E.1) ──
export interface Geofence {
  id: string;
  event_id: string | null;
  venue_id: string | null;
  lat: number;
  lng: number;
  radius_m: number;
  created_at: string;
}

export interface GeofenceMatch {
  subscription_id: string;
  event_id: string | null;
  distance_m: number;
}

export async function createGeofence(input: {
  event_id?: string;
  venue_id?: string;
  lat: number;
  lng: number;
  radius_m?: number;
}): Promise<Geofence> {
  const { data } = await api.post<Geofence>("/geofences", input);
  return data;
}

export async function listMyGeofences(): Promise<Geofence[]> {
  const { data } = await api.get<Geofence[]>("/geofences");
  return data;
}

export async function deleteGeofence(id: string): Promise<void> {
  await api.delete(`/geofences/${id}`);
}

export async function checkGeofence(lat: number, lng: number): Promise<GeofenceMatch[]> {
  const { data } = await api.post<GeofenceMatch[]>("/geofences/check", { lat, lng });
  return data;
}

// ── Price Alert API (Phase E.2) ──
export interface PriceAlert {
  id: string;
  user_id: string;
  event_id: string;
  tier_id: string;
  target_price: number;
  triggered: boolean;
  created_at: string;
}

export async function createPriceAlert(
  eventId: string,
  tierId: string,
  targetPrice: number
): Promise<PriceAlert> {
  const { data } = await api.post<PriceAlert>(`/events/${eventId}/price-alert`, {
    tier_id: tierId,
    target_price: targetPrice,
  });
  return data;
}

export async function getMyPriceAlerts(includeTriggered = false): Promise<PriceAlert[]> {
  const { data } = await api.get<PriceAlert[]>("/users/me/price-alerts", {
    params: { include_triggered: includeTriggered },
  });
  return data;
}

export async function deletePriceAlert(alertId: string): Promise<void> {
  await api.delete(`/price-alerts/${alertId}`);
}

// ── Lottery API (v2 aligned: per-tier endpoints) ──
export interface LotteryApplyRequest {
  group_size: number;
  group_id?: string;
  client_seed?: string;
  invested_ap?: number;
}

export interface LotteryEntryResponse {
  id: string;
  pool_id: string;
  user_id: string;
  group_size: number;
  fan_weight: number;
  invested_ap: number;
  tier_multiplier: number;
  pity_bonus: number;
  amendment_count: number;
  result: string;
  created_at: string;
}

export interface LotteryPoolResponse {
  id: string;
  event_id: string;
  tier_id: string;
  total_seats: number;
  total_applicants: number;
  status: string;
  seed_used: number | null;
}

export interface LotteryMyResultResponse {
  pool_id: string;
  user_id: string;
  result: string;
  fan_weight: number;
  weight_breakdown: Record<string, unknown>;
  invested_ap: number;
  pool_stats: Record<string, unknown>;
  verification_link: string | null;
}

export async function applyLottery(eventId: string, tierId: string, params: LotteryApplyRequest) {
  const { data } = await api.post<LotteryEntryResponse>(
    `/events/${eventId}/tiers/${tierId}/lottery/apply`,
    params,
  );
  return data;
}

export async function getLotteryStatus(eventId: string, tierId: string) {
  const { data } = await api.get<LotteryPoolResponse>(
    `/events/${eventId}/tiers/${tierId}/lottery/status`,
  );
  return data;
}

export async function getMyLotteryResult(poolId: string) {
  const { data } = await api.get<LotteryMyResultResponse>(
    `/lottery/pools/${poolId}/my-result`,
  );
  return data;
}

// ── Lottery: 추가 API (v2 web consumer 동일) ──
export type MyEventStatus = V2MyEventStatus;

// v2 공유 타입 (상단 import에서 가져옴)
export type { PointBalance, PointTransaction, PointHistoryResponse };

export function getTotalPoints(balance: PointBalance): number {
  return balance.fan + balance.social;
}

export interface MyResult {
  won: boolean;
  bid_price: number | null;
  // v2 MyAllocationResult.fair_price (구 vcg_price — DB 컬럼명 유지, API 필드명 변경됨)
  fair_price: number | null;
  final_price: number | null;
  externality: number | null;
  event_title: string;
  event_id: string;
  order_id?: string | null;
  payment_deadline: string | null;
  tier_name: string | null;
  seat_label: string | null;
}

export async function getMyEventStatus(eventId: string) {
  const { data } = await api.get<MyEventStatus>(`/events/${eventId}/my-status`);
  return data;
}

export async function getMyResult(eventId: string) {
  const { data } = await api.get<MyResult>(`/events/${eventId}/my-result`);
  return data;
}

export async function getPointBalance() {
  const { data } = await api.get<PointBalance>("/points/balance");
  return data;
}

export async function getPointHistory(limit = 50, offset = 0) {
  const { data } = await api.get<PointHistoryResponse>("/points/history", {
    params: { limit, offset },
  });
  return data;
}

// ── Fanclub Membership API (Phase F.2) ──
export interface FanclubMembershipItem {
  id: string;
  fanclub_id: string;
  fanclub_name: string;
  artist_name: string;
  logo_url: string | null;
  tier: string;
  status: string;
  expires_at: string | null;
  joined_at: string | null;
}

export async function getMyFanclubMemberships() {
  const { data } = await api.get<FanclubMembershipItem[]>("/users/me/fanclubs");
  return data;
}

// ── Waitlist API (v2 aligned: per-tier endpoints) ──
export type { WaitlistEntryResponse, WaitlistStatusResponse };

export async function joinWaitlist(eventId: string, tierId: string, quantity = 1) {
  const { data } = await api.post<WaitlistEntryResponse>(
    `/events/${eventId}/tiers/${tierId}/waitlist`,
    { quantity },
  );
  return data;
}

export async function getWaitlistStatus(eventId: string, tierId: string) {
  const { data } = await api.get<WaitlistStatusResponse>(
    `/events/${eventId}/tiers/${tierId}/waitlist/status`,
  );
  return data;
}

export async function leaveWaitlist(eventId: string, tierId: string) {
  await api.delete(`/events/${eventId}/tiers/${tierId}/waitlist`);
}

// ── Tracking API (behavior analytics) ──
// AUDIT 2026-04-20 §40 P0: aligned with backend ALLOWED_EVENT_TYPES.
export interface TrackingEvent {
  event_type:
    | "page_view"
    | "event_view"
    | "search"
    | "bid"
    | "purchase"
    | "purchase_start"
    | "purchase_complete"
    | "payment_cancel"
    | "payment_error"
    | "share"
    | "favorite"
    | "click"
    | "discover_card_view"
    | "app_open"
    | "login_success"
    | "signup_complete"
    | "queue_joined"
    | "waitlist_joined"
    | "lottery_applied"
    | "notification_opened"
    | "ticket_check_in";
  target_type?: "event" | "tier" | "artist" | "category";
  target_id?: string;
  metadata?: Record<string, unknown>;
  timestamp?: string;
}

export async function trackEvents(events: TrackingEvent[]) {
  const { data } = await api.post<{ accepted: number; message: string }>(
    "/track",
    { events },
    { headers: { "X-Tracking-Consent": "true" } },
  );
  return data;
}

// ── Price Advice API (v2 backend PriceAdviceResponse schema) ──
export type PriceAdvice = V2PriceAdvice;

export async function getPriceAdvice(eventId: string) {
  const { data } = await api.get<PriceAdvice>(`/events/${eventId}/price-advice`);
  return data;
}

// ── Event Open (티켓오픈 알림 랜딩) ──
export interface EventOpenResponse {
  id: string;
  slug: string;
  title: string;
  venue: string;
  image_url?: string;
  event_date: string;
  ticket_open_at?: string;
  brand_color?: string;
  brand_color_fg?: string;
  category: string;
  artist_name?: string;
  status: string;
  service_fee_rate: number;
  subscriber_count: number;
}

export interface OpenSubscriptionResponse {
  subscribed: boolean;
  subscriber_count: number;
}

export async function getEventBySlug(slug: string) {
  const { data } = await api.get<EventOpenResponse>(`/events/by-slug/${slug}`);
  return data;
}

export async function subscribeOpenNotification(eventId: string, channel?: string) {
  const { data } = await api.post<OpenSubscriptionResponse>(
    `/events/${eventId}/open-subscriptions`,
    channel ? { channel } : {},
  );
  return data;
}

export async function unsubscribeOpenNotification(eventId: string) {
  const { data } = await api.delete<OpenSubscriptionResponse>(
    `/events/${eventId}/open-subscriptions`,
  );
  return data;
}

// ── Preferences API (Phase 6: Personalization Onboarding) ──
export interface PopularArtist {
  id: string;
  name: string;
  image_url?: string;
}

export async function savePreferences(genres: string[], artistIds: string[]): Promise<void> {
  await api.post("/users/me/preferences", { genres, artist_ids: artistIds });
}

/**
 * 인기 아티스트 — backend에 `/artists/popular` 엔드포인트가 존재하지 않는다.
 * 404를 빈 배열로 삼키면 온보딩 화면이 영구히 빈 상태가 되어 원인 추적이 불가하므로,
 * 명시적으로 미구현을 전파한다. (backend 추가 시 호출로 교체)
 */
export async function getPopularArtists(): Promise<PopularArtist[]> {
  throw new FeatureNotImplementedError("인기 아티스트(/artists/popular)");
}

// ── Fan Profile API (Phase 10) ──
import type { FanProfile } from "@/types/fan";

export async function getFanProfile(): Promise<FanProfile> {
  const { data } = await api.get<FanProfile>("/users/me/fan-profile");
  return data;
}

// ── Fan Stamp API (Phase 11) ──
import type { FanStamp, StampAssets } from "@/types/fan-stamp";

export async function getStampAssets(eventId: string): Promise<StampAssets> {
  const { data } = await api.get<StampAssets>(`/events/${eventId}/stamp-assets`);
  return data;
}

export async function createFanStamp(
  eventId: string,
  imageUri: string,
  status: "going" | "completed" = "completed",
): Promise<{ id: string; sequence_number?: number }> {
  const formData = new FormData();
  formData.append("image", { uri: imageUri, type: "image/png", name: "stamp.png" } as unknown as Blob);
  formData.append("status", status);
  const { data } = await api.post<{ id: string; sequence_number?: number }>(`/events/${eventId}/fan-stamps`, formData, {
    headers: { "Content-Type": "multipart/form-data" },
  });
  return data;
}

export async function deleteFanStamp(pickId: string): Promise<void> {
  await api.delete(`/users/me/fan-stamps/${pickId}`);
}

export async function getFanStamps(): Promise<FanStamp[]> {
  const { data } = await api.get<FanStamp[]>("/users/me/fan-stamps");
  return data;
}

// ── Utility ──
export function generateIdempotencyKey(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
