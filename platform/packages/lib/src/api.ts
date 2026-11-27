import axios, { type AxiosError, type InternalAxiosRequestConfig } from "axios";
import { useAuthStore, type User } from "@pickket/store";
import { getApiConfig } from "./api-config";
import { API_URL } from "./env";
import { DEVICE_FINGERPRINT_HEADER, getDeviceFingerprint } from "./device-fingerprint";
import { handleRetryAfter, isOnCooldown } from "./retry-guard";

const api = axios.create({
  baseURL: `${API_URL}/api/v1`,
  headers: { "Content-Type": "application/json" },
  timeout: 30000,
  withCredentials: true,
});

// ─── Retry helpers ──────────────────────────────────────────────────────────

const MAX_RETRIES = 3;
const RETRY_STATUS = new Set([502, 503, 504]);

interface RetryableConfig extends InternalAxiosRequestConfig {
  _retryCount?: number;
  _authRetried?: boolean;
}

function shouldRetry(err: AxiosError): boolean {
  if (
    !err.config ||
    (err.config as RetryableConfig)._retryCount! >= MAX_RETRIES
  )
    return false;
  // Never retry canceled/aborted requests (e.g. from deduplication or AbortController)
  if (axios.isCancel(err) || err.code === "ERR_CANCELED") return false;
  if (err.response && RETRY_STATUS.has(err.response.status)) {
    // 503 with a JSON detail = intentional kill switch, not transient — don't retry
    if (
      err.response.status === 503 &&
      (err.response.data as Record<string, unknown>)?.detail
    )
      return false;
    return true;
  }
  // Network errors (no response) — includes ERR_NETWORK from offline/DNS failures
  // and ECONNABORTED from timeouts
  if (
    !err.response &&
    (err.code === "ERR_NETWORK" || err.code === "ECONNABORTED")
  )
    return true;
  return false;
}

function retryWithBackoff(config: RetryableConfig): Promise<unknown> {
  const count = (config._retryCount ?? 0) + 1;
  config._retryCount = count;
  const baseDelay = 100 * Math.pow(4, count - 1);
  const jitter = Math.random() * 100;
  const delay = Math.min(baseDelay + jitter, 5000);
  return new Promise((resolve) => setTimeout(resolve, delay)).then(() =>
    api.request(config),
  );
}

// ─── GET request deduplication ──────────────────────────────────────────────

const pendingRequests = new Map<string, AbortController>();
let isRefreshing = false;
let refreshSubscribers: {
  resolve: (token: string) => void;
  reject: (error: unknown) => void;
}[] = [];
let behaviorTokenProvider:
  | null
  | (() =>
      | Promise<{ token: string; sessionId: string } | null>
      | { token: string; sessionId: string }
      | null) = null;

function onTokenRefreshed(token: string) {
  refreshSubscribers.forEach((subscriber) => subscriber.resolve(token));
  refreshSubscribers = [];
}

function onTokenRefreshFailed(error: unknown) {
  refreshSubscribers.forEach((subscriber) => subscriber.reject(error));
  refreshSubscribers = [];
}

function addRefreshSubscriber(
  resolve: (token: string) => void,
  reject: (error: unknown) => void,
) {
  refreshSubscribers.push({ resolve, reject });
}

export function setBehaviorTokenProvider(
  provider:
    | null
    | (() =>
        | Promise<{ token: string; sessionId: string } | null>
        | { token: string; sessionId: string }
        | null),
) {
  behaviorTokenProvider = provider;
}

function deduplicateGet(
  config: InternalAxiosRequestConfig,
): InternalAxiosRequestConfig {
  if (config.method?.toLowerCase() !== "get") return config;
  const key = `${config.url}?${JSON.stringify(config.params ?? {})}`;
  const existing = pendingRequests.get(key);
  if (existing) existing.abort();
  const controller = new AbortController();
  config.signal = controller.signal;
  pendingRequests.set(key, controller);
  return config;
}

function cleanupPending(config: InternalAxiosRequestConfig | undefined) {
  if (!config || config.method?.toLowerCase() !== "get") return;
  const key = `${config.url}?${JSON.stringify(config.params ?? {})}`;
  pendingRequests.delete(key);
}

// ─── Proactive token refresh ─────────────────────────────────────────────────

function getTokenExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split(".")[1]));
    return payload.exp ?? null;
  } catch {
    return null;
  }
}

// ─── CSRF (double-submit cookie) ────────────────────────────────────────────

const CSRF_COOKIE_NAME = "pickket_csrf";
const CSRF_HEADER_NAME = "X-CSRF-Token";
const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Backend CSRF middleware exempts these paths — don't add the header
// (preflight OPTIONS would fail since backend CORS doesn't list X-CSRF-Token)
const CSRF_EXEMPT_PATHS = [
  "/auth/csrf-token",
  "/auth/login",
  "/auth/register",
  "/auth/refresh",
  "/auth/logout",
  "/auth/password/",
  "/auth/mfa/verify",
  "/auth/oauth/",
  "/webhooks/",
];

function isCsrfExempt(url: string): boolean {
  return CSRF_EXEMPT_PATHS.some((p) => url.includes(p));
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const parts = document.cookie.split(";");
  for (const part of parts) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

let csrfFetchInflight: Promise<string | null> | null = null;

async function fetchCsrfToken(): Promise<string | null> {
  if (csrfFetchInflight) return csrfFetchInflight;
  csrfFetchInflight = (async () => {
    try {
      const res = await api.get<{ csrf_token: string }>("/auth/csrf-token");
      return res.data?.csrf_token ?? null;
    } catch {
      return null;
    } finally {
      csrfFetchInflight = null;
    }
  })();
  return csrfFetchInflight;
}

async function ensureCsrfToken(): Promise<string | null> {
  const cached = readCookie(CSRF_COOKIE_NAME);
  if (cached) return cached;
  const fetched = await fetchCsrfToken();
  return readCookie(CSRF_COOKIE_NAME) ?? fetched;
}

// ─── Request interceptor ────────────────────────────────────────────────────

api.interceptors.request.use(async (config) => {
  // HttpOnly cookie handles auth — no manual header needed

  // TOTP device fingerprint headers (screen info + timezone)
  if (typeof window !== "undefined") {
    config.headers["X-Screen-Info"] =
      `${window.screen.width}x${window.screen.height}`;
    config.headers["X-Timezone"] =
      Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  // Attach behavior token for bot-detection-protected endpoints
  // /guests/orders: 게스트 주문 생성(공개)은 verify_behavior_token 게이트를 통과해야 한다.
  const protectedPaths = [
    "/purchase",
    "/bids",
    "/lottery/apply",
    "/waitlist",
    "/guests/orders",
  ];
  const needsBehaviorToken =
    behaviorTokenProvider &&
    !config.headers["X-Behavior-Token"] &&
    protectedPaths.some((p) => config.url?.includes(p));
  if (needsBehaviorToken) {
    const result = await behaviorTokenProvider!();
    if (result) {
      config.headers["X-Behavior-Token"] = result.token;
      config.headers["X-Behavior-Session"] = result.sessionId;
    }
  }
  // Block requests during rate-limit cooldown (purchase paths only)
  const purchasePaths = [
    "/cart/reserve",
    "/cart/confirm",
    "/purchase",
    "/tiers/",
  ];
  const isPurchasePath = purchasePaths.some((p) => config.url?.includes(p));
  if (isPurchasePath && isOnCooldown()) {
    return Promise.reject(
      new axios.AxiosError(
        "Rate limited — please wait before retrying",
        "ERR_RATE_LIMITED",
        config,
        null,
        {
          status: 429,
          statusText: "Too Many Requests",
          headers: {},
          config,
          data: null,
        } as any,
      ),
    );
  }

  // CSRF double-submit: attach token on unsafe methods (cookie-auth path)
  const method = (config.method ?? "get").toUpperCase();
  const url = config.url ?? "";
  if (UNSAFE_METHODS.has(method) && !isCsrfExempt(url)) {
    const token = await ensureCsrfToken();
    if (token) {
      config.headers[CSRF_HEADER_NAME] = token;
    }
  }

  return deduplicateGet(config);
});

// ─── Auth helpers ───────────────────────────────────────────────────────────

/**
 * 세션 만료(401·refresh 실패) 때 로그인 화면으로 보낼지 정하는 규칙.
 * 기본은 항상 보낸다(관리자 앱). 피켓은 공개 화면(홈·이벤트 등)에서는 조용히 로그아웃만 하도록
 * 규칙을 바꾼다 — 홈 화면 앱(PWA)을 며칠 만에 열었을 때 첫 화면이 로그인으로 튕기지 않게.
 */
let shouldRedirectToLogin: (pathname: string) => boolean = () => true;
export function setLoginRedirectPolicy(fn: (pathname: string) => boolean): void {
  shouldRedirectToLogin = fn;
}

function _redirectToLogin(): void {
  if (typeof window === "undefined") return;
  const path = window.location.pathname;
  // 이미 auth 페이지면 무한 리다이렉트 방지
  if (path.includes("/auth")) return;
  if (!shouldRedirectToLogin(path)) return;
  // locale prefix 감지: /ko/.. → /ko/auth, admin은 prefix 없음 → /auth
  const localeMatch = path.match(/^\/([a-z]{2}(?:-[A-Z]{2})?)\//);
  const loginPath = localeMatch ? `/${localeMatch[1]}/auth` : "/auth";
  const callbackUrl = encodeURIComponent(path + window.location.search);
  window.location.href = `${loginPath}?callbackUrl=${callbackUrl}`;
}

// ─── Response interceptor ───────────────────────────────────────────────────

api.interceptors.response.use(
  (res) => {
    cleanupPending(res.config);
    return res;
  },
  async (err: AxiosError) => {
    cleanupPending(err.config);

    /* Canceled requests (AbortController, deduplication) — skip all retry/refresh logic */
    if (axios.isCancel(err) || err.code === "ERR_CANCELED") {
      return Promise.reject(err);
    }

    if (err.response?.status === 401) {
      const originalConfig = err.config as RetryableConfig;
      if (!originalConfig) {
        return Promise.reject(err);
      }
      const requestUrl = originalConfig?.url ?? "";

      // 로그인/회원가입/refresh 엔드포인트 자체 실패는 각 페이지에서 처리
      if (
        requestUrl.includes("/auth/login") ||
        requestUrl.includes("/auth/register") ||
        requestUrl.includes("/auth/refresh")
      ) {
        return Promise.reject(err);
      }

      // /users/me 또는 이미 재시도한 요청이 또 401 → 세션 완전 무효
      // refresh 시도하지 않고 바로 logout + 로그인 페이지 이동
      if (requestUrl.includes("/users/me") || originalConfig?._authRetried) {
        useAuthStore.getState().logout();
        _redirectToLogin();
        return Promise.reject(err);
      }

      // Try to refresh the access token (cookie-based)
      if (!isRefreshing) {
        isRefreshing = true;
        try {
          const refreshBase = getApiConfig().baseURL || API_URL;
          const res = await axios.post(
            `${refreshBase}/api/v1/auth/refresh`,
            {},
            { withCredentials: true },
          );
          const { user } = res.data ?? {};
          if (user) {
            useAuthStore.getState().setAuth(user, "cookie");
          }
          isRefreshing = false;
          onTokenRefreshed("cookie");
          originalConfig._authRetried = true;
          // New access token is in HttpOnly cookie — just retry
          return api.request(originalConfig);
        } catch (refreshError) {
          isRefreshing = false;
          onTokenRefreshFailed(refreshError);
          useAuthStore.getState().logout();
          _redirectToLogin();
          return Promise.reject(err);
        }
      } else {
        return new Promise((resolve, reject) => {
          addRefreshSubscriber(() => {
            originalConfig._authRetried = true;
            resolve(api.request(originalConfig));
          }, reject);
        });
      }
    }

    // 403 CSRF — refetch token once and retry
    if (err.response?.status === 403) {
      const data = err.response.data as { code?: string } | undefined;
      const isCsrf =
        data?.code === "CSRF_MISSING" || data?.code === "CSRF_INVALID";
      const cfg = err.config as RetryableConfig & { __csrfRetried?: boolean };
      if (isCsrf && cfg && !cfg.__csrfRetried) {
        cfg.__csrfRetried = true;
        csrfFetchInflight = null; // force re-issue
        const token = await fetchCsrfToken();
        if (token) {
          cfg.headers = cfg.headers ?? {};
          (cfg.headers as Record<string, string>)[CSRF_HEADER_NAME] = token;
          return api.request(cfg);
        }
      }
    }

    // Handle 429 Too Many Requests with Retry-After
    if (err.response?.status === 429) {
      // Cap the auto-retry wait at 10s so a hostile/large Retry-After can't
      // freeze the request (and the UI awaiting it) for an unbounded period.
      const retryAfter = Math.min(
        parseInt(err.response.headers?.["retry-after"] || "30", 10),
        10,
      );
      handleRetryAfter(retryAfter);

      // Auto-retry once after cooldown
      if (!(err.config as any)?.__retried429) {
        (err.config as any).__retried429 = true;
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        return api.request(err.config!);
      }
    }

    if (shouldRetry(err)) {
      return retryWithBackoff(err.config as RetryableConfig);
    }

    return Promise.reject(err);
  },
);

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ProgramPiece {
  composer: string;
  title: string;
  movements?: string[];
  duration_min?: number;
  soloist?: string;
}

export type EventProgramData = ProgramPiece[] | Record<string, unknown> | null;

/**
 * Matches backend SeatTierResponseCompact schema (embedded in EventResponse).
 */
export interface SeatTierCompact {
  id: string;
  name: string;
  capacity: number;
  base_price: number;
  sale_mode: string;
  face_price: number;
  sold_count: number;
  remaining: number;
  min_price: number;
  max_price_cap: number;
  lottery_application_hours: number;
  seating_type: string;
  bidding_opens_at: string | null;
  bidding_closes_at: string | null;
}

export interface Event {
  id: string;
  title: string;
  slug?: string;
  description?: string;
  venue: string;
  event_date: string;
  total_seats: number;
  min_price: number;
  max_price: number | null;
  status: string;
  bidding_opens_at: string;
  bidding_closes_at: string;
  category: string;
  sub_category?: string;
  image_url?: string;
  images?: string[];
  thumbnail_url?: string;
  location_city?: string;
  artist_name?: string;
  subject_name?: string | null;
  age_restriction?: string;
  tags?: string;
  is_featured: boolean;
  bid_count: number;
  view_count: number;
  is_public_sector?: boolean;
  is_free?: boolean;
  deposit_amount?: number;
  // Backend: list[dict] | dict | None — unified to match EventDetail.
  discount_policies?:
    | Record<string, number>
    | Array<Record<string, unknown>>
    | null;
  resident_priority?: boolean;
  resident_priority_days?: number;
  nft_enabled?: boolean;
  duration_minutes?: number;
  event_date_end?: string;
  participant_enabled?: boolean;
  // Global / i18n fields
  currency?: string;
  event_timezone?: string;
  // Sports-specific fields
  home_team?: string;
  away_team?: string;
  match_status?: string;
  broadcast_url?: string;
  broadcast_platform?: string;
  parking_info?: string;
  // Classical / Festival fields
  program_notes?: string;
  program_data?: EventProgramData;
  stage_info?: string;
  time_slot_enabled?: boolean;
  time_slot_capacity?: number | null;
  time_slot_duration_minutes?: number | null;
  blurhash?: string | null;
  image_variants?: Record<string, string> | null;
  gallery_images?: Array<{ url: string; variants?: Record<string, string> | null }> | null;
  comment_count?: number;
  sale_mode?: string;
  // Derived from dominant seat tier (backend EventResponse.primary_sale_mode)
  primary_sale_mode?: string | null;
  // 매진 표시용 (모든 tier 의 sold_count/capacity 합계)
  sold_count?: number;
  total_capacity?: number;
  is_sold_out?: boolean;
  // DICE+Laylo DNA (A1, A4)
  service_fee_rate?: number;
  brand_color?: string | null;
  brand_color_fg?: string | null;
}

/**
 * Matches backend EventResponse schema (detail endpoint).
 */
/**
 * Phase 1-Map — 좌석 배치도 원본(canvas) 계약. go seat_maps.map_data 원본을 변환 없이 담고,
 * 배경 도면·랜드마크·다층(floor) 정보를 병합한 렌더용 payload.
 * organizer `SeatMapDataPayload`(seat-map-payload.ts) / v2 `EventResponse.seat_map_data` 와 shape 일치.
 * map_data 는 go 원본 canvas(unknown) — 소비자는 `{ mode:"figma", figmaLayout:{ sections } }` 형태만 해석.
 */
export interface SeatMapLandmark {
  type: string;
  label: string | null;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  color_hex: string | null;
  metadata?: unknown;
}

export interface SeatMapLayer {
  id: string;
  name: string;
  status: string;
  floor_index: number;
  floor_label: string | null;
  parent_map_id: string | null;
  /** go 원본 canvas — 변환 없음. 소비자는 figma 모드 sections 만 해석(그 외 형태는 폴백). */
  map_data: unknown;
  background: {
    url: string | null;
    opacity: number;
    width: number | null;
    height: number | null;
  } | null;
  landmarks: SeatMapLandmark[];
}

export interface SeatMapData {
  version: number;
  maps: SeatMapLayer[];
}

export interface EventDetail {
  id: string;
  organizer_id: string;
  title: string;
  slug?: string;
  description: string | null;
  venue: string;
  venue_id?: string | null;
  event_date: string;
  bidding_opens_at: string;
  bidding_closes_at: string;
  total_seats: number;
  min_price: number;
  max_price: number | null;
  status: string;
  sales_paused?: boolean; // 주최자 판매 일시중지 — 예매 CTA 를 '판매중지'로 전환
  // 게스트(비회원) 체크아웃 opt-in 게이트(상세통합 S2a·S3). true 일 때만 consumer 가
  // 비로그인 구매 흐름(GuestCheckoutModal)을 노출한다. 미노출/false 면 기존 로그인 게이트.
  // ⚠️ 백엔드 EventResponse 스키마가 이 필드를 노출해야 값이 채워진다(S3 backend 요청).
  guest_checkout_enabled?: boolean;
  created_at?: string;
  // Extended fields
  category?: string;
  sub_category?: string;
  image_url?: string;
  thumbnail_url?: string;
  location_city?: string;
  artist_name?: string;
  subject_name?: string | null;
  community_id?: string | null;
  age_restriction?: string;
  tags?: string;
  is_featured?: boolean;
  bid_count?: number;
  view_count?: number;
  duration_minutes?: number;
  // Public sector
  is_public_sector?: boolean;
  is_free?: boolean;
  require_checkin?: boolean;
  locality_restricted?: string | null;
  deposit_amount?: number;
  no_show_policy?: string;
  cancellation_fee_tiers?: Array<{
    days_before: number;
    fee_pct: number;
  }> | null;
  discount_policies?:
    | Record<string, number>
    | Array<Record<string, unknown>>
    | null;
  resident_priority?: boolean;
  resident_priority_days?: number;
  nft_enabled?: boolean;
  // Regulation
  price_cap_multiplier?: number;
  require_identity_verification?: boolean;
  // 나이스 결제수단 게이팅(C2) — 대문자 코드 리스트(CARD/BANK/VBANK/CELLPHONE/EASYPAY/CARDANDEASYPAY).
  // NULL/미포함 = 전체 허용(현행 무변). 서버가 pay_method 를 이 목록으로 강제하므로
  // 프론트는 UX상 선택지만 제한한다(값 정규화는 서버 소유). 토스 경로 무영향.
  allowed_pay_methods?: string[] | null;
  // Remainder policy
  remainder_strategy?: string;
  remainder_trigger_hours?: number;
  remainder_step_interval_min?: number;
  // Multi-session
  multi_max_wins_per_user?: number;
  multi_loser_bonus_weight?: number;
  multi_cross_session_dedup?: boolean;
  // Resale
  resale_enabled?: boolean;
  resale_max_markup_pct?: number;
  resale_royalty_pct?: number;
  resale_opens_at?: string | null;
  resale_closes_at?: string | null;
  // Organizer portal fields
  age_rating?: string | null;
  // 상세페이지 통합 트랙B U1 — go 정본 필드, v2 EventResponse 노출. NULL/빈값·false 시 소비자 상세 미노출(비파괴).
  venue_address?: string | null; // 공연장 주소 — 장소 섹션 venue 명 아래 주소 라인
  venue_lat?: number | null; // 지도 API 연동 — 「장소 찾기」 좌표(둘 다 있을 때만 지도)
  venue_lng?: number | null;
  is_online?: boolean; // 온라인 이벤트 여부 — true 시 온라인 배지 + 장소/오시는길 온라인 표기
  homepage_url?: string | null; // 공식 홈페이지 외부 링크
  seat_type?: string;
  seat_map_url?: string | null;
  allocation_ratio?: number | null;
  delivery_method?: string;
  mobile_ticket_enabled?: boolean;
  ticket_display_info?: string | null;
  desired_open_date?: string | null;
  notice?: string | null;
  description_images?: string | null;
  participant_enabled?: boolean;
  board_types?: string | null;
  event_date_end?: string | null;
  // 상세페이지 통합 갭 필드 (Phase 1-S) — go→v2 흡수, NULL 시 소비자 상세 미노출.
  summary?: string | null; // 한 줄 요약
  event_schedules?: Array<{
    time?: string | null;
    title?: string | null;
    description?: string | null;
  }> | null; // 타임테이블 [{time, title, description}]
  seo_metadata?: {
    title?: string | null;
    description?: string | null;
    keywords?: string | null;
    og_image?: string | null;
  } | null; // {title, description, keywords, og_image}
  questions?: Array<{
    label?: string | null;
    type?: string | null;
    required?: boolean | null;
    options?: string[] | null;
  }> | null; // 예매 설문 (주로 체크아웃에서 사용, 상세엔 안내만)
  transport_info?: string | null; // 오시는 길
  runtime_minutes?: number | null; // 공연시간(분)
  intermission_minutes?: number | null; // 인터미션(분)
  // Phase 1-Map — 좌석 배치도 원본(canvas). go seat_maps.map_data + 배경/층/랜드마크.
  // NULL 시 seat_map_url(이미지)/venue.sections 폴백. 소비자가 원본 렌더에 소비.
  seat_map_data?: SeatMapData | null;
  // Sports-specific fields
  home_team?: string;
  away_team?: string;
  match_status?: string;
  broadcast_url?: string;
  broadcast_platform?: string;
  parking_info?: string;
  // Classical / Festival fields
  program_notes?: string;
  program_data?: EventProgramData;
  stage_info?: string;
  time_slot_enabled?: boolean;
  time_slot_capacity?: number | null;
  time_slot_duration_minutes?: number | null;
  // Computed / relationship fields
  organizer_name?: string | null;
  organizer_contact_email?: string | null;
  organizer_contact_phone?: string | null;
  blurhash?: string | null;
  image_variants?: Record<string, string> | null;
  gallery_images?: Array<{ url: string; variants?: Record<string, string> | null }> | null;
  // Globalization
  currency?: string;
  event_timezone?: string;
  // Seat tiers (loaded via relationship)
  seat_tiers?: SeatTierCompact[];
  primary_sale_mode?: string | null;
  // DICE+Laylo DNA (A1, A4)
  service_fee_rate?: number;
  brand_color?: string | null;
  brand_color_fg?: string | null;
  // 상세페이지 통합 트랙B U3 — go 공개 랜딩 부속기능 이식. NULL/false 시 소비자 상세 미노출(비파괴).
  // RSVP(무료 참석 등록) 게이트 — true 일 때만 RsvpForm 노출. 백엔드 EventResponse 노출 필요(U3 backend).
  rsvp_enabled?: boolean;
  // 단체(그룹) 예약 신청 진입 게이트 — true 일 때만 GroupBookingForm 노출.
  group_booking_enabled?: boolean;
  // 이벤트별 동적 컨텍스트 배너 문구. 값이 있을 때만 상단 배너 렌더(plain text 로 안전 렌더).
  context_banner?: string | null;
  // UI-only virtual fields (not in backend schema)
  images?: string[];
  artist_image_url?: string;
}

// ─── 상세페이지 통합 트랙B U3 — 공개 부속기능 (RSVP · 그룹부킹) ────────────
// ⚠️ 계약 기반 스텁. 백엔드 라우트가 배선되면 실연결(경로/필드 계약 맞춤).

export interface RsvpRequest {
  event_id: string;
  name: string;
  email: string;
  phone?: string;
}

export interface RsvpResult {
  status: string;
  message: string;
}

/** 무료 참석(RSVP) 등록 — 공개. event.rsvp_enabled 게이트. */
export const submitRsvp = (data: RsvpRequest) =>
  api.post<RsvpResult>("/public/rsvp", data).then((r) => r.data);

export interface GroupBookingRequest {
  event_id: string;
  org_name: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string;
  attendee_count: number;
  product_id?: string;
  notes?: string;
}

export interface GroupBookingResult {
  status: string;
  message?: string;
}

/** 단체 예약 신청 — 공개. event.group_booking_enabled 게이트. */
export const submitGroupBooking = (data: GroupBookingRequest) =>
  api
    .post<GroupBookingResult>("/public/group-bookings", data)
    .then((r) => r.data);

export interface SearchParams {
  q?: string;
  category?: string;
  sub_category?: string;
  city?: string;
  date_from?: string;
  date_to?: string;
  price_min?: number;
  price_max?: number;
  status?: string;
  sort?: string;
  is_public_sector?: boolean;
  skip?: number;
  limit?: number;
}

/**
 * Matches backend CategoryCount schema: {category, count}.
 * For display labels, use CATEGORIES constant from @pickket/lib.
 */
export interface CategoryCount {
  category: string;
  count: number;
}

/**
 * Matches backend PriceAdviceResponse schema.
 */
export interface PriceAdvice {
  event_id: string;
  competition_level: number;
  avg_historical_price: number | null;
  fan_weight: number;
  weight_percentile: number;
  estimated_win_probability: number;
  suggested_min_bid: number;
  suggested_max_bid: number;
  suggestion_text: string;
}

export interface RankingEvent extends Event {
  rank: number;
  rank_change: number | null;
  is_new: boolean;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

/** login 성공 (MFA 미사용) 또는 MFA 필요 응답 */
export interface LoginResponse {
  /** MFA 미사용 계정: 발급된 액세스 토큰 (HttpOnly 쿠키). MFA 계정: null */
  access_token: string | null;
  /** MFA 미사용: 유저 객체. MFA 계정: 없음 */
  user?: User;
  /** MFA 사용 계정에서 true */
  mfa_required?: boolean;
  /** MFA 사용 계정에서 임시 토큰 (POST /auth/mfa/verify 에 전달) */
  mfa_token?: string;
}

export const register = (data: {
  email: string;
  password: string;
  name: string;
  is_organizer?: boolean;
  consents?: {
    terms: boolean;
    privacy: boolean;
    age14: boolean;
    marketing: boolean;
    marketing_channels: { email: boolean; sms: boolean; push: boolean };
    third_party: boolean;
    consented_at: string;
  };
}) => api.post("/auth/register", data);

export const login = (data: { email: string; password: string }) =>
  api.post<LoginResponse>("/auth/login", data);

/**
 * MFA TOTP 코드 검증.
 * body: { mfa_token, code } → POST /auth/mfa/verify
 * 성공 시 { user, access_token, ... } 반환.
 */
export async function mfaVerify({
  mfaToken,
  code,
}: {
  mfaToken: string;
  code: string;
}): Promise<{ user: User; access_token: string | null }> {
  const { data } = await api.post<{
    user: User;
    access_token: string | null;
  }>("/auth/mfa/verify", { mfa_token: mfaToken, code });
  return data;
}

export async function requestPasswordReset(email: string) {
  const { data } = await api.post("/auth/password/reset-request", { email });
  return data;
}

export async function confirmPasswordReset(
  token: string,
  uid: string,
  newPassword: string,
) {
  const { data } = await api.post("/auth/password/reset-confirm", {
    token,
    uid,
    new_password: newPassword,
  });
  return data;
}

// ─── Events ──────────────────────────────────────────────────────────────────

export const getEvents = (skip = 0, limit = 20) =>
  api.get(`/events/?skip=${skip}&limit=${limit}`);

export const getEvent = (id: string) => api.get(`/events/${id}`);

export interface MyEventStatus {
  has_ticket: boolean;
  ticket_count: number;
  has_lottery_entry: boolean;
  lottery_status: string | null;
  lottery_entry_id: string | null;
  invested_ap: number;
  lottery_tier_id: string | null;
  lottery_pool_id: string | null;
  lottery_group_size: number;
  lottery_order_id: string | null;
  lottery_payment_deadline: string | null;
  lottery_order_status: string | null;
  /** waitlisted 인 경우 같은 pool 내 FIFO 순번 (1-based) */
  lottery_waitlist_position?: number | null;
}

export const getMyEventStatus = (eventId: string) =>
  api.get<MyEventStatus>(`/events/${eventId}/my-status`);

export const getTimeSlots = (eventId: string, date: string) =>
  api
    .get<TimeSlotAvailabilityResponse>(`/events/${eventId}/time-slots`, {
      params: { date },
    })
    .then((r) => r.data);

export const createEvent = (data: {
  title: string;
  description?: string;
  venue: string;
  venue_id?: string;
  event_date: string;
  bidding_opens_at: string;
  bidding_closes_at: string;
  total_seats: number;
  min_price: number;
  max_price?: number;
  category?: string;
  sub_category?: string;
  image_url?: string;
  thumbnail_url?: string;
  location_city?: string;
  artist_name?: string;
  age_restriction?: string;
  tags?: string;
  is_featured?: boolean;
  duration_minutes?: number;
  // Public sector
  is_public_sector?: boolean;
  is_free?: boolean;
  require_checkin?: boolean;
  locality_restricted?: string;
  deposit_amount?: number;
  no_show_policy?: string;
  cancellation_fee_tiers?: Array<{ days_before: number; fee_pct: number }>;
  discount_policies?: Record<string, unknown>;
  resident_priority?: boolean;
  resident_priority_days?: number;
  nft_enabled?: boolean;
  // Regulation
  price_cap_multiplier?: number;
  require_identity_verification?: boolean;
  // Remainder
  remainder_strategy?: string;
  remainder_trigger_hours?: number;
  remainder_step_interval_min?: number;
  // Multi-session
  multi_max_wins_per_user?: number;
  multi_loser_bonus_weight?: number;
  multi_cross_session_dedup?: boolean;
  // Resale
  resale_enabled?: boolean;
  resale_max_markup_pct?: number;
  resale_royalty_pct?: number;
  resale_opens_at?: string;
  resale_closes_at?: string;
  resale_surplus_recapture_pct?: number;
  // Organizer portal
  age_rating?: string;
  seat_type?: string;
  seat_map_url?: string;
  allocation_ratio?: number;
  delivery_method?: string;
  mobile_ticket_enabled?: boolean;
  ticket_display_info?: string;
  desired_open_date?: string;
  notice?: string;
  description_images?: string;
  participant_enabled?: boolean;
  board_types?: string;
  event_date_end?: string;
  // Sports
  home_team?: string;
  away_team?: string;
  match_status?: string;
  broadcast_url?: string;
  broadcast_platform?: string;
  parking_info?: string;
  // Classical / Festival / Exhibition
  program_notes?: string;
  program_data?: Array<Record<string, unknown>> | Record<string, unknown>;
  stage_info?: string;
  time_slot_enabled?: boolean;
  time_slot_capacity?: number;
  time_slot_duration_minutes?: number;
  // Globalization
  currency?: string;
  event_timezone?: string;
  // Additional model fields
  subject_name?: string;
  season_ticket_enabled?: boolean;
  home_away_section?: string;
}) => api.post("/events/", data);

export const createSeatTier = (
  eventId: string,
  data: {
    name: string;
    capacity: number;
    base_price: number;
    sale_mode?: string;
    face_price?: number;
    min_price?: number;
    max_price_cap?: number;
    lottery_application_hours?: number;
    fanclub_discount_pct?: number;
    allow_group_tickets?: boolean;
    max_group_size?: number;
    bidding_opens_at?: string;
    bidding_closes_at?: string;
    // View metadata
    view_description?: string;
    distance_from_stage?: number;
    view_rating?: number;
    view_image_url?: string;
    position_label?: string;
    // Seating & resale
    seating_type?: string;
    section_name?: string;
    resale_allowed?: boolean;
    resale_max_price?: number;
  },
) => api.post(`/events/${eventId}/tiers`, data);

export const updateEvent = (eventId: string, data: Record<string, unknown>) =>
  api.patch(`/events/${eventId}`, data);

export const deleteEvent = (eventId: string) =>
  api.delete(`/events/${eventId}`);

// ─── Search & Discovery ─────────────────────────────────────────────────────

export interface EventSearchResponse {
  events: Event[];
  total: number;
}

export const searchEvents = (params: SearchParams) =>
  api.get<EventSearchResponse>("/events/search", { params });

export const getFeaturedEvents = () => api.get<Event[]>("/events/featured");

export const getTrendingEvents = (limit = 10) =>
  api.get<Event[]>("/events/trending", { params: { limit } });

export const getOpeningSoonEvents = (limit = 10) =>
  api.get<Event[]>("/events/opening-soon", { params: { limit } });

export const getRankingEvents = (period?: string, category?: string) =>
  api.get<RankingEvent[]>("/events/ranking", { params: { period, category } });

export const getCategories = () =>
  api.get<CategoryCount[]>("/events/categories");

// ─── AI Features ────────────────────────────────────────────────────────────

export const getRecommendedEvents = () =>
  api.get<Event[]>("/events/recommended");

export const getSimilarEvents = (eventId: string) =>
  api.get<Event[]>(`/events/${eventId}/similar`);

export const getPriceAdvice = (eventId: string) =>
  api.get<PriceAdvice>(`/events/${eventId}/price-advice`);

// ─── Interactions ───────────────────────────────────────────────────────────

export const recordView = (eventId: string) =>
  api.post<void>(`/events/${eventId}/view`);

export const toggleFavorite = (eventId: string) =>
  api.post<{ is_favorited: boolean }>(`/events/${eventId}/favorite`);

export const checkFavorite = (eventId: string) =>
  api.get<{ is_favorited: boolean }>(`/events/${eventId}/favorite/check`);

export const getFavorites = () => api.get<Event[]>("/users/me/favorites");

// ─── Surveys ────────────────────────────────────────────────────────────────

export interface SurveyStats {
  total_responses: number;
  answers_distribution: Record<string, Record<string, number>>;
}

export const submitSurveyResponse = (
  surveyId: string,
  answers: Record<string, unknown>,
) =>
  api.post<{ id: string; message: string }>(`/surveys/${surveyId}/responses`, {
    answers,
  });

export const getSurveyStats = (surveyId: string) =>
  api.get<SurveyStats>(`/surveys/${surveyId}/stats`);

// ─── Event Comments ─────────────────────────────────────────────────────────

export interface EventComment {
  id: string;
  event_id: string;
  user_id: string;
  parent_id: string | null;
  content: string;
  role: string;
  likes_count: number;
  replies_count: number;
  is_pinned: boolean;
  user_name: string;
  user_avatar: string | null;
  is_liked_by_me: boolean;
  created_at: string;
}

export interface EventCommentList {
  items: EventComment[];
  total: number;
  has_more: boolean;
}

export const getEventComments = (
  eventId: string,
  params?: { skip?: number; limit?: number; sort?: string; filter?: string },
) => api.get<EventCommentList>(`/events/${eventId}/comments`, { params });

export const createComment = (
  eventId: string,
  data: { content: string; parent_id?: string },
) => api.post<EventComment>(`/events/${eventId}/comments`, data);

export const toggleCommentLike = (eventId: string, commentId: string) =>
  api.post<{ is_liked: boolean; likes_count: number }>(
    `/events/${eventId}/comments/${commentId}/like`,
  );

export const deleteComment = (eventId: string, commentId: string) =>
  api.delete(`/events/${eventId}/comments/${commentId}`);

// ─── Bids ───────────────────────────────────────────────────────────────────

export const placeBid = (
  eventId: string,
  data: { max_willingness_to_pay: number; quantity: number },
) => api.post(`/events/${eventId}/bids`, data);

export const getBidStatus = (eventId: string) =>
  api.get(`/events/${eventId}/bids/status`);

export const cancelBid = (eventId: string, bidId: string) =>
  api.delete(`/events/${eventId}/bids/${bidId}`);

// ─── Allocation ─────────────────────────────────────────────────────────────

export const triggerAllocation = (eventId: string) =>
  api.post(`/events/${eventId}/allocate`);

export const getResults = (eventId: string) =>
  api.get(`/events/${eventId}/results`);

export const getMyResult = (eventId: string) =>
  api.get(`/events/${eventId}/my-result`);

// ─── User Profile ───────────────────────────────────────────────────────────

export const getUserProfile = () => api.get("/users/me");
export const updateUserProfile = (data: {
  name?: string;
  phone?: string;
  avatar_url?: string;
  bio?: string;
  preferred_language?: string;
  timezone?: string;
}) => api.patch("/users/me", data);
export const getBidHistory = () => api.get("/users/me/bids");
export const getUserStats = () => api.get("/users/me/stats");

// ─── Organizer ──────────────────────────────────────────────────────────────

export const getOrganizerEvents = () => api.get("/organizer/events");
export const getEventAnalytics = (eventId: string) =>
  api.get(`/organizer/events/${eventId}/analytics`);
export const getEventBids = (eventId: string) =>
  api.get(`/organizer/events/${eventId}/bids`);

// ─── Event Page Management ─────────────────────────────────────────────────

export const getEventPageByEvent = (eventId: string) =>
  api.get(`/events/by-event/${eventId}`).catch(() => ({ data: null }));

export const createEventPage = (data: {
  event_id: string;
  subdomain_slug: string;
  page_template?: string;
}) => api.post("/events/pages", data);

export const updateEventPageTheme = (
  pageId: string,
  theme: Record<string, string | undefined>,
) => api.patch(`/events/${pageId}/theme`, theme);

export const updateEventPageData = (
  pageId: string,
  pageData: Record<string, unknown>,
) => api.patch(`/events/${pageId}/data`, { page_data: pageData });

export const updateEventPageTemplate = (pageId: string, pageTemplate: string) =>
  api.put(`/events/${pageId}/template`, { page_template: pageTemplate });

export const publishEventPage = (pageId: string) =>
  api.patch(`/events/${pageId}/publish`);

export const getEventPageDetail = (pageId: string) =>
  api.get(`/events/${pageId}`);

// ─── Event KPI ──────────────────────────────────────────────────────────────

export interface EventKpi {
  event_id: string;
  event_title: string;
  views: number;
  total_bids: number;
  total_wins: number;
  avg_bid_price: number;
  total_orders: number;
  total_revenue: number;
  conversion_rate: number;
  bid_count: number;
}

export const getEventKpi = (eventId: string) =>
  api.get<EventKpi>(`/organizer/events/${eventId}/kpi`).then((r) => r.data);

// ─── Event Analytics Dashboard ──────────────────────────────────────────────

export interface AnalyticsOverview {
  event_id: string;
  event_title: string;
  pageviews: number;
  unique_visitors: number;
  bids: number;
  orders: number;
  revenue: number;
  conversion_rate: number;
}

export interface FunnelStage {
  stage: string;
  label: string;
  count: number;
  percentage: number;
  dropoff_rate: number;
}

export interface FunnelResponse {
  event_id: string;
  stages: FunnelStage[];
}

export interface TimeseriesPoint {
  date: string;
  pageviews: number;
}

export interface TimeseriesResponse {
  event_id: string;
  days: number;
  data: TimeseriesPoint[];
}

export interface TrafficSource {
  source: string;
  label: string;
  count: number;
  percentage: number;
}

export interface SourcesResponse {
  event_id: string;
  total: number;
  sources: TrafficSource[];
}

export const getEventAnalyticsOverview = (eventId: string) =>
  api
    .get<AnalyticsOverview>(`/events/${eventId}/analytics/overview`)
    .then((r) => r.data);

export const getEventAnalyticsFunnel = (eventId: string) =>
  api
    .get<FunnelResponse>(`/events/${eventId}/analytics/funnel`)
    .then((r) => r.data);

export const getEventAnalyticsTimeseries = (
  eventId: string,
  params?: { days?: number },
) =>
  api
    .get<TimeseriesResponse>(`/events/${eventId}/analytics/timeseries`, {
      params,
    })
    .then((r) => r.data);

export const getEventAnalyticsSources = (eventId: string) =>
  api
    .get<SourcesResponse>(`/events/${eventId}/analytics/sources`)
    .then((r) => r.data);

// ─── Organizer Refunds ──────────────────────────────────────────────────────

export interface OrganizerRefundItem {
  order_id: string;
  event_title: string;
  total_amount: number;
  status: string;
  quantity: number;
  updated_at: string;
  created_at: string;
}

export const getOrganizerRefunds = (params?: {
  skip?: number;
  limit?: number;
}) =>
  api
    .get<OrganizerRefundItem[]>("/organizer/refunds", { params })
    .then((r) => r.data);

// ─── Settlement / Revenue ──────────────────────────────────────────────────

export interface RevenueByEvent {
  event_id: string;
  event_title: string;
  revenue: number;
  tickets_sold: number;
  refunded_amount: number;
  net_revenue: number;
}

export interface OrganizerSettlementSummary {
  gross_revenue: number;
  platform_fee: number;
  platform_fee_rate: number;
  net_settlement: number;
  pending_refunds: number;
  final_payout: number;
}

export interface OrganizerDashboardSummary {
  total_events: number;
  total_revenue: number;
  total_tickets_sold: number;
  total_bids_received: number;
  average_competition_ratio: number;
  events_by_status: Record<string, number>;
}

export const getOrganizerDashboard = () =>
  api
    .get<OrganizerDashboardSummary>("/organizer/dashboard")
    .then((r) => r.data);

export const getRevenueByEvent = (params?: { skip?: number; limit?: number }) =>
  api
    .get<RevenueByEvent[]>("/organizer/revenue", { params })
    .then((r) => r.data);

export const getSettlementSummary = (eventId?: string) =>
  api
    .get<OrganizerSettlementSummary>("/organizer/settlement", {
      params: eventId ? { event_id: eventId } : undefined,
    })
    .then((r) => r.data);

// ─── Notifications ──────────────────────────────────────────────────────────

export const getNotifications = () => api.get("/notifications/");

export const markNotificationRead = (notificationId: string) =>
  api.patch(`/notifications/${notificationId}/read`);

export const markAllNotificationsRead = () =>
  api.patch("/notifications/read-all");

export const getUnreadNotificationCount = () =>
  api
    .get<{ count: number }>("/notifications/unread-count")
    .then((r) => r.data?.count ?? 0);

export const createNotificationStreamToken = () =>
  api
    .post<{ token: string; expires_in: number }>("/notifications/stream-token")
    .then((r) => r.data);

export const getNotificationPreferences = () =>
  api
    .get<Record<string, boolean>>("/notifications/preferences")
    .then((r) => r.data);

export const updateNotificationPreferences = (prefs: Record<string, boolean>) =>
  api
    .put<Record<string, boolean>>("/notifications/preferences", prefs)
    .then((r) => r.data);

// ─── Rehearsal ────────────────────────────────────────────────────────────

export interface RehearsalInput {
  total_seats: number;
  min_price: number;
  max_price: number;
  expected_bids: number;
  category?: string;
}

export interface RehearsalResult {
  total_bids: number;
  total_seats: number;
  competition_ratio: number;
  winners_count: number;
  price_stats: {
    min: number;
    max: number;
    median: number;
    p25: number;
    p75: number;
    mean: number;
  };
  estimated_revenue: number;
  fair_vs_face_price_ratio: number;
  bids_summary: {
    count_by_quantity: Record<string, number>;
    price_distribution: { mean: number; std: number };
  };
  top_winners: Array<{
    bid_amount: number;
    final_price: number;
    savings: number;
    fan_weight: number;
  }>;
}

export const runRehearsalSimulation = (data: RehearsalInput) =>
  api.post<RehearsalResult>("/rehearsal/simulate", data).then((r) => r.data);

// ─── Check-in ─────────────────────────────────────────────────────────────

export interface CheckinStats {
  total_tickets: number;
  checked_in: number;
  no_show: number;
  cancelled: number;
  revenue_impact?: number;
}

export interface CheckinEventOption {
  id: string;
  title: string;
}

export interface CheckinAttendee {
  ticket_id: string;
  user_id: string;
  name: string;
  phone: string | null;
  tier: string | null;
  seat: string | null;
  status: "active" | "checked_in" | "no_show";
  checked_in_at: string | null;
}

export interface CheckinAttendeeResponse {
  attendees: CheckinAttendee[];
  total: number;
}

export interface NoShowHistoryItem {
  event_id: string;
  event_title: string;
  event_date: string | null;
  order_id: string;
  recorded_at: string;
  penalty_level: string;
}

export interface NoShowHistoryResponse {
  user_id: string;
  total_no_shows: number;
  restricted_until: string | null;
  history: NoShowHistoryItem[];
}

export const getCheckinStats = (eventId: string) =>
  api.get<CheckinStats>(`/events/${eventId}/checkin/stats`).then((r) => r.data);

export const processNoShows = (eventId: string) =>
  api.post(`/events/${eventId}/checkin/process-noshows`);

export const getCheckinAttendees = (
  eventId: string,
  params?: {
    q?: string;
    status?: "active" | "checked_in" | "no_show";
    skip?: number;
    limit?: number;
  },
) =>
  api
    .get<CheckinAttendeeResponse>(`/events/${eventId}/checkin/attendees`, {
      params,
    })
    .then((r) => r.data);

export const getMyCheckinEvents = () =>
  api
    .get<CheckinEventOption[]>("/events/checkin/my-events")
    .then((r) => r.data);

export const getNoShowHistory = (userId: string) =>
  api
    .get<NoShowHistoryResponse>(`/users/${userId}/noshow-history`)
    .then((r) => r.data);

// ─── Orders ────────────────────────────────────────────────────────────

export interface OrderDetail {
  id: string;
  user_id: string;
  event_id: string;
  tier_id: string | null;
  order_type: string;
  status: string;
  quantity: number;
  unit_price: number;
  total_amount: number;
  payment_currency: string;
  payment_id: string | null;
  pg_provider: string | null;
  pg_transaction_id: string | null;
  payment_deadline: string | null;
  payment_started_at: string | null;
  pg_approved_at: string | null;
  authorized_at: string | null;
  captured_at: string | null;
  payment_failed_at: string | null;
  payment_failed_reason: string | null;
  time_slot_start: string | null;
  time_slot_end: string | null;
  created_at: string;
  // Refund fields — populated when status === 'refunded'
  refund_amount?: number | null;
  refunded_at?: string | null;
}

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

export interface TicketDetail {
  id: string;
  event_id: string;
  tier_id: string;
  tier_name?: string;
  seat_id: string | null;
  current_owner_id: string;
  purchase_price: number;
  sale_mode: string;
  status: string;
  is_resalable: boolean;
  transfer_count: number;
  created_at: string;
  // Fields returned by backend TicketResponse (schemas/ticket.py) — previously absent
  event_title?: string | null;
  event_date?: string | null;
  event_category?: string | null;
  seat_label?: string | null;
  checked_in?: boolean | null;
}

export interface TicketListResponse {
  tickets: TicketDetail[];
  total: number;
}

export interface TicketQrResponse {
  ticket_id: string;
  qr_data: string;
  expires_in_seconds: number;
  /** 화면이 새 QR 을 받아 올 주기(초). expires_in_seconds(입구에서 인정하는 시간)보다 짧다. 옛 서버는 안 보낸다. */
  refresh_in_seconds?: number | null;
}

export interface NfcTicketLookup {
  ticket_id: string;
  event_id: string;
  tier_id: string;
  current_owner_id: string;
  status: string;
  nfc_uid?: string | null;
}

export interface NftTicketRecord {
  id: string;
  ticket_id: string;
  event_id: string;
  owner_id: string;
  token_name: string;
  description: string;
  image_url: string;
  attributes?: Array<{ trait_type: string; value: string }>;
  chain?: string | null;
  contract_address?: string | null;
  token_id?: number | null;
  tx_hash?: string | null;
  minted_at?: string | null;
  status: string;
  created_at: string;
}

export interface EventNftList {
  items: NftTicketRecord[];
  total: number;
}

export interface FacilityRecord {
  id: string;
  organizer_id: string;
  name: string;
  facility_type: string;
  address: string;
  city: string;
  district?: string | null;
  lat?: number | null;
  lng?: number | null;
  capacity?: number | null;
  amenities?: string[] | null;
  accessibility?: Record<string, boolean> | null;
  operating_hours?: Record<
    string,
    string | { start?: string; end?: string }
  > | null;
  photos?: string[] | null;
  kakao_map_id?: string | null;
  naver_map_id?: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProxyBookingRecord {
  id: string;
  booker_id: string;
  actual_user_name: string;
  actual_user_phone: string;
  requested_quantity: number;
  event_id: string;
  tier_id: string;
  order_id?: string | null;
  status: string;
  created_at: string;
}

export interface DiscountVerificationResult {
  eligible: boolean;
  discount_type: string;
  applied_rate?: number | null;
  message: string;
}

export interface PublicFestival {
  title: string;
  region: string;
  year: number;
  start_date: string;
  end_date: string;
  venue: string;
  description?: string;
  source: string;
}

export interface TimeSlotAvailability {
  start: string;
  end: string;
  available: number;
  total: number;
}

export interface TimeSlotAvailabilityResponse {
  slots: TimeSlotAvailability[];
}

export interface GovernmentDashboard {
  total_bookings: number;
  utilization_rate: number;
  no_show_rate: number;
  bot_blocked_count: number;
  waitlist_reallocation_count: number;
  discount_usage_count: number;
  simple_mode_usage_rate: number;
  proxy_booking_rate: number;
  facility_heatmap: Array<{ name: string; city: string; utilization: number }>;
  monthly_trend: Array<{ month: string; bookings: number }>;
}

export interface GeneratedReport {
  report_id: string;
  format: string;
  filename: string;
}

export interface BenchmarkData {
  averages_by_city: Array<{
    city: string;
    avg_capacity: number;
    events: number;
  }>;
  averages_by_category: Array<{
    category: string;
    avg_bookings: number;
    events: number;
  }>;
}

/**
 * 나이스페이(구형/정규) 결제창 파라미터 — provider="nicepay" 일 때만 채워진다(토스면 null).
 * 서버(v2)가 SignData·EdiDate·ReturnURL 등을 생성해 내려주므로 **클라에서 절대 변형 금지**
 * (변형 시 서명 깨짐). form.* 를 그대로 hidden form 에 넣어 goPay 로 제출만 한다.
 */
export interface NicePayProviderParams {
  /** nicepay-pgweb.js SDK URL(goPay 제공). */
  js_url: string;
  /** 서버 게이트웨이 모드. "mock" 이면 상점키 없는 개발 환경 — 결제창 없이 모의 승인한다(운영은 늘 "live"). */
  mode?: "mock" | "live";
  /** goPay 폼 필드 — 전부 문자열, 서버 생성값 그대로 hidden input 으로 주입. */
  form: Record<string, string>;
}

export interface PaymentPrepareResponse {
  order_id: string;
  provider: string;
  payment_id: string;
  amount: number;
  currency: string;
  redirect_url: string;
  payment_deadline: string;
  status: string;
  /** 나이스페이 구형 결제창 파라미터(provider="nicepay" 일 때만). 토스면 null/미포함. */
  provider_params?: NicePayProviderParams | null;
}

export const getOrder = (orderId: string) =>
  api.get<OrderDetail>(`/orders/${orderId}`);

export const getMyOrders = (params?: {
  status?: string;
  event_id?: string;
  skip?: number;
  limit?: number;
}) => api.get<OrderDetail[]>("/orders/my", { params });

export const cancelOrder = (orderId: string) =>
  api.post<OrderDetail>(`/orders/${orderId}/cancel`);

export const confirmOrderPayment = (
  orderId: string,
  data: {
    pg_provider: string;
    pg_transaction_id: string;
    payment_id?: string;
    amount?: number;
  },
) => api.post<OrderDetail>(`/orders/${orderId}/pay`, data);

export const prepareOrderPayment = (
  orderId: string,
  data?: {
    idempotency_key?: string;
    success_url?: string;
    fail_url?: string;
    /**
     * 나이스페이 결제수단 코드(CARD·BANK·VBANK·CELLPHONE·EASYPAY·CARDANDEASYPAY).
     * 선택. 미지정=CARD. 서버가 화이트리스트 정규화(오염값→CARD)하며 토스는 무시.
     */
    pay_method?: string;
  },
) =>
  api.post<PaymentPrepareResponse>(
    `/orders/${orderId}/payment/prepare`,
    data ?? {},
  );

export const voidOrder = (orderId: string, reason = "user_requested_void") =>
  api.post(`/orders/${orderId}/void`, { reason });

export const refundOrder = (
  orderId: string,
  data: { reason: string; amount?: number },
) => api.post<RefundResponse>(`/orders/${orderId}/refund`, data);

// ─── Guest (비회원) 셀프서비스 ────────────────────────────────────────────
// 백엔드 계약: backend/app/api/v1/guests.py (S2b). 게스트는 세션이 없으므로 접근권한을
// 오직 view/refund/claim 토큰(SHA-256, order-scoped)으로 판정한다. view_token 은 주문
// 생성 응답에 1회만 실려오며 sessionStorage 에 보관해 confirm/조회에 재사용한다(localStorage 금지).

/** 게스트 구매자 블록. email 필수(주문 소유증명·영수증·매직링크 기준). */
export interface GuestBuyer {
  email: string;
  name?: string | null;
  phone?: string | null;
  marketing_opt_in: boolean;
}

/** 게스트 주문 라인. 자유석=tier_id+quantity, 좌석지정=seat_ids(==quantity)+hold_id. */
export interface GuestOrderItem {
  tier_id: string;
  quantity: number;
  unit_price: number;
  seat_ids?: string[];
  hold_id?: string | null;
}

export interface GuestOrderCreateRequest {
  event_id: string;
  items: GuestOrderItem[];
  guest_buyer: GuestBuyer;
  total_amount: number;
  discount_code?: string | null;
  /** 멱등키(필수). 동일 키 재요청은 동일 주문을 재생. consumer 가 UUID 생성. */
  idempotency_key: string;
}

export interface GuestOrderCreateResponse {
  order_id: string;
  /** OrderStatus 원값: "payment_required"(유료) | "confirmed"(0원 즉시확정). */
  status: string;
  total_amount: number;
  ticket_ids: string[];
  created: boolean;
  /** view 토큰 — 응답 1회. sessionStorage 보관, confirm/조회 소유증명. */
  view_token: string;
  view_token_expires_at: string;
}

/** 게스트 주문 조회 응답(PII 부분마스킹). */
export interface GuestOrderView {
  order: {
    order_id: string;
    status: string;
    event_id: string;
    quantity: number;
    total_amount: number;
    total_refunded: number;
    payment_method: string | null;
    created_at: string | null;
    buyer_name_masked: string | null;
    buyer_email_masked: string | null;
    buyer_phone_masked: string | null;
  };
  tickets: Array<{
    ticket_id: string;
    status: string;
    tier_id: string | null;
    seat_id: string | null;
    admission_day: string | null;
    checked_in: boolean;
  }>;
}

/** refund/claim 매직링크 토큰 발급 응답(raw 토큰 1회). */
export interface GuestScopedTokenResponse {
  purpose: string;
  raw_token: string;
  expires_at: string;
}

export interface GuestRefundResponse {
  order_id: string;
  status: string;
  refund_amount: number;
}

export interface GuestClaimResponse {
  order_id: string;
  claimed_user_id: string;
  tickets_claimed: number;
}

/** 게스트 주문 생성(공개 진입점 — 봇방지 헤더는 인터셉터가 /guests/orders 경로에 자동 첨부). */
export const createGuestOrder = (data: GuestOrderCreateRequest) =>
  api.post<GuestOrderCreateResponse>("/guests/orders", data);

/**
 * 게스트 유료 PG prepare — view 토큰 소유증명 + 회원과 동일한 PG 준비 파라미터.
 *
 * 회원 prepareOrderPayment 와 동형 응답(PaymentPrepareResponse: provider·payment_id·redirect_url
 * ·payment_deadline). 재prepare 는 동일 attempt→동일 payment_id 로 멱등(PG 이중청구 방지).
 * 봇방지 헤더는 인터셉터가 `/guests/orders` prefix 에 자동 첨부(경로 매칭 .includes).
 */
export const prepareGuestPayment = (
  orderId: string,
  data: {
    view_token: string;
    idempotency_key?: string;
    success_url?: string;
    fail_url?: string;
    /**
     * 나이스페이 결제수단 코드(회원 prepareOrderPayment 와 동형). 선택. 미지정=CARD.
     * 서버가 화이트리스트 정규화하며 토스는 무시.
     */
    pay_method?: string;
  },
) =>
  api.post<PaymentPrepareResponse>(
    `/guests/orders/${orderId}/payment/prepare`,
    data,
  );

/** 게스트 결제 confirm — view 토큰 소유증명 + PG 승인 파라미터. 재confirm 멱등. */
export const confirmGuestPayment = (
  orderId: string,
  data: {
    view_token: string;
    pg_provider: string;
    pg_transaction_id: string;
    payment_id?: string;
    amount?: number;
  },
) => api.post<OrderDetail>(`/guests/orders/${orderId}/confirm`, data);

/** 게스트 주문/티켓 조회 — view 토큰(POST body). PII 부분마스킹. */
export const getGuestOrder = (orderId: string, viewToken: string) =>
  api.post<GuestOrderView>(`/guests/orders/${orderId}/view`, {
    view_token: viewToken,
  });

/** 게스트 환불 매직링크(single-use refund 토큰) 발급 — view 토큰 소유증명. */
export const issueGuestRefundToken = (orderId: string, viewToken: string) =>
  api.post<GuestScopedTokenResponse>(`/guests/orders/${orderId}/tokens/refund`, {
    view_token: viewToken,
  });

/** 게스트 회원승격 매직링크(single-use claim 토큰) 발급 — view 토큰 소유증명. */
export const issueGuestClaimToken = (orderId: string, viewToken: string) =>
  api.post<GuestScopedTokenResponse>(`/guests/orders/${orderId}/tokens/claim`, {
    view_token: viewToken,
  });

/** 게스트 환불 실행 — single-use refund 토큰. */
export const guestRefund = (
  orderId: string,
  data: { refund_token: string; reason?: string },
) => api.post<GuestRefundResponse>(`/guests/orders/${orderId}/refund`, data);

/** 게스트 회원승격 실행 — claim 토큰 + 회원 세션(쿠키) 필수. */
export const claimGuestOrder = (
  orderId: string,
  data: { claim_token: string },
) => api.post<GuestClaimResponse>(`/guests/orders/${orderId}/claim`, data);

// ─── Tickets ──────────────────────────────────────────────────────────

export const getMyTickets = (skip = 0, limit = 50) =>
  api.get<TicketListResponse>("/tickets/my", { params: { skip, limit } });

export const getTicket = (ticketId: string) =>
  api.get<TicketDetail>(`/tickets/${ticketId}`);

export const getTicketQr = (ticketId: string) =>
  api.get<TicketQrResponse>(`/tickets/${ticketId}/qr`);

// 현장 입장 QR 검증 (스태프/admin 권한)
export interface ValidateQRResult {
  status: "ok" | "already_used" | "invalid";
  message: string;
  ticket_id?: string | null;
  attendee_name?: string | null;
  event_title?: string | null;
  tier_name?: string | null;
  seat_label?: string | null;
  checked_in_at?: string | null;
}

export const validateTicketQr = (qrPayload: string) =>
  api.post<ValidateQRResult>("/tickets/validate-qr", { qr_payload: qrPayload });

export const bindNfc = (ticketId: string, nfcUid: string) =>
  api
    .post<NfcTicketLookup>(`/tickets/${ticketId}/nfc-bind`, { nfc_uid: nfcUid })
    .then((r) => r.data);

export const lookupByNfc = (nfcUid: string) =>
  api
    .get<NfcTicketLookup>(`/tickets/by-nfc/${encodeURIComponent(nfcUid)}`)
    .then((r) => r.data);

export const getNftByTicket = (ticketId: string) =>
  api.get<NftTicketRecord>(`/tickets/${ticketId}/nft`).then((r) => r.data);

export const generateNft = (ticketId: string) =>
  api
    .post<NftTicketRecord>(`/tickets/${ticketId}/nft/generate`)
    .then((r) => r.data);

export const getEventNfts = (
  eventId: string,
  params?: { skip?: number; limit?: number },
) =>
  api
    .get<EventNftList>(`/events/${eventId}/nfts`, { params })
    .then((r) => r.data);

export const getFacilities = (params?: {
  city?: string;
  type?: string;
  q?: string;
  skip?: number;
  limit?: number;
}) => api.get<FacilityRecord[]>("/facilities", { params }).then((r) => r.data);

export const getFacility = (facilityId: string) =>
  api.get<FacilityRecord>(`/facilities/${facilityId}`).then((r) => r.data);

export const createFacility = (
  data: Omit<
    FacilityRecord,
    "id" | "organizer_id" | "created_at" | "updated_at"
  >,
) => api.post<FacilityRecord>("/facilities", data).then((r) => r.data);

export const updateFacility = (
  facilityId: string,
  data: Partial<
    Omit<FacilityRecord, "id" | "organizer_id" | "created_at" | "updated_at">
  >,
) =>
  api
    .put<FacilityRecord>(`/facilities/${facilityId}`, data)
    .then((r) => r.data);

export const getFacilityEvents = (facilityId: string) =>
  api.get<Event[]>(`/facilities/${facilityId}/events`).then((r) => r.data);

export const getFacilityAvailability = (facilityId: string) =>
  api
    .get<{
      facility_id: string;
      total_events: number;
      next_event_at: string | null;
      busy_dates: string[];
    }>(`/facilities/${facilityId}/availability`)
    .then((r) => r.data);

export const createProxyBooking = (data: {
  actual_user_name: string;
  actual_user_phone: string;
  requested_quantity?: number;
  event_id: string;
  tier_id: string;
}) => api.post<ProxyBookingRecord>("/proxy-bookings", data).then((r) => r.data);

export const getProxyBookings = (bookerId?: string) =>
  api
    .get<ProxyBookingRecord[]>("/proxy-bookings", {
      params: bookerId ? { booker_id: bookerId } : undefined,
    })
    .then((r) => r.data);

export const submitSimpleBooking = (data: {
  actual_user_name: string;
  actual_user_phone: string;
  requested_quantity: number;
  event_id: string;
  tier_id: string;
}) =>
  api
    .post<ProxyBookingRecord>("/public/simple-bookings", data)
    .then((r) => r.data);

export const verifyDiscount = (
  eventId: string,
  data: {
    user_id: string;
    discount_type: string;
    rate?: number;
    order_id?: string;
  },
) =>
  api
    .post<DiscountVerificationResult>(
      `/events/${eventId}/discounts/verify`,
      data,
    )
    .then((r) => r.data);

export const fetchPublicFestivals = (params?: {
  region?: string;
  year?: number;
}) =>
  api
    .get<PublicFestival[]>("/public/festivals", { params })
    .then((r) => r.data);

export const getGovernmentDashboard = () =>
  api.get<GovernmentDashboard>("/government/dashboard").then((r) => r.data);

export const generateReport = (data: {
  organizer_id: string;
  period: "monthly" | "quarterly" | "yearly";
  format: "xlsx" | "pdf";
}) => api.post<GeneratedReport>("/reports/generate", data).then((r) => r.data);

export const downloadReport = (reportId: string) =>
  api
    .get<Blob>(`/reports/${reportId}/download`, { responseType: "blob" })
    .then((r) => r.data);

export const getBenchmarkData = () =>
  api.get<BenchmarkData>("/benchmarking").then((r) => r.data);

// ─── Transfers ─────────────────────────────────────────────────────────

export const initiateTransfer = (data: {
  ticket_id: string;
  to_user_id: string;
  transfer_type?: string;
  price?: number;
}) => api.post("/transfers", data);

export const sendTransferCode = (transferId: string) =>
  api.post(`/transfers/${transferId}/send-code`);

export const verifyTransferCode = (transferId: string, code: string) =>
  api.post(`/transfers/${transferId}/verify`, { code });

export const completeTransfer = (transferId: string) =>
  api.post(`/transfers/${transferId}/complete`);

export const cancelTransfer = (transferId: string) =>
  api.post(`/transfers/${transferId}/cancel`);

// ─── Resale Trading ────────────────────────────────────────────────────────

export interface OrderBookLevel {
  price: number;
  quantity: number;
  total_volume: number;
}

export interface TradeRecord {
  ticket_id: string;
  price: number;
  seller_amount: number;
  platform_fee: number;
  artist_royalty: number;
  transferred_at: string | null;
}

export interface MarketSummary {
  current_price: number | null;
  price_change: number;
  price_change_pct: number;
  day_high: number | null;
  day_low: number | null;
  day_volume: number;
  total_listings: number;
  total_buy_orders: number;
}

export interface PriceCandle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface TradingData {
  summary: MarketSummary;
  ask_levels: OrderBookLevel[];
  bid_levels: OrderBookLevel[];
  recent_trades: TradeRecord[];
  candles: PriceCandle[];
}

export const getTradingData = (eventId: string, tierId: string) =>
  api.get<TradingData>(`/resale/trading/${eventId}/${tierId}`);

export const getPriceCandles = (
  eventId: string,
  tierId: string,
  interval = 1,
  limit = 48,
) =>
  api.get<PriceCandle[]>(`/resale/trading/${eventId}/${tierId}/candles`, {
    params: { interval, limit },
  });

export const createResaleListing = (data: {
  ticket_id: string;
  asking_price: number;
}) => api.post("/resale/listings", data);

export const cancelResaleListing = (id: string) =>
  api.delete(`/resale/listings/${id}`);

export const createResaleBuyOrder = (data: {
  event_id: string;
  tier_id: string;
  max_price: number;
}) => api.post("/resale/buy-orders", data);

export const cancelResaleBuyOrder = (id: string) =>
  api.delete(`/resale/buy-orders/${id}`);

export interface MyResaleListing {
  id: string;
  ticket_id: string;
  event_id?: string;
  event_title?: string;
  tier_id?: string;
  tier_name?: string;
  seller_id: string;
  asking_price: number;
  status: "active" | "sold" | "cancelled" | "expired" | string;
  seller_receives: number;
  platform_fee: number;
  artist_royalty: number;
  created_at: string;
}

export interface MyResaleBuyOrder {
  id: string;
  event_id: string;
  tier_id: string;
  event_title?: string;
  tier_name?: string;
  buyer_id: string;
  max_price: number;
  status: "active" | "matched" | "cancelled" | "expired" | string;
  created_at: string;
}

export const getMyResaleListings = () =>
  api.get<MyResaleListing[]>("/resale/my/listings");

export const getMyResaleBuyOrders = () =>
  api.get<MyResaleBuyOrder[]>("/resale/my/buy-orders");

// ─── Resale Browse (Sell page) ─────────────────────────────────────────────

export interface ResaleListingDetail {
  id: string;
  ticket_id: string;
  seller_id: string;
  asking_price: number;
  status: string;
  seller_receives: number;
  artist_royalty: number;
  created_at: string;
  event_id: string;
  event_title: string;
  event_date: string;
  venue: string;
  category: string;
  image_url: string | null;
  artist_name: string | null;
  original_price: number;
  section: string | null;
  tier_name: string | null;
  seller_name: string;
}

export interface ResaleListingBrowseResponse {
  listings: ResaleListingDetail[];
  total: number;
}

export const browseResaleListings = (params?: {
  category?: string;
  skip?: number;
  limit?: number;
}) => api.get<ResaleListingBrowseResponse>("/resale/browse", { params });

// ─── Resale Event Discovery ─────────────────────────────────────────────────

export interface ResaleTierInfo {
  tier_id: string;
  tier_name: string;
  base_price: number;
  listing_count: number;
  lowest_ask: number | null;
  buy_order_count: number;
}

export interface ResaleEventInfo {
  event_id: string;
  title: string;
  venue: string;
  event_date: string | null;
  category: string;
  sub_category: string | null;
  image_url: string | null;
  thumbnail_url: string | null;
  location_city: string | null;
  artist_name: string | null;
  age_restriction: string | null;
  bid_count: number;
  view_count: number;
  tiers: ResaleTierInfo[];
}

export const getResaleEvents = (category?: string, skip = 0, limit = 20) =>
  api.get<ResaleEventInfo[]>("/resale/events", {
    params: { category, skip, limit },
  });

export interface ResaleFeeInfo {
  platform_fee_rate: number;
  artist_royalty_rate: number;
  seller_premium_rate: number;
  zero_fee_below_face: boolean;
  absolute_price_ceiling: number;
}
export const getResaleFeeInfo = () =>
  api.get<ResaleFeeInfo>("/resale/fee-info");

// ─── Seat Tiers ────────────────────────────────────────────────────────────

export interface SeatTier {
  id: string;
  event_id: string;
  name: string;
  capacity: number;
  base_price: number;
  sale_mode: string;
  face_price: number;
  sold_count: number;
  remaining: number;
  min_price: number;
  max_price_cap: number;
  bidding_opens_at: string | null;
  bidding_closes_at: string | null;
  seating_type?: string;
  section_name?: string | null;
  max_group_size?: number;
  fanclub_discount_pct?: number;
  lottery_application_hours?: number;
  allow_group_tickets?: boolean;
  view_description?: string | null;
  distance_from_stage?: number | null;
  view_rating?: number | null;
  view_image_url?: string | null;
  position_label?: string | null;
}

export interface PurchaseResult {
  success: boolean;
  order_id: string | null;
  ticket_ids: string[];
  sale_mode: string;
  unit_price: number;
  total_price: number;
  waitlist_position: number | null;
  message: string;
}

export const getEventTiers = (eventId: string) =>
  api.get<SeatTier[]>(`/events/${eventId}/tiers`);

export const purchaseTicket = (
  eventId: string,
  tierId: string,
  data: { quantity: number; seat_ids?: string[]; idempotency_key?: string },
) =>
  api.post<PurchaseResult>(`/events/${eventId}/tiers/${tierId}/purchase`, {
    ...data,
    idempotency_key: data.idempotency_key ?? crypto.randomUUID(),
  });

export const purchaseFanclub = (
  eventId: string,
  tierId: string,
  data: { quantity: number; seat_ids?: string[]; idempotency_key?: string },
) =>
  api.post<PurchaseResult>(
    `/events/${eventId}/tiers/${tierId}/purchase/fanclub`,
    {
      ...data,
      idempotency_key: data.idempotency_key ?? crypto.randomUUID(),
    },
  );

// ─── Lottery ────────────────────────────────────────────────────────────

export async function applyLottery(
  eventId: string,
  tierId: string,
  data: {
    group_size: number;
    group_id?: string;
    client_seed?: string;
    invested_ap?: number;
  },
) {
  // 과업 1-3) 계정 복제 차단: 같은 브라우저의 다중 계정 응모를 서버가 셀 수 있게 기기 식별값을 싣는다.
  const fingerprint = getDeviceFingerprint();
  return api.post(
    `/events/${eventId}/tiers/${tierId}/lottery/apply`,
    data,
    fingerprint ? { headers: { [DEVICE_FINGERPRINT_HEADER]: fingerprint } } : undefined,
  );
}

export async function getLotteryStatus(eventId: string, tierId: string) {
  return api.get(`/events/${eventId}/tiers/${tierId}/lottery/status`);
}

export interface MyLotteryEntry {
  pool_id: string;
  tier_id: string;
  tier_name: string;
  result: "pending" | "won" | "waitlisted" | string;
  group_size: number;
  invested_ap: number;
  pool_status: string;
  order_id?: string | null;
  order_status?: string | null;
  payment_deadline?: string | null;
  total_amount?: number | null;
  seats: Array<{
    id: string;
    section: string;
    row: number;
    seat_number: number;
    label: string | null;
  }>;
}

export const getMyLotteryEntries = (eventId: string) =>
  api.get<{ event_id: string; entries: MyLotteryEntry[] }>(
    `/events/${eventId}/lottery/my-entries`,
  );

// ─── Venue & Seat Map ──────────────────────────────────────────────────────

export interface VenueData {
  id: string;
  name: string;
  city: string;
  address: string;
  total_capacity: number;
  map_svg_url: string | null;
  map_width: number;
  map_height: number;
  thumbnail_url: string | null;
  seating_chart_url?: string | null;
  sections: VenueSectionData[];
}

export interface VenueSectionData {
  id: string;
  venue_id: string;
  name: string;
  label: string;
  capacity: number;
  svg_path: string | null;
  center_x: number;
  center_y: number;
  floor: number;
  color: string;
  view_image_url?: string | null;
  /** 피그마 빌더 메타데이터 (go sync). 구버전 응답엔 없을 수 있음. */
  kind?: "assigned" | "standing" | "stage" | "console";
  rotation?: number;
  width?: number | null;
  height?: number | null;
}

export interface SeatData {
  id: string;
  section: string;
  row_number: number;
  seat_number: number;
  is_obstructed: boolean;
  x: number;
  y: number;
  label: string | null;
  status: "available" | "held" | "sold" | "reserved";
  tier_id: string;
  quality_score: number;
}

export interface SeatHoldResult {
  success: boolean;
  held_seat_ids: string[];
  hold_until: string;
  hold_id: string;
}

export interface SessionData {
  event_id: string;
  session_number: number;
  event_date: string;
  bidding_opens_at: string;
  bidding_closes_at: string;
  status: string;
  title: string;
  venue: string;
  location_city: string | null;
  total_seats: number;
  available_seats: number;
}

export const getVenues = () =>
  api.get<
    Array<{
      id: string;
      name: string;
      city: string;
      address: string;
      total_capacity: number;
    }>
  >("/venues/");

export const getVenue = (venueId: string) =>
  api.get<VenueData>(`/venues/${venueId}`);

export const getEventSeats = (
  eventId: string,
  params?: { section?: string; tier_id?: string },
) => api.get<SeatData[]>(`/events/${eventId}/seats`, { params });

export const holdSeats = (
  eventId: string,
  data: { seat_ids: string[]; hold_minutes?: number },
) => api.post<SeatHoldResult>(`/events/${eventId}/seats/hold`, data);

export const releaseHold = (eventId: string, holdId: string) =>
  api.delete(`/events/${eventId}/seats/hold/${holdId}`);

/** 현재 사용자의 해당 이벤트 홀드 전부 해제. 주문 취소 실패 시 fallback 으로 사용. */
export const releaseSeats = (eventId: string) =>
  api.delete<SeatHoldResult>(`/events/${eventId}/seats/hold`);

export const getBestAvailable = (
  eventId: string,
  params: { tier_id: string; quantity: number },
) => api.get<SeatData[]>(`/events/${eventId}/seats/best-available`, { params });

export const getEventSessions = (eventId: string) =>
  api.get<SessionData[]>(`/events/${eventId}/sessions`);

export const generateTimeSlots = (
  eventId: string,
  body: {
    start_hour: number;
    end_hour: number;
    interval_minutes?: number;
    capacity_per_slot?: number;
  },
) => api.post<Event[]>(`/events/${eventId}/sessions/generate-slots`, body);

// ─── Queue (대기열) ─────────────────────────────────────────────────────────

export interface QueueJoinResponse {
  position: number;
  total_waiting: number;
  is_active: boolean;
  estimated_wait_seconds: number;
  token: string | null;
  message: string;
}

export interface QueueStatusResponse {
  position: number;
  total_waiting: number;
  is_active: boolean;
  estimated_wait_seconds: number;
  token: string | null;
}

export interface QueueLeaveResponse {
  success: boolean;
  message: string;
}

export interface QueueStatsResponse {
  total_waiting: number;
  active_count: number;
  max_active: number;
}

export const joinQueue = (eventId: string) =>
  api.post<QueueJoinResponse>(`/events/${eventId}/queue/join`);

export const getQueueStatus = (eventId: string) =>
  api.get<QueueStatusResponse>(`/events/${eventId}/queue/status`);

export const leaveQueue = (eventId: string) =>
  api.post<QueueLeaveResponse>(`/events/${eventId}/queue/leave`);

export const getQueueStats = (eventId: string) =>
  api.get<QueueStatsResponse>(`/events/${eventId}/queue/stats`);

// ─── Waitlist (정가 대기열) ──────────────────────────────────────────────────

export interface WaitlistEntryResponse {
  id: string;
  tier_id: string;
  user_id: string;
  position: number;
  priority_score: number;
  status: "waiting" | "offered" | "accepted" | "expired" | "removed";
  entered_at: string;
}

export interface WaitlistStatusResponse {
  total_waiting: number;
  my_position: number | null;
  my_entry: WaitlistEntryResponse | null;
}

export const joinWaitlist = (eventId: string, tierId: string, quantity = 1) =>
  api.post<WaitlistEntryResponse>(
    `/events/${eventId}/tiers/${tierId}/waitlist`,
    { quantity },
  );

export const getWaitlistStatus = (eventId: string, tierId: string) =>
  api.get<WaitlistStatusResponse>(
    `/events/${eventId}/tiers/${tierId}/waitlist/status`,
  );

export const leaveWaitlist = (eventId: string, tierId: string) =>
  api.delete(`/events/${eventId}/tiers/${tierId}/waitlist`);

// ─── Check-in ──────────────────────────────────────────────────────────────

export interface CheckInResponse {
  attendance_id: string;
  ticket_id: string;
  user_id: string;
  event_id: string;
  checked_in_at: string;
  method: string;
  deposit_refunded: boolean;
}

export interface AttendanceStats {
  event_id: string;
  total_tickets: number;
  checked_in: number;
  not_checked_in: number;
  attendance_rate: number;
  hourly_breakdown: { hour: string; count: number }[];
}

export interface PublicReport {
  event_id: string;
  title: string;
  event_date: string;
  total_seats: number;
  total_tickets_issued: number;
  checked_in: number;
  attendance_rate: number;
  no_show_count: number;
  lottery: {
    total_applicants: number;
    total_seats: number;
    competition_ratio: number;
    seed_used: number | null;
  } | null;
  is_free: boolean;
  deposit_amount: number;
  bot_blocked_count: number;
  avg_bookings_per_user: number;
  review_avg_rating: number;
  simple_mode_usage_rate: number;
  proxy_booking_rate: number;
  discount_stats: {
    configured_policy_count: number;
    active_discount_count: number;
  };
}

export const checkIn = (
  eventId: string,
  data: { qr_data?: string; ticket_id?: string; method?: string },
) => api.post<CheckInResponse>(`/events/${eventId}/checkin`, data);

export const getPublicEvents = (params?: {
  category?: string;
  city?: string;
  skip?: number;
  limit?: number;
}) => api.get<Event[]>("/public-events", { params });

export const getPublicReport = (eventId: string) =>
  api.get<PublicReport>(`/events/${eventId}/public-report`);

// ─── Point API ────────────────────────────────────────────────────────────

export interface PointBalance {
  fan: number;
  social: number;
}

/** Sum of fan + social points */
export function getTotalPoints(balance: PointBalance): number {
  return balance.fan + balance.social;
}

export interface PointTransaction {
  id: string;
  tx_type: string;
  amount: number;
  balance_after: number;
  reference_id: string | null;
  description: string | null;
  created_at: string;
}

export interface PointHistoryResponse {
  transactions: PointTransaction[];
  total: number;
}

export const getPointBalance = () => api.get<PointBalance>("/points/balance");

export const getPointHistory = (pointType?: string, limit = 20, offset = 0) => {
  const params = new URLSearchParams();
  if (pointType) params.set("point_type", pointType);
  params.set("limit", String(limit));
  params.set("offset", String(offset));
  return api.get<PointHistoryResponse>(`/points/history?${params}`);
};

// ── Fanclub API ──
export const getFanclubs = (params?: { skip?: number; limit?: number }) =>
  api.get("/fanclubs/", { params }).then((r) => r.data);

export const getFanclub = (id: string) =>
  api.get(`/fanclubs/${id}`).then((r) => r.data);

export const createFanclub = (data: {
  name: string;
  artist_name: string;
  description?: string;
  logo_url?: string;
  max_members?: number;
  is_official?: boolean;
  domain?: string;
}) => api.post("/fanclubs/", data).then((r) => r.data);

export const joinFanclub = (
  id: string,
  data: { membership_code: string; tier?: string },
) => api.post(`/fanclubs/${id}/join`, data).then((r) => r.data);

export const getFanclubMembers = (
  id: string,
  params?: {
    status?: string;
    tier?: string;
    search?: string;
    page?: number;
    page_size?: number;
  },
) => api.get(`/fanclubs/${id}/members`, { params }).then((r) => r.data);

export const bulkImportMembers = (
  id: string,
  data: {
    entries: Array<{ email: string; membership_code?: string; tier?: string }>;
  },
) => api.post(`/fanclubs/${id}/bulk-import`, data).then((r) => r.data);

export const removeFanclubMember = (fanclubId: string, userId: string) =>
  api.delete(`/fanclubs/${fanclubId}/members/${userId}`).then((r) => r.data);

export const getMyFanclubs = () =>
  api.get("/users/me/fanclubs").then((r) => r.data);

// ── Group API ──
export const createGroup = (data: {
  event_id: string;
  tier_id: string;
  require_adjacent?: boolean;
}) => api.post("/groups/", data).then((r) => r.data);

export const getGroup = (id: string) =>
  api.get(`/groups/${id}`).then((r) => r.data);

export const joinGroup = (code: string) =>
  api.post(`/groups/join/${code}`).then((r) => r.data);

export const leaveGroup = (groupId: string) =>
  api.delete(`/groups/${groupId}/members/me`).then((r) => r.data);

export const getMyGroups = () =>
  api.get("/groups/my/active").then((r) => r.data);

// ── Admin API ──

export interface PlatformKPI {
  total_users: number;
  total_organizers: number;
  total_events: number;
  active_events: number;
  total_communities: number;
  total_tickets: number;
  new_users_7d: number;
  new_events_7d: number;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  is_organizer: boolean;
  is_admin: boolean;
  is_active: boolean;
  is_verified: boolean;
  verification_level: number;
  abuse_score: number;
  admin_role?: string | null;
  created_at: string;
}

export interface AdminEvent {
  id: string;
  title: string;
  organizer_id: string;
  category: string;
  status: string;
  total_seats: number;
  bid_count: number;
  is_featured: boolean;
  event_date: string;
  created_at: string;
  currency?: string;
  event_timezone?: string;
}

export interface AdminCommunity {
  id: string;
  name: string;
  artist_name: string;
  subject_name: string | null;
  community_type: string;
  domain: string | null;
  organizer_id: string;
  member_count: number;
  is_official: boolean;
  is_active: boolean;
  created_at: string;
}

export interface AuditEntry {
  id: string;
  event_id: string;
  action: string;
  user_id: string | null;
  admin_id: string | null;
  result: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

export const getAdminKPI = () =>
  api.get<PlatformKPI>("/admin/kpi").then((r) => r.data);

export const getAdminUsers = (params?: {
  q?: string;
  is_organizer?: boolean;
  is_active?: boolean;
  skip?: number;
  limit?: number;
}) =>
  api
    .get<{ users: AdminUser[]; total: number }>("/admin/users", { params })
    .then((r) => r.data);

export const getAdminUserById = (userId: string) =>
  api.get<AdminUser>(`/admin/users/${userId}`).then((r) => r.data);

export const updateUserRoles = (
  userId: string,
  data: { is_organizer?: boolean; is_admin?: boolean },
) => api.patch(`/admin/users/${userId}/roles`, data).then((r) => r.data);

export const banUser = (userId: string, reason = "") =>
  api.post(`/admin/users/${userId}/ban`, { reason }).then((r) => r.data);

export const unbanUser = (userId: string) =>
  api.post(`/admin/users/${userId}/unban`).then((r) => r.data);

export const getAdminEvents = (params?: {
  status?: string;
  category?: string;
  q?: string;
  skip?: number;
  limit?: number;
}) =>
  api
    .get<{ events: AdminEvent[]; total: number }>("/admin/events", { params })
    .then((r) => r.data);

export const toggleEventFeatured = (eventId: string) =>
  api.post(`/admin/events/${eventId}/feature`).then((r) => r.data);

export const adminCancelEvent = (eventId: string) =>
  api.post(`/admin/events/${eventId}/cancel`).then((r) => r.data);

export const getAdminCommunities = (params?: {
  is_official?: boolean;
  q?: string;
  community_type?: string;
  skip?: number;
  limit?: number;
}) =>
  api
    .get<{
      communities: AdminCommunity[];
      total: number;
    }>("/admin/communities", { params })
    .then((r) => r.data);

export const toggleCommunityOfficial = (communityId: string) =>
  api.post(`/admin/communities/${communityId}/official`).then((r) => r.data);

export const getAdminAuditLog = (params?: {
  event_id?: string;
  action?: string;
  date_from?: string;
  date_to?: string;
  skip?: number;
  limit?: number;
}) =>
  api
    .get<{ entries: AuditEntry[]; total: number }>("/admin/audit", { params })
    .then((r) => r.data);

export const getDomainConfig = (category: string) =>
  api.get(`/admin/domain-config/${category}`).then((r) => r.data);

export const setDomainConfig = (domain: string, key: string, value: string) =>
  api
    .put(`/admin/domain-config/${domain}/${key}`, { value })
    .then((r) => r.data);

// ─── Organizer Portal Types ─────────────────────────────────────────────────

export interface OrganizerProfile {
  id: string;
  user_id: string;
  company_name: string;
  business_number: string;
  representative_name: string;
  address?: string | null;
  contact_phone: string;
  contact_email: string;
  primary_domains?: string | null;
  status: string;
  approved_at?: string | null;
  rejection_reason?: string | null;
  created_at: string;
}

export interface OrganizerOnboardingStatus {
  profile: OrganizerProfile | null;
}

export interface OrganizerRequest {
  id: string;
  organizer_id: string;
  event_id?: string | null;
  request_type: string;
  status: string;
  title: string;
  content?: string | null;
  attachments?: string | null;
  reviewer_id?: string | null;
  reviewer_comment?: string | null;
  submitted_at?: string | null;
  reviewed_at?: string | null;
  extra_data?: string | null;
  created_at: string;
  updated_at: string;
}

export interface OpenNotice {
  id: string;
  event_id: string;
  organizer_id: string;
  category?: string | null;
  notice_type: string;
  publish_at: string;
  open_at: string;
  event_info?: string | null;
  discount_info?: string | null;
  description?: string | null;
  participant_info?: string | null;
  notice_image_url?: string | null;
  video_url?: string | null;
  region?: string | null;
  status: string;
  created_at: string;
}

export interface ParticipantSlot {
  id: string;
  event_id: string;
  slot_name: string;
  sort_order: number;
  created_at: string;
}

export interface ParticipantAssignment {
  id: string;
  slot_id: string;
  session_date: string;
  participant_name: string;
  participant_image_url?: string | null;
  duration_minutes?: number | null;
  created_at: string;
}

export interface Discount {
  id: string;
  event_id: string;
  discount_type: string;
  name: string;
  description?: string | null;
  rate?: number | null;
  amount?: number | null;
  conditions?: string | null;
  is_active: boolean;
  created_at: string;
}

export interface FinalCall {
  id: string;
  event_id: string;
  organizer_id: string;
  discount_price: number;
  sale_opens_at: string;
  session_ids?: string | null;
  status: string;
  created_at: string;
}

export interface Promotion {
  id: string;
  event_id: string;
  organizer_id: string;
  promotion_type: string;
  title: string;
  content?: string | null;
  start_date: string;
  end_date: string;
  prizes?: string | null;
  status: string;
  created_at: string;
}

export interface BridgePage {
  id: string;
  organizer_id: string;
  title: string;
  slug: string;
  content?: string | null;
  event_ids: string;
  images?: string | null;
  is_active: boolean;
  created_at: string;
}

export interface PartnershipRequest {
  id: string;
  event_id: string;
  organizer_id: string;
  partner_type: string;
  partner_ids?: string | null;
  discount_info?: string | null;
  status: string;
  created_at: string;
}

export interface PackageProduct {
  id: string;
  organizer_id: string;
  name: string;
  sub_title?: string | null;
  category: string;
  desired_open_date?: string | null;
  status: string;
  items: PackageItem[];
  created_at: string;
}

export interface PackageItem {
  id: string;
  package_id: string;
  event_id: string;
  seat_tier?: string | null;
  regular_price: number;
  discount_price: number;
}

export interface TicketIssuance {
  id: string;
  event_id: string;
  organizer_id: string;
  issue_type: string;
  seat_info?: string | null;
  ticket_display_info?: string | null;
  quantity: number;
  delivery_method: string;
  recipient_name?: string | null;
  recipient_phone?: string | null;
  delivery_address?: string | null;
  attachments?: string | null;
  status: string;
  created_at: string;
}

// ─── Organizer Onboarding ───────────────────────────────────────────────────

export const submitOnboarding = (data: {
  company_name: string;
  business_number: string;
  representative_name: string;
  address?: string;
  contact_phone: string;
  contact_email: string;
  primary_domains: string[];
}) => api.post<OrganizerProfile>("/organizer/onboarding", data);

export const getOnboardingStatus = () =>
  api
    .get<OrganizerOnboardingStatus>("/organizer/onboarding/status")
    .then((r) => r.data);

export const registerGovernmentOrganizer = (data: {
  org_type: string;
  org_code: string;
  org_name: string;
  region: string;
  description: string;
  contacts: Array<{
    name: string;
    position: string;
    email: string;
    phone: string;
  }>;
  facilities: string[];
}) =>
  api
    .post<OrganizerProfile>("/organizers/government", data)
    .then((r) => r.data);

// ─── Organizer Requests ─────────────────────────────────────────────────────

export const createOrganizerRequest = (data: {
  event_id?: string;
  request_type: string;
  title: string;
  content?: string;
  attachments?: string;
  extra_data?: string;
}) =>
  api.post<OrganizerRequest>("/organizer/requests", data).then((r) => r.data);

export const getOrganizerRequests = (params?: {
  request_type?: string;
  status?: string;
  skip?: number;
  limit?: number;
}) =>
  api
    .get<{
      requests: OrganizerRequest[];
      total: number;
    }>("/organizer/requests", { params })
    .then((r) => r.data);

export const getOrganizerRequest = (id: string) =>
  api.get<OrganizerRequest>(`/organizer/requests/${id}`).then((r) => r.data);

export const updateOrganizerRequest = (
  id: string,
  data: {
    title?: string;
    content?: string;
    attachments?: string;
    extra_data?: string;
  },
) =>
  api
    .patch<OrganizerRequest>(`/organizer/requests/${id}`, data)
    .then((r) => r.data);

export const submitOrganizerRequest = (id: string) =>
  api
    .post<OrganizerRequest>(`/organizer/requests/${id}/submit`)
    .then((r) => r.data);

export const getRequestSummary = () =>
  api
    .get<Record<string, Record<string, number>>>("/organizer/requests/summary")
    .then((r) => r.data);

// ─── Open Notices ───────────────────────────────────────────────────────────

export const createOpenNotice = (data: {
  event_id: string;
  notice_type?: string;
  publish_at: string;
  open_at: string;
  event_info?: string;
  discount_info?: string;
  description?: string;
  participant_info?: string;
  notice_image_url?: string;
  video_url?: string;
  region?: string;
}) => api.post<OpenNotice>("/open-notices/", data).then((r) => r.data);

export const getOpenNotices = (params?: { skip?: number; limit?: number }) =>
  api.get<OpenNotice[]>("/open-notices/", { params }).then((r) => r.data);

export const getOpenNotice = (id: string) =>
  api.get<OpenNotice>(`/open-notices/${id}`).then((r) => r.data);

export const updateOpenNotice = (id: string, data: Record<string, unknown>) =>
  api.patch<OpenNotice>(`/open-notices/${id}`, data).then((r) => r.data);

export const deleteOpenNotice = (id: string) =>
  api.delete(`/open-notices/${id}`).then((r) => r.data);

export const getPublicOpenNotices = (params?: {
  category?: string;
  skip?: number;
  limit?: number;
}) =>
  api.get<OpenNotice[]>("/open-notices/public", { params }).then((r) => r.data);

// ─── Participants ───────────────────────────────────────────────────────────

export const createParticipantSlot = (
  eventId: string,
  data: { slot_name: string; sort_order?: number },
) =>
  api
    .post<ParticipantSlot>(`/events/${eventId}/participants/slots`, data)
    .then((r) => r.data);

export const getParticipantSlots = (eventId: string) =>
  api
    .get<ParticipantSlot[]>(`/events/${eventId}/participants/slots`)
    .then((r) => r.data);

export const updateParticipantSlot = (
  eventId: string,
  slotId: string,
  data: { slot_name?: string; sort_order?: number },
) =>
  api
    .patch<ParticipantSlot>(
      `/events/${eventId}/participants/slots/${slotId}`,
      data,
    )
    .then((r) => r.data);

export const deleteParticipantSlot = (eventId: string, slotId: string) =>
  api
    .delete(`/events/${eventId}/participants/slots/${slotId}`)
    .then((r) => r.data);

export const createParticipantAssignment = (
  eventId: string,
  data: {
    slot_id: string;
    session_date: string;
    participant_name: string;
    participant_image_url?: string;
    duration_minutes?: number | null;
  },
) =>
  api
    .post<ParticipantAssignment>(
      `/events/${eventId}/participants/assignments`,
      data,
    )
    .then((r) => r.data);

export const getParticipantAssignments = (
  eventId: string,
  params?: { slot_id?: string },
) =>
  api
    .get<
      ParticipantAssignment[]
    >(`/events/${eventId}/participants/assignments`, { params })
    .then((r) => r.data);

export const deleteParticipantAssignment = (
  eventId: string,
  assignmentId: string,
) =>
  api
    .delete(`/events/${eventId}/participants/assignments/${assignmentId}`)
    .then((r) => r.data);

// ─── Discounts ──────────────────────────────────────────────────────────────

export const createDiscount = (
  eventId: string,
  data: {
    discount_type: string;
    name: string;
    description?: string;
    rate?: number;
    amount?: number;
    conditions?: string;
    is_active?: boolean;
  },
) =>
  api.post<Discount>(`/events/${eventId}/discounts`, data).then((r) => r.data);

export const getDiscounts = (eventId: string) =>
  api.get<Discount[]>(`/events/${eventId}/discounts`).then((r) => r.data);

export const toggleDiscount = (
  eventId: string,
  discountId: string,
  isActive: boolean,
) =>
  api
    .patch<Discount>(`/events/${eventId}/discounts/${discountId}`, null, {
      params: { is_active: isActive },
    })
    .then((r) => r.data);

export const deleteDiscount = (eventId: string, discountId: string) =>
  api.delete(`/events/${eventId}/discounts/${discountId}`).then((r) => r.data);

// ─── Final Calls ────────────────────────────────────────────────────────────

export const createFinalCall = (data: {
  event_id: string;
  discount_price: number;
  sale_opens_at: string;
  session_ids?: string;
}) => api.post<FinalCall>("/organizer/final-calls", data).then((r) => r.data);

export const getFinalCalls = (params?: { skip?: number; limit?: number }) =>
  api
    .get<FinalCall[]>("/organizer/final-calls", { params })
    .then((r) => r.data);

export const updateFinalCall = (id: string, data: Record<string, unknown>) =>
  api
    .patch<FinalCall>(`/organizer/final-calls/${id}`, data)
    .then((r) => r.data);

export const deleteFinalCall = (id: string) =>
  api.delete(`/organizer/final-calls/${id}`).then((r) => r.data);

export const getPublicFinalCalls = (params?: {
  skip?: number;
  limit?: number;
}) =>
  api
    .get<FinalCall[]>("/organizer/final-calls/public", { params })
    .then((r) => r.data);

// ─── Packages ───────────────────────────────────────────────────────────────

export const createPackage = (data: {
  name: string;
  sub_title?: string;
  category: string;
  desired_open_date?: string;
  items: {
    event_id: string;
    seat_tier?: string;
    regular_price: number;
    discount_price: number;
  }[];
}) => api.post<PackageProduct>("/organizer/packages", data).then((r) => r.data);

export const getPackages = (params?: { skip?: number; limit?: number }) =>
  api
    .get<PackageProduct[]>("/organizer/packages", { params })
    .then((r) => r.data);

export const getPackage = (id: string) =>
  api.get<PackageProduct>(`/organizer/packages/${id}`).then((r) => r.data);

export const deletePackage = (id: string) =>
  api.delete(`/organizer/packages/${id}`).then((r) => r.data);

// ─── Ticket Issuance ────────────────────────────────────────────────────────

export const createTicketIssuance = (data: {
  event_id: string;
  issue_type: string;
  seat_info?: string;
  ticket_display_info?: string;
  quantity: number;
  delivery_method: string;
  recipient_name?: string;
  recipient_phone?: string;
  delivery_address?: string;
  attachments?: string;
}) =>
  api
    .post<TicketIssuance>("/organizer/ticket-issuance", data)
    .then((r) => r.data);

export const getTicketIssuances = (params?: {
  skip?: number;
  limit?: number;
}) =>
  api
    .get<TicketIssuance[]>("/organizer/ticket-issuance", { params })
    .then((r) => r.data);

export const getTicketIssuance = (id: string) =>
  api
    .get<TicketIssuance>(`/organizer/ticket-issuance/${id}`)
    .then((r) => r.data);

// ─── Promotions ─────────────────────────────────────────────────────────────

export const createPromotion = (data: {
  event_id: string;
  promotion_type: string;
  title: string;
  content?: string;
  start_date: string;
  end_date: string;
  prizes?: string;
}) => api.post<Promotion>("/organizer/promotions", data).then((r) => r.data);

export const getPromotions = (params?: { skip?: number; limit?: number }) =>
  api.get<Promotion[]>("/organizer/promotions", { params }).then((r) => r.data);

export const updatePromotion = (id: string, data: Record<string, unknown>) =>
  api.patch<Promotion>(`/organizer/promotions/${id}`, data).then((r) => r.data);

export const deletePromotion = (id: string) =>
  api.delete(`/organizer/promotions/${id}`).then((r) => r.data);

// ─── Bridge Pages ───────────────────────────────────────────────────────────

export const createBridgePage = (data: {
  title: string;
  slug: string;
  content?: string;
  event_ids: string;
  images?: string;
}) => api.post<BridgePage>("/organizer/bridge-pages", data).then((r) => r.data);

export const getBridgePages = (params?: { skip?: number; limit?: number }) =>
  api
    .get<BridgePage[]>("/organizer/bridge-pages", { params })
    .then((r) => r.data);

export const updateBridgePage = (id: string, data: Record<string, unknown>) =>
  api
    .patch<BridgePage>(`/organizer/bridge-pages/${id}`, data)
    .then((r) => r.data);

export const deleteBridgePage = (id: string) =>
  api.delete(`/organizer/bridge-pages/${id}`).then((r) => r.data);

// ─── Partnerships ───────────────────────────────────────────────────────────

export const createPartnership = (data: {
  event_id: string;
  partner_type: string;
  partner_ids?: string;
  discount_info?: string;
}) =>
  api
    .post<PartnershipRequest>("/organizer/partnerships", data)
    .then((r) => r.data);

export const getPartnerships = (params?: { skip?: number; limit?: number }) =>
  api
    .get<PartnershipRequest[]>("/organizer/partnerships", { params })
    .then((r) => r.data);

// ─── Organizer Community ────────────────────────────────────────────────────

export const getOrganizerReviews = (
  eventId: string,
  params?: { review_type?: string; skip?: number; limit?: number },
) =>
  api
    .get(`/organizer/events/${eventId}/reviews`, { params })
    .then((r) => r.data);

export const toggleBestReview = (eventId: string, reviewId: string) =>
  api
    .post(`/organizer/events/${eventId}/reviews/${reviewId}/best`)
    .then((r) => r.data);

export const requestReviewDeletion = (
  eventId: string,
  reviewId: string,
  reason = "other",
) =>
  api
    .post(
      `/organizer/events/${eventId}/reviews/${reviewId}/delete-request`,
      null,
      { params: { reason } },
    )
    .then((r) => r.data);

export const answerQna = (eventId: string, qnaId: string, answer: string) =>
  api
    .post(`/organizer/events/${eventId}/qna/${qnaId}/answer`, null, {
      params: { answer },
    })
    .then((r) => r.data);

// ─── Event Review Workflow ──────────────────────────────────────────────────

export const submitEventForReview = (eventId: string) =>
  api.post(`/events/${eventId}/submit-review`).then((r) => r.data);

export const adminReviewEvent = (
  eventId: string,
  action: string,
  comment?: string,
) =>
  api
    .patch(`/events/${eventId}/admin-review`, null, {
      params: { action, comment },
    })
    .then((r) => r.data);

// ─── Admin Organizer Profiles ───────────────────────────────────────────────

export const getOrganizerProfiles = (params?: {
  status?: string;
  skip?: number;
  limit?: number;
}) =>
  api
    .get<OrganizerProfile[]>("/admin/organizer-profiles", { params })
    .then((r) => r.data);

export const approveOrganizerProfile = (
  profileId: string,
  approved: boolean,
  reason?: string,
) =>
  api
    .patch(`/admin/organizer-profiles/${profileId}`, {
      approved,
      rejection_reason: reason,
    })
    .then((r) => r.data);

// ─── Admin CS: User Orders & Tickets ────────────────────────────────────────

export interface AdminOrderItem {
  id: string;
  user_id: string;
  user_email?: string;
  user_name?: string;
  event_id: string;
  event_title?: string;
  order_type: string;
  status: string;
  quantity: number;
  total_amount: number;
  payment_id?: string;
  pg_transaction_id?: string;
  created_at: string;
}

export interface AdminTicketItem {
  id: string;
  event_id: string;
  event_title?: string;
  tier_id: string;
  status: string;
  purchase_price: number;
  sale_mode: string;
  created_at: string;
}

export const getAdminUserOrders = (
  userId: string,
  params?: { skip?: number; limit?: number },
) =>
  api
    .get<{
      orders: AdminOrderItem[];
      total: number;
    }>(`/admin/users/${userId}/orders`, { params })
    .then((r) => r.data);

export const getAdminUserTickets = (
  userId: string,
  params?: { skip?: number; limit?: number },
) =>
  api
    .get<{
      tickets: AdminTicketItem[];
      total: number;
    }>(`/admin/users/${userId}/tickets`, { params })
    .then((r) => r.data);

// ─── Admin Orders ───────────────────────────────────────────────────────────

export const getAdminOrders = (params?: {
  q?: string;
  status?: string;
  event_id?: string;
  date_from?: string;
  date_to?: string;
  skip?: number;
  limit?: number;
}) =>
  api
    .get<{
      orders: AdminOrderItem[];
      total: number;
    }>("/admin/orders", { params })
    .then((r) => r.data);

// 관리자 단건 환불 — 유저전용 `/orders/{id}/refund` 는 소유자/주최자만 통과하여
// admin(is_admin) 은 403 을 받는다(P2-C6). admin-scoped 일괄 환불 엔드포인트를
// 단건 리스트로 호출하고, 실패 건이 있으면 throw 해 호출부 catch 가 동작하게 한다.
export const adminRefundOrder = (orderId: string, reason = "") =>
  api
    .post<BulkResult>("/admin/bulk/orders/refund", { ids: [orderId], reason })
    .then((r) => {
      if (r.data && r.data.failed_count > 0) {
        throw new Error(r.data.detail || "환불 처리에 실패했습니다.");
      }
      return r.data;
    });

// ─── Admin Bulk Operations ──────────────────────────────────────────────────

export interface BulkResult {
  success_count: number;
  failed_count: number;
  detail: string;
}

export const bulkBanUsers = (ids: string[], reason = "") =>
  api
    .post<BulkResult>("/admin/bulk/users/ban", { ids, reason })
    .then((r) => r.data);

export const bulkUnbanUsers = (ids: string[]) =>
  api.post<BulkResult>("/admin/bulk/users/unban", { ids }).then((r) => r.data);

export const bulkCancelEvents = (ids: string[], reason = "") =>
  api
    .post<BulkResult>("/admin/bulk/events/cancel", { ids, reason })
    .then((r) => r.data);

export const bulkFeatureEvents = (ids: string[], featured: boolean) =>
  api
    .post<BulkResult>("/admin/bulk/events/feature", { ids, featured })
    .then((r) => r.data);

export const bulkReviewEvents = (ids: string[], action: string, comment = "") =>
  api
    .post<BulkResult>("/admin/bulk/events/review", { ids, action, comment })
    .then((r) => r.data);

export const bulkRefundOrders = (ids: string[], reason = "") =>
  api
    .post<BulkResult>("/admin/bulk/orders/refund", { ids, reason })
    .then((r) => r.data);

export const bulkApproveOrganizers = (ids: string[]) =>
  api
    .post<BulkResult>("/admin/bulk/organizers/approve", { ids })
    .then((r) => r.data);

export const bulkRejectOrganizers = (ids: string[], reason = "") =>
  api
    .post<BulkResult>("/admin/bulk/organizers/reject", { ids, reason })
    .then((r) => r.data);

// ─── Admin Finance ──────────────────────────────────────────────────────────

export interface FinanceSummary {
  gross_revenue: number;
  platform_fees: number;
  pg_fees?: number;
  total_refunds: number;
  net_settlement: number;
  order_count: number;
  refund_count: number;
  daily_revenue?: { date: string; amount: number }[];
}

export interface FinanceByEventItem {
  event_id: string;
  event_title: string;
  category: string;
  organizer_id: string;
  gross_revenue: number;
  platform_fee: number;
  pg_fee?: number;
  refund_total: number;
  net_settlement: number;
  ticket_count: number;
}

export interface FinanceByOrganizerItem {
  organizer_id: string;
  organizer_name: string;
  organizer_email: string;
  event_count: number;
  gross_revenue: number;
  platform_fee: number;
  pg_fee?: number;
  net_settlement: number;
}

export const getFinanceSummary = (params?: {
  date_from?: string;
  date_to?: string;
  period?: string;
}) =>
  api
    .get<FinanceSummary>("/admin/finance/summary", { params })
    .then((r) => r.data);

export const getFinanceByEvent = (params?: {
  date_from?: string;
  date_to?: string;
  skip?: number;
  limit?: number;
}) =>
  api
    .get<{
      events: FinanceByEventItem[];
      total: number;
    }>("/admin/finance/by-event", { params })
    .then((r) => r.data);

export const getFinanceByOrganizer = (params?: {
  date_from?: string;
  date_to?: string;
  skip?: number;
  limit?: number;
}) =>
  api
    .get<{
      organizers: FinanceByOrganizerItem[];
      total: number;
    }>("/admin/finance/by-organizer", { params })
    .then((r) => r.data);

// ─── Admin Notifications ────────────────────────────────────────────────────

export const adminSendNotification = (data: {
  user_ids: string[];
  title: string;
  message: string;
  notification_type?: string;
}) => api.post("/admin/notifications/send", data).then((r) => r.data);

export const adminBroadcastNotification = (data: {
  target: string;
  title: string;
  message: string;
}) => api.post("/admin/notifications/broadcast", data).then((r) => r.data);

export interface AdminNotificationHistoryItem {
  id: string;
  sender_id: string;
  target: string;
  title: string;
  message: string;
  recipient_count: number;
  created_at: string;
}

export const getAdminNotificationHistory = (params?: {
  skip?: number;
  limit?: number;
}) =>
  api
    .get<{
      notifications: AdminNotificationHistoryItem[];
      total: number;
    }>("/admin/notifications/history", { params })
    .then((r) => r.data);

// ─── Admin System Health ────────────────────────────────────────────────────

export interface SystemHealth {
  status: string;
  database: { connected: boolean; latency_ms: number };
  redis: { connected: boolean; latency_ms: number };
  celery: { workers: number; active_tasks: number };
  uptime_seconds: number;
  error_count_24h: number;
}

export const getSystemHealth = () =>
  api.get<SystemHealth>("/admin/system/health").then((r) => r.data);

// ─── Admin RBAC ─────────────────────────────────────────────────────────────

export const updateAdminRole = (userId: string, adminRole: string | null) =>
  api
    .put(`/admin/users/${userId}/role`, { admin_role: adminRole })
    .then((r) => r.data);

// ─── Admin Domain Config ────────────────────────────────────────────────────

export const getAdminDomainConfig = (domain: string) =>
  api.get(`/admin/domain-config/${domain}`).then((r) => r.data);

export const setAdminDomainConfig = (
  domain: string,
  key: string,
  value: unknown,
) =>
  api
    .put(`/admin/domain-config/${domain}/${key}`, { value })
    .then((r) => r.data);

// ─── Exchange Rates ────────────────────────────────────────────────────────

export const getExchangeRate = (from: string, to: string) =>
  api
    .get<{
      from: string;
      to: string;
      rate: number;
    }>(`/exchange-rates/${from}/${to}`)
    .then((r) => r.data);

// ─── Partner API ───────────────────────────────────────────────────────────

export interface PartnerInfo {
  id: string;
  name: string;
  api_key: string;
  tier: string;
  rate_limit: number;
  is_active: boolean;
  created_at: string;
}

export const getAdminPartners = () =>
  api.get<PartnerInfo[]>("/admin/partners").then((r) => r.data);

export const registerPartner = (data: {
  name: string;
  contact_email?: string;
  webhook_url?: string;
}) => api.post<PartnerInfo>("/admin/partners", data).then((r) => r.data);

// ─── File uploads ───────────────────────────────────────────────────────────

export interface PresignedUrlResponse {
  upload_url: string;
  key: string;
  method: string;
  headers: Record<string, string>;
  public_url: string;
  asset_id?: string;
}

export async function getPresignedUrl(
  uploadType: string,
  filename: string,
  contentType: string,
) {
  const res = await api.post<PresignedUrlResponse>("/uploads/presigned-url", {
    upload_type: uploadType,
    filename,
    content_type: contentType,
  });
  return res.data;
}

// ─── Batch presigned URLs ───────────────────────────────────────────────────

export interface BatchPresignedUrlRequest {
  upload_type: string;
  filename: string;
  content_type: string;
}

export interface BatchPresignedUrlResponse {
  items: (PresignedUrlResponse & { asset_id: string })[];
}

export async function getBatchPresignedUrls(items: BatchPresignedUrlRequest[]) {
  const res = await api.post<BatchPresignedUrlResponse>(
    "/uploads/presigned-urls",
    { items },
  );
  return res.data;
}

// ─── Upload complete callback ───────────────────────────────────────────────

export interface UploadCompleteRequest {
  asset_id: string;
  key: string;
}

export interface UploadCompleteResponse {
  status: string;
  asset_id: string;
  public_url: string;
}

export async function uploadComplete(data: UploadCompleteRequest) {
  const res = await api.post<UploadCompleteResponse>("/uploads/complete", data);
  return res.data;
}

// ─── Delete image ───────────────────────────────────────────────────────────

export async function deleteImage(assetId: string) {
  const res = await api.delete(`/uploads/${assetId}`);
  return res.data;
}

// ─── List my images ─────────────────────────────────────────────────────────

export interface MyImagesResponse {
  items: {
    id: string;
    original_url: string;
    variants: Record<
      string,
      { url: string; width: number; height: number; size: number }
    > | null;
    blurhash: string | null;
    upload_type: string;
    processing_status: string;
    created_at: string;
  }[];
  total: number;
}

export async function listMyImages(uploadType?: string, page = 1, size = 20) {
  const params = new URLSearchParams({
    page: String(page),
    size: String(size),
  });
  if (uploadType) params.set("upload_type", uploadType);
  const res = await api.get<MyImagesResponse>(`/uploads/my?${params}`);
  return res.data;
}

// ─── Event Reviews ──────────────────────────────────────────────────────────

export interface ReviewData {
  id: string;
  user_id: string;
  event_id: string;
  rating: number;
  title: string;
  content: string;
  is_verified_attendee: boolean;
  helpful_count: number;
  reviewer_name: string;
  created_at: string;
}

export interface ReviewSummaryData {
  average_rating: number;
  total_reviews: number;
  rating_distribution: Record<number, number>;
}

export async function getEventReviews(eventId: string, skip = 0, limit = 20) {
  const res = await api.get<ReviewData[]>(`/events/${eventId}/reviews`, {
    params: { skip, limit },
  });
  return res.data;
}

export async function getReviewSummary(eventId: string) {
  const res = await api.get<ReviewSummaryData>(
    `/events/${eventId}/reviews/summary`,
  );
  return res.data;
}

export async function createReview(
  eventId: string,
  data: { rating: number; title: string; content: string },
) {
  const res = await api.post<ReviewData>(`/events/${eventId}/reviews`, data);
  return res.data;
}

export async function markReviewHelpful(eventId: string, reviewId: string) {
  const res = await api.post<{ helpful_count: number }>(
    `/events/${eventId}/reviews/${reviewId}/helpful`,
  );
  return res.data;
}

export async function deleteReview(eventId: string, reviewId: string) {
  await api.delete(`/events/${eventId}/reviews/${reviewId}`);
}

// ── Public API (no auth) ──────────────────────────────────────────────────────

export interface ContactFormData {
  name: string;
  email: string;
  subject: string;
  message: string;
}

export interface SubscribeResponse {
  email: string;
  message: string;
}

export interface CareerApplicationData {
  name: string;
  email: string;
  position: string;
  message: string;
  resume_url?: string;
  phone?: string;
}

export interface PublicFormResponse {
  id: string;
  message: string;
}

export async function submitContactForm(data: ContactFormData) {
  const res = await api.post<PublicFormResponse>("/public/contact", data);
  return res.data;
}

export async function subscribeNewsletter(email: string) {
  const res = await api.post<SubscribeResponse>("/public/subscribe", { email });
  return res.data;
}

export async function submitCareerApplication(data: CareerApplicationData) {
  const res = await api.post<PublicFormResponse>("/public/careers/apply", data);
  return res.data;
}

// ─── OAuth2 Social Login ────────────────────────────────────────────────────

export const getOAuthRedirectUrl = (provider: string) =>
  api
    .get<{
      redirect_url: string;
      state: string;
    }>(`/auth/oauth/${provider}/redirect`)
    .then((r) => r.data);

export interface OAuthCallbackResponse {
  access_token: string;
  token_type: string;
  user: {
    id: string;
    email: string;
    name: string;
    phone?: string;
    is_organizer: boolean;
    is_admin?: boolean;
    is_verified: boolean;
    verification_level: number;
    loyalty_score: number;
    history_score: number;
    is_fanclub_member: boolean;
    no_show_rate: number;
    cancel_rate: number;
    dispute_rate: number;
    fan_points?: number;
    social_points?: number;
    admin_role?: string | null;
    avatar_url?: string;
    bio?: string;
    preferred_language?: string;
    timezone?: string;
    fanclub_memberships?: Array<{
      id: string;
      fanclub_id: string;
      fanclub_name: string;
      artist_name: string;
      logo_url?: string;
      tier: string;
      status: string;
      expires_at?: string;
      joined_at?: string;
    }>;
  };
}

export const oauthCallback = (
  provider: string,
  code: string,
  state?: string,
) =>
  api
    .post<OAuthCallbackResponse>(`/auth/oauth/${provider}/callback`, {
      code,
      ...(state ? { state } : {}),
    })
    .then((r) => r.data);

// ─── Organizer Team Management ──────────────────────────────────────────────

export interface TeamMember {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role: "owner" | "manager" | "viewer";
  joined_at: string;
}

export const getTeamMembers = () =>
  api.get<TeamMember[]>("/organizer/team").then((r) => r.data);

export const inviteTeamMember = (data: { email: string; role: string }) =>
  api.post<TeamMember>("/organizer/team", data).then((r) => r.data);

export const updateTeamMember = (id: string, data: { role: string }) =>
  api.put<TeamMember>(`/organizer/team/${id}`, data).then((r) => r.data);

export const removeTeamMember = (id: string) =>
  api.delete(`/organizer/team/${id}`).then((r) => r.data);

// ─── Admin Custom Reports ───────────────────────────────────────────────────

export interface ReportType {
  key: string;
  label: string;
  description: string;
}

export interface ReportRequest {
  report_type: string;
  date_from?: string;
  date_to?: string;
  format?: string;
}

export interface ReportResponse {
  report_type: string;
  generated_at: string;
  data: Record<string, unknown>[];
  summary: Record<string, unknown>;
}

export const getReportTypes = () =>
  api.get<ReportType[]>("/admin/reports/types").then((r) => r.data);

export const generateAdminReport = (data: ReportRequest) =>
  api.post<ReportResponse>("/admin/reports/generate", data).then((r) => r.data);

// ─── Organizer Messaging ────────────────────────────────────────────────────

export interface OrganizerMessageCreate {
  subject: string;
  content: string;
  message_type?: string;
}

export interface OrganizerMessageResponse {
  id: string;
  subject: string;
  content: string;
  message_type: string;
  recipient_count: number;
  sent_at: string | null;
  created_at: string;
}

export const sendOrganizerMessage = (
  eventId: string,
  data: OrganizerMessageCreate,
) =>
  api
    .post<OrganizerMessageResponse>(
      `/organizer/events/${eventId}/message`,
      data,
    )
    .then((r) => r.data);

export const getOrganizerMessages = (eventId: string) =>
  api
    .get<OrganizerMessageResponse[]>(`/organizer/events/${eventId}/messages`)
    .then((r) => r.data);

// ─── Lottery Verification (WP01-03) ────────────────────────────────────────

export async function verifyLotteryPool(poolId: string) {
  return api.get(`/lottery/pools/${poolId}/verify`);
}

export async function getLotteryTransparencyReport(poolId: string) {
  return api.get(`/lottery/pools/${poolId}/transparency-report`);
}

export async function getMyLotteryResult(poolId: string) {
  return api.get(`/lottery/pools/${poolId}/my-result`);
}

// ── Public Lottery Stats (consumer CTA phase 분기용) ─────────────────────

export interface PublicLotteryStats {
  event_id: string;
  /** pre_apply | applying | closed | drawing | drawn */
  phase: "pre_apply" | "applying" | "closed" | "drawing" | "drawn";
  total_entries: number;
  total_seats: number;
  competition_ratio: number;
  opens_at: string | null;
  closes_at: string | null;
}

export async function getLotteryStats(eventId: string) {
  return api.get<PublicLotteryStats>(`/events/${eventId}/lottery-stats`);
}

export interface MyLotteryHistoryEntry {
  entry_id: string;
  event_id: string;
  event_title: string;
  event_image_url: string | null;
  event_date: string | null;
  tier_id: string;
  tier_name: string;
  result: string; // pending | won | waitlisted | lost
  invested_ap: number;
  group_size: number;
  applied_at: string;
  payment_deadline: string | null;
  order_id: string | null;
  /** waitlisted 인 경우 같은 pool 내 FIFO 순번 (1-based) */
  waitlist_position?: number | null;
  /** 응모한 tier 의 매진 여부 — 매진 + waitlisted 면 사실상 낙첨 (좌석 더 안 나옴) */
  is_tier_sold_out?: boolean;
  /** 당첨자(result=won)의 order 상태 — payment_required/confirmed/expired/cancelled */
  lottery_order_status?: string | null;
}

export async function getMyLotteryHistory() {
  return api.get<{ entries: MyLotteryHistoryEntry[] }>(
    "/events/my-lottery-history",
  );
}

// ─── AP Shop (WP09/15) ─────────────────────────────────────────────────────

export async function getShopItems(params?: {
  category?: string;
  limit?: number;
}) {
  return api.get("/shop/items", { params });
}

export async function exchangeShopItem(
  itemId: string,
  shippingAddress?: string,
) {
  return api.post("/shop/exchange", {
    item_id: itemId,
    shipping_address: shippingAddress,
  });
}

export async function getMyExchanges(limit = 20) {
  return api.get("/shop/my-exchanges", { params: { limit } });
}

// ─── Quests & Attendance (WP14) ─────────────────────────────────────────────

export async function getDailyQuests() {
  return api.get("/quests/daily");
}

export async function getWeeklyQuests() {
  return api.get("/quests/weekly");
}

export async function questCheckIn() {
  return api.post("/quests/check-in");
}

export async function getMyBadges() {
  return api.get("/quests/badges/my");
}

export async function getAttendanceStreak() {
  return api.get("/quests/attendance/streak");
}

// ─── Membership Tier (WP13) ─────────────────────────────────────────────────

export async function getMyTier() {
  return api.get("/users/me/tier");
}

// ─── Template Change Requests (WP05) ────────────────────────────────────────

export async function requestTemplateChange(
  communityId: string,
  newTemplate: string,
  reason: string,
) {
  return api.post(
    `/organizer/communities/${communityId}/template-change-request`,
    {
      new_template: newTemplate,
      reason,
    },
  );
}

export async function getMyTemplateRequests(communityId: string) {
  return api.get(
    `/organizer/communities/${communityId}/template-change-requests`,
  );
}

export async function getTemplateChangeRequests(status?: string) {
  return api.get("/admin/template-change-requests", {
    params: status ? { status } : {},
  });
}

export async function approveTemplateChange(requestId: string) {
  return api.post(`/admin/template-change-requests/${requestId}/approve`);
}

export async function rejectTemplateChange(requestId: string, reason: string) {
  return api.post(`/admin/template-change-requests/${requestId}/reject`, {
    reason,
  });
}

// ─── GDPR/PIPA (Phase C WP-C2) ─────────────────────────────────────────────

export interface ConsentItem {
  purpose: string;
  consented: boolean;
  consented_at: string | null;
  withdrawn_at: string | null;
}

export async function deleteAccount() {
  return api.delete("/users/me");
}

export async function cancelAccountDeletion() {
  return api.post("/users/me/cancel-deletion");
}

export async function exportMyData() {
  return api.get("/users/me/data-export", { responseType: "blob" });
}

export async function getConsents() {
  return api.get<ConsentItem[]>("/users/me/consents");
}

export async function updateConsent(purpose: string, consented: boolean) {
  return api.put("/users/me/consents", { purpose, consented });
}

// ─── Audit Logs (Phase C WP-C3) ────────────────────────────────────────────

export interface AuditLogItem {
  id: string;
  actor_id: string | null;
  action: string;
  resource_type: string;
  resource_id: string | null;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface AuditLogResponse {
  logs: AuditLogItem[];
  total: number;
}

// ── Shop Types ──────────────────────────────────────────
export interface ShopItem {
  id: string;
  name: string;
  description: string | null;
  category: string;
  ap_price: number;
  stock: number | null;
  image_url: string | null;
  is_active: boolean;
}

export interface ShopExchange {
  id: string;
  item_id: string;
  ap_spent: number;
  category: string;
  status: string;
  created_at: string;
  shipping_address?: string | null;
}

export interface ShopItemListResponse {
  items: ShopItem[];
  total: number;
}

export interface ShopExchangeListResponse {
  exchanges: ShopExchange[];
  total: number;
}

// ── Quest / Attendance Types ────────────────────────────
export interface Quest {
  id: string;
  title: string;
  description: string | null;
  quest_type: string;
  ap_reward: number;
  condition_type: string;
  condition_count: number;
  completed: boolean;
  progress?: number;
  goal?: number;
}

export interface QuestListResponse {
  quests: Quest[];
  total: number;
}

export interface StreakInfo {
  current_week_days: number;
  consecutive_weeks: number;
  rescue_remaining: number;
  last_week_qualified: boolean;
  monthly_attendance_count: number;
}

// ── Badge Types ─────────────────────────────────────────
export interface Badge {
  id: string;
  name: string;
  description: string | null;
  icon_url: string | null;
  category: string;
  earned: boolean;
  earned_at: string | null;
}

export interface BadgeListResponse {
  badges: Badge[];
  total: number;
}

// ── Tier Types ──────────────────────────────────────────
export interface TierInfo {
  tier: string;
  tier_score: number;
  multiplier: number;
  next_tier: string | null;
  next_threshold: number | null;
  tier_updated_at: string | null;
}

export async function getAuditLogs(params?: {
  action?: string;
  resource_type?: string;
  actor_id?: string;
  date_from?: string;
  date_to?: string;
  skip?: number;
  limit?: number;
}) {
  return api.get<AuditLogResponse>("/admin/audit-logs", { params });
}

// ─── Follow ──────────────────────────────────────────────────────────────────

export const getFollowStatus = (userId: string) =>
  api.get<{
    is_following: boolean;
    follower_count: number;
    following_count: number;
  }>(`/follows/${userId}/status`);

export const toggleFollow = (userId: string) =>
  api.post<{ is_following: boolean }>(`/follows/${userId}`);

// ─── Artist Messages ──────────────────────────────────────────────────────────

export function getArtistMessages(eventId: string) {
  return api.get<{
    items: Array<{
      id: string;
      event_id: string;
      author_name: string;
      author_avatar_url: string | null;
      content: string;
      pinned: boolean;
      reactions: Record<string, number>;
      created_at: string;
    }>;
  }>(`/events/${eventId}/artist-messages`);
}

export function createArtistMessage(
  eventId: string,
  data: { author_name: string; content: string; author_avatar_url?: string },
) {
  return api.post(`/events/${eventId}/artist-messages`, data);
}

export function toggleArtistMessagePin(messageId: string) {
  return api.patch(`/events/artist-messages/${messageId}/pin`);
}

export function deleteArtistMessage(messageId: string) {
  return api.delete(`/events/artist-messages/${messageId}`);
}

export function reactToArtistMessage(messageId: string, emoji: string) {
  return api.post(`/events/artist-messages/${messageId}/react`, { emoji });
}

// ─── Fan Letters ─────────────────────────────────────────────────────────────

export function getFanLetters(
  eventId: string,
  params?: { limit?: number; offset?: number },
) {
  return api.get<{
    items: Array<{
      id: string;
      event_id: string;
      user_id: string;
      user_name: string;
      content: string;
      featured: boolean;
      visible: boolean;
      created_at: string;
    }>;
    total: number;
    has_more: boolean;
  }>(`/events/${eventId}/fan-letters`, { params });
}

export function createFanLetter(eventId: string, data: { content: string }) {
  return api.post(`/events/${eventId}/fan-letters`, data);
}

export function toggleFanLetterFeatured(letterId: string) {
  return api.patch(`/events/fan-letters/${letterId}/feature`);
}

export function toggleFanLetterVisibility(letterId: string) {
  return api.patch(`/events/fan-letters/${letterId}/visibility`);
}

export function deleteFanLetter(letterId: string) {
  return api.delete(`/events/fan-letters/${letterId}`);
}

// ─── Digital Photocards ─────────────────────────────────────────────────────

export function createPhotocard(
  eventId: string,
  data: {
    user_name: string;
    event_title: string;
    event_date: string;
    tier_name?: string | null;
    template_url?: string | null;
    purchase_id?: string | null;
  },
) {
  return api.post<{
    id: string;
    event_id: string;
    user_id: string;
    purchase_id: string | null;
    share_code: string;
    template_url: string | null;
    user_name: string;
    event_title: string;
    event_date: string;
    tier_name: string | null;
    created_at: string;
  }>(`/events/${eventId}/photocards`, data);
}

export function getPhotocardByCode(shareCode: string) {
  return api.get<{
    id: string;
    event_title: string;
    event_date: string;
    user_name: string;
    tier_name: string | null;
    template_url: string | null;
    share_code: string;
  }>(`/photocards/by-code/${shareCode}`);
}

export function getMyPhotocards(params?: { skip?: number; limit?: number }) {
  return api.get<{
    items: Array<{
      id: string;
      event_title: string;
      share_code: string;
      created_at: string;
    }>;
    total: number;
  }>("/users/me/photocards", { params });
}

// ─── Bridge Pages (Public) ──────────────────────────────────────────────────

export function getPublicBridgePage(slug: string) {
  return api.get<{
    id: string;
    title: string;
    slug: string;
    content: string | null;
    event_ids: string;
    images: string | null;
    is_active: boolean;
    events: Array<{
      id: string;
      title: string;
      image_url: string | null;
      venue_name: string | null;
      event_date: string | null;
      min_price: number | null;
      max_price: number | null;
      status: string;
      subdomain: string | null;
    }>;
  }>(`/bridge-pages/public/${slug}`);
}

// ── Anticipation Sessions (같이 기대하기) ─────────────────────────────────

export function getAnticipationSessions(eventId: string) {
  return api.get<{
    items: Array<{
      id: string;
      event_id: string;
      title: string;
      description: string | null;
      scheduled_at: string | null;
      spotify_playlist_url: string | null;
      participant_count: number;
      created_at: string;
    }>;
    total: number;
  }>(`/events/${eventId}/anticipation-sessions`);
}

export function joinAnticipationSession(sessionId: string) {
  return api.post<{ participant_count: number }>(
    `/anticipation-sessions/${sessionId}/join`,
  );
}

// ── Custom Domain Mapping ────────────────────────────────────────────────────

export interface CustomDomainData {
  id: string;
  event_page_id: string;
  domain: string;
  verification_status: "pending" | "verifying" | "active" | "failed";
  dns_record_value: string;
  cloudflare_certificate_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface CustomDomainWithInstructions extends CustomDomainData {
  cname_instructions: string;
}

export function registerCustomDomain(data: {
  event_page_id: string;
  domain: string;
}) {
  return api.post<CustomDomainWithInstructions>("/custom-domains", data);
}

export function getCustomDomain(domainId: string) {
  return api.get<CustomDomainData>(`/custom-domains/${domainId}`);
}

export function verifyCustomDomain(domainId: string) {
  return api.post<CustomDomainData>(`/custom-domains/${domainId}/verify`);
}

export function deleteCustomDomain(domainId: string) {
  return api.delete(`/custom-domains/${domainId}`);
}

// ─── Event Page White-Label ─────────────────────────────────────────────────

export function updateEventPageWhiteLabel(
  pageId: string,
  data: {
    white_label: boolean;
    white_label_config?: Record<string, unknown>;
  },
) {
  return api.patch(`/events/${pageId}/white-label`, data);
}

// ─── A/B Testing ────────────────────────────────────────────────────────────

export interface ABVariantData {
  id: string;
  name: string;
  weight: number;
}

export interface ABTestData {
  id: string;
  event_page_id: string;
  name: string;
  variants: ABVariantData[];
  is_active: boolean;
  winner_variant_id: string | null;
  created_at: string;
  updated_at: string;
}

export function getEventPageABTests(pageId: string) {
  return api.get<{ items: ABTestData[]; total: number }>(
    `/event-pages/${pageId}/ab-tests`,
  );
}

export function createEventPageABTest(
  pageId: string,
  data: { name: string; variants: Array<{ name: string; weight: number }> },
) {
  return api.post<ABTestData>(`/event-pages/${pageId}/ab-tests`, data);
}

export function getEventPageABTest(testId: string) {
  return api.get<ABTestData>(`/ab-tests/${testId}`);
}

export function updateEventPageABTest(
  testId: string,
  data: { is_active?: boolean; winner_variant_id?: string },
) {
  return api.patch<ABTestData>(`/ab-tests/${testId}`, data);
}

export function deleteABTest(testId: string) {
  return api.delete(`/ab-tests/${testId}`);
}

// ─── Admin Refunds ──────────────────────────────────────────────────────────

export interface AdminRefundItem {
  refund_id: string;
  order_id: string;
  status: string;
  refund_type: string;
  amount: number;
  original_amount?: number | null;
  currency: string;
  reason: string;
  initiated_by: string;
  requested_at: string;
  ticket_ids: string[];
}

export const getAdminPendingRefunds = (params?: {
  skip?: number;
  limit?: number;
  q?: string;
  status?: string;
  date_from?: string;
  date_to?: string;
}) =>
  api
    .get<{
      refunds: AdminRefundItem[];
      total: number;
    }>("/admin/refunds/pending", { params })
    .then((r) => r.data);

export const approveRefund = (refundId: string) =>
  api.post(`/admin/refunds/${refundId}/approve`).then((r) => r.data);

export const rejectRefund = (refundId: string, reason: string) =>
  api.post(`/admin/refunds/${refundId}/reject`, { reason }).then((r) => r.data);

// ─── Admin Settlements ──────────────────────────────────────────────────────

export interface AdminSettlementItem {
  id: string;
  organizer_id: string;
  organizer_name: string;
  organizer_email?: string;
  period_start: string;
  period_end: string;
  gross_revenue: number;
  refund_amount: number;
  platform_fee: number;
  pg_fee: number;
  net_settlement: number;
  status: string;
  fee_schedule_id?: string;
  reviewed_by?: string;
  reviewed_at?: string;
  approved_by?: string;
  approved_at?: string;
  paid_at?: string;
  dispute_reason?: string;
  created_at: string;
}

export interface AdminSettlementDetail extends AdminSettlementItem {
  fee_rate?: number;
  pg_fee_rate?: number;
  adjustments: SettlementAdjustmentItem[];
  reviewer_name?: string;
  approver_name?: string;
}

export interface SettlementSummary {
  total_pending: number;
  total_pending_amount: number;
  total_reviewed: number;
  total_reviewed_amount: number;
  total_approved: number;
  total_approved_amount: number;
  total_paid: number;
  total_paid_amount: number;
  total_disputed: number;
  this_month_count: number;
  this_month_amount: number;
}

export interface SettlementAdjustmentItem {
  id: string;
  settlement_id: string;
  amount: number;
  reason: string;
  adjustment_type: string;
  created_by: string;
  created_by_name?: string;
  created_at: string;
}

export const getAdminSettlements = (params?: Record<string, string | number>) =>
  api
    .get<{
      settlements: AdminSettlementItem[];
      total: number;
    }>("/admin/settlements", { params })
    .then((r) => r.data);

export const getAdminSettlementSummary = () =>
  api.get<SettlementSummary>("/admin/settlements/summary").then((r) => r.data);

export const getSettlementDetail = (settlementId: string) =>
  api
    .get<AdminSettlementDetail>(`/admin/settlements/${settlementId}`)
    .then((r) => r.data);

export const reviewSettlement = (settlementId: string) =>
  api.post(`/admin/settlements/${settlementId}/review`).then((r) => r.data);

export const approveSettlement = (settlementId: string) =>
  api.post(`/admin/settlements/${settlementId}/approve`).then((r) => r.data);

export const updateSettlementStatus = (
  settlementId: string,
  action: string,
  reason?: string,
) =>
  api
    .patch(`/admin/settlements/${settlementId}`, { action, reason })
    .then((r) => r.data);

export const createSettlementAdjustment = (
  settlementId: string,
  data: { amount: number; reason: string; adjustment_type?: string },
) =>
  api
    .post(`/admin/settlements/${settlementId}/adjust`, data)
    .then((r) => r.data);

export const exportSettlementsCsv = (params?: Record<string, string>) =>
  api
    .get("/admin/settlements/export", { params, responseType: "blob" })
    .then((r) => r.data);

// ─── Admin Feature Flags ────────────────────────────────────────────────────

export interface FeatureFlag {
  key: string;
  enabled: boolean;
  description?: string;
  updated_at?: string;
}

export const getAdminFeatureFlags = () =>
  api.get<FeatureFlag[]>("/admin/feature-flags").then((r) => r.data);

export const updateFeatureFlag = (key: string, enabled: boolean) =>
  api.put(`/admin/feature-flags/${key}`, { enabled }).then((r) => r.data);

// ─── Fan Requests ──────────────────────────────────────────────────────────

export interface FanRequestArtistRanking {
  id: string;
  name: string;
  image_url: string | null;
  genre: string | null;
  request_count: number;
  is_live: boolean;
  user_requested: boolean;
}

export const getFanRequestRanking = (limit?: number) =>
  api
    .get<FanRequestArtistRanking[]>("/fan-requests/ranking", {
      params: limit ? { limit } : undefined,
    })
    .then((r) => r.data);

export const createFanRequest = (artistId: string) =>
  api.post(`/fan-requests/${artistId}`).then((r) => r.data);

export const deleteFanRequest = (artistId: string) =>
  api.delete(`/fan-requests/${artistId}`).then((r) => r.data);

export const getMyFanRequests = () =>
  api.get<FanRequestArtistRanking[]>("/fan-requests/me").then((r) => r.data);

export const getAdminFanRequests = (includeInactive?: boolean) =>
  api
    .get<FanRequestArtistRanking[]>("/admin/fan-requests", {
      params: includeInactive ? { include_inactive: true } : undefined,
    })
    .then((r) => r.data);

export const updateFanRequestArtist = (
  artistId: string,
  data: { is_featured?: boolean; is_active?: boolean },
) => api.patch(`/admin/fan-requests/${artistId}`, data).then((r) => r.data);

export const createFanRequestArtist = (data: {
  name: string;
  image_url?: string;
  genre?: string;
}) => api.post("/admin/fan-requests/artists", data).then((r) => r.data);

// ─── Admin CS Tickets ───────────────────────────────────────────────────────

export interface CSTicketItem {
  id: string;
  subject: string;
  description: string;
  category: string;
  status: string;
  priority: string;
  reporter_id: string;
  reporter_name?: string;
  reporter_email?: string;
  assignee_id?: string;
  assignee_name?: string;
  assignee_email?: string;
  event_id?: string;
  event_title?: string;
  related_order_id?: string;
  sla_deadline?: string;
  escalated: boolean;
  created_at: string;
  updated_at: string;
  resolved_at?: string;
  comment_count: number;
}

export interface CSTicketDetail extends CSTicketItem {
  comments: CSTicketComment[];
}

export interface CSTicketComment {
  id: string;
  ticket_id: string;
  author_id: string;
  author_name?: string;
  author_email?: string;
  content: string;
  is_internal: boolean;
  created_at: string;
}

export interface CSTicketStats {
  total: number;
  open: number;
  in_progress: number;
  waiting_customer: number;
  resolved: number;
  closed: number;
  overdue: number;
}

export const getCSTickets = (params?: {
  status?: string;
  priority?: string;
  category?: string;
  assignee_id?: string;
  escalated?: boolean;
  q?: string;
  skip?: number;
  limit?: number;
}) =>
  api
    .get<{ tickets: CSTicketItem[]; total: number }>("/admin/cs/tickets", {
      params,
    })
    .then((r) => r.data);

export const createCSTicket = (data: {
  subject: string;
  description: string;
  category?: string;
  priority?: string;
  reporter_id: string;
  assignee_id?: string;
  event_id?: string;
  related_order_id?: string;
}) => api.post<CSTicketItem>("/admin/cs/tickets", data).then((r) => r.data);

export const getCSTicket = (id: string) =>
  api.get<CSTicketDetail>(`/admin/cs/tickets/${id}`).then((r) => r.data);

export const updateCSTicket = (
  id: string,
  data: {
    subject?: string;
    description?: string;
    status?: string;
    priority?: string;
    assignee_id?: string;
    category?: string;
  },
) =>
  api.patch<CSTicketItem>(`/admin/cs/tickets/${id}`, data).then((r) => r.data);

export const addCSTicketComment = (
  ticketId: string,
  data: { content: string; is_internal?: boolean },
) =>
  api
    .post<CSTicketComment>(`/admin/cs/tickets/${ticketId}/comments`, data)
    .then((r) => r.data);

export const getCSTicketComments = (ticketId: string) =>
  api
    .get<CSTicketComment[]>(`/admin/cs/tickets/${ticketId}/comments`)
    .then((r) => r.data);

export const escalateCSTicket = (id: string) =>
  api
    .post<CSTicketItem>(`/admin/cs/tickets/${id}/escalate`)
    .then((r) => r.data);

export const getCSTicketStats = () =>
  api.get<CSTicketStats>("/admin/cs/stats").then((r) => r.data);

// ─── Chatbot (P1-4) ─────────────────────────────────────────────────────────

export interface ChatMessageRequest {
  message: string;
  conversation_id?: string;
}

export interface ChatMessageResponse {
  response: string;
  tier: 0 | 1;
  conversation_id: string;
  escalated: boolean;
}

export const sendChatMessage = (data: ChatMessageRequest) =>
  api.post<ChatMessageResponse>("/chat/chat", data).then((r) => r.data);

// ─── Conversion Funnel Analytics (P1-11) ────────────────────────────────────

export interface FunnelStage {
  name: string;
  count: number;
  conversion_rate: number;
}

export interface FunnelPeriod {
  start: string;
  end: string;
}

export interface FunnelOverviewResponse {
  stages: FunnelStage[];
  period: FunnelPeriod;
  overall_conversion: number;
}

export interface FunnelEventOption {
  id: string;
  title: string;
}

export const getAdminFunnelOverview = (params?: {
  date_from?: string;
  date_to?: string;
}) =>
  api
    .get<FunnelOverviewResponse>("/admin/funnel/overview", { params })
    .then((r) => r.data);

export const getAdminFunnelByEvent = (
  eventId: string,
  params?: { date_from?: string; date_to?: string },
) =>
  api
    .get<FunnelOverviewResponse>(`/admin/funnel/event/${eventId}`, { params })
    .then((r) => r.data);

export const getAdminFunnelEvents = (params?: { q?: string; limit?: number }) =>
  api
    .get<{ events: FunnelEventOption[] }>("/admin/funnel/events", { params })
    .then((r) => r.data);

// ─── A/B Testing (P1-10) ────────────────────────────────────────────────────

export type ABTestStatus = "DRAFT" | "RUNNING" | "PAUSED" | "COMPLETED";

export interface ABTestVariant {
  name: string;
  weight: number;
  config: Record<string, unknown>;
}

export interface ABTestTargetAudience {
  percentage: number;
  user_segments: string[];
}

export interface ABTestItem {
  id: string;
  name: string;
  description: string | null;
  status: ABTestStatus;
  variants: ABTestVariant[];
  target_audience: ABTestTargetAudience | null;
  metric_key: string | null;
  event_page_id: string | null;
  start_date: string | null;
  end_date: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface ABTestVariantResult {
  name: string;
  assignments: number;
  impressions: number;
  conversions: number;
  conversion_rate: number;
  avg_value: number | null;
}

export interface ABTestResults {
  variants: ABTestVariantResult[];
  total_assignments: number;
}

export interface ABTestDetail extends ABTestItem {
  results: ABTestResults;
}

export interface ABTestListResponse {
  items: ABTestItem[];
  total: number;
}

export interface CreateABTestData {
  name: string;
  description?: string;
  variants: {
    name: string;
    weight: number;
    config?: Record<string, unknown>;
  }[];
  target_audience?: { percentage: number; user_segments?: string[] };
  metric_key?: string;
  start_date?: string;
  end_date?: string;
}

export interface UpdateABTestData {
  status?: ABTestStatus;
  description?: string;
  target_audience?: { percentage: number; user_segments?: string[] };
  metric_key?: string;
  start_date?: string;
  end_date?: string;
}

export const getABTests = (params?: {
  status?: ABTestStatus;
  skip?: number;
  limit?: number;
}) => api.get<ABTestListResponse>("/ab-tests", { params }).then((r) => r.data);

export const getABTest = (id: string) =>
  api.get<ABTestDetail>(`/ab-tests/${id}`).then((r) => r.data);

export const createABTest = (data: CreateABTestData) =>
  api.post<ABTestItem>("/ab-tests", data).then((r) => r.data);

export const updateABTest = (id: string, data: UpdateABTestData) =>
  api.patch<ABTestItem>(`/ab-tests/${id}`, data).then((r) => r.data);

/** GET 중복 제거(deduplicateGet) 또는 AbortController에 의해 취소된 요청인지 확인 */
export function isApiCanceled(err: unknown): boolean {
  if (axios.isCancel(err)) return true;
  if (
    err instanceof Error &&
    (err.message === "canceled" ||
      (err as { code?: string }).code === "ERR_CANCELED")
  )
    return true;
  return false;
}

export default api;
