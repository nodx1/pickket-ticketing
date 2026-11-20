/**
 * v2 커머스 코어 write-through 클라이언트 (미러 제거 리팩토링 토대).
 *
 * MASTER-PLAN-go-tower: 커머스 도메인(이벤트·재고·주문·티켓·소비자콘텐츠)의 SoT 는 v2.
 * go 대시보드는 go DB 에 쓰고 미러하는 대신 **이 클라이언트로 v2 에 직접 write** 한다.
 *
 * 미러 모듈(event-sync.ts 등)과의 결정적 차이:
 *  1. 미러 = fire-and-forget(실패 무시). write-through = **에러 전파**(v2 write 실패 = 작업 실패).
 *  2. **organizer_ref 자동 첨부** — v2 가 go-system 유저로 붕괴 매핑하지 않도록 실 organizer 식별자 전달.
 *  3. **멱등키 + 재시도** — 네트워크 재시도 시 중복 생성 방지.
 *
 * 인증: HMAC 서명(X-Pickket-Signature/Timestamp) + 토큰(X-Pickket-Service-Token) **병행**.
 *   v2 _internal_auth(d76a182): 서명 있으면 HMAC 검증 / 없으면 토큰 폴백(전환기).
 *   go 서명 배포 통보 후 v2 enforce=True → 서명 필수. signCommerceRequest 참조.
 *
 * ⚠️ 엔드포인트는 v2 P0 에서 구현 예정(go-conversion-workplan §v2지시). 본 클라이언트는 그 시그니처에
 *    맞춰 선행 구축 — P0 publish 시 경로/필드 미세조정만.
 */
import crypto from "node:crypto";
import { logger } from "@/lib/logger";

// env 는 **호출 시점에 lazy** 로 읽는다(모듈 로드 시점 캡처 금지).
//   cron/스크립트(tsx)는 ESM import 가 inline .env.local 로더보다 먼저 실행돼,
//   모듈 로드 시점 캡처하면 V2_BASE/SERVICE_TOKEN 이 undefined 로 굳는다(reaper/reconcile 미설정 버그).
//   호출 시점 read 면 prod(ECS env)·dev(.env.local 후행 로드) 양쪽 정상.
function getV2Base(): string | undefined {
  return process.env.V2_INTERNAL_BASE_URL;
}
// v2 가 internal_sync 검증에 쓰는 시크릿과 동일 값(= go .env 의 GO_WEBHOOK_SECRET).
function getServiceToken(): string | undefined {
  return process.env.GO_WEBHOOK_SECRET ?? process.env.V2_EVENT_SYNC_SECRET;
}

/** write-through 실패 — 호출자가 트랜잭션 롤백/사용자 에러로 처리해야 함(fire-and-forget 아님). */
export class V2CommerceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "V2CommerceError";
  }
}

interface RequestOptions {
  /**
   * 멱등키. 미지정 시 요청 내용(method+path+payload)에서 **결정적**으로 파생(랜덤 아님) →
   * 동일 요청 재시도는 자동으로 같은 키를 얻는다. 부작용 write(주문/환불/좌석)는 호출자가
   * **안정 시드 키(=external_order_id 기반, 예: `go-order:${orderId}`)** 를 반드시 전달한다.
   */
  idempotencyKey?: string;
  /** 재시도 횟수(네트워크/5xx). 기본 2. 4xx 는 재시도 안 함. */
  retries?: number;
  timeoutMs?: number;
}

const RETRY_BACKOFF_MS = [0, 500, 2000];

/**
 * HMAC 서명 — v2 _internal_auth(commit d76a182) 계약.
 *   sig = HMAC_SHA256(GO_WEBHOOK_SECRET, `${ts}.${rawBody}`).hex(), ts = ISO8601 UTC.
 *   GET/무본문 = rawBody "" 로 서명. v2 replay-guard off(멱등=Idempotency-Key), timestamp ±tolerance.
 *
 * 전환기: 토큰 헤더(X-Pickket-Service-Token)와 **병행 전송**.
 *   v2 INTERNAL_COMMERCE_REQUIRE_HMAC=False 동안 토큰 폴백 → 무중단.
 *   go 서명 배포 통보 후 v2 enforce=True flip → 서명 필수.
 * 재시도마다 ts 를 새로 찍어 tolerance 창 밖 stale 서명 방지(per-attempt).
 */
function signCommerceRequest(rawBody: string): { signature: string; timestamp: string } | null {
  const token = getServiceToken();
  if (!token) return null;
  const timestamp = new Date().toISOString();
  const signature = crypto
    .createHmac("sha256", token)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return { signature, timestamp };
}

/**
 * v2 커머스 API 코어 요청. 성공 시 응답 JSON(T), 실패 시 V2CommerceError throw.
 * 미러와 달리 절대 swallow 하지 않는다.
 */
async function v2CommerceRequest<T>(
  method: "POST" | "PATCH" | "PUT" | "DELETE" | "GET",
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const V2_BASE = getV2Base();
  const SERVICE_TOKEN = getServiceToken();
  if (!V2_BASE || !SERVICE_TOKEN) {
    throw new V2CommerceError(
      "v2 커머스 클라이언트 미설정 (V2_INTERNAL_BASE_URL / GO_WEBHOOK_SECRET)",
      500,
    );
  }

  const url = `${V2_BASE.replace(/\/$/, "")}${path}`;
  const retries = opts.retries ?? 2;
  const payload = body === undefined ? undefined : JSON.stringify(body);

  // 멱등키 결정 규칙(레벨2 재감사 P1 — createOrder retry idempotency).
  //   과거: `opts.idempotencyKey ?? crypto.randomUUID()`. 랜덤 폴백은 **재시도마다 키가 바뀌어**
  //   v2 dedup(Idempotency-Key 재사용/external_order_id UNIQUE)을 무력화한다(중복 주문/좌석hold 원천).
  //   ✅ 폴백을 **요청 내용(method+path+payload)에서 파생한 결정적 SHA-256** 으로 교체한다.
  //     동일 요청 재시도 → 동일 키 → v2 가 첫 응답을 재생(중복 부작용 없음). 랜덤성 제거.
  //   ⚠️ 주문·환불 등 부작용 write 는 호출자가 **안정 idempotencyKey(=external_order_id 시드)** 를
  //     반드시 전달한다(createOrder: `go-order:${orderId}`). 이 폴백은 read/보조 write 안전망일 뿐,
  //     호출자 키를 대체하지 않는다. GET 은 v2 가 멱등키를 dedup 에 쓰지 않으므로 영향 없음.
  const idempotencyKey =
    opts.idempotencyKey ??
    `auto:${crypto.createHash("sha256").update(`${method} ${path}\n${payload ?? ""}`).digest("hex")}`;

  let lastErr: V2CommerceError | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt] ?? 2000));
    }
    try {
      // 서명은 fetch 에 실제로 보내는 바이트(payload)와 1:1 — GET/무본문은 "".
      const signed = signCommerceRequest(payload ?? "");
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Pickket-Service-Token": SERVICE_TOKEN, // 전환기 토큰 병행(enforce 전 폴백)
        "Idempotency-Key": idempotencyKey,
        "User-Agent": "pickket-go-commerce/1.0",
      };
      if (signed) {
        headers["X-Pickket-Signature"] = signed.signature;
        headers["X-Pickket-Timestamp"] = signed.timestamp;
      }
      const res = await fetch(url, {
        method,
        headers,
        body: payload,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
      });

      if (res.ok) {
        const text = await res.text();
        // 응답 봉투: { ok, data, idempotent_replay } | { ok:false, error }
        const env = text ? JSON.parse(text) : { ok: true, data: {} };
        if (env && env.ok === false) {
          throw new V2CommerceError(env.error?.message ?? "v2 커머스 에러", res.status, JSON.stringify(env.error));
        }
        return (env?.data ?? env) as T;
      }

      const errBody = await res.text().catch(() => "");
      // 에러 봉투에서 code 추출
      let errMsg = `v2 커머스 ${method} ${path} 실패`;
      try {
        const parsed = JSON.parse(errBody);
        if (parsed?.error?.code) errMsg = `${parsed.error.code}: ${parsed.error.message ?? ""}`;
      } catch { /* raw body 유지 */ }
      lastErr = new V2CommerceError(errMsg, res.status, errBody);
      // 4xx 는 재시도 무의미(잘못된 요청) — 즉시 throw
      if (res.status >= 400 && res.status < 500) throw lastErr;
      // 5xx 는 재시도
      logger.warn("v2 커머스 요청 5xx — 재시도", { path, status: res.status, attempt });
    } catch (err) {
      if (err instanceof V2CommerceError) {
        if (err.status >= 400 && err.status < 500) throw err;
        lastErr = err;
      } else {
        lastErr = new V2CommerceError(
          `v2 커머스 ${method} ${path} 네트워크 오류: ${err instanceof Error ? err.message : "unknown"}`,
          0,
        );
      }
    }
  }
  throw lastErr ?? new V2CommerceError(`v2 커머스 ${method} ${path} 실패`, 0);
}

/**
 * v2 read CSV export 코어 — JSON 봉투가 아닌 text/csv 평문을 그대로 반환.
 * (export 엔드포인트는 PlainTextResponse 라 JSON.parse 하면 깨짐. envelope unwrap 없이 text.)
 * 실패 시 V2CommerceError. 4xx 즉시 throw, 5xx 재시도.
 */
async function v2CommerceRequestText(
  path: string,
  opts: RequestOptions = {},
): Promise<string> {
  const V2_BASE = getV2Base();
  const SERVICE_TOKEN = getServiceToken();
  if (!V2_BASE || !SERVICE_TOKEN) {
    throw new V2CommerceError(
      "v2 커머스 클라이언트 미설정 (V2_INTERNAL_BASE_URL / GO_WEBHOOK_SECRET)",
      500,
    );
  }
  const url = `${V2_BASE.replace(/\/$/, "")}${path}`;
  const retries = opts.retries ?? 2;
  let lastErr: V2CommerceError | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt] ?? 2000));
    }
    try {
      // GET 은 빈 본문 서명("") — v2 계약.
      const signed = signCommerceRequest("");
      const headers: Record<string, string> = {
        "X-Pickket-Service-Token": SERVICE_TOKEN, // 전환기 토큰 병행
        "User-Agent": "pickket-go-commerce/1.0",
      };
      if (signed) {
        headers["X-Pickket-Signature"] = signed.signature;
        headers["X-Pickket-Timestamp"] = signed.timestamp;
      }
      const res = await fetch(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000),
      });
      if (res.ok) return await res.text();
      const errBody = await res.text().catch(() => "");
      lastErr = new V2CommerceError(`v2 커머스 GET ${path} 실패`, res.status, errBody);
      if (res.status >= 400 && res.status < 500) throw lastErr;
      logger.warn("v2 커머스 export 5xx — 재시도", { path, status: res.status, attempt });
    } catch (err) {
      if (err instanceof V2CommerceError) {
        if (err.status >= 400 && err.status < 500) throw err;
        lastErr = err;
      } else {
        lastErr = new V2CommerceError(
          `v2 커머스 GET ${path} 네트워크 오류: ${err instanceof Error ? err.message : "unknown"}`,
          0,
        );
      }
    }
  }
  throw lastErr ?? new V2CommerceError(`v2 커머스 GET ${path} 실패`, 0);
}

/**
 * organizer_ref 해석 — read 엔드포인트(settlements/dashboard/search)가 v2 로 넘길 식별자.
 *
 * ⚠️ 앵커 전환(레벨2 영역D): 예전엔 여기서 go DB `accounts JOIN users` 를 돌려
 *   owner 의 v2_user_id 를 반환했다. 이제 세션이 v2UserId(=JWT sub=v2 canonical user id)를
 *   이미 품으므로 **그 값을 그대로 반환**하고 go DB 재조회를 제거한다.
 *
 * 안전성 근거:
 *   1. v2 read 측 `_resolve_organizer`(internal_commerce.py)는 UUID 를 organizer_id(=v2 User.id)로
 *      해석한다. v2UserId 는 정확히 v2 User.id 이므로 1:1 로 해석된다(기존 반환값과 **동일 의미**).
 *   2. write-through 계약 무변: 이 함수는 read 3라우트만 쓴다. write-through 는 여전히
 *      goAccountRef(session.accountId)={go_account_id} 경로(별도, 본 변경과 무관).
 *   3. v2UserId 부재(레거시 토큰 등) 시 null → 호출부가 `?? session.accountId` 폴백.
 *      go accounts.id(UUID)는 v2 가 organizer_id 미스 → go_account_id 폴백 재해석
 *      (_resolve_organizer #4 fallback)으로 여전히 정상 해석된다(무중단).
 *
 * @param sessionV2UserId 세션의 v2UserId (User.v2UserId). 미지정/null 이면 null 반환.
 */
export function resolveOrganizerRef(sessionV2UserId: string | null | undefined): string | null {
  return sessionV2UserId ?? null;
}

/**
 * 판매 단계(sale plan) 전용 요청 게이트 — 레벨2 컷오버 T2-PHASE.
 *
 * `v2CommerceRequest` 는 모듈 내부 전용이라 phase-client 가 직접 못 쓴다. 판매계획
 * 엔드포인트만 노출하는 얇은 래퍼(임의 경로 호출을 열지 않도록 경로 검증 포함).
 */
export function v2SalePlanRequest<T>(
  method: "GET" | "PUT",
  path: string,
  body?: unknown,
  opts?: RequestOptions,
): Promise<T> {
  if (!/^\/api\/v1\/internal\/events\/[0-9a-fA-F-]{36}\/sale-plan$/.test(path)) {
    throw new V2CommerceError(`허용되지 않은 sale-plan 경로: ${path}`, 500);
  }
  return v2CommerceRequest<T>(method, path, body, opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// 커머스 write 메서드 (v2 P0 엔드포인트 시그니처에 맞춤 — go-conversion-workplan)
// 모든 write 는 organizerRef 필수. 호출자는 트랜잭션 경계에서 호출하고 에러를 전파한다.
// ─────────────────────────────────────────────────────────────────────────────

/** organizer_ref (SLICE-A §공통규약) — v2 가 OrganizerProfile.go_account_id 로 해석. go-system fallback 폐기. */
export type OrganizerRef = { go_account_id: string } | { organizer_id: string };

/** go account_id → organizer_ref. v2 에 OrganizerProfile.go_account_id 선등록 필요. */
export function goAccountRef(accountId: string): OrganizerRef {
  return { go_account_id: accountId };
}

/**
 * v2 organizer(user) id 로 지목한다.
 *
 * 🔴 공개 경로(초대권 양도 등)에는 go account 세션이 없다. 티켓 조회 응답의
 *    `event.organizer_id` 가 곧 v2 organizer 라 그것으로 지목한다
 *    (v2 `OrganizerRef` 는 go_account_id / organizer_id 둘 다 받는다).
 */
export function organizerIdRef(organizerId: string): OrganizerRef {
  return { organizer_id: organizerId };
}

// SLICE-A 배포 계약 (POST/PATCH /internal/events)
export interface EventWriteInput {
  organizer_ref: OrganizerRef;
  /** go-local id (멱등 upsert 키). 동일 external_ref 재호출 → 같은 canonical event_id, created:false */
  external_ref: string;
  title: string;
  venue?: string | null;
  /**
   * ── 상세페이지 통합 트랙B U1 핵심 상세 필드(전부 optional·가산) ──
   * go events 에만 있고 v2 미배선이던 필드. v2 events(소비자 상세 SoT)로 write-through.
   * PATCH 는 키 포함=반영/미포함=보존, 명시 null/빈값=해당 필드 삭제(read-after-write 정합).
   */
  /** go events.description — 상세 본문(소비자 상세 본문). */
  description?: string | null;
  /** go events.venue_address — 공연장 주소. */
  venue_address?: string | null;
  /** 지도 API 연동 — 「장소 찾기」로 고른 좌표(둘 다 보내거나 둘 다 null). */
  venue_lat?: number | null;
  venue_lng?: number | null;
  /** go events.age_rating — 연령 등급(all/12+/15+/18+ 등). */
  age_rating?: string | null;
  /** go events.is_online — 온라인 이벤트 여부. */
  is_online?: boolean | null;
  /** go events.homepage_url — 공식 홈페이지. */
  homepage_url?: string | null;
  /** v2 category 8종 (go EventType→category 매핑 후). domain-model toV2Category 사용 */
  category: string;
  /**
   * 이벤트 전체 좌석수(go max_attendees → v2 total_seats). 트랙B U1 부분배선 수정.
   * go 에서 정원(max_attendees)을 바꿔도 v2 로 재sync 되지 않던 갭을 메운다.
   * v2 가 판매/홀드된 좌석보다 작은 축소는 409 로 차단(과판매 방지). 미전송 시 v2 값 유지.
   */
  total_seats?: number | null;
  event_date: string;
  /** 판매창 go 정본 — v2 bidding window 가 이걸로 결정(event_date 추정 금지) */
  sale_window: { opens_at: string; closes_at: string };
  sale_channels: string[];
  /** v2 11-상태 값 직접 전송(기본 draft) */
  status: string;
  /**
   * 판매 일시중지 플래그 (go "paused" 전용, 2026-06-03 계약).
   * status enum/sale_window 를 건드리지 않고 true=중지/false=재개 → v2 가 직전 status(approved 등) 복원.
   * true 면 v2 가 구매·응모 모두 차단. read 라운드트립: status="paused", status_v2="approved", sales_paused=true.
   */
  sales_paused?: boolean;
  /**
   * 소비자 노출 히어로/커버 이미지 URL (go hero_image_url → v2 image_url).
   * 미전송 시 v2 image_url 이 null 로 남아 소비자 /e/[slug] 히어로가 무이미지로 렌더된다
   * (GO_V2_COMMERCE_SYNC_AUDIT — 이미지 sync 누락 버그). 절대 URL 필수.
   */
  image_url?: string | null;
  /**
   * 화면비별 렌디션 맵 {wide,portrait,thumb,og} (P1). 소비자 각 화면이 알맞은 크기를 선택.
   * 미전송/빈객체면 소비자는 image_url 로 폴백.
   */
  image_variants?: Record<string, string> | null;
  /**
   * 갤러리 이미지(최대 4장, P2). 각 항목이 마스터 url + 화면비별 렌디션 보관.
   * 소비자 상세페이지 캐러셀에 노출. 첫 항목이 대표.
   */
  gallery_images?: Array<{ url: string; variants?: Record<string, string> | null }> | null;
  /**
   * 취소 수수료 티어(취소/환불정책). 소비자 상세·결제에 노출. v2 SoT.
   * go 는 [{daysBefore,feePct}] 로 보관 → 전송 시 v2 스키마 [{days_before,fee_pct}] 로 변환해 전달.
   * 미전송(undefined) 시 v2 값 유지, 빈배열/null 은 정책 없음.
   */
  cancellation_fee_tiers?: Array<{ days_before: number; fee_pct: number }> | null;
  /**
   * F1 입장방식(single|daypass|allpass). go 편집 UI → v2 events.admission_mode(SoT).
   * single=단일일(입장 1회) / daypass=지정·선택 1일권 / allpass=전일권. 미전송 시 v2 값 유지.
   * 판매 개시 후 변경은 v2 가 409(EVENT_NOT_MODIFIABLE)로 차단.
   */
  admission_mode?: "single" | "daypass" | "allpass";
  /**
   * F1 다일 종료일(allpass/daypass 관람 창). go ends_at → v2 event_date_end.
   * daypass/allpass 는 다일 이벤트여야 하므로 종료일 필수. null=단일일 복귀.
   */
  event_date_end?: string | null;
  /**
   * F4 경품/추첨 활성. go 편집 UI → v2 events.raffle_enabled(SoT).
   * true 면 발권 시 이벤트 스코프 유니크 raffle_number 부여(F5 초대권 표시가 소비). 미전송 시 v2 값 유지.
   */
  raffle_enabled?: boolean;
  /**
   * 좌석 판매 방식(assigned|unassigned) → v2 events.seat_type(SoT).
   * assigned=지정석(배치도로 좌석을 그려 판다) / unassigned=자유입장(등급 수량만).
   * go 운영 콘솔이 이 값으로 배치도 에디터 노출을 가른다. 미전송 시 v2 값 유지.
   * assigned→unassigned 전환은 **좌석이 배정된 티켓이 있으면** v2 가 409 로 차단.
   */
  seat_type?: "assigned" | "unassigned";
  /**
   * ── 트랙B U3 공개 랜딩 부속기능 게이트(주최자 opt-in) → v2 events(소비자 SoT) write-through ──
   * consumer 가 이 플래그로 RSVP/단체예약 폼 노출 여부를 판정한다. 미전송 시 v2 값 유지.
   */
  /** 무료 참석(RSVP) 폼 노출·수신 허용. */
  rsvp_enabled?: boolean;
  /** 단체 예약 문의 폼 노출·수신 허용. */
  group_booking_enabled?: boolean;
  /** 주최자 수동 상단 배너 문구. 빈문자열/null=배너 해제, 미전송=보존. */
  context_banner?: string | null;
  // ── Phase 1-O 상세페이지 갭 필드 write-through (1-S 계약, 전부 optional·가산) ──
  // go 편집 데이터를 v2(소비자 상세 SoT)로 흘려보낸다. PATCH 는 키 포함=반영/미포함=보존.
  // 명시 null/빈값 = 해당 섹션 삭제(read-after-write 정합). 출처: go events + event_schedules + event_questions.
  /** go events.summary — 한 줄 요약. */
  summary?: string | null;
  /** go event_schedules 테이블 → [{time, title, description}] (time=starts_at ISO). */
  event_schedules?: Array<{ time: string; title: string; description?: string | null }> | null;
  /** go events.seo_metadata(JSONB) → {title, description, keywords, og_image}. */
  seo_metadata?: {
    title?: string | null;
    description?: string | null;
    keywords?: string[] | null;
    og_image?: string | null;
  } | null;
  /** go event_questions 테이블 → [{label, type, required, options}]. */
  questions?: Array<{
    label: string;
    type: string;
    required: boolean;
    options?: string[] | null;
  }> | null;
  /** go events.transport_info — 오시는 길(대중교통 등). */
  transport_info?: string | null;
  /** go events.parking_info — 주차 안내(v2 기존 컬럼 재사용). */
  parking_info?: string | null;
  /**
   * 프로그램 탭 자유문구 (2026-08-02 배선).
   *
   * ⚠️ v2 는 이 둘을 **컬럼으로 갖고 `EventUpdate` 로 받는데**, 상세 read
   *    (`internal_commerce.py` `_event_detail_dict`)에 **노출이 없다**.
   *    즉 **쓸 수는 있어도 읽어올 수 없다** — v2 노출 2줄이 선행이다(메인 세션).
   *    그 전까지 저장은 되고 화면에는 안 보인다.
   */
  program_notes?: string | null;
  stage_info?: string | null;
  /** go events.runtime_minutes — 공연 러닝타임(분). */
  runtime_minutes?: number | null;
  /** go events.intermission_minutes — 인터미션(분). */
  intermission_minutes?: number | null;
  /**
   * Phase 1-Map — 좌석 배치도 원본 canvas. go seat_maps.map_data(canvas JSON, 변환 없이) +
   * background/floor/landmarks 를 병합한 렌더용 원본. v2 events.seat_map_data(SoT)에 저장, 소비자(1-C)가
   * 좌석 배치도를 원본 렌더하는 데 소비한다. 미전송(undefined) 시 v2 값 유지, null/빈 maps=배치도 삭제.
   * 형태: {version, maps:[{id,name,status,floor_index,floor_label,parent_map_id, map_data, background, landmarks}]}
   */
  seat_map_data?: SeatMapDataPayload | null;
  /**
   * ── 레벨2 컷오버 T2-EVT: go events 전용 컬럼(v2 마이그 ctevt_0727) ──
   * go DB 제거 후 v2 가 유일 SoT 이므로 이 값들도 반드시 write-through 되어야 한다.
   * 미전송(undefined) = v2 값 보존, 명시 null = 삭제(PATCH 부분갱신 계약과 동일).
   */
  /**
   * 🔴 go events.slug. **반드시 전송해야 한다.**
   * 미전송 시 v2 가 `_slugify(title, id8)` 로 자체 생성해 go slug 와 갈라지고,
   * slug 기반 공개 라우트(`/e/[slug]`)가 v2 by-slug 조회에서 미스난다.
   * ⚠️ go 는 UNIQUE(account_id, slug)(테넌트별)지만 v2 는 **전역 UNIQUE** —
   * 타 계정과 slug 가 겹치면 v2 가 409 를 준다(호출측이 한국어로 안내할 것).
   */
  slug?: string;
  /**
   * 🔴 go events.event_type 원본(13종+). v2 category(9종)는 toV2Category 의 손실 매핑이라
   * 역변환이 불가능하다 — 원본을 같이 보내지 않으면 go DB 제거 시 비가역 손실.
   */
  event_type?: string | null;
  /** 🔴 주최자 기능 토글 정본(go require-feature 게이트가 소비). */
  enabled_features?: string[] | null;
  homepage_design?: Record<string, unknown> | null;
  landing_config?: Record<string, unknown> | null;
  custom_domain?: string | null;
  domain_metadata?: Record<string, unknown> | null;
  queue_enabled?: boolean | null;
  queue_config?: Record<string, unknown> | null;
  rsvp_config?: Record<string, unknown> | null;
  comp_capacity_cap?: number | null;
  /** go events.timezone → v2 event_timezone. */
  timezone?: string | null;
}

/** Phase 1-Map — v2 events.seat_map_data 계약 shape(소비자 렌더 원본). */
export interface SeatMapDataPayload {
  version: number;
  maps: Array<{
    id: string;
    name: string;
    status: string;
    floor_index: number;
    floor_label: string | null;
    parent_map_id: string | null;
    /** go seat_maps.map_data — canvas JSON. 변환 없이 그대로. */
    map_data: unknown;
    background: { url: string | null; opacity: number; width: number | null; height: number | null } | null;
    landmarks: Array<{
      /** 레벨2 3차 3.1 — 단일 add/remove 를 위한 안정 id(go seat_map_landmarks.id 대체). 소비자는 무시. */
      id?: string;
      type: string;
      label: string | null;
      x: number;
      y: number;
      width: number;
      height: number;
      rotation: number;
      color_hex: string | null;
      metadata: unknown;
    }>;
    /** 레벨2 영역A — go seat_map_versions 흡수(스냅샷 이력, 최근 30개). */
    versions?: Array<{
      version: number;
      note: string | null;
      snapshot: unknown;
      created_at: string | null;
    }>;
    /** 레벨2 영역A — go seat_groups 흡수(블록 단위 그룹 + 멤버 좌석 refs). */
    groups?: Array<{
      /** 레벨2 3차 3.1 — 단일 delete 를 위한 안정 id(go seat_groups.id 대체). 소비자는 무시. */
      id?: string;
      name: string;
      type: string;
      color_hex: string | null;
      icon: string | null;
      seat_refs: string[];
    }>;
  }>;
}

/** 레벨2 영역A — v2 seat_map_templates 계약(go seat_map_templates 흡수). */
export interface SeatMapTemplate {
  id: string;
  organizer_id: string | null;
  name: string;
  description: string | null;
  category: string;
  thumbnail_url: string | null;
  layout: unknown;
  is_system: boolean;
  created_at: string | null;
}

export interface SeatMapTemplateCreateInput {
  name: string;
  description?: string | null;
  category: string;
  layout: unknown;
  thumbnail_url?: string | null;
}

export interface EventWriteResult {
  event_id: string; // v2 canonical UUID — go 가 external_ref↔event_id 매핑 보관
  external_ref: string;
  slug: string;
  status: string;
  created: boolean;
}

/** 이벤트 생성(write-through). 멱등키 필수. → canonical event_id 반환. */
export function createEvent(input: EventWriteInput, opts: RequestOptions & { idempotencyKey: string }) {
  return v2CommerceRequest<EventWriteResult>("POST", "/api/v1/internal/events", input, opts);
}

/** 이벤트 수정(부분). */
export function updateEvent(eventId: string, patch: Partial<Omit<EventWriteInput, "external_ref">>, opts: RequestOptions & { idempotencyKey: string }) {
  return v2CommerceRequest<EventWriteResult>("PATCH", `/api/v1/internal/events/${eventId}`, patch, opts);
}

// ── Slice A read (live, 빅뱅 read-flip 용) ─────────────────────────────────────
// ⚠️ summary.total_revenue/revenue = gross. go 표시 매출 = net = revenue − refund_amount (rev2 lock).

export interface EventSummary {
  tier_count: number; product_count: number; seats_total: number; seats_sold: number;
  order_count: number; attendee_count: number;
  total_revenue: number; refund_amount: number; // net = total_revenue − refund_amount
}
export interface EventDetail {
  event_id: string; external_ref: string | null; title: string; slug: string;
  description: string | null; venue: string | null; category: string;
  // 상태 매핑(1-StateMap): status 는 v2 가 이미 go 어휘로 투영해 내려준다(v2 core/commerce_status.py
  // project_event_status). status_v2 는 v2 원본 enum. go 로컬 투영 함수(read/write 양방향)와 매핑표는
  // domain-model.ts(projectToGoEventStatus / goToV2WriteEventStatus, order/attendee/settlement 포함) 참조.
  status: string;     // go 4-상태 투영(v2 project_event_status)
  status_v2: string;  // v2 11-상태 원본
  event_date: string | null;
  sale_window: { opens_at: string | null; closes_at: string | null };
  /** 나이스 카드전용 게이팅(C2) — 허용 결제수단 대문자 코드. 없으면 null(전체 허용). */
  allowed_pay_methods?: string[] | null;
  /**
   * 카드사 자동할인(T13/T14) — `{ "BC": { rate, card_code, discount_code } }`.
   * 🔴 이건 **internal 응답**이라 `discount_code` 가 실려 온다. 브라우저로 넘기기 전에
   *    반드시 벗겨낼 것(checkout/page.tsx) — 클라가 알면 임의 적용을 시도할 수 있다.
   */
  card_discounts?: Record<string, { rate: number; card_code: string; discount_code: string }> | null;
  sale_channels: string[]; organizer_id: string; total_seats: number | null; image_url: string | null;
  summary: EventSummary;
  /**
   * 레벨2 2차 A2 — v2 상세 응답의 content 네임스페이스(_event_detail_dict content).
   * 좌석 배치도 원본(seat_map_data)을 빌더 GET read-flip 에서 live 로 읽는다.
   * v2 가 항상 내려주지만(NULL 가능), 하위호환 위해 optional 로 선언.
   */
  content?: {
    seat_map_data?: SeatMapDataPayload | null;
    [key: string]: unknown;
  } | null;
  /**
   * ── 레벨2 컷오버 T2-EVT — go events 흡수분(v2 마이그 ctevt_0727) ──
   * go DB 제거 후 이 응답이 **유일한 출처**다.
   */
  /** 소유 테넌트(go accounts.id). go 가 events 테이블 없이 account 경계를 확인하는 값. */
  go_account_id?: string | null;
  /** W2-PUB — 공개 표기용 주최자명(구 go `organizers.name`). 미등록 주최자는 null. */
  organizer_name?: string | null;
  /** 🔴 go EventType 원본. category 는 손실 파생이므로 편집 UI 는 이 값을 써야 한다. */
  event_type?: string | null;
  /** 🔴 기능 게이트 정본. v2 는 항상 배열로 내려준다(NULL 없음 → fail-closed 판정 가능). */
  enabled_features?: string[];
  homepage_design?: Record<string, unknown> | null;
  landing_config?: Record<string, unknown> | null;
  custom_domain?: string | null;
  domain_metadata?: Record<string, unknown> | null;
  queue_enabled?: boolean;
  queue_config?: Record<string, unknown> | null;
  rsvp_config?: Record<string, unknown> | null;
  comp_capacity_cap?: number | null;
  timezone?: string | null;
  venue_address?: string | null;
  venue_lat?: number | null;
  venue_lng?: number | null;
  age_rating?: string | null;
  is_online?: boolean;
  homepage_url?: string | null;
  rsvp_enabled?: boolean;
  group_booking_enabled?: boolean;
  context_banner?: string | null;
  image_variants?: Record<string, string> | null;
  gallery_images?: Array<{ url: string; variants?: Record<string, string> | null }> | null;
  admission_mode?: "single" | "daypass" | "allpass";
  raffle_enabled?: boolean;
  seat_type?: "assigned" | "unassigned";
  event_date_end?: string | null;
  cancellation_fee_tiers?: Array<{ days_before: number; fee_pct: number }> | null;
  sales_paused?: boolean;
}
export interface EventListItem {
  event_id: string; external_ref: string | null; title: string; status: string;
  category: string; event_date: string | null;
  sale_window: { opens_at: string | null; closes_at: string | null };
  total_seats: number | null;
  order_count: number; attendee_count: number;
  revenue: number; refund_amount: number; // net = revenue − refund_amount
  // ── 레벨2 T2-EVT: go 목록 화면이 go events 없이 렌더되도록 확장된 필드 ──
  slug?: string;
  summary?: string | null;
  venue?: string | null;
  age_rating?: string | null;
  is_online?: boolean;
  image_url?: string | null;
  event_type?: string | null;
  event_date_end?: string | null;
  enabled_features?: string[];
  sales_paused?: boolean;
}

/**
 * 이벤트 상세 live read (v2 서버사이드 집계 포함).
 *
 * @param organizerRef go accounts.id(또는 v2 organizer_id). **주면 v2 가 테넌트 경계를
 *   강제**한다(불일치 → 404). 레벨2 T2-EVT 이후 go 의 `AND account_id = $2` 가 이 인자로
 *   이관됐다 — 주최자 스코프 라우트는 **반드시** 넘겨야 크로스테넌트 누출이 막힌다.
 */
export function getEvent(eventId: string, opts?: RequestOptions & { organizerRef?: string }) {
  const q = opts?.organizerRef
    ? `?${new URLSearchParams({ organizer_ref: opts.organizerRef }).toString()}`
    : "";
  return v2CommerceRequest<EventDetail>("GET", `/api/v1/internal/events/${eventId}${q}`, undefined, opts);
}

/**
 * slug → 이벤트 상세 live read (레벨2 T2-EVT).
 *
 * go `SELECT ... FROM events WHERE slug = $1` 의 대체. 공개 라우트(`/e/[slug]` 등)는
 * organizerRef 없이 전역 조회한다(go 도 계정 스코프 없이 조회했다).
 * ⚠️ v2 slug 는 전역 UNIQUE — go 의 테넌트별 UNIQUE 보다 강한 제약이다.
 * 상태 게이트(live/soldout 등)는 **호출측이** `status` 로 판정한다(v2 가 하드 필터하지 않음).
 */
export function getEventBySlug(slug: string, opts?: RequestOptions & { organizerRef?: string }) {
  const q = opts?.organizerRef
    ? `?${new URLSearchParams({ organizer_ref: opts.organizerRef }).toString()}`
    : "";
  return v2CommerceRequest<EventDetail>(
    "GET", `/api/v1/internal/events/by-slug/${encodeURIComponent(slug)}${q}`, undefined, opts,
  );
}

export interface EventDuplicateResult {
  event_id: string;
  slug: string;
  status: string;
  tier_count?: number;
  created: boolean;
}

/**
 * 이벤트 복제 (authoring only — 주문·티켓·좌석 실적은 복제되지 않는다).
 *
 * newEventId 를 지정하면 그것이 **DB 레벨 멱등키**가 되어, 동시/재시도 실행에도
 * 이벤트가 2개 생기지 않는다(created=false 로 기존 것을 반환).
 */
export function duplicateEvent(
  eventId: string,
  input: {
    organizer_ref: OrganizerRef;
    new_event_id?: string;
    title?: string;
    slug?: string;
    copy_tiers?: boolean;
  },
  opts: RequestOptions & { idempotencyKey: string },
) {
  return v2CommerceRequest<EventDuplicateResult>(
    "POST", `/api/v1/internal/events/${eventId}/duplicate`, input, opts,
  );
}

/**
 * 이벤트 하드삭제(테스트 이벤트 전용). v2 가 SoT 로 **주문·티켓 0건 + 소유권**을 서버 검증한 뒤
 * cascade 삭제한다. 주문이 있으면 409(EVENT_HAS_ORDERS), 미해결 자식은 409(EVENT_HAS_DEPENDENTS),
 * 소유자 불일치 403, 이미 없으면 404(호출측이 "이미 삭제됨"으로 흡수). organizer_ref = go account_id.
 */
export function deleteEvent(eventId: string, accountId: string, opts?: RequestOptions) {
  const q = new URLSearchParams({ organizer_ref: accountId }).toString();
  return v2CommerceRequest<{ deleted: boolean; event_id: string }>(
    "DELETE", `/api/v1/internal/events/${eventId}?${q}`, undefined, opts,
  );
}

/** organizer 이벤트 목록 live read. organizerRef = organizer_id(uuid) 또는 go_account_id. status는 go 4-상태. */
export function listOrganizerEvents(
  organizerRef: string,
  params: {
    status?: string;
    limit?: number;
    offset?: number;
    /** 제목 부분일치(v2 가 ILIKE 와일드카드를 이스케이프한다). */
    search?: string;
    /** latest | oldest | created | title — go sortMap 과 1:1. */
    sort?: string;
    /** go EventType 원본 필터(v2 category 가 아님). */
    eventType?: string;
  } = {},
  opts?: RequestOptions,
) {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  if (params.search) qs.set("search", params.search);
  if (params.sort) qs.set("sort", params.sort);
  if (params.eventType) qs.set("event_type", params.eventType);
  const q = qs.toString();
  return v2CommerceRequest<{ events: EventListItem[]; total: number; limit: number; offset: number }>(
    "GET", `/api/v1/internal/organizers/${encodeURIComponent(organizerRef)}/events${q ? `?${q}` : ""}`, undefined, opts,
  );
}

// ── Slice B/C/D 배포 계약 (배치 upsert) ───────────────────────────────────────
// ★ organizer_ref 불필요(event_id가 organizer 스코프). external_ref = 멱등 upsert 키(중복생성 방지).

export interface TierUpsertInput {
  /** go productId/tierId — 멱등 upsert 키. 동일 external_ref 재호출 → 같은 v2 tier_id(중복 tier 방지). */
  external_ref?: string | null;
  name: string;
  capacity: number; // > 0
  base_price?: number;
  /** canonical 4종(domain-model.toCanonicalSaleMode 적용 후). */
  sale_mode?: string;
  face_price?: number | null;
  min_price?: number | null;
  max_price_cap?: number | null;
  sale_window?: { opens_at: string; closes_at: string } | null;
  seating_type?: string | null;
}
/**
 * 상품/티어 배치 upsert(write-through). external_ref 멱등. → {tiers:[{external_ref,tier_id}]} 매핑 반환.
 *
 * replace=true 면 이 페이로드의 external_ref 집합에 없는 **미판매(sold=0) v2 티어를 삭제**한다.
 * go 에서 지운 상품/좌석티어가 v2 에 잔존하는 팬텀 티어(min_price 오염)를 정리하는 용도
 * (GO_V2_COMMERCE_SYNC_AUDIT — 티어 DELETE sync 갭). 판매분이 있는 티어는 보호(삭제 안 됨).
 *
 * event-level 가격(1-Price): EventWriteInput 에는 event min/max 필드가 없다 — v2 가 이 upsert
 * 직후 판매가능(capacity>0) 티어의 base_price 집계로 Event.min_price/max_price 를 **자동 재계산**한다
 * (internal_commerce._do_upsert_tiers). 따라서 go 는 티어만 write-through 하면 event 가격표시가
 * read-after-write 로 정합된다(별도 event 가격 patch 불필요).
 */
export function upsertTiers(
  eventId: string,
  tiers: TierUpsertInput[],
  opts?: RequestOptions,
  replace = false,
) {
  return v2CommerceRequest<{ tiers: Array<{ external_ref?: string | null; tier_id: string }>; deleted?: number }>(
    "POST", `/api/v1/internal/events/${eventId}/tiers`, { tiers, replace }, opts);
}

export interface SeatUpsertInput {
  external_ref?: string | null;
  /** go productId(external) — tier_id 해석용 */
  tier_ref?: string | null;
  tier_id?: string | null;
  section: string;
  row_number: number;
  seat_number: number;
  quality_score?: number;
  x?: number;
  y?: number;
  label?: string | null;
  is_obstructed?: boolean;
  /** 'reserved'(organizer block) 등 명시. SOLD/HELD는 v2가 보호. */
  status?: string | null;
}
/**
 * 좌석 인벤토리 배치 upsert(write-through). external_ref 멱등 upsert. 응답에 좌석별 v2 seat_id 매핑.
 *
 * 레벨2 컷오버 T1 — `replace` 로 **레이아웃 전체교체**를 표현한다(go seats 스테이징 폐지 대응).
 * 이전에는 go 가 `DELETE FROM seats` 후 재INSERT 해 축소를 표현했으나, go 좌석이 사라진 뒤에는
 * upsert 만으로 "없어진 좌석"을 지울 수 없어 유령좌석이 재고·집계를 오염시킨다.
 *  - `replace=true`: 페이로드 external_ref 집합에 없는 좌석을 삭제. **SOLD/HELD 는 v2 가 보호**(미삭제).
 *  - `scopePrefix`: 정리 범위를 external_ref prefix 로 한정(`smseat:{mapId}:`) → 다른 맵·import
 *    경로 좌석을 오삭제하지 않는다. prefix 밖(레거시 uuid ref) 좌석은 보존.
 *  - replace=true 일 때만 빈 배열 허용(좌석 전부 제거 = 스탠딩 전용 전환).
 */
export function upsertSeats(
  eventId: string,
  seats: SeatUpsertInput[],
  opts?: RequestOptions,
  replace?: { replace: boolean; scopePrefix?: string | null },
) {
  return v2CommerceRequest<{
    count: number;
    created?: number;
    updated?: number;
    deleted?: number;
    protected?: number;
    seats: Array<{ external_ref?: string | null; section: string; row_number: number; seat_number: number; seat_id: string }>;
  }>(
    "POST",
    `/api/v1/internal/events/${eventId}/seats`,
    {
      seats,
      replace: replace?.replace ?? false,
      ...(replace?.scopePrefix != null ? { scope_prefix: replace.scopePrefix } : {}),
    },
    opts,
  );
}

// ── 레벨2 영역A — 좌석맵 템플릿(go seat_map_templates 흡수) ────────────────────
// go 는 account_id(UUID) 로 조직을 식별 → go_account_id 쿼리/organizer_ref 로 전달.

/** 좌석맵 템플릿 목록(시스템 시드 + 조직 저장). accountId 없으면 시스템 시드만. */
export function listSeatMapTemplates(
  accountId: string | null,
  category?: string | null,
  opts?: RequestOptions,
) {
  const qs = new URLSearchParams();
  if (accountId) qs.set("go_account_id", accountId);
  if (category) qs.set("category", category);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return v2CommerceRequest<{ templates: SeatMapTemplate[]; total: number }>(
    "GET",
    `/api/v1/internal/seat-map-templates${suffix}`,
    undefined,
    opts,
  );
}

/** 조직 좌석맵 템플릿 저장(write-through). 멱등키 권장. */
export function createSeatMapTemplate(
  accountId: string,
  input: SeatMapTemplateCreateInput,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<SeatMapTemplate>(
    "POST",
    `/api/v1/internal/seat-map-templates`,
    { organizer_ref: goAccountRef(accountId), ...input },
    opts,
  );
}

/** 조직 좌석맵 템플릿 삭제(write-through). 시스템 시드는 v2 가 404 로 보호. */
export function deleteSeatMapTemplate(
  templateId: string,
  accountId: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ deleted: boolean; id: string }>(
    "DELETE",
    `/api/v1/internal/seat-map-templates/${templateId}?go_account_id=${encodeURIComponent(accountId)}`,
    undefined,
    opts,
  );
}

export interface EventContentInput {
  participants?: Array<{ name: string; role?: string | null; bio?: string | null; image_url?: string | null; sort_order?: number }>;
  notices?: Array<{ title: string; notice_type?: string | null; content?: string | null; published_at?: string | null }>;
  facilities?: Array<{ name: string; category?: string | null; quantity?: number | null; status?: string | null }>;
}
/** 소비자 노출 콘텐츠 write-through. PUT 시맨틱: 제공된 섹션만 전체교체, 미제공(undefined)은 보존. */
export function upsertEventContent(eventId: string, content: EventContentInput, opts?: RequestOptions) {
  return v2CommerceRequest<{ ok: true }>("PUT", `/api/v1/internal/events/${eventId}/content`, content, opts);
}
/**
 * 소비자 노출 콘텐츠 live read(참석진/공지/시설). 응답 shape = EventContentInput(각 섹션 배열).
 * 1-B 백필의 역보정 스냅샷(백필 이전 v2 content 캡처)·정합 확인용. (get 이라 멱등키 불필요)
 */
export function getEventContent(eventId: string, opts?: RequestOptions) {
  return v2CommerceRequest<Required<EventContentInput>>(
    "GET", `/api/v1/internal/events/${eventId}/content`, undefined, opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// 트랙B U2 — event_page (랜딩 편집 write-through). go homepage_design(JSON)을 v2
// event_pages(subdomain 랜딩 SoT)로 push → 소비자 화이트라벨 /s/{slug} 가 page_theme·
// page_data(Puck) 를 소비. event_id 1:1(unique) 멱등 upsert. 매핑은 homepage-design-mapping.ts.
// ─────────────────────────────────────────────────────────────────────────────

export interface EventPageUpsertInput {
  /** subdomain_slug — 미제공 시 v2 최초 생성에서 event.slug 로 자동 파생(재호출은 기존 URL 유지). */
  subdomain_slug?: string | null;
  /** concert/festival/exhibition/conference/fanmeeting/esports/classical/sports. */
  page_template?: string | null;
  /** 색토큰(camelCase). v2 가 기존 테마와 **병합**(미전달 키 보존). */
  page_theme?: Record<string, unknown> | null;
  /** Puck JSON(`{content,root}`). v2 전체교체. 소비자 PuckRenderer 가 content>0 이면 커스텀 렌더. */
  page_data?: Record<string, unknown> | null;
  /** 페이지 빌더 섹션 배열(전체교체). */
  sections?: Array<Record<string, unknown>> | null;
  white_label?: boolean | null;
  white_label_config?: Record<string, unknown> | null;
  /** 게시 여부. go 랜딩 저장 = 게시로 취급(이벤트 status 가 실 공개 게이트). */
  page_published?: boolean | null;
}

export interface EventPageUpsertResult {
  event_id: string;
  page_id: string;
  subdomain_slug: string;
  page_published: boolean;
  created: boolean;
}

/**
 * 랜딩(event_page) write-through. event_id 1:1 upsert(멱등키 필수).
 * page_theme 는 v2 가 병합, page_data/sections/white_label_config 는 전체교체.
 * COMMIT 후 외부호출·에러 전파(V2CommerceError) — 호출부가 502 로 사용자 통지.
 */
export function upsertEventPage(
  eventId: string,
  input: EventPageUpsertInput,
  opts: RequestOptions & { idempotencyKey: string },
) {
  return v2CommerceRequest<EventPageUpsertResult>(
    "PUT", `/api/v1/internal/events/${eventId}/event-page`, input, opts);
}

// W3.2 배포 계약 (POST /internal/orders) — OrderCreateRequest (커밋 f6d422f/4b1b4a3)
export interface OrderCreateInput {
  /** 멱등 dedup 앵커(go order id) → 재시도 시 같은 canonical order_id 재생. UNIQUE. */
  external_order_id?: string | null;
  /** 회원 주문. 게스트는 user_id 생략 + buyer.email 필수(v2가 resolve-or-create). */
  user_id?: string | null;
  buyer?: { name?: string | null; email?: string | null; phone?: string | null };
  event_id: string;
  source?: string | null;
  affiliate_ref?: string | null;
  items: Array<{
    tier_id?: string | null;
    /** go productId — tier 해석(external_ref) */
    external_ref?: string | null;
    quantity: number;
    /** v2가 tier min_price/max_price_cap 범위 검증(🔴1). 동적가격은 범위 내. */
    unit_price: number;
    seat_ids?: string[]; // 지정석: len == quantity 필수 (v2 canonical seat_id)
    /** 좌석 hold bearer token — v2가 hold_id 일치=소유로 claim(익명/회원 공통, 탈취 차단). */
    hold_id?: string | null;
    /** F2/F1: daypass 지정일 초대권 — 이 라인의 티켓에 admission_day(YYYY-MM-DD) 부여. */
    admission_day?: string | null;
  }>;
  /** v2가 코드 rule로 amount 재계산(🔴1 SoT) — go의 amount는 무시됨. code 또는 code_id만 전달. */
  discount?: { code_id?: string | null; code?: string | null } | null;
  total_amount: number;
  payment_deadline?: string | null;
  /** T2-ORD: 예매 설문 응답(구 go attendees.answers) — 발권된 전 티켓에 부여된다. */
  answers?: Record<string, string | string[]> | null;
  /** T2-ORD: 주문 워크플로 메모(구 go orders.memo). */
  memo?: string | null;
  terms_agreed_at?: string | null;
}

/**
 * ⭐ 원자적 주문생성 — v2 가 orders+order_items(1:N)+tickets+ownership_transfers+discount차감
 *   +seat_tiers.sold_count+seats(hold→sold)+affiliate_conversions 를 단일 트랜잭션으로.
 * 멱등 앵커 = external_order_id(UNIQUE) → 재시도 안전(이중주문 무). 가격 SoT = v2.
 * 응답 ticket_ids/lines 로 go 가 로컬 attendee(answers/체크인)를 v2 ticket_id 에 키잉.
 */
export function createOrder(input: OrderCreateInput, opts?: RequestOptions) {
  return v2CommerceRequest<{
    order_id: string;
    external_order_id: string | null;
    status: string;
    ticket_ids: string[];
    lines: Array<{ external_ref?: string | null; tier_id: string; ticket_ids: string[] }>;
    created: boolean;
    // F4: raffle_enabled 이벤트 발권 시 v2 가 부여한 경품번호(ticket_id → 번호).
    // 초대권 표시(F5)용. raffle 미활성 이벤트면 없음(undefined).
    raffle_numbers?: Record<string, number>;
  }>("POST", "/api/v1/internal/orders", input, opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// W3.3 — 재고 hold/confirm/release + block/unblock + reaper (좌석 전용, v2 원자·멱등)
// 정본: internal_commerce.py:1860~ (HoldRequest/ConfirmRequest/ReleaseRequest/BlockRequest).
// ★ 좌석은 v2 canonical seat_id 로 식별(go seat id 아님). user_id = v2 buyer uuid.
//   GA(좌석 없는 티어)는 hold 없이 주문 시 sold_count 차감(W3.2 가 처리) — 여기선 좌석만.
// ─────────────────────────────────────────────────────────────────────────────

/** 좌석 hold(HELD, TTL). seat_ids = v2 canonical seat_id. user_id 생략=익명(held_by NULL, hold_id가 bearer). → {hold_id,expires_at,held[]} */
export function holdInventory(
  input: { event_id: string; seat_ids: string[]; user_id?: string | null; ttl_seconds?: number },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ hold_id: string; expires_at: string; held: string[] }>(
    "POST", `/api/v1/internal/inventory/hold`, input, opts);
}

/** hold 확정(HELD→SOLD). 멱등(이미 SOLD 면 confirmed 에 포함). → {hold_id,confirmed[]} */
export function confirmInventory(holdId: string, opts?: RequestOptions) {
  return v2CommerceRequest<{ hold_id: string; confirmed: string[] }>(
    "POST", `/api/v1/internal/inventory/confirm`, { hold_id: holdId }, opts);
}

/**
 * release — 두 가지 모드:
 *  1) {hold_id}: 만료/취소 hold 해제(HELD→AVAILABLE, 멱등).
 *  2) {seat_ids, reason:"refund", event_id?}: 환불 좌석해제(SOLD→AVAILABLE + 티켓 CANCELLED).
 * → {released:number}
 */
export function releaseInventory(
  input:
    | { hold_id: string }
    | { seat_ids: string[]; reason: "refund"; event_id?: string },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ released: number }>(
    "POST", `/api/v1/internal/inventory/release`, input, opts);
}

/** 좌석 판매중지(→RESERVED). SOLD/HELD 좌석은 409. → {affected:number} */
export function blockSeats(input: { event_id: string; seat_ids: string[] }, opts?: RequestOptions) {
  return v2CommerceRequest<{ affected: number }>(
    "POST", `/api/v1/internal/inventory/block`, input, opts);
}

/** 좌석 판매재개(RESERVED→AVAILABLE). → {affected:number} */
export function unblockSeats(input: { event_id: string; seat_ids: string[] }, opts?: RequestOptions) {
  return v2CommerceRequest<{ affected: number }>(
    "POST", `/api/v1/internal/inventory/unblock`, input, opts);
}

/**
 * 만료 hold/미결제주문 정리(go reaper → v2). 쿼리스트링 event_id/limit.
 * → {holds_reaped, orders_expired, seats_released}
 */
export function reapInventory(
  params: { eventId?: string; limit?: number } = {},
  opts?: RequestOptions,
) {
  const qs = new URLSearchParams();
  if (params.eventId) qs.set("event_id", params.eventId);
  if (params.limit != null) qs.set("limit", String(params.limit));
  const q = qs.toString();
  return v2CommerceRequest<{ holds_reaped: number; orders_expired: number; seats_released: number }>(
    "POST", `/api/v1/internal/inventory/reap${q ? `?${q}` : ""}`, undefined, opts);
}

// ─────────────────────────────────────────────────────────────────────────────
// W3.4 — 환불/취소 (order 상태머신 = v2 SoT, 전이검증 422). 정본: internal_commerce.py:2246~.
// ★ orderId = v2 canonical order_id(orders.v2_order_id). 부분커밋 금지 — v2 가 원자성 소유.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 주문 환불(전액/부분). full=true 는 잔여 전액 환불, cancel_all=true 는 지급액과
 * 무관하게 주문 전체 티켓·좌석 취소. 순수 금액 부분환불만 PARTIALLY_REFUNDED.
 * 멱등키 필수(중복 환불 차단). → {order_id,status,refunded,total_refunded,seats_released}
 */
export function refundOrder(
  orderId: string,
  /**
   * `allow_admitted` — 입장 완료 티켓이 있어도 환불을 강행한다(v2 기본은 422 차단).
   * 🔴 **사람이 명시 결정한 경로에서만** 켠다(우천취소 등). 자동 경로(크론·보상 드레인)는
   *    "주최자가 결정했다"는 근거가 없으므로 켜지 말고 manual_review 로 남길 것.
   */
  /**
   * `pg_already_voided` — 호출측이 **이미 provider 승인취소를 마쳤을 때만** 켠다(T16).
   * 🔴 켜면 v2 가 PG 를 다시 부르지 않는다. 잘못 켜면 돈이 안 나가고(조용함),
   *    잘못 끄면 두 번 나간다(시끄러움). 기본은 끄는 쪽이다.
   */
  input: {
    amount?: number;
    full?: boolean;
    cancel_all?: boolean;
    reason?: string;
    allow_admitted?: boolean;
    pg_already_voided?: boolean;
  },
  opts: RequestOptions & { idempotencyKey: string },
) {
  return v2CommerceRequest<{
    order_id: string;
    status: string;
    refunded: number;
    total_refunded: number;
    seats_released: number;
  }>(
    "POST",
    `/api/v1/internal/orders/${orderId}/refund`,
    input,
    // 🔴 환불은 **자동 재시도하지 않는다**(기본 retries=2 를 0 으로 덮는다).
    //    v2 의 멱등 캐시는 **성공 응답만** 저장하고 선점 락이 없다("동시성 1차 방어는 DB
    //    유니크 제약" — `_idempotent` 주석). 환불에는 그런 유니크 제약이 없다(한 주문에
    //    여러 환불 행이 정상이므로).
    //    ⟹ PG 가 10초(타임아웃)를 넘겨 클라가 abort 해도 **서버는 계속 실행 중**인데,
    //       0.5초 뒤 재시도가 캐시 미스로 producer 에 재진입한다. FOR UPDATE 는 직렬화만
    //       할 뿐이라 2차가 갱신된 잔여액으로 재검증을 **통과**해 같은 델타를 또 집행한다.
    //       (10,000 원 부분환불 1회 지시 → 20,000 원 집행)
    //    돈이 나가는 호출은 "모르면 다시 걸지 않는다" 가 맞다. 실패는 운영자가 확인 후 재시도한다.
    { ...opts, retries: 0 },
  );
}

/**
 * 라인(티켓) 단위 부분취소/환불. v2 `PartialRefundService.process_partial_refund` 의 internal 노출.
 * items 의 각 ticket_id 를 CANCELLED + 좌석 release + 해당 line_amount 환불(amount 생략 시 자동 산출).
 * 마지막 잔여 티켓 취소 시 주문 REFUNDED, 그 외 PARTIALLY_REFUNDED. 멱등키 필수(중복 환불 차단).
 * → {order_id,status,refunded,seats_released,cancelled_ticket_ids}
 * ⚠️ v2 backend 선행 배포 필요(신규 internal 엔드포인트). 미배포 시 404/501 → 호출부에서 폴백 처리.
 */
export function refundOrderItems(
  orderId: string,
  input: { items: Array<{ ticket_id: string; amount?: number }>; reason?: string },
  opts: RequestOptions & { idempotencyKey: string },
) {
  return v2CommerceRequest<{
    order_id: string;
    status: string;
    refunded: number;
    seats_released: number;
    cancelled_ticket_ids: string[];
  }>(
    "POST",
    `/api/v1/internal/orders/${orderId}/refund-items`,
    input,
    // refundOrder 와 같은 이유로 자동 재시도 금지 — 돈이 나가는 호출이다.
    { ...opts, retries: 0 },
  );
}

/**
 * 미결제 주문 취소(PENDING/PAYMENT_REQUIRED). 좌석/티켓 release. 결제완료 주문은 422(환불 사용).
 * 멱등키 필수. → {order_id,status:"cancelled",seats_released}
 */
export function cancelOrder(
  orderId: string,
  input: { reason?: string },
  opts: RequestOptions & { idempotencyKey: string },
) {
  return v2CommerceRequest<{ order_id: string; status: string; seats_released: number }>(
    "POST", `/api/v1/internal/orders/${orderId}/cancel`, input, opts);
}

/**
 * 신뢰경로 결제확정 (manual/group/comp 주문 — go/외부에서 결제완결). PG 검증 생략(go 신뢰).
 * PAYMENT_REQUIRED/PENDING/AUTHORIZED → CONFIRMED + 티켓 ACTIVE + fee 동결. 이미 confirmed면 멱등. terminal 422.
 * 소비자 PG결제(/orders/{id}/pay)와 별개. 멱등키 권장.
 */
export function confirmOrderPayment(
  orderId: string,
  input: { amount?: number } = {},
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ order_id: string; status: string; captured_at: string | null }>(
    "POST", `/api/v1/internal/orders/${orderId}/confirm-payment`, input, opts);
}

/**
 * 나이스페이(구형) 결제창 provider_params — go self-checkout 주문의 결제개시.
 *
 * 나이스 구형 결제창(goPay 폼 POST)은 서버가 계산한 payForm(MID·Moid·Amt·EdiDate·SignData·
 * GoodsName·ReturnURL·MallReserved·PayMethod)을 클라로 내려줘야 한다(SignData 입력 MerchantKey 는
 * v2 전용 시크릿 — go 는 서명 계산 불가). v2 가 `PaymentService.initiate_payment` 로 payForm 을
 * 계산하고 provider_params 로 반환한다.
 *
 * ⚠️ success_url="go" 는 origin 센티넬 — v2 return 핸들러가 MallReserved 를 읽어 go 전역 랜딩
 *    (NICEPAY_GO_SUCCESS_URL)으로 302 redirect 하게 한다. 실제 목적지 URL 은 v2 config 소유
 *    (open-redirect 차단). pay_method 는 서버가 화이트리스트 정규화(오염값→CARD).
 *
 * ⚠️ 이 엔드포인트(`/internal/orders/{id}/payment/prepare`)는 **backend-dev 배선 선결**이다.
 *    go self-checkout 은 회원/게스트 토큰 없이 서비스 토큰으로 주문을 만들므로, 회원(get_current_user)·
 *    게스트(view 토큰) prepare 를 재사용할 수 없다 → 서비스 토큰 인증 + external_ref(=go order id)
 *    매칭으로 initiate_payment 를 재사용하는 internal prepare 가 필요하다. 미배선 시 404/에러가
 *    반환되고, 호출부는 이를 흡수해 provider_params 없이(=mock/데모) 진행한다(라이브 조용한 실패 금지).
 */
export function prepareNicePayment(
  v2OrderId: string,
  input: { success_url: string; fail_url: string; pay_method?: string | null; idempotency_key?: string | null },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{
    order_id: string;
    provider: string;
    payment_id: string;
    amount: number;
    currency: string;
    redirect_url: string;
    payment_deadline: string;
    status: string;
    provider_params?: { js_url: string; form: Record<string, string> } | null;
  }>("POST", `/api/v1/internal/orders/${v2OrderId}/payment/prepare`, input, opts);
}

// 가격 수정자(promo/affiliate/discount) — v2 가 주문 시 적용
// Slice D 배포 계약 — discount codes 배치 upsert (used_count 보존, v2가 주문시 코드rule 재계산).
export interface DiscountCodeInput {
  code: string;
  discount_type: "percentage" | "fixed";
  rate?: number | null;
  amount?: number | null;
  max_uses?: number | null;
  valid_from?: string | null;
  valid_until?: string | null;
  applicable_tiers?: string | null;
  min_order_amount?: number | null;
  max_discount_amount?: number | null;
  description?: string | null;
  is_active?: boolean;
}
export function upsertDiscountCodes(eventId: string, codes: DiscountCodeInput[], opts?: RequestOptions) {
  return v2CommerceRequest<{ codes: Array<{ code: string; discount_code_id: string }> }>(
    "POST", `/api/v1/internal/events/${eventId}/discount-codes`, { codes }, opts);
}

/**
 * SPEC rev2.1 §2.7 — fee plan 미러 (정률+정액).
 * go fee plan(platform_fee_plans, 기본 3%+₩300)을 v2 FeeSchedule(event 레벨)로 push →
 * v2 get_fee_rates(event→organizer→platform) 해석으로 **청구=정산 자동 일치**.
 * ⚠️ platform_fee_fixed(₩300) 누락 시 정산 어긋남 — fee_type·fixed 반드시 전송.
 */
export interface FeePlanInput {
  fee_type: "percentage" | "fixed" | "percentage_plus_fixed";
  platform_fee_rate: number;   // 0.03
  platform_fee_fixed: number;  // 300 (정수원)
  pg_fee_rate?: number;
  pg_fee_fixed?: number;
}
/** 이벤트 fee plan (SLICE-A §2.7). 개설 직후 호출(주문 전 fee 확정). 멱등키 필수. */
export function upsertEventFeePlan(eventId: string, input: FeePlanInput, opts: RequestOptions & { idempotencyKey: string }) {
  return v2CommerceRequest<{ ok: true }>("PUT", `/api/v1/internal/events/${eventId}/fee-plan`, input, opts);
}
// ─────────────────────────────────────────────────────────────────────────────
// Wave3 W3.1 — affiliate(정의 write/read) + 티켓 체크인(상태=v2 SoT)
// 배포 계약: internal_commerce.py:1363~ (커밋 4384f3b)
// ─────────────────────────────────────────────────────────────────────────────

export interface AffiliateInput {
  /** go affiliate id (멱등 upsert 키) */
  external_ref?: string | null;
  account_id?: string | null;
  name: string;
  code: string;
  /** percent 0–100 (예: 10.0). v2가 범위검증. */
  commission_rate: number;
  status?: string; // 기본 'active'
}

/** 제휴 정의 배치 upsert(write-through). v2가 주문 시 affiliate_ref로 conversion 원자기록. */
export function upsertAffiliates(eventId: string, affiliates: AffiliateInput[], opts?: RequestOptions) {
  return v2CommerceRequest<{
    event_id: string;
    affiliates: Array<{ external_ref?: string | null; affiliate_id: string; code: string }>;
  }>("PUT", `/api/v1/internal/events/${eventId}/affiliates`, { affiliates }, opts);
}

/** 제휴 목록 live read(+전환 집계). commission_total = 원 단위 BIGINT. */
export function listAffiliates(eventId: string, opts?: RequestOptions) {
  return v2CommerceRequest<{
    affiliates: Array<{
      affiliate_id: string; external_ref?: string | null; account_id?: string | null;
      name: string; code: string; commission_rate: number; status: string;
      conversion_count: number; commission_total: number;
    }>;
    total: number;
  }>("GET", `/api/v1/internal/events/${eventId}/affiliates`, undefined, opts);
}

/** 제휴 상세 + 전환목록 live read. affiliateRef = go affiliate id. 금액=원 단위 BIGINT.
 *  conversion.order_ref = go order id → 표시 주문번호는 go orders 앵커에서 매핑. */
export function getAffiliateDetail(eventId: string, affiliateRef: string, opts?: RequestOptions) {
  return v2CommerceRequest<{
    affiliate: {
      affiliate_id: string; external_ref?: string | null; account_id?: string | null;
      name: string; code: string; commission_rate: number; status: string;
      created_at: string | null;
    };
    conversions: Array<{
      id: string; order_ref: string | null;
      order_amount: number; commission_amount: number; created_at: string | null;
    }>;
  }>("GET", `/api/v1/internal/events/${eventId}/affiliates/${affiliateRef}`, undefined, opts);
}

/** 제휴 부분수정 write-through. affiliateRef = go affiliate id. code 불변. */
export function patchAffiliate(
  eventId: string,
  affiliateRef: string,
  patch: { name?: string; commission_rate?: number; status?: string },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ affiliate_id: string; external_ref?: string | null; updated: boolean }>(
    "PATCH", `/api/v1/internal/events/${eventId}/affiliates/${affiliateRef}`, patch, opts,
  );
}

/** 제휴 soft-delete write-through. 전환·수수료 증거는 보존한다. */
export function deleteAffiliate(eventId: string, affiliateRef: string, opts?: RequestOptions) {
  return v2CommerceRequest<{ deleted: boolean; soft_deleted?: boolean; already_absent?: boolean }>(
    "DELETE", `/api/v1/internal/events/${eventId}/affiliates/${affiliateRef}`, undefined, opts,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// F4 — 경품 추첨 실행/이력 (체크인자 풀·재현가능 seed). 정본: internal_commerce.py:1842~.
// ★ eventId = v2 canonical event_id(events.v2_event_id). 추첨 풀 = 체크인 완료자(raffle_number).
//   go 라우트가 이벤트 소유검증 후 서비스토큰으로 호출. seed 공개, 결과 감사가능·재현가능.
// ─────────────────────────────────────────────────────────────────────────────

export interface RaffleDrawResult {
  draw_id: string;
  event_id: string;
  draw_key: string | null;
  seed: string;
  winner_count: number;
  pool_size: number;
  /** 당첨 raffle_number 목록(추첨 순서 보존). 수신자 매핑은 v2 미제공(현 계약). */
  winning_numbers: number[];
  executed_by: string | null;
  executed_at: string | null;
}

/**
 * 추첨 실행(write). 체크인 완료자(raffle_number 부여분) 풀에서 seed 로 시드된 결정적 RNG 비복원 추출.
 * raffle 미활성 이벤트 → 409(RAFFLE_DISABLED). 풀 비면 409(POOL_EMPTY). winner_count<=0 → 400.
 * draw_key 멱등: 같은 (event, draw_key) 재실행 → 기존 결과 재생(이중 추첨 방지).
 * 멱등키(Idempotency-Key) 필수 — 네트워크 재시도 시 중복 실행 방지.
 */
export function runRaffleDraw(
  eventId: string,
  input: { winner_count: number; seed: string; executed_by?: string | null; draw_key?: string | null },
  opts: RequestOptions & { idempotencyKey: string },
) {
  return v2CommerceRequest<RaffleDrawResult>(
    "POST", `/api/v1/internal/events/${eventId}/raffle/draw`, input, opts);
}

/** 추첨 실행 이력 조회(read). 최신순. → {draws:[...]}. */
export function listRaffleDraws(eventId: string, opts?: RequestOptions) {
  return v2CommerceRequest<{ draws: RaffleDrawResult[] }>(
    "GET", `/api/v1/internal/events/${eventId}/raffle/draws`, undefined, opts);
}

/**
 * 티켓 체크인 — 입장 멱등 SoT=v2 event_admissions(per-day 원장). 오늘 재스캔→already:true.
 * F1 다일: allpass 는 매일 입장(status ACTIVE 유지), daypass/single 은 입장 시 USED.
 * CANCELLED/EXPIRED·입장일 아님 → 422. go 현장도구는 이걸 호출 + go-local 로그(집계 SoT)도 기록.
 * admission_mode(single|daypass|allpass)·attended_date(KST YYYY-MM-DD)는 F1 신규 필드.
 */
export function checkInTicket(ticketId: string, input: { at?: string } = {}, opts?: RequestOptions) {
  return v2CommerceRequest<{
    ticket_id: string;
    checked_in_at: string;
    status: string;
    already: boolean;
    // §13 당일 재입장: admitted(최초입장) | reentry_ok(당일 재스캔=정상 재입장). 실제 차단은 4xx.
    outcome?: "admitted" | "reentry_ok";
    admission_mode?: string;
    attended_date?: string;
  }>("POST", `/api/v1/internal/tickets/${ticketId}/check-in`, input, opts);
}

/**
 * 입장 취소(오스캔 복구) — §13 체크인 undo/취소. 특정 (ticket, attended_date) 입장 원장 삭제 +
 * 유일 입장이면 status USED→ACTIVE·first_checked_in_at 리셋(재입장 허용). 멱등: 없으면 revoked:false.
 * 부작용(포인트·NFT) 자동 회수는 v2 정책상 보류(별도 정산). 동시 취소 안전(티켓 FOR UPDATE).
 */
export function revokeAdmission(
  ticketId: string,
  input: { attended_date?: string; reason?: string } = {},
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{
    ticket_id: string;
    revoked: boolean;
    attended_date: string;
    was_last_admission: boolean;
    status_reverted: boolean;
    first_checked_in_reset: boolean;
    status: string;
  }>("POST", `/api/v1/internal/tickets/${ticketId}/revoke-admission`, input, opts);
}

// ═════════════════════════════════════════════════════════════════════════════
// READ-CLUSTER (빅뱅 read-flip D) — go DB JOIN → v2 live 집계 read.
// 정본: pickket.v2/backend/app/api/v1/internal_commerce_read.py (§7~14 + 정정6).
// ★ 매출 모델 단일: revenue_gross / refund_amount / net_revenue. go 헤드라인 = net_revenue.
// ★ soldCount(sold) = refunded 제외. organizer_ref = string 그대로(go account_id 또는 v2 uuid).
// 모든 응답 타입은 v2 _ok({...}) 의 data dict 기준(봉투는 v2CommerceRequest 가 이미 unwrap).
// ═════════════════════════════════════════════════════════════════════════════

/** §공통 — 일별 매출 행(net 기준). */
export interface DailySalesPoint { date: string; amount: number; count: number }
/** §공통 — 티어(=go product)별 판매/매출. sold = refunded 제외. */
export interface ProductSalesRow { tier_id: string; name: string; sold: number; revenue: number }

// ── §7 GET /events/{id}/dashboard ────────────────────────────────────────────
export interface EventDashboard {
  summary: {
    total_orders: number;
    total_attendees: number;
    total_revenue: number;   // = net_revenue (go 헤드라인)
    net_revenue: number;
    revenue_gross: number;
    refund_amount: number;
    checked_in_count: number;
  };
  daily_sales: DailySalesPoint[];
  product_sales: ProductSalesRow[];
}
/** §7 이벤트 대시보드 live read. */
export function getEventDashboard(eventId: string, opts?: RequestOptions) {
  return v2CommerceRequest<EventDashboard>(
    "GET", `/api/v1/internal/events/${eventId}/dashboard`, undefined, opts);
}

// ── §8 GET /organizers/{ref}/dashboard ───────────────────────────────────────
export interface OrganizerDashboard {
  today_revenue: number; today_orders: number;
  this_week_revenue: number; this_week_orders: number;
  last_week_revenue: number; last_week_orders: number;
  active_check_ins: number;
  low_stock_count: number;
}
/** §8 조직 대시보드 live read. organizerRef = go account_id 또는 v2 organizer uuid(string 그대로). */
export function getOrganizerDashboard(organizerRef: string, opts?: RequestOptions) {
  return v2CommerceRequest<OrganizerDashboard>(
    "GET", `/api/v1/internal/organizers/${encodeURIComponent(organizerRef)}/dashboard`, undefined, opts);
}

// ── §9 GET /events/{id}/reports?type=sales|products|attendees|promo ───────────
export type EventReportType = "sales" | "products" | "attendees" | "promo";
export interface SalesReport {
  type: "sales";
  daily_sales: DailySalesPoint[];
  total_revenue: number;   // = net_revenue
  revenue_gross: number;
  total_orders: number;
  avg_order_value: number;
  refunded_amount: number;
}
export interface ProductsReport {
  type: "products";
  items: Array<ProductSalesRow & { stock: number }>;
  summary: { total_sold: number; total_revenue: number; total_stock: number };
}
export interface AttendeesReport {
  type: "attendees";
  daily_registrations: Array<{ date: string; count: number }>;
  total_attendees: number;
  checked_in_count: number;
  check_in_rate: number;
}
export interface PromoReport {
  type: "promo";
  // discount_total: 고정할인=amount×used_count, 정률=null(OrderDiscount 영속화 후속)
  items: Array<{ code: string; promo_type: string; usage_count: number; discount_total: number | null }>;
}
export type EventReport<T extends EventReportType> =
  T extends "sales" ? SalesReport :
  T extends "products" ? ProductsReport :
  T extends "attendees" ? AttendeesReport :
  T extends "promo" ? PromoReport :
  never;
/** §9 리포트 live read. type 별 응답 분기(sales/products/attendees/promo). */
export function getEventReports<T extends EventReportType>(
  eventId: string, type: T, opts?: RequestOptions,
) {
  return v2CommerceRequest<EventReport<T>>(
    "GET", `/api/v1/internal/events/${eventId}/reports?type=${type}`, undefined, opts);
}

// ── §10 GET /events/{id}/seat-analytics (funnel=null) ─────────────────────────
export interface SeatAnalytics {
  status_counts: Record<string, number>;
  tier_stats: Array<{ tier_id: string; name: string; capacity: number; sold: number; base_price: number; fill_rate: number }>;
  section_top_revenue: Array<{ section: string; sold: number; revenue: number }>;
  funnel: null; // seat_funnel_events 미존재 — funnel 은 go-local boundary(seat_funnel_events 직접 읽음)
}
/** §10 좌석 분석 live read. funnel 은 항상 null(go-local boundary). */
export function getSeatAnalytics(eventId: string, opts?: RequestOptions) {
  return v2CommerceRequest<SeatAnalytics>(
    "GET", `/api/v1/internal/events/${eventId}/seat-analytics`, undefined, opts);
}

// ── §11 GET /events/{id}/analytics/revenue-intelligence ───────────────────────
export interface RevenueIntelligence {
  kpis: {
    total_revenue: number;   // = net_revenue
    revenue_gross: number;
    total_orders: number;
    avg_order_value: number;
    unique_buyers: number;
    refund_rate: number;
    refund_amount: number;
  };
  by_product: ProductSalesRow[];
  promo_codes: Array<{ code: string; usage: number }>;
}
// ── §12 GET /organizers/{ref}/settlements ─────────────────────────────────────
export interface SettlementRow {
  settlement_id: string;
  event_title: string | null;   // v2 settlement=organizer·period 집계 → 항상 null
  period_start: string | null;
  period_end: string | null;
  gross_amount: number;
  platform_fee: number;
  platform_fee_rate: number;     // = platform_fee / gross_amount (gross>0), else 0
  pg_fee: number;
  refund_amount: number;
  net_amount: number;
  order_count: number;           // 기간 내 매출대상(_REVENUE_STATUSES) 주문수
  status: string;
  paid_at: string | null;        // 정산 입금완료 시각
  memo: string | null;           // = dispute_reason
  // 정산 입금정보(organizer User) — 행마다 동일 값(organizer 단위)
  bank_name: string | null;
  account_number: string | null;
  account_holder: string | null;
}
export interface SettlementsResult {
  settlements: SettlementRow[];
  total: number;
  limit: number;
  offset: number;
  month_summary: { gross_amount: number; platform_fee: number; net_amount: number };
}
/** §12 정산 목록 live read. limit 기본 50(최대 200). */
export function listSettlements(
  organizerRef: string,
  params: { limit?: number; offset?: number } = {},
  opts?: RequestOptions,
) {
  const qs = new URLSearchParams();
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  const q = qs.toString();
  return v2CommerceRequest<SettlementsResult>(
    "GET", `/api/v1/internal/organizers/${encodeURIComponent(organizerRef)}/settlements${q ? `?${q}` : ""}`, undefined, opts);
}

// ── §13 GET /organizers/{ref}/search?q= ───────────────────────────────────────
export interface OrganizerSearchResult {
  events: Array<{ event_id: string; title: string; slug: string | null; status: string }>;       // status = go 4-상태 투영
  orders: Array<{
    order_id: string;
    /** = go order id. 주문 상세·환불 라우트가 이 값으로 조회한다(v2 id 로는 404). */
    external_order_id?: string | null;
    order_number: string;        // = external_ref (없으면 order_id)
    event_id: string;
    buyer_name: string | null;
    buyer_email: string | null;
    status: string;              // = go 6-상태 투영
    ordered_at: string | null;
  }>;
  attendees: Array<{
    ticket_id: string;
    event_id: string;
    name: string | null;         // order.buyer_name → owner User.name 폴백
    email: string | null;        // order.buyer_email → owner User.email 폴백
  }>;
}
/** §13 통합 검색 live read. q 빈 문자열이면 전체 like(%%). limit 기본 20(최대 100). */
export function searchOrganizer(
  organizerRef: string,
  params: { q?: string; limit?: number } = {},
  opts?: RequestOptions,
) {
  const qs = new URLSearchParams();
  qs.set("q", params.q ?? "");
  if (params.limit != null) qs.set("limit", String(params.limit));
  return v2CommerceRequest<OrganizerSearchResult>(
    "GET", `/api/v1/internal/organizers/${encodeURIComponent(organizerRef)}/search?${qs.toString()}`, undefined, opts);
}

// ── §14 GET /events/{id}/orders ───────────────────────────────────────────────
import type { PaymentAttemptSummary } from "@/lib/orders/payment-attempt-label";

export interface OrderListRow {
  order_id: string;
  external_ref: string | null;
  order_number: string;     // = external_ref (없으면 order_id) — go 주문번호 표시용
  buyer_name: string | null;
  buyer_email: string | null;
  total_amount: number;
  paid_amount: number;      // 고객 실결제액(= 청구 total_amount)
  total_refunded: number;   // net = total_amount − total_refunded
  status: string;           // go 6-상태 투영
  payment_method: string | null;
  /**
   * 🔴 결제 시도 요약 — 「결제창 이탈」과 「결제 실패」를 가르는 근거 (2026-08-10).
   * 구버전 v2 는 안 준다 → `undefined`(화면은 아무 말도 하지 않는다).
   */
  payment_attempts?: PaymentAttemptSummary;
  /**
   * 🔴 초대권·수동발권 구분 — 목록에서 **매출로 세면 안 되는 주문**을 가른다.
   *    v2 가 이미 판정해서 내려준다(기본값 없음). 구버전은 안 준다 → `undefined`(모름).
   * ⚠️ `undefined` 를 `false` 로 접지 않는다. 판정은 `@/lib/orders/issue-source` 하나로만.
   */
  is_invitation?: boolean;
  is_manual_issue?: boolean;
  ordered_at: string | null;
}
export interface OrderListResult {
  orders: OrderListRow[];
  total: number;
  limit: number;
  offset: number;
  /**
   * 🔴 **v2 가 실제로 적용한** 필터 에코. 미지정이면 `null` 이고 **키는 항상 있다**(v2 73f11c9b).
   *
   * ⚠️ 우리가 보낸 값이 아니라 **v2 가 돌려준 값**이다. 둘이 다르면 필터가 안 먹은 것이고,
   *    그때 화면이 조용히 전체를 보여주면 발주처가 그걸 「실판매 N건」으로 읽는다.
   *    구버전 v2 는 이 키 자체가 없다(`undefined`) — 그것도 미적용 신호다.
   */
  issue_source?: string | null;
}
/** §14 주문 목록 live read. status = go 6-상태(v2 가 역투영). q = order_number(external_ref)/buyer 검색. limit 기본 50(최대 200). */
export function listOrders(
  eventId: string,
  params: {
    status?: string;
    q?: string;
    limit?: number;
    offset?: number;
    /** `sale`(실판매) | `issued`(초대권·수동발권). 미지정이면 전체. */
    issueSource?: string;
  } = {},
  opts?: RequestOptions,
) {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.q) qs.set("q", params.q);
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  // v2 계약: `issue_source=sale|issued` (73f11c9b). 응답이 **적용된 값**을 에코한다.
  if (params.issueSource) qs.set("issue_source", params.issueSource);
  const q = qs.toString();
  return v2CommerceRequest<OrderListResult>(
    "GET", `/api/v1/internal/events/${eventId}/orders${q ? `?${q}` : ""}`, undefined, opts);
}

// ── §14 GET /events/{id}/attendees ────────────────────────────────────────────
export interface AttendeeListRow {
  ticket_id: string;
  order_id: string | null;
  owner_user_id: string | null;
  name: string | null;             // order.buyer_name → owner User.name 폴백
  email: string | null;            // order.buyer_email → owner User.email 폴백
  phone: string | null;            // order.buyer_phone (owner 폴백 없음)
  status: string;                  // v2 ticket status 원본(소문자)
  checked_in_at: string | null;
  product_name: string | null;
  seat_id: string | null;
  tier_id: string | null;             // #1b 체크인 리스트 product_ids 매칭용
  product_external_ref: string | null; // = go productId
  // T2-ORD: v2 가 go attendees.ticket_number 를 흡수 — 더 이상 항상 null 이 아니다.
  ticket_number: string | null;
  raffle_number: number | null;
}
export interface AttendeeListResult {
  attendees: AttendeeListRow[];
  total: number;
  limit: number;
  offset: number;
}
/** §14 참석자(=ticket) 목록 live read. status = checked_in | v2 ticket status. q = buyer/owner name·email 검색. limit 기본 100(최대 500). */
export function listAttendees(
  eventId: string,
  params: { status?: string; q?: string; limit?: number; offset?: number } = {},
  opts?: RequestOptions,
) {
  const qs = new URLSearchParams();
  if (params.status) qs.set("status", params.status);
  if (params.q) qs.set("q", params.q);
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  const q = qs.toString();
  return v2CommerceRequest<AttendeeListResult>(
    "GET", `/api/v1/internal/events/${eventId}/attendees${q ? `?${q}` : ""}`, undefined, opts);
}

// ── §14 export — CSV 평문(text/csv) ───────────────────────────────────────────
/** §14 주문 CSV export. 평문 text/csv 그대로 반환(JSON 봉투 아님). */
export function exportOrders(eventId: string, opts?: RequestOptions) {
  return v2CommerceRequestText(`/api/v1/internal/events/${eventId}/orders/export`, opts);
}
/** §14 참석자 CSV export. 평문 text/csv 그대로 반환. */
export function exportAttendees(eventId: string, opts?: RequestOptions) {
  return v2CommerceRequestText(`/api/v1/internal/events/${eventId}/attendees/export`, opts);
}

// ── 정정6 GET /events/{id}/live (실시간 스냅샷, no-store) ──────────────────────
export interface EventLiveSnapshot {
  net_revenue: number;
  order_count: number;
  checked_in_count: number;
  total_attendees: number;   // 진행률 분모(체크인율)
  stock_remaining: number;
  total_stock: number;       // 잔여 재고 바 분모
  ts: string;
}
/** 정정6 실시간 대시보드 스냅샷(폴링용). 캐시 금지(v2 no-store). */
export function getEventLive(eventId: string, opts?: RequestOptions) {
  return v2CommerceRequest<EventLiveSnapshot>(
    "GET", `/api/v1/internal/events/${eventId}/live`, undefined, opts);
}

// ── 정정6 GET /events/{id}/analytics/forecast ─────────────────────────────────
export interface ForecastResult { daily_sales: DailySalesPoint[] }
// ── 정정6 GET /events/{id}/reports/export — 매출 리포트 CSV ────────────────────
// ── GET /events/{id}/seats — 좌석 목록 + 상태 집계 live read (status SoT) ──────
// 정본: internal_commerce.py list_seats. ★ v2EventId = v2 canonical event_id(events.v2_event_id).
// status = v2 SoT(available|held|reserved|sold|blocked 등). external_ref = go seat id(매핑 키).
// status_counts = 상태별 집계(blocked 포함). total_seats = 이벤트 전체 좌석수(status_counts 합).
export interface SeatReadRow {
  seat_id: string;
  external_ref: string | null; // = go seat id (upsertSeats 멱등키)
  tier_id: string | null;
  section: string;
  row_number: number;
  seat_number: number;
  status: string; // v2 SoT 상태(소문자)
  quality_score: number | null;
  // 레벨2 2차 A2 — 커머스 좌표 이중보관(list_seats 응답). 빌더 GET read-flip 이 x/y/label/is_obstructed 소비.
  x: number | null;
  y: number | null;
  label: string | null;
  is_obstructed: boolean;
}
export interface SeatListResult {
  seats: SeatReadRow[];
  status_counts: Record<string, number>;
  total_seats: number; // status_counts 합 (이벤트 전체 좌석수)
  page_count: number; // 이번 페이지 반환 좌석수
  limit: number;
  offset: number;
}
/**
 * 좌석 목록 + 상태 집계 live read. ★ v2EventId 는 v2 canonical event_id(events.v2_event_id).
 * status 가 v2 SoT — go-local seats.status(stale) 대신 표시/집계에 사용.
 * limit 기본 2000(최대 5000). 5000석 초과 이벤트는 offset 페이지네이션 필요.
 */
export function listSeats(
  v2EventId: string,
  params: { limit?: number; offset?: number } = {},
  opts?: RequestOptions,
) {
  const qs = new URLSearchParams();
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  const q = qs.toString();
  return v2CommerceRequest<SeatListResult>(
    "GET", `/api/v1/internal/events/${v2EventId}/seats${q ? `?${q}` : ""}`, undefined, opts);
}

// ── GET /events/{id}/tiers — 티어 목록 live read(soldCount SoT) ────────────────
// 정본: internal_commerce.py list_tiers (_tier_dict). ★ eventId = v2 canonical event_id.
// external_ref = go product/tier id(멱등 upsert 키) → go 앵커와 매칭. sold_count = refunded 제외(좌석 존재 시 seats 집계).
export interface TierReadRow {
  tier_id: string;
  external_ref: string | null;
  name: string;
  capacity: number;
  base_price: number;
  sale_mode: string | null;
  sale_window: { opens_at: string | null; closes_at: string | null };
  sold_count: number;
  fill_rate: number;
  /**
   * 🔴 공개 판매 가능 여부의 정본. v2 `_tier_dict` 가 이미 싣고 있는데 여기 선언이 없어
   *    **공개 구매 경로가 이 값을 볼 수 없었다**(2026-08-01).
   *    `"hidden"`/`"private"` = 주최자만 발급하는 티어(초대권 등).
   */
  visibility?: string | null;
  /** 판매 중단된 티어. v2 `is_active=false` 면 어느 경로로도 팔면 안 된다. */
  is_active?: boolean | null;
}
export interface TierListResult {
  tiers: TierReadRow[];
  total: number;
}
/** 티어 목록 live read. ★ eventId 는 v2 canonical event_id(events.v2_event_id). sold_count = 판매수 SoT. */
export function listTiers(v2EventId: string, opts?: RequestOptions) {
  return v2CommerceRequest<TierListResult>(
    "GET", `/api/v1/internal/events/${v2EventId}/tiers`, undefined, opts);
}

/**
 * 레벨2 read-flip 편의: 티어 목록을 go productId(=external_ref) → TierReadRow 맵으로 반환.
 *
 * 금액·재고 정본 read 의 단일 진입점. go products.price/stock 직접 read 를 이 맵으로 대체한다.
 *   - 금액 정본: tier.base_price (go products.price 는 write-through 로 v2 tier.base_price 와 동일 보장).
 *   - 재고 정본: tier.capacity − tier.sold_count (sold_count = 환불 제외 판매 SoT).
 *
 * external_ref 가 NULL 인 티어(go 앵커 없이 v2 에서 생성된 티어)는 맵에서 제외한다.
 * V2CommerceError 는 전파(호출자가 502/폴백 결정) — 조용한 0원/0재고 강등 금지.
 */
export async function getTiersByEvent(
  v2EventId: string,
  opts?: RequestOptions,
): Promise<Map<string, TierReadRow>> {
  const result = await listTiers(v2EventId, opts);
  const map = new Map<string, TierReadRow>();
  for (const tier of result.tiers) {
    if (tier.external_ref) {
      map.set(tier.external_ref, tier);
    }
  }
  return map;
}

// ═════════════════════════════════════════════════════════════════════════════
// 단건 READ + 정산 freeze/patch (빅뱅 flip #1/#1b/#5)
// 정본: internal_commerce_read.py get_order(612~)/get_ticket(695~)/get_settlement(660~)
//       internal_commerce.py freeze_settlement(2567)/patch_settlement(2590).
// ★ orderId/ticketId/settlementId = v2 canonical UUID. organizerRef = string(go account_id 또는 v2 uuid).
// 모든 응답 타입은 v2 _ok({...}) data dict 기준(봉투 unwrap 은 v2CommerceRequest 가 처리).
// ═════════════════════════════════════════════════════════════════════════════

// ── #1 GET /orders/{order_id} — 단건 주문 상세(items + tickets) ────────────────
export interface OrderDetailItem {
  tier_id: string | null;
  external_ref: string | null;   // = go productId (tier 멱등 앵커)
  product_name: string | null;
  quantity: number;
  unit_price: number;
  line_amount: number;
  seat_id: string | null;
}
export interface OrderDetailTicket {
  ticket_id: string;
  status: string;                // v2 ticket status 원본(소문자)
  seat_id: string | null;
  tier_id: string | null;
  checked_in_at: string | null;
}
export interface OrderDetail {
  order_id: string;
  external_order_id: string | null;
  order_number: string;          // = external_ref (없으면 order_id)
  event_id: string;
  buyer: { name: string | null; email: string | null; phone: string | null };
  status: string;                // go 6-상태 투영
  status_v2: string;             // v2 원본 상태
  total_amount: number;
  total_refunded: number;        // net = total_amount − total_refunded
  paid_amount: number;           // 고객 실결제액(= total_amount)
  platform_fee: number | null;   // fee 동결 전이면 null
  net_amount: number | null;     // fee 동결 전이면 null
  payment_method: string | null; // = pg_provider
  /**
   * PG 결제가 이미 걸려 있는 주문인지(v2 `orders.payment_id` 존재 여부).
   * 🔴 go `orders.payment_method` 는 소비자 체크아웃 주문도 `offline` 로 적어 두 경우를
   * 구분하지 못한다 — 무통장 입금확정 대상 판정에는 **반드시 이 값**을 써야 한다.
   * 구버전 v2 응답에는 없을 수 있어 optional.
   */
  has_pg_payment?: boolean;
  /**
   * 이 주문이 **초대권**에서 나왔는지(v2 가 그 주문의 티켓 `answers._invitationId` 로 판정).
   * 🔴 결제수단으로는 판정할 수 없다 — `offline` 은 주최자 **수동 주문**의 정당한 값이고,
   * `free` 는 **무료 티켓**에도 쓰인다. 둘 중 하나로 읽으면 멀쩡한 주문이 초대권으로 둔갑한다.
   * 구버전 v2 응답에는 없을 수 있어 optional(없으면 지금 그대로 결제수단 라벨).
   */
  is_invitation?: boolean;
  /**
   * 주최자가 **발권 화면에서 직접 만든 0원 주문**인지(v2 가 티켓 `answers._manualIssue` 로 판정).
   * 🔴 같은 발권 라우트가 `payment_method='offline'` 도 적어서 화면이 「현장결제」로 떴다 —
   * 돈을 받은 적이 없는데. `offline` 은 주최자 **수동 주문**의 정당한 값이기도 해서
   * 결제수단으로는 갈리지 않는다. 구버전 v2 응답에는 없을 수 있어 optional.
   */
  is_manual_issue?: boolean;
  /** 🔴 결제 시도 요약 — 목록과 **같은 값**이어야 한다(담당자가 다시 캐지 않게). */
  payment_attempts?: PaymentAttemptSummary;
  ordered_at: string | null;
  items: OrderDetailItem[];
  tickets: OrderDetailTicket[];
}
/**
 * #1 단건 주문 상세 live read. orderId = v2 canonical order_id(orders.v2_order_id).
 * receipt/invoice/refund base 모두 이 응답 하나로 구성(go-local orders JOIN 대체).
 * 미존재 시 V2CommerceError(404 ORDER_NOT_FOUND).
 */
export function getOrder(orderId: string, opts?: RequestOptions) {
  return v2CommerceRequest<OrderDetail>(
    "GET", `/api/v1/internal/orders/${orderId}`, undefined, opts);
}

// ── #1b GET /tickets/{ticket_id} — 단건 티켓 ───────────────────────────────────
export interface TicketDetail {
  ticket_id: string;
  /** T2-ORD: 소비자 티켓 URL 키(구 go attendees.ticket_number). v2 가 go 와 동일 공식으로 생성. */
  ticket_number: string | null;
  status: string;                // v2 SoT 상태(소문자)
  checked_in_at: string | null;
  /**
   * 🔴 **오늘(KST) 입장했는가** — 라이브 화면 전환의 유일한 근거.
   *
   * `checked_in_at` 으로 판정하면 안 된다. 그건 티켓당 **하나의 시각**이라, 주중권처럼
   * 이틀짜리 티켓은 1일차에 입장하면 값이 남고 **2일차에 QR 이 사라진다.**
   * v2 는 날짜별 원장(`event_admissions`)을 보고 이 값을 따로 준다.
   *
   * ⚠️ `undefined` = v2 구버전이라 **모른다**. 모르면 QR 을 그대로 보여준다
   *    (`@/lib/live/gate` 참고). truthy 검사로 흘리면 입장 전인 사람의 QR 이 사라진다.
   */
  admitted_today?: boolean;
  seat_id: string | null;
  tier_id: string | null;
  product_name: string | null;
  product_external_ref: string | null; // = go productId (체크인 리스트 product_ids 매칭)
  raffle_number: number | null;        // T2-ORD: F4 경품 응모번호(v2 SoT)
  answers: Record<string, string | string[]> | null; // T2-ORD: 예매 설문 응답(구 go attendees.answers)
  /** W2-PUB — 발급 시각(구 go `attendees.created_at`). 초대권 화면 표시용. */
  issued_at?: string | null;
  event_id: string;
  event: {
    starts_at: string | null;
    title: string | null;
    organizer_id: string | null;
    external_ref: string | null;
    /**
     * W2-ORD(가산): 소유 테넌트(go accounts.id). 티켓 산출물(QR/PDF/지갑) 접근제어에서
     * go `events.account_id` 를 읽던 **유일한 이유**를 대체한다. v2 네이티브 주최자는 null.
     */
    go_account_id?: string | null;
    /** W2-ORD(가산): 표시용 공연장명(구 go `events.venue_name`). */
    venue?: string | null;
  };
  order: {
    id: string | null;
    order_number: string | null;
    /**
     * W2-PUB — go order id 원본(v2 `orders.external_ref`). `order_number` 는 external_ref
     * 부재 시 v2 order id 로 폴백하므로 "go 주문 id" 판별용으로 쓰면 안 된다.
     */
    external_ref?: string | null;
    buyer: { name: string | null; email: string | null; phone: string | null } | null;
    /**
     * 🔴 같은 주문의 티켓 전부(자기 포함, **초대권 제외**) — 「N장 샀는데 QR 이 하나」를 푼다.
     *
     * 구매완료 알림톡·메일의 딥링크는 첫 장 하나뿐이고 티켓 화면에도 나머지로 가는 길이
     * 없었다. prod 실측(2026-08-19): 유료 복수구매 54명·120장 중 **64장이 링크로 닿지 않았다.**
     *
     * ⚠️ `undefined` = v2 구버전이라 **모른다**. 전환 줄을 띄우지 않는다(빈 배열과 같게 다룬다).
     *    있지도 않은 티켓으로 넘기는 것보다 종전 화면이 낫다.
     * ⚠️ 초대권은 v2 가 이미 뺀다 — 장마다 주인이 다르므로 여기 섞이면 남의 티켓이 열린다.
     */
    tickets?: Array<{
      ticket_number: string;
      status: string;
      /** F1 daypass 지정일(YYYY-MM-DD). 없으면 행사 전체. */
      admission_day: string | null;
    }>;
  };
}
/**
 * #1b 단건 티켓 live read. ticketId = v2 canonical ticket_id.
 * 체크인 도구·공개 티켓 검증의 상태 SoT(go-local 티켓 stale 대신). 미존재 시 V2CommerceError(404 TICKET_NOT_FOUND).
 */
export function getTicket(ticketId: string, opts?: RequestOptions) {
  return v2CommerceRequest<TicketDetail>(
    "GET", `/api/v1/internal/tickets/${ticketId}`, undefined, opts);
}

/**
 * T2-ORD 단건 티켓 live read — **티켓번호 키**. go `attendees.ticket_number` 를 v2 가 흡수한 뒤의
 * 소비자 티켓 진입점(`/tickets/{n}`·QR·PDF·Apple/Google 지갑)용.
 * 번호 체계가 go 와 동일해 이미 배포된 링크가 그대로 유효하다. 미존재 시 V2CommerceError(404).
 */
export function getTicketByNumber(ticketNumber: string, opts?: RequestOptions) {
  return v2CommerceRequest<TicketDetail>(
    "GET", `/api/v1/internal/tickets/by-number/${encodeURIComponent(ticketNumber)}`, undefined, opts);
}

// ── #5 GET /organizers/{ref}/settlements/{id} — 단건 정산 ──────────────────────
// 응답 shape 은 §12 SettlementRow 와 동일(단건). event_title 필드는 없음(organizer·period 집계).
export interface SettlementDetail {
  settlement_id: string;
  organizer_id: string;
  period_start: string | null;
  period_end: string | null;
  gross_amount: number;
  platform_fee: number;
  platform_fee_rate: number;     // = platform_fee / gross_amount (gross>0), else 0
  pg_fee: number;
  refund_amount: number;
  net_amount: number;
  order_count: number;           // 기간 내 매출대상 주문수
  status: string;                // draft|pending_review|reviewed|approved|paid|disputed
  paid_at: string | null;
  memo: string | null;           // = dispute_reason
  bank_name: string | null;      // organizer 정산계좌(여러 정산 공통)
  account_number: string | null;
  account_holder: string | null;
}
/**
 * #5 단건 정산 live read. organizerRef = go account_id 또는 v2 organizer uuid(string 그대로).
 * 미존재/타 organizer 정산 시 V2CommerceError(404 SETTLEMENT_NOT_FOUND).
 */
export function getSettlement(organizerRef: string, settlementId: string, opts?: RequestOptions) {
  return v2CommerceRequest<SettlementDetail>(
    "GET",
    `/api/v1/internal/organizers/${encodeURIComponent(organizerRef)}/settlements/${settlementId}`,
    undefined, opts);
}

// ── #5 POST /organizers/{ref}/settlements — 정산 동결(freeze) ──────────────────
export interface SettlementFreezeInput {
  /** ISO datetime — 정산 기간 시작(inclusive). */
  period_start: string;
  /** ISO datetime — 정산 기간 끝(exclusive). period_end > period_start 필수. */
  period_end: string;
  /** 지정 시 해당 이벤트들만 집계(생략 시 organizer 전체 이벤트). v2 uuid. */
  event_ids?: string[] | null;
}
export interface SettlementFreezeResult {
  settlement_id: string;
  organizer_id: string;
  gross_amount: number;
  platform_fee: number;
  pg_fee: number;
  refund_amount: number;
  net_amount: number;            // = gross − platform_fee − pg_fee − refund
  order_count: number;
  status: string;                // 항상 "draft"(동결 직후)
}
/**
 * #5 정산 동결(write-through). 기간 내 매출대상 주문(CONFIRMED/PAID/(PARTIALLY_)REFUNDED)을
 * 집계해 OrganizerSettlement 행 생성(status=draft). 멱등키 필수(중복 동결 차단 — 동일 키/지문 재호출은 재생).
 * period_end ≤ period_start 면 V2CommerceError(400 VALIDATION_ERROR).
 */
export function freezeSettlement(
  organizerRef: string,
  input: SettlementFreezeInput,
  opts: RequestOptions & { idempotencyKey: string },
) {
  return v2CommerceRequest<SettlementFreezeResult>(
    "POST",
    `/api/v1/internal/organizers/${encodeURIComponent(organizerRef)}/settlements`,
    input, opts);
}

// ── #5 PATCH /organizers/{ref}/settlements/{id} — 정산 갱신 ────────────────────
export interface SettlementPatchInput {
  /** draft|pending_review|reviewed|approved|paid|disputed. 그 외 값은 400. */
  status?: string | null;
  /** organizer 정산계좌(여러 정산 공통 — User 레벨 갱신). */
  bank_name?: string | null;
  account_number?: string | null;
  account_holder?: string | null;
  /** = dispute_reason(메모). */
  memo?: string | null;
  /** ISO datetime — 입금완료 시각. */
  paid_at?: string | null;
}
/**
 * #5 정산 갱신(write-through). status/은행정보/memo/paid_at 부분 갱신.
 * 은행정보는 organizer User 정산계좌(여러 정산 공통)에 반영. 멱등키 필수.
 * 미존재/타 organizer 정산 시 V2CommerceError(404). 잘못된 status 값은 400.
 * → {settlement_id, status, paid_at}
 */
export function updateSettlement(
  organizerRef: string,
  settlementId: string,
  input: SettlementPatchInput,
  opts: RequestOptions & { idempotencyKey: string },
) {
  return v2CommerceRequest<{ settlement_id: string; status: string; paid_at: string | null }>(
    "PATCH",
    `/api/v1/internal/organizers/${encodeURIComponent(organizerRef)}/settlements/${settlementId}`,
    input, opts);
}

// ── 레벨2 3.4a: 조직자 단체메시지/캠페인 발송 v2 재배선 ──────────────────────
// go 주최자 단체발송/캠페인 route 가 go DB event_messages/email_campaigns 에 쓰고 go cron 이
// 발송하던 경로를 v2 조직자 메시징 SoT(EventMessage 생성 + Celery dispatch 큐잉)로 흡수한다.
// 발송 자체는 v2 Celery beat 가 소유(dispatch_messages/dispatch_campaigns). 이 함수들은 큐잉만.
// ⚠️ ORGANIZER_MESSAGING_V2_ENABLED 원자 컷오버: v2 라우터도 동일 flag OFF 면 409(미개시).

/** go event_messages 저장 채널 — push 는 조직자 발송 미지원. */
export type OrganizerMessageChannel = "email" | "sms" | "alimtalk";

export interface CreateMessageInput {
  /** go account_id(조직자 스코프 키) — v2 EventMessage.account_id 로 그대로 저장. */
  go_account_id: string;
  /** go/v2 공유 event_id. */
  event_id: string;
  title: string;
  body: string;
  channel: OrganizerMessageChannel;
  /** go 가 §3-1 deriveMessageType 로 서버강제한 값(v2 는 재판정 없이 신뢰·발송 시 게이트 재검사). */
  message_type: "informational" | "advertising";
  recipient_filter?: "all" | "checked_in" | "not_checked_in";
  segment?: Record<string, unknown> | null;
  template_code?: string | null;
  /** ISO8601 — 미래면 v2 status=scheduled(Celery 가 시각 도달 시 드레인). */
  scheduled_at?: string | null;
  /** 감사 메타(recipientCount/purpose/messageTypeReason) — go 가 계산해 그대로 저장. */
  result_meta?: Record<string, unknown> | null;
}

export interface CreateMessageResult {
  message_id: string;
  status: string;
  scheduled: boolean;
}

/**
 * 단체메시지/캠페인 생성 → v2 EventMessage(queued|scheduled). 발송은 v2 Celery 가 드레인.
 * 멱등키 필수(재시도 중복 생성 방지). 미존재 flag(OFF) 시 V2CommerceError(409).
 */
export function createOrganizerMessage(
  input: CreateMessageInput,
  opts: RequestOptions & { idempotencyKey: string },
) {
  return v2CommerceRequest<CreateMessageResult>(
    "POST",
    `/api/v1/internal/events/${input.event_id}/messages`,
    input,
    opts,
  );
}

/**
 * 메시지 재발송 요청 → v2 EventMessage status=queued(sent/failed 에서만). account/event 경계 검증.
 * 이미 발송된 수신자는 v2 원장 멱등으로 스킵, 실패/미처리만 재시도.
 */
export function requeueOrganizerMessage(
  messageId: string,
  scope: { go_account_id: string; event_id: string },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ message_id: string; status: string }>(
    "POST",
    `/api/v1/internal/messages/${messageId}/requeue`,
    scope,
    opts,
  );
}

export interface TestSendInput {
  go_account_id: string;
  channel: OrganizerMessageChannel;
  to: string;
  title?: string;
  body: string;
  message_type?: "informational" | "advertising";
  template_code?: string | null;
}

/**
 * 본인 테스트 발송(단발, 원장 미기록) → v2 dispatch_one. provider 스텁이면 502(PROVIDER_UNWIRED).
 * 게이트 제외 시 422(SEND_SKIPPED). 성공 시 {status:'sent', request_id}.
 */
export function testSendOrganizerMessage(input: TestSendInput, opts?: RequestOptions) {
  return v2CommerceRequest<{ status: string; request_id?: string | null }>(
    "POST",
    `/api/v1/internal/messages/test-send`,
    input,
    opts,
  );
}

// ── Level2 B2-3: outbound webhook subscriptions/delivery live on v2 ──────────

export interface V2WebhookSubscription {
  /** go-facing stable id (= external_ref), used by organizer route URLs. */
  id: string;
  subscription_id: string;
  external_ref: string | null;
  name: string;
  url: string;
  /** Full only in create/regenerate response; otherwise masked by v2. */
  secret: string;
  event_types: string[];
  is_active: boolean;
  created_at: string | null;
  updated_at: string | null;
  created?: boolean;
}

export interface V2WebhookDelivery {
  id: string;
  event_type: string;
  status: string;
  response_code: number | null;
  response_body: string | null;
  attempts: number;
  next_retry_at: string | null;
  created_at: string | null;
  delivered_at: string | null;
}

export function listWebhookSubscriptions(eventId: string, opts?: RequestOptions) {
  return v2CommerceRequest<{
    webhooks: V2WebhookSubscription[];
    total: number;
  }>("GET", `/api/v1/internal/events/${eventId}/webhooks`, undefined, opts);
}

export function createWebhookSubscription(
  eventId: string,
  input: {
    external_ref: string;
    name: string;
    url: string;
    event_types: string[];
  },
  opts: RequestOptions & { idempotencyKey: string },
) {
  return v2CommerceRequest<V2WebhookSubscription>(
    "POST",
    `/api/v1/internal/events/${eventId}/webhooks`,
    input,
    opts,
  );
}

export function getWebhookSubscription(
  eventId: string,
  externalRef: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<V2WebhookSubscription & {
    deliveries: V2WebhookDelivery[];
  }>(
    "GET",
    `/api/v1/internal/events/${eventId}/webhooks/${encodeURIComponent(externalRef)}`,
    undefined,
    opts,
  );
}

export function patchWebhookSubscription(
  eventId: string,
  externalRef: string,
  patch: {
    name?: string;
    url?: string;
    event_types?: string[];
    is_active?: boolean;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<V2WebhookSubscription>(
    "PATCH",
    `/api/v1/internal/events/${eventId}/webhooks/${encodeURIComponent(externalRef)}`,
    patch,
    opts,
  );
}

export function deleteWebhookSubscription(
  eventId: string,
  externalRef: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ deleted: boolean }>(
    "DELETE",
    `/api/v1/internal/events/${eventId}/webhooks/${encodeURIComponent(externalRef)}`,
    undefined,
    opts,
  );
}

export function regenerateWebhookSecret(
  eventId: string,
  externalRef: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ id: string; secret: string }>(
    "POST",
    `/api/v1/internal/events/${eventId}/webhooks/${encodeURIComponent(externalRef)}/regenerate`,
    undefined,
    opts,
  );
}

export function queueWebhookTest(
  eventId: string,
  externalRef: string,
  opts: RequestOptions & { idempotencyKey: string },
) {
  return v2CommerceRequest<{ delivery_id: string; queued: boolean }>(
    "POST",
    `/api/v1/internal/events/${eventId}/webhooks/${encodeURIComponent(externalRef)}/test`,
    undefined,
    opts,
  );
}

export function dispatchWebhookEvent(
  eventId: string,
  eventType: string,
  payload: Record<string, unknown>,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ delivery_ids: string[]; queued: number }>(
    "POST",
    `/api/v1/internal/events/${eventId}/webhooks/dispatch`,
    { event_type: eventType, payload },
    opts,
  );
}

export function replayInterServiceWebhook(
  eventId: string,
  deliveryId: string,
  opts: RequestOptions & { idempotencyKey: string },
) {
  return v2CommerceRequest<{
    status: "queued";
    original_delivery_id: string;
    delivery_id: string;
  }>(
    "POST",
    `/api/v1/internal/events/${eventId}/webhooks/inter-service/${deliveryId}/replay`,
    undefined,
    opts,
  );
}

// ── Level2 B2-2: anonymous purchase queue lives on v2 Redis ─────────────────

export interface V2QueueStatus {
  position: number;
  total_waiting: number;
  is_active: boolean;
  estimated_wait_seconds: number;
  /** Short-lived purchase admission token; distinct from the session token. */
  token: string | null;
}

export function joinQueueV2(
  eventId: string,
  sessionToken: string,
  maxConcurrent: number,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<V2QueueStatus>(
    "POST",
    `/api/v1/internal/events/${eventId}/queue/join`,
    {
      session_token: sessionToken,
      max_concurrent: maxConcurrent,
    },
    opts,
  );
}

export function getQueueStatusV2(
  eventId: string,
  sessionToken: string,
  opts?: RequestOptions,
) {
  const token = encodeURIComponent(sessionToken);
  return v2CommerceRequest<V2QueueStatus>(
    "GET",
    `/api/v1/internal/events/${eventId}/queue/status?session_token=${token}`,
    undefined,
    opts,
  );
}

export function leaveQueueV2(
  eventId: string,
  sessionToken: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ success: boolean }>(
    "POST",
    `/api/v1/internal/events/${eventId}/queue/leave`,
    { session_token: sessionToken },
    opts,
  );
}

export function consumeQueueAdmissionV2(
  eventId: string,
  input: {
    session_token: string;
    access_token: string;
    purchase_key: string;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ accepted: boolean; replayed: boolean }>(
    "POST",
    `/api/v1/internal/events/${eventId}/queue/consume`,
    input,
    opts,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 레벨2 컷오버 T2-REST — go 전용 원장 2종의 v2 이관 클라이언트
//   · tax_invoices       (세금계산서/현금영수증 발행 원장 = 규제 데이터)
//   · seat_funnel_events (좌석 선택 퍼널 텔레메트리)
// 둘 다 v2 에 대응물이 없어 go DB 폐기 시 무성 소실되던 데이터다. v2 신설(ctrest_0727)
// 후 go 는 직접 SQL 대신 이 클라이언트만 사용한다.
// ─────────────────────────────────────────────────────────────────────────────

export interface TaxInvoiceRecord {
  id: string;
  order_id: string;
  receipt_type: "tax_invoice" | "cash_receipt";
  business_number: string | null;
  company_name: string | null;
  identity_tail: string | null;
  amount: number;
  tax_amount: number;
  status: "requested" | "issued" | "cancelled";
  provider: string | null;
  issued_at: string | null;
  meta: Record<string, unknown>;
  created_at: string | null;
}

export interface TaxInvoiceRecordInput {
  receipt_type: "tax_invoice" | "cash_receipt";
  amount: number;
  tax_amount?: number;
  business_number?: string | null;
  company_name?: string | null;
  /** 현금영수증 식별번호는 **원문 전송 금지** — 마스킹된 꼬리 4자리만. */
  identity_tail?: string | null;
  provider?: string | null;
  status?: "requested" | "issued" | "cancelled";
  meta?: Record<string, unknown>;
}

/**
 * 세금계산서/현금영수증 발행 **원장 기록**(v2 정본). 실제 발행 호출은 go 가 수행하고
 * 그 결과를 meta 로 넘긴다 = v2 는 기록만 담당(외부호출과 원장 쓰기의 경계 분리).
 *
 * 멱등: v2 가 (order_id, receipt_type) 부분 유니크(status<>'cancelled')로 중복을 봉쇄하고,
 * 경합 시 승자 행을 `created:false` 로 재생한다 → 더블클릭/재시도가 2건을 만들지 않는다.
 * (go 원본 SQL 에는 멱등장치가 아예 없어 중복 발행이 가능했다 — 이관하며 교정.)
 */
export function recordTaxInvoice(
  v2OrderId: string,
  accountId: string,
  input: TaxInvoiceRecordInput,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ invoice: TaxInvoiceRecord; created: boolean }>(
    "POST",
    `/api/v1/internal/orders/${v2OrderId}/tax-invoice`,
    { organizer_ref: goAccountRef(accountId), ...input },
    opts,
  );
}

export type SeatFunnelStep =
  | "view" | "hover" | "select" | "hold" | "checkout" | "complete" | "abandon";

/**
 * 좌석 퍼널 이벤트 1건 수집. **fail-soft** 계약 — 호출자는 실패를 삼켜야 한다
 * (분석 수집이 구매 경로를 막으면 안 된다). v2 도 미존재 event/알 수 없는 step 을
 * 에러 대신 `accepted:false` 로 조용히 버린다.
 *
 * 멱등키 없음이 **의도**다: 집계가 COUNT(DISTINCT session_id) 라서 중복 삽입이 결과를
 * 바꾸지 않는다 → at-least-once 수집으로 충분하다.
 */
export function collectSeatFunnelEvent(
  v2EventId: string,
  input: {
    seat_map_id?: string | null;
    session_id: string;
    step: SeatFunnelStep;
    seat_count?: number | null;
    meta?: Record<string, unknown>;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ accepted: boolean; reason?: string }>(
    "POST",
    `/api/v1/internal/events/${v2EventId}/seat-funnel`,
    input,
    opts,
  );
}

export interface SeatFunnelAggregate {
  funnel: Record<SeatFunnelStep, number>;
  dropoff_rate: {
    view_to_select: number;
    select_to_hold: number;
    hold_to_checkout: number;
    checkout_to_complete: number;
  };
  window_days: number;
}

/** 단계별 고유 세션 집계 + 이탈률. 이벤트 소유 organizer 로 스코프된다. */
export function getSeatFunnel(
  v2EventId: string,
  accountId: string,
  days: number = 7,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<SeatFunnelAggregate>(
    "GET",
    `/api/v1/internal/events/${v2EventId}/seat-funnel?organizer_ref=${encodeURIComponent(accountId)}&days=${days}`,
    undefined,
    opts,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 레벨2 컷오버 W2-EVT — go `organizers` / `event_organizers` 흡수 (v2 마이그 w2evt_0727)
//
// go 에만 있던 두 테이블을 v2 로 옮겼다.
//  - go `organizers`        → v2 `event_hosts`       (주최자 표기 엔티티 카탈로그, 계정당 N개)
//  - go `event_organizers`  → v2 `event_host_links`  (이벤트↔호스트 M:N, 역할·표시순서)
//
// ⚠️ v2 기존 `organizer_profiles`(user 1:1 사업자 프로필) / `organizer_team_members`(v2 user 기반
//    협업자)와는 **다른 개념**이다. go `organizers` 는 v2 user 계정이 없는 순수 표기용 엔티티라
//    재사용이 불가능해 별도 모델을 신설했다.
//
// 🔴 테넌트 경계: 모든 호출에 `organizer_ref`(go accounts.id)를 넘긴다. v2 가 organizer 경계를
//    강제하며 불일치는 404 다 — 옛 `AND account_id = $2` 의 1:1 대체다. 빠뜨리면 크로스테넌트 누출.
// ─────────────────────────────────────────────────────────────────────────────

/** 주최자 표기 엔티티(옛 go `organizers` 행). */
export interface EventHost {
  host_id: string;
  name: string;
  slug: string;
  description: string | null;
  email: string | null;
  phone: string | null;
  logo_url: string | null;
  contact_public: boolean;
  is_published: boolean;
  created_at: string | null;
  updated_at: string | null;
}

/** 이벤트에 연결된 호스트 1건(옛 go `event_organizers` JOIN `organizers`). */
export interface EventHostLink {
  link_id: string;
  host_id: string;
  role: "host" | "coordinator" | "sponsor";
  display_order: number;
  name: string;
  slug: string;
  logo_url: string | null;
  contact_public: boolean;
  email: string | null;
  phone: string | null;
}

export interface EventHostInput {
  name: string;
  slug: string;
  description?: string | null;
  email?: string | null;
  phone?: string | null;
  logo_url?: string | null;
  contact_public?: boolean;
  is_published?: boolean;
  /** go organizers.id 보존용(백필 훅). 지정 시 그 UUID 를 PK 로 사용하며 동일 소유면 멱등 upsert. */
  host_id?: string;
}

/** 계정의 호스트 카탈로그 목록. */
export function listEventHosts(accountId: string, opts?: RequestOptions) {
  const q = new URLSearchParams({ organizer_ref: accountId }).toString();
  return v2CommerceRequest<{ hosts: EventHost[] }>(
    "GET", `/api/v1/internal/event-hosts?${q}`, undefined, opts,
  );
}

/** 호스트 생성. slug 중복(계정 스코프) → 409. */
export function createEventHost(accountId: string, input: EventHostInput, opts?: RequestOptions) {
  return v2CommerceRequest<EventHost>(
    "POST", `/api/v1/internal/event-hosts`, { organizer_ref: accountId, ...input }, opts,
  );
}

/** 호스트 단건. 미존재/타 계정 → 404. */
export function getEventHost(accountId: string, hostId: string, opts?: RequestOptions) {
  const q = new URLSearchParams({ organizer_ref: accountId }).toString();
  return v2CommerceRequest<EventHost>(
    "GET", `/api/v1/internal/event-hosts/${encodeURIComponent(hostId)}?${q}`, undefined, opts,
  );
}

/** 호스트 수정(slug 는 불변). 미존재/타 계정 → 404. */
export function patchEventHost(
  accountId: string,
  hostId: string,
  patch: Omit<EventHostInput, "slug" | "host_id" | "name"> & { name?: string },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<EventHost>(
    "PATCH", `/api/v1/internal/event-hosts/${encodeURIComponent(hostId)}`,
    { organizer_ref: accountId, ...patch }, opts,
  );
}

export interface EventHostDeleteResult {
  deleted: boolean;
  needs_unlink: boolean;
  linked_event_count: number;
  unlinked_event_count: number;
}

/**
 * 호스트 삭제. `unlink=false`(기본) 이고 연결 이벤트가 있으면 삭제하지 않고
 * `{deleted:false, needs_unlink:true}` 로 프론트 확인을 유도한다(옛 go 동작 보존).
 */
export function deleteEventHost(
  accountId: string,
  hostId: string,
  unlink: boolean,
  opts?: RequestOptions,
) {
  const q = new URLSearchParams({
    organizer_ref: accountId,
    unlink: unlink ? "true" : "false",
  }).toString();
  return v2CommerceRequest<EventHostDeleteResult>(
    "DELETE", `/api/v1/internal/event-hosts/${encodeURIComponent(hostId)}?${q}`, undefined, opts,
  );
}

/** 이벤트의 호스트 연결 목록. 이벤트 미존재/타 계정 → 404. */
export function listEventHostLinks(accountId: string, eventId: string, opts?: RequestOptions) {
  const q = new URLSearchParams({ organizer_ref: accountId }).toString();
  return v2CommerceRequest<{ hosts: EventHostLink[] }>(
    "GET", `/api/v1/internal/events/${encodeURIComponent(eventId)}/hosts?${q}`, undefined, opts,
  );
}

/**
 * 이벤트의 호스트 연결 전체 교체(옛 go DELETE+INSERT 트랜잭션의 1:1 대체).
 * host 역할 0개 → 400, 타 계정 host_id 포함 → 400(부분 반영 없음). 이벤트 미존재/타 계정 → 404.
 */
export function putEventHostLinks(
  accountId: string,
  eventId: string,
  hosts: Array<{ host_id: string; role: "host" | "coordinator" | "sponsor"; display_order: number }>,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ hosts: EventHostLink[] }>(
    "PUT", `/api/v1/internal/events/${encodeURIComponent(eventId)}/hosts`,
    { organizer_ref: accountId, hosts }, opts,
  );
}

/**
 * 이벤트 여러 건의 호스트 연결을 한 번에 조회(목록 화면 N+1 회피).
 * ⚠️ 타 계정 이벤트 id 는 응답 키에서 **빠진다**(존재 노출 금지) — 호출측은 누락을 빈 배열로 취급.
 */
export function batchEventHostLinks(
  accountId: string,
  eventIds: string[],
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ hosts_by_event: Record<string, EventHostLink[]> }>(
    "POST", `/api/v1/internal/event-hosts/batch`,
    { organizer_ref: accountId, event_ids: eventIds }, opts,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// W2-PS (레벨2 컷오버 wave2) — 상품/좌석등급 카탈로그 계약
//
// go `products` / `seat_tiers` 를 없애기 위해 v2 tier 계약을 **가산 확장**한다.
// 기존 `TierUpsertInput` / `TierReadRow` / `upsertTiers` / `listTiers` 는 손대지 않는다
// (병렬 트랙 충돌 회피 + 옛 호출자 계약 불변). 새 필드가 필요한 호출부만 아래를 쓴다.
//
// 정본: platform/backend internal_commerce.py — TierUpsert / _tier_dict / delete_tier.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * go `products` / `seat_tiers` 메타 전량. v2 `_tier_dict` 의 W2-PS 확장분.
 *
 * ⚠️ `stock_limit` vs `capacity`
 *   - `stock_limit` = 주최자가 입력한 재고 **원본**. `null` = 무제한, `0` = 재고 없음.
 *   - `capacity`    = v2 가 집행하는 값(무제한이면 1,000,000 sentinel).
 *   재고 표시/폼 초기값은 **반드시 `stock_limit`** 을 써야 한다. capacity 를 쓰면 무제한 상품이
 *   "재고 1,000,000개"로 보인다.
 */
export interface TierProductMeta {
  stock_limit: number | null;
  description: string | null;
  product_type: string | null;   // ticket | addon | bundle | donation
  visibility: string | null;     // public | private | hidden
  tax_rate: number | null;
  tax_included: boolean | null;
  image_url: string | null;
  sort_order: number | null;
  min_per_order: number | null;
  max_per_order: number | null;
  is_active: boolean | null;
  bundle_items: Array<{ productId: string; quantity: number }> | null;
  color_hex: string | null;
  seat_map_id: string | null;
  tier_metadata: Record<string, unknown> | null;
  face_price: number | null;
  min_price: number | null;
  max_price_cap: number | null;
  section_name: string | null;
  seating_type: string | null;
  view_description: string | null;
  distance_from_stage: number | null;
  view_rating: number | null;
  view_image_url: string | null;
  position_label: string | null;
  resale_allowed: boolean | null;
  resale_max_price: number | null;
  allow_group_tickets: boolean | null;
  max_group_size: number | null;
}

/** `listTiers` 응답 + W2-PS 메타. 같은 엔드포인트이고 필드만 더 읽는다. */
export type TierCatalogRow = TierReadRow & TierProductMeta;

/**
 * 티어 목록 live read(메타 포함).
 *
 * 🔴 실패를 흡수하지 않는다 — V2CommerceError 를 그대로 던진다. 재고/가격 조회 실패를
 *    빈 목록·0원·0석으로 뭉개면 매진·무료로 보인다(호출부가 503 으로 통지해야 한다).
 */
export function listTierCatalog(v2EventId: string, opts?: RequestOptions) {
  return v2CommerceRequest<{ tiers: TierCatalogRow[]; total: number }>(
    "GET", `/api/v1/internal/events/${v2EventId}/tiers`, undefined, opts);
}

/**
 * upsert 입력(메타 포함).
 *
 * ⚠️ `TierUpsertInput` 과의 결정적 차이: 아래 nullable 메타는 **키를 보냈는지**로 판정된다
 *    (v2 `model_fields_set`). 즉 `stock_limit: null` 을 보내면 "무제한으로 되돌림"이고,
 *    키를 아예 빼면 "기존 값 보존"이다. 부분 수정 시 의도치 않은 초기화를 피하려면
 *    바꿀 키만 실어라.
 */
export interface TierCatalogUpsertInput extends TierUpsertInput {
  stock_limit?: number | null;
  description?: string | null;
  product_type?: string | null;
  visibility?: string | null;
  tax_rate?: number | null;
  tax_included?: boolean | null;
  image_url?: string | null;
  sort_order?: number | null;
  min_per_order?: number | null;
  max_per_order?: number | null;
  is_active?: boolean | null;
  bundle_items?: Array<{ productId: string; quantity: number }> | null;
  color_hex?: string | null;
  seat_map_id?: string | null;
  tier_metadata?: Record<string, unknown> | null;
  section_name?: string | null;
  view_description?: string | null;
  distance_from_stage?: number | null;
  view_rating?: number | null;
  view_image_url?: string | null;
  position_label?: string | null;
  resale_allowed?: boolean | null;
  resale_max_price?: number | null;
  allow_group_tickets?: boolean | null;
  max_group_size?: number | null;
}

/** 상품/티어 배치 upsert(메타 포함). `upsertTiers` 와 동일 엔드포인트·동일 멱등 규칙. */
export function upsertTierCatalog(
  eventId: string,
  tiers: TierCatalogUpsertInput[],
  opts?: RequestOptions,
  replace = false,
) {
  return v2CommerceRequest<{ tiers: Array<{ external_ref?: string | null; tier_id: string }>; deleted?: number }>(
    "POST", `/api/v1/internal/events/${eventId}/tiers`, { tiers, replace }, opts);
}

/**
 * 티어 단건 삭제. `tierRef` = external_ref(go product/tier id) 또는 v2 tier_id.
 *
 * v2 가 fail-closed 로 판정한다:
 *   - 404 미존재/타 이벤트 · 409 판매분 있음(sold>0) · 409 좌석 붙어 있음.
 * 🔴 호출부는 404 를 "이미 없음 → 성공"으로 흡수하기 전에, 조회 실패(5xx)와 반드시 구분해야 한다.
 */
export function deleteTier(eventId: string, tierRef: string, opts?: RequestOptions) {
  return v2CommerceRequest<{ event_id: string; tier_id: string; deleted: boolean }>(
    "DELETE",
    `/api/v1/internal/events/${eventId}/tiers/${encodeURIComponent(tierRef)}`,
    undefined,
    opts,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// W2-PUB — 공개(비인증) 경로 read (레벨2 컷오버 wave2)
// 정본: internal_commerce_read.py public_events / public_stats / public_ticket_lookup.
// go `events`·`attendees` 공개 SELECT 의 대체. 실패는 **전파**한다 —
// 공개 화면이 "빈 목록"으로 위장되면 판매중인 이벤트가 조용히 사라진다.
// ═════════════════════════════════════════════════════════════════════════════

/** 공개 목록 1행 — 구 go `SELECT ... FROM events WHERE status='live'` 의 컬럼 대응. */
export interface PublicEventListItem {
  event_id: string;
  external_ref: string | null;
  slug: string;
  title: string;
  summary: string | null;
  description: string | null;
  venue: string | null;
  venue_address: string | null;
  event_type: string | null;
  category: string;
  age_rating: string | null;
  is_online: boolean;
  event_date: string | null;
  event_date_end: string | null;
  image_url: string | null;
  image_variants: Record<string, string> | null;
  /** go 4-상태 투영. 서버가 이미 live 만 내려주지만 호출측 재확인용으로 실려온다. */
  status: string;
  sale_channels: string[];
  total_seats: number | null;
  attendee_count: number;
  tier_count: number;
  updated_at: string | null;
}

/**
 * 공개 이벤트 목록 live read.
 *
 * @param channel `marketplace` 등 판매 채널 필터(go `'marketplace' = ANY(sale_channels)`).
 *   미지정 = 채널 무관 전체 live(사이트맵·랜딩 그리드).
 * @param sort `date`(event_date ASC, 기본) | `updated`(updated_at DESC, 사이트맵).
 *
 * ⚠️ 상태 게이트는 **v2 가 강제**한다(draft/paused/archived 미포함) — 상세 by-slug 와 다르다.
 */
export function listPublicEventsV2(
  params: { channel?: string; sort?: "date" | "updated"; limit?: number; offset?: number } = {},
  opts?: RequestOptions,
) {
  const qs = new URLSearchParams();
  if (params.channel) qs.set("channel", params.channel);
  if (params.sort) qs.set("sort", params.sort);
  if (params.limit != null) qs.set("limit", String(params.limit));
  if (params.offset != null) qs.set("offset", String(params.offset));
  const q = qs.toString();
  return v2CommerceRequest<{
    events: PublicEventListItem[];
    total: number;
    limit: number;
    offset: number;
  }>("GET", `/api/v1/internal/public/events${q ? `?${q}` : ""}`, undefined, opts);
}

/** 랜딩 소셜프루프 집계. ⚠️ 분모가 플랫폼 전체(v2) — go DB 만 세던 예전 수치보다 크다. */
export interface PublicStats {
  event_count: number;
  live_event_count: number;
  ticket_count: number;
}

export function getPublicStatsV2(opts?: RequestOptions) {
  return v2CommerceRequest<PublicStats>("GET", "/api/v1/internal/public/stats", undefined, opts);
}

/** 내 티켓 조회 1행. go `attendees JOIN events` 대체. */
export interface PublicTicketLookupRow {
  ticket_id: string;
  ticket_number: string | null;
  name: string | null;
  status: string;
  product_name: string | null;
  event_id: string;
  event_title: string | null;
  event_starts_at: string | null;
  event_venue: string | null;
}

/**
 * 구매자 이메일+전화로 티켓 조회(내 티켓).
 *
 * PII 라 GET 쿼리가 아니라 **POST 본문**으로 보낸다(액세스 로그·리퍼러 유출 방지).
 * ⚠️ 매칭 기준이 go(참석자 연락처) → v2(주문 구매자 연락처)로 좁아진다 — v2 는 티켓별
 *    참석자 연락처를 보관하지 않는다. 단건 구매는 동일.
 */
export function lookupPublicTicketsV2(
  input: { email: string; phone: string; limit?: number },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ tickets: PublicTicketLookupRow[]; total: number }>(
    "POST",
    "/api/v1/internal/public/ticket-lookup",
    input,
    opts,
  );
}

/**
 * go order id(= v2 `orders.external_ref`) → 단건 주문 상세.
 *
 * ⚠️ **주문 id 는 event id 와 달리 canonical 승격되지 않았다**(go orders.id != v2 orders.id).
 * go `SELECT v2_order_id FROM orders WHERE id=$1` 앵커 조회를 대체하는 역인덱스 진입점이다.
 * 정확 매칭만(prefix/LIKE 없음). 미존재 시 V2CommerceError(404 ORDER_NOT_FOUND).
 */
export function getOrderByExternalRef(goOrderId: string, opts?: RequestOptions) {
  return v2CommerceRequest<OrderDetail>(
    "GET",
    `/api/v1/internal/orders/by-external/${encodeURIComponent(goOrderId)}`,
    undefined,
    opts,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 레벨2 W5-CONTENT — 콘텐츠·표시 계열(위젯 / 티켓 디자이너 / 브릿지 / 공지 / 시설 / 출연진)
//
// go DB 의 6개 테이블(widget_configs·ticket_designs·bridge_pages·open_notices·
// event_facilities·event_participants)이 v2 정본(`organizer_*`)으로 이관됐다.
// 서버 라우터: platform/backend/app/api/v1/internal_organizer_content.py
//
// 🔴 호출 규약
//  · 주최자 스코프 함수는 `organizerRef`(= session.accountId) **필수**. v2 가 이걸로
//    테넌트 경계를 강제한다(불일치 → 404). 빼먹으면 크로스테넌트 누출이다.
//  · 생성 함수는 호출자가 `itemId`(UUID)를 만들어 넘긴다 → 네트워크 재시도로 같은 요청이
//    두 번 도착해도 같은 행을 갱신할 뿐 중복 행이 생기지 않는다.
//  · 실패는 전부 V2CommerceError 로 전파된다. **절대 빈 배열/기본값으로 폴백하지 마라** —
//    특히 위젯 `allowedDomains` 는 embed 허용 화이트리스트라 폴백이 곧 전면 허용이다.
//
// ⚠️ 이 블록 위쪽의 `upsertEventContent` / `getEventContent`(v2 `/events/{id}/content`)는
//    **호출부 0 인 레거시**가 됐다(실측: 선언부 외 참조 없음). 옛 구조는 go 가 원본을 갖고
//    소비자 노출 섹션을 통째로 재PUT 하는 방식이었는데, 지금은 정본도 투영도 v2 안에서
//    한 트랜잭션으로 갱신된다. 새 코드에서 그 두 함수를 다시 쓰지 마라 — 섹션 전체교체
//    (delete-then-insert)라 주최자 편집 원본과 투영이 어긋난다.
// ═════════════════════════════════════════════════════════════════════════════

const CONTENT_BASE = "/api/v1/internal/events";

function contentQuery(organizerRef: string): string {
  return `?${new URLSearchParams({ organizer_ref: organizerRef }).toString()}`;
}

export interface OrganizerParticipantRow {
  id: string;
  event_id: string;
  name: string;
  role: string;
  bio: string | null;
  image_url: string | null;
  sort_order: number;
  is_visible: boolean;
  created_at: string | null;
  updated_at: string | null;
}

export interface OrganizerParticipantInput {
  name: string;
  role?: string;
  bio?: string | null;
  image_url?: string | null;
  sort_order?: number;
  is_visible?: boolean;
}

export function listOrganizerParticipants(
  eventId: string,
  organizerRef: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ participants: OrganizerParticipantRow[] }>(
    "GET",
    `${CONTENT_BASE}/${eventId}/organizer-content/participants${contentQuery(organizerRef)}`,
    undefined,
    opts,
  );
}

export function createOrganizerParticipant(
  eventId: string,
  organizerRef: string,
  itemId: string,
  input: OrganizerParticipantInput,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<OrganizerParticipantRow>(
    "POST",
    `${CONTENT_BASE}/${eventId}/organizer-content/participants`,
    { organizer_ref: organizerRef, item_id: itemId, ...input },
    opts,
  );
}

export function patchOrganizerParticipant(
  eventId: string,
  organizerRef: string,
  itemId: string,
  input: Partial<OrganizerParticipantInput>,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<OrganizerParticipantRow>(
    "PATCH",
    `${CONTENT_BASE}/${eventId}/organizer-content/participants/${itemId}`,
    { organizer_ref: organizerRef, ...input },
    opts,
  );
}

export function deleteOrganizerParticipant(
  eventId: string,
  organizerRef: string,
  itemId: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ deleted: true; id: string }>(
    "DELETE",
    `${CONTENT_BASE}/${eventId}/organizer-content/participants/${itemId}${contentQuery(organizerRef)}`,
    undefined,
    opts,
  );
}

export interface OrganizerNoticeRow {
  id: string;
  event_id: string;
  notice_type: string;
  title: string;
  content: string;
  is_published: boolean;
  published_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface OrganizerNoticeInput {
  notice_type?: string;
  title: string;
  content: string;
  is_published?: boolean;
}

export function listOrganizerNotices(
  eventId: string,
  organizerRef: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ notices: OrganizerNoticeRow[] }>(
    "GET",
    `${CONTENT_BASE}/${eventId}/organizer-content/notices${contentQuery(organizerRef)}`,
    undefined,
    opts,
  );
}

export function createOrganizerNotice(
  eventId: string,
  organizerRef: string,
  itemId: string,
  input: OrganizerNoticeInput,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<OrganizerNoticeRow>(
    "POST",
    `${CONTENT_BASE}/${eventId}/organizer-content/notices`,
    { organizer_ref: organizerRef, item_id: itemId, ...input },
    opts,
  );
}

export function patchOrganizerNotice(
  eventId: string,
  organizerRef: string,
  itemId: string,
  input: Partial<OrganizerNoticeInput>,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<OrganizerNoticeRow>(
    "PATCH",
    `${CONTENT_BASE}/${eventId}/organizer-content/notices/${itemId}`,
    { organizer_ref: organizerRef, ...input },
    opts,
  );
}

export function deleteOrganizerNotice(
  eventId: string,
  organizerRef: string,
  itemId: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ deleted: true; id: string }>(
    "DELETE",
    `${CONTENT_BASE}/${eventId}/organizer-content/notices/${itemId}${contentQuery(organizerRef)}`,
    undefined,
    opts,
  );
}

/** 공개 랜딩용 — **발행된 공지만**. organizer_ref 없음(공개 경로). */
export function listPublicNotices(eventId: string, limit = 10, opts?: RequestOptions) {
  return v2CommerceRequest<{ notices: OrganizerNoticeRow[] }>(
    "GET",
    `${CONTENT_BASE}/${eventId}/public-content/notices?${new URLSearchParams({ limit: String(limit) })}`,
    undefined,
    opts,
  );
}

export interface OrganizerFacilityRow {
  id: string;
  event_id: string;
  name: string;
  category: string;
  quantity: number;
  status: string;
  vendor: string | null;
  cost: number;
  notes: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface OrganizerFacilityInput {
  name: string;
  category?: string;
  quantity?: number;
  status?: string;
  vendor?: string | null;
  cost?: number;
  notes?: string | null;
}

export function listOrganizerFacilities(
  eventId: string,
  organizerRef: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ facilities: OrganizerFacilityRow[] }>(
    "GET",
    `${CONTENT_BASE}/${eventId}/organizer-content/facilities${contentQuery(organizerRef)}`,
    undefined,
    opts,
  );
}

export function createOrganizerFacility(
  eventId: string,
  organizerRef: string,
  itemId: string,
  input: OrganizerFacilityInput,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<OrganizerFacilityRow>(
    "POST",
    `${CONTENT_BASE}/${eventId}/organizer-content/facilities`,
    { organizer_ref: organizerRef, item_id: itemId, ...input },
    opts,
  );
}

export function patchOrganizerFacility(
  eventId: string,
  organizerRef: string,
  itemId: string,
  input: Partial<OrganizerFacilityInput>,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<OrganizerFacilityRow>(
    "PATCH",
    `${CONTENT_BASE}/${eventId}/organizer-content/facilities/${itemId}`,
    { organizer_ref: organizerRef, ...input },
    opts,
  );
}

export function deleteOrganizerFacility(
  eventId: string,
  organizerRef: string,
  itemId: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ deleted: true; id: string }>(
    "DELETE",
    `${CONTENT_BASE}/${eventId}/organizer-content/facilities/${itemId}${contentQuery(organizerRef)}`,
    undefined,
    opts,
  );
}

export interface OrganizerWidgetConfigPayload {
  /** 설정 행이 **실제로 없어서** 기본값인지(false) 저장된 설정인지(true). 조회 실패와 혼동 금지. */
  configured: boolean;
  mode: string;
  theme: Record<string, unknown>;
  allowed_domains: string[];
  is_active: boolean;
  updated_at?: string | null;
}

export function getOrganizerWidgetConfig(
  eventId: string,
  organizerRef: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<OrganizerWidgetConfigPayload>(
    "GET",
    `${CONTENT_BASE}/${eventId}/organizer-content/widget-config${contentQuery(organizerRef)}`,
    undefined,
    opts,
  );
}

export function putOrganizerWidgetConfig(
  eventId: string,
  organizerRef: string,
  input: {
    mode: string;
    theme: Record<string, unknown>;
    allowed_domains: string[];
    is_active: boolean;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<OrganizerWidgetConfigPayload>(
    "PUT",
    `${CONTENT_BASE}/${eventId}/organizer-content/widget-config`,
    { organizer_ref: organizerRef, ...input },
    opts,
  );
}

/**
 * 공개 위젯 embed 설정. organizer_ref 없음(공개 경로).
 * 🔴 호출측은 실패 시 **절대 "제한 없음"으로 폴백하면 안 된다** — 아무 사이트나 위젯을 박게 된다.
 */
export function getPublicWidgetConfig(eventId: string, opts?: RequestOptions) {
  return v2CommerceRequest<OrganizerWidgetConfigPayload>(
    "GET",
    `${CONTENT_BASE}/${eventId}/public-content/widget-config`,
    undefined,
    opts,
  );
}

export function getOrganizerTicketDesign(
  eventId: string,
  organizerRef: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ canvas_json: Record<string, unknown> }>(
    "GET",
    `${CONTENT_BASE}/${eventId}/organizer-content/ticket-design${contentQuery(organizerRef)}`,
    undefined,
    opts,
  );
}

/** 티켓 디자인 저장 — **top-level 병합**(디자이너/초대권 편집기가 같은 문서를 공유). */
export function putOrganizerTicketDesign(
  eventId: string,
  organizerRef: string,
  canvasJson: Record<string, unknown>,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ canvas_json: Record<string, unknown> }>(
    "PUT",
    `${CONTENT_BASE}/${eventId}/organizer-content/ticket-design`,
    { organizer_ref: organizerRef, canvas_json: canvasJson },
    opts,
  );
}

/** 공개 티켓뷰용 디자인. 설정이 없으면 `canvas_json: null`. */
export function getPublicTicketDesign(eventId: string, opts?: RequestOptions) {
  return v2CommerceRequest<{ canvas_json: Record<string, unknown> | null }>(
    "GET",
    `${CONTENT_BASE}/${eventId}/public-content/ticket-design`,
    undefined,
    opts,
  );
}

export interface OrganizerBridgePagePayload {
  configured: boolean;
  is_active: boolean;
  title: string;
  description: string | null;
  countdown_target: string | null;
  background_color: string;
  logo_url: string | null;
  updated_at?: string | null;
}

export function getOrganizerBridgePage(
  eventId: string,
  organizerRef: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<OrganizerBridgePagePayload>(
    "GET",
    `${CONTENT_BASE}/${eventId}/organizer-content/bridge-page${contentQuery(organizerRef)}`,
    undefined,
    opts,
  );
}

export function putOrganizerBridgePage(
  eventId: string,
  organizerRef: string,
  input: {
    is_active: boolean;
    title: string;
    description: string | null;
    countdown_target: string | null;
    background_color: string;
    logo_url: string | null;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<OrganizerBridgePagePayload>(
    "PUT",
    `${CONTENT_BASE}/${eventId}/organizer-content/bridge-page`,
    { organizer_ref: organizerRef, ...input },
    opts,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// W5-COMMERCE — 상거래 부가기능 (레벨2 컷오버 wave5)
// 정본: internal_commerce.py 말미 "Wave5 W5-COMMERCE" 절.
//
// go `promo_codes` / `group_bookings` / `pricing_rules` / `price_history` /
// `refund_policies` 의 대체. 🔴 전부 금액에 직결된다 — 실패를 절대 흡수하지 않는다.
// 라우트는 V2CommerceError.status 로 404(미소유/미존재) vs 503(v2 장애)을 갈라야 한다.
// ═════════════════════════════════════════════════════════════════════════════

/** 프로모코드 1행. `promo_id` = v2 canonical discount_code_id(go 앵커 폐기 후 유일 식별자). */
export interface PromoCodeRow {
  promo_id: string;
  code: string;
  promo_type: "fixed" | "percentage";
  discount_value: number;
  usage_limit: number | null;
  /** 사용 횟수 **정본**. go used_count 앵커/리포트 오버레이는 폐기됐다. */
  used_count: number;
  starts_at: string | null;
  ends_at: string | null;
  is_active: boolean;
  description: string | null;
  min_order_amount: number | null;
  max_discount_amount: number | null;
  created_at: string | null;
}

export interface PromoCodeCreateInput {
  code: string;
  promo_type: "fixed" | "percentage";
  discount_value: number;
  usage_limit: number | null;
  starts_at?: string | null;
  ends_at?: string | null;
  is_active?: boolean;
}

/**
 * 부분 수정 — **보낸 키만** 반영된다(v2 `model_fields_set`).
 * ⚠️ `promo_type` 과 `discount_value` 는 짝이다. 한쪽만 보내면 v2 가 400 으로 끊는다.
 */
export interface PromoCodePatchInput {
  code?: string;
  promo_type?: "fixed" | "percentage";
  discount_value?: number;
  usage_limit?: number | null;
  starts_at?: string | null;
  ends_at?: string | null;
  is_active?: boolean;
}

export function listPromoCodes(v2EventId: string, opts?: RequestOptions) {
  return v2CommerceRequest<{ promo_codes: PromoCodeRow[]; total: number }>(
    "GET", `/api/v1/internal/events/${v2EventId}/promo-codes`, undefined, opts);
}

export function createPromoCode(
  v2EventId: string,
  input: PromoCodeCreateInput,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<PromoCodeRow>(
    "POST", `/api/v1/internal/events/${v2EventId}/promo-codes`, input, opts);
}

export function patchPromoCode(
  v2EventId: string,
  promoId: string,
  patch: PromoCodePatchInput,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<PromoCodeRow>(
    "PATCH",
    `/api/v1/internal/events/${v2EventId}/promo-codes/${encodeURIComponent(promoId)}`,
    patch,
    opts,
  );
}

/**
 * 프로모코드 삭제(소프트). v2 가 `is_active=false` 를 함께 세팅해 주문 경로에서도 즉시 거부된다.
 * 🔴 404 를 "이미 없음 → 성공"으로 흡수하지 마라 — 조회 실패(5xx)와 구분되지 않는다.
 */
export function deletePromoCode(v2EventId: string, promoId: string, opts?: RequestOptions) {
  return v2CommerceRequest<{ promo_id: string; deleted: boolean }>(
    "DELETE",
    `/api/v1/internal/events/${v2EventId}/promo-codes/${encodeURIComponent(promoId)}`,
    undefined,
    opts,
  );
}

export interface PromoValidateResult {
  valid: true;
  promo_id: string;
  code: string;
  promo_type: "fixed" | "percentage";
  discount_value: number;
  gross_amount: number;
  discount_amount: number;
  final_amount: number;
}

/**
 * 체크아웃 프로모코드 검증 + **할인액 산정**.
 *
 * 🔴 이 값이 결제 금액의 정본이다. v2 는 주문 생성이 쓰는 것과 **같은 함수**로 계산하므로,
 *    go 가 자체 산식으로 다시 계산하면 표시액≠청구액이 되고 주문 생성이 AMOUNT_MISMATCH 로
 *    거절된다. 반환값을 그대로 써라.
 * 🔴 사용 횟수는 **차감하지 않는다**(차감은 주문 생성 트랜잭션 안에서 1회). 대신 한도 초과는
 *    여기서도 409 로 막는다 — 통과시키면 화면만 할인되고 결제가 실패한다.
 *
 * 에러: 404 미존재/비활성/삭제됨 · 400 기간 밖·최소주문액 미달 · 409 한도 초과.
 */
export function validatePromoCode(
  v2EventId: string,
  input: { code: string; gross_amount: number },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<PromoValidateResult>(
    "POST", `/api/v1/internal/events/${v2EventId}/promo-codes/validate`, input, opts);
}

/** 단체예약 1행. `product_name`/`product_price` 는 v2 티어에서 해석(티어 부재 시 null). */
export interface GroupBookingRow {
  booking_id: string;
  event_id: string;
  product_ref: string;
  product_name: string | null;
  /** 🔴 null = 상품(티어)이 사라짐. **0원으로 대체하지 마라** — 승인 금액이 0이 된다. */
  product_price: number | null;
  order_ref: string | null;
  order_number: string | null;
  organization_name: string;
  contact_name: string;
  contact_email: string;
  contact_phone: string | null;
  attendee_count: number;
  discount_rate: number;
  notes: string | null;
  rejection_reason: string | null;
  approved_by_ref: string | null;
  approved_at: string | null;
  status: "pending" | "confirmed" | "cancelled";
  created_at: string | null;
}

export function listGroupBookings(v2EventId: string, opts?: RequestOptions) {
  return v2CommerceRequest<{ bookings: GroupBookingRow[]; total: number }>(
    "GET", `/api/v1/internal/events/${v2EventId}/group-bookings`, undefined, opts);
}

export function getGroupBooking(v2EventId: string, bookingId: string, opts?: RequestOptions) {
  return v2CommerceRequest<GroupBookingRow>(
    "GET",
    `/api/v1/internal/events/${v2EventId}/group-bookings/${encodeURIComponent(bookingId)}`,
    undefined,
    opts,
  );
}

export function createGroupBooking(
  v2EventId: string,
  input: {
    product_ref: string;
    organization_name: string;
    contact_name: string;
    contact_email: string;
    contact_phone?: string | null;
    attendee_count: number;
    notes?: string | null;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<GroupBookingRow>(
    "POST", `/api/v1/internal/events/${v2EventId}/group-bookings`, input, opts);
}

/**
 * 단체예약 승인/거절. **상태 전이는 v2 가 `FOR UPDATE` 로 원자 집행**한다
 * (동시 2회 승인 → 하나만 200, 나머지 409). 허용: pending→confirmed · →cancelled ·
 * confirmed→cancelled. 그 외 409.
 */
export function patchGroupBooking(
  v2EventId: string,
  bookingId: string,
  patch: {
    status: "confirmed" | "cancelled";
    discount_rate?: number;
    rejection_reason?: string | null;
    order_ref?: string | null;
    order_number?: string | null;
    approved_by_ref?: string | null;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<GroupBookingRow>(
    "PATCH",
    `/api/v1/internal/events/${v2EventId}/group-bookings/${encodeURIComponent(bookingId)}`,
    patch,
    opts,
  );
}

/** 환불 규칙 1행 — go `RefundRule`(lib/refund/calculator) 과 동형. */
export interface RefundPolicyRule {
  daysBefore: number;
  percent: number;
  label: string;
}

export interface RefundPolicyRow {
  policy_id: string;
  event_id: string;
  title: string;
  description: string | null;
  refund_type: "full" | "partial";
  rules: RefundPolicyRule[];
  created_at: string | null;
  updated_at: string | null;
}

/**
 * 이벤트 커스텀 환불 정책 조회.
 *
 * `policy: null` = 커스텀 정책 없음(기본규칙 적용)이라는 **확정된 사실**이다.
 * 🔴 조회 실패(V2CommerceError)를 null 로 뭉개면 "정책 없음"과 구분되지 않아
 *    표시 환불액과 실제 처리액이 갈라진다 — 반드시 예외를 전파하고 503 으로 끊어라.
 */
export function getRefundPolicy(v2EventId: string, opts?: RequestOptions) {
  return v2CommerceRequest<{ policy: RefundPolicyRow | null }>(
    "GET", `/api/v1/internal/events/${v2EventId}/refund-policy`, undefined, opts);
}

/** 환불 정책 저장(upsert). go 에는 없던 write 경로 — 이벤트당 1건. */
export function putRefundPolicy(
  v2EventId: string,
  input: {
    title: string;
    description?: string | null;
    refund_type?: "full" | "partial";
    rules: RefundPolicyRule[];
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<RefundPolicyRow>(
    "PUT", `/api/v1/internal/events/${v2EventId}/refund-policy`, input, opts);
}

/** 환불 정책 제거 → 기본규칙 복귀. 미존재는 404(200 으로 흡수 금지). */
export function deleteRefundPolicy(v2EventId: string, opts?: RequestOptions) {
  return v2CommerceRequest<{ event_id: string; deleted: boolean }>(
    "DELETE", `/api/v1/internal/events/${v2EventId}/refund-policy`, undefined, opts);
}

export interface PricingRuleRow {
  rule_id: string;
  rule_type: "demand" | "time" | "inventory" | "surge";
  config: Record<string, unknown>;
  priority: number;
  is_active: boolean;
  created_at: string | null;
}

export interface PriceHistoryRow {
  history_id: string;
  old_price: number;
  new_price: number;
  reason: string | null;
  rule_type: string | null;
  applied_at: string | null;
}

/** `tierRef` = go 상품 id(= v2 external_ref) 또는 v2 tier_id. 미존재/타 이벤트 → 404. */
export function listPricingRules(v2EventId: string, tierRef: string, opts?: RequestOptions) {
  return v2CommerceRequest<{ rules: PricingRuleRow[]; total: number }>(
    "GET",
    `/api/v1/internal/events/${v2EventId}/tiers/${encodeURIComponent(tierRef)}/pricing-rules`,
    undefined,
    opts,
  );
}

export function createPricingRule(
  v2EventId: string,
  tierRef: string,
  input: {
    rule_type: "demand" | "time" | "inventory" | "surge";
    config: Record<string, unknown>;
    priority?: number;
    is_active?: boolean;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<PricingRuleRow>(
    "POST",
    `/api/v1/internal/events/${v2EventId}/tiers/${encodeURIComponent(tierRef)}/pricing-rules`,
    input,
    opts,
  );
}

/** 가격 변경 이력. writer = v2 티어 upsert(base_price 변경 감지) — go 에는 writer 가 없었다. */
export function listPriceHistory(
  v2EventId: string,
  tierRef: string,
  limit = 50,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ history: PriceHistoryRow[]; total: number }>(
    "GET",
    `/api/v1/internal/events/${v2EventId}/tiers/${encodeURIComponent(tierRef)}/price-history?limit=${limit}`,
    undefined,
    opts,
  );
}

/**
 * v2 에러 봉투에서 `error.code` 만 뽑는다(`{ok:false, error:{code,message,field}}`).
 *
 * 왜 필요한가: 같은 400 이라도 "아직 사용할 수 없는 코드"와 "만료된 코드"는 사용자에게
 * 다른 말을 해야 한다. 상태코드만으로 뭉개면 안내가 틀리고, v2 메시지를 그대로 노출하면
 * 영어 내부 문구가 사용자 화면에 새 나간다. 코드로 분기해 **한국어 문구는 go 가 고른다**.
 *
 * @returns 에러 코드 문자열. 파싱 불가하면 `null`(호출측은 상태코드 기반 기본 문구 사용).
 *
 * ⚠️ 상태코드만으로 판정하면 안 되는 실례(2026-07-30): 초대권 예약의 409 에는
 *    `INVITATION_LIMIT`(그 번호 상한 도달 — 루프 종료)과 `CONFLICT`(동시성 — 재시도 대상)
 *    두 가지가 있다. 코드로 갈라야 한다.
 */
/**
 * 🔴 **정본은 `@/lib/v2/error-code` 다.** 여기 있던 판은 봉투를 한 겹 더 벗겨
 *    `parsed.error.code` 를 읽었고, 실제 `body` 는 `JSON.stringify(env.error)`
 *    (= `{code, message, field}` 평면)라 **항상 null 을 냈다**(2026-08-09 실증).
 *
 *    그래서 이 판을 쓰던 분기는 한 번도 실행되지 않았다:
 *      · `server/invitations.ts` 의 INVITATION_LIMIT 종료조건
 *      · `checkout/initiate` 의 ORDER_NOT_REPLAYABLE 만료토큰 복구
 *
 *    ⚠️ 두 벌로 두면 다음에 한쪽만 고쳐진다. **재수출**로 접는다.
 */
export { v2ErrorCode } from "@/lib/v2/error-code";

// ════════════════════════════════════════════════════════════════════════════
// 레벨2 W5-SUPPORT — 문의·게시심사·알림·용량·파이널콜·제휴생성 (go DB 제거)
//
// 대응 v2 모듈: platform/backend/app/api/v1/internal_support.py
// 🔴 이 구역의 함수는 전부 실패를 **전파**한다(빈 배열·기본값 폴백 없음). 호출 라우트가
//    V2CommerceError 를 받아 503(재시도 가능)으로 번역한다. 특히 게시 심사는 조회 실패를
//    승인/반려 어느 쪽으로도 흘리면 안 된다.
// ════════════════════════════════════════════════════════════════════════════

/** 조직자 알림 1건 — go `notifications` 행과 1:1(카멜 변환은 라우트가 수행). */
export interface OrganizerNotificationRow {
  id: string;
  account_id: string;
  event_id: string | null;
  type: string;
  title: string;
  message: string;
  is_read: boolean;
  metadata: Record<string, unknown>;
  created_at: string | null;
}

/** 조직자 알림 목록. accountId 가 테넌트 경계 — 호출측은 반드시 session.accountId 를 넘긴다. */
export function listOrganizerNotifications(
  accountId: string,
  params: { page: number; limit: number; unreadOnly: boolean },
  opts?: RequestOptions,
) {
  const qs = new URLSearchParams({
    account_id: accountId,
    page: String(params.page),
    limit: String(params.limit),
    unread_only: String(params.unreadOnly),
  });
  return v2CommerceRequest<{
    items: OrganizerNotificationRow[];
    total: number;
    page: number;
    limit: number;
  }>("GET", `/api/v1/internal/organizer-notifications?${qs.toString()}`, undefined, opts);
}

/** 미읽음 알림 수. 실패 시 throw — 0 으로 위장하지 않는다(뱃지가 조용히 사라짐). */
export function getOrganizerUnreadCount(accountId: string, opts?: RequestOptions) {
  const qs = new URLSearchParams({ account_id: accountId });
  return v2CommerceRequest<{ count: number }>(
    "GET",
    `/api/v1/internal/organizer-notifications/unread-count?${qs.toString()}`,
    undefined,
    opts,
  );
}

/** 조직자 알림 생성. type 은 v2 ORGANIZER_NOTIFICATION_TYPES 화이트리스트(미허용 → 400). */
export function createOrganizerNotification(
  input: {
    account_id: string;
    event_id?: string | null;
    type: string;
    title: string;
    message: string;
    metadata?: Record<string, unknown>;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ id: string }>(
    "POST",
    "/api/v1/internal/organizer-notifications",
    input,
    opts,
  );
}

/** 전체 읽음 처리. */
export function markAllOrganizerNotificationsRead(accountId: string, opts?: RequestOptions) {
  return v2CommerceRequest<{ updated: number }>(
    "PATCH",
    "/api/v1/internal/organizer-notifications/read-all",
    { account_id: accountId },
    opts,
  );
}

/** 단건 읽음 처리. 미존재/타 계정 → V2CommerceError(404). */
export function markOrganizerNotificationRead(
  notificationId: string,
  accountId: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ updated: boolean }>(
    "PATCH",
    `/api/v1/internal/organizer-notifications/${encodeURIComponent(notificationId)}/read`,
    { account_id: accountId },
    opts,
  );
}

/** 단건 삭제. 미존재/타 계정 → V2CommerceError(404). v2 장애는 404 가 아니라 5xx 로 온다. */
export function deleteOrganizerNotification(
  notificationId: string,
  accountId: string,
  opts?: RequestOptions,
) {
  const qs = new URLSearchParams({ account_id: accountId });
  return v2CommerceRequest<{ deleted: boolean }>(
    "DELETE",
    `/api/v1/internal/organizer-notifications/${encodeURIComponent(notificationId)}?${qs.toString()}`,
    undefined,
    opts,
  );
}

/** 게시 심사 이력 1건. ⚠️ v2 `reviews`(관람객 후기)가 아니라 `event_publication_reviews`. */
export interface PublicationReviewRow {
  id: string;
  action: "submit" | "approve" | "reject" | "resubmit" | "auto_approved";
  reason: string | null;
  checklist: Record<string, unknown>;
  reviewer_ref: string | null;
  reviewer_name: string | null;
  created_at: string | null;
}

/**
 * 게시 심사 이력(최신순). organizerRef 가 테넌트 경계 — 미소유는 v2 가 404 로 끊는다.
 * 🔴 실패를 빈 배열로 바꾸지 않는다: 빈 배열은 "심사 이력 없음"으로 오독된다.
 */
export function listPublicationReviews(
  eventId: string,
  organizerRef: string,
  params?: { limit?: number },
  opts?: RequestOptions,
) {
  const qs = new URLSearchParams({ organizer_ref: organizerRef });
  if (params?.limit) qs.set("limit", String(params.limit));
  return v2CommerceRequest<{ reviews: PublicationReviewRow[]; total: number }>(
    "GET",
    `/api/v1/internal/events/${eventId}/publication-reviews?${qs.toString()}`,
    undefined,
    opts,
  );
}

/**
 * 게시 심사 이력 기록.
 * `organizer_ref` 는 주최자 submit 경로에서만 넘긴다 — 어드민 승인/반려 webhook 은
 * organizer 스코프가 없으므로 생략한다(v2 가 이벤트 존재만 확인).
 */
export function recordPublicationReview(
  eventId: string,
  input: {
    organizer_ref?: string;
    action: "submit" | "approve" | "reject" | "resubmit" | "auto_approved";
    reason?: string | null;
    checklist?: Record<string, unknown>;
    reviewer_ref?: string | null;
    reviewer_name?: string | null;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ id: string }>(
    "POST",
    `/api/v1/internal/events/${eventId}/publication-reviews`,
    input,
    opts,
  );
}

/** 소비자 문의 1건. `contact` 는 PII 원문 — 표시 시 마스킹은 라우트 책임. */
export interface EventInquiryRow {
  id: string;
  contact: string | null;
  question: string;
  answer: string | null;
  status: "open" | "answered" | "archived";
  source: string;
  category: string | null;
  urgency: string | null;
  created_at: string | null;
  updated_at: string | null;
}

/** 주최자 문의함. organizerRef 가 테넌트 경계. */
export function listEventInquiries(
  eventId: string,
  organizerRef: string,
  params?: { status?: string },
  opts?: RequestOptions,
) {
  const qs = new URLSearchParams({ organizer_ref: organizerRef });
  if (params?.status) qs.set("status", params.status);
  return v2CommerceRequest<{ inquiries: EventInquiryRow[]; total: number }>(
    "GET",
    `/api/v1/internal/events/${eventId}/inquiries?${qs.toString()}`,
    undefined,
    opts,
  );
}

/**
 * 공개(비인증) 문의 접수 저장.
 * 🔴 실패는 반드시 throw 된다 — 호출 라우트가 5xx 로 응답해야 한다. 200 흡수 시 고객은
 *    접수됐다고 믿는데 아무 데도 남지 않는다.
 */
export function submitEventInquiry(
  eventId: string,
  input: { question: string; contact?: string | null; source?: "web" | "chatbot" },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ id: string }>(
    "POST",
    `/api/v1/internal/events/${eventId}/inquiries`,
    input,
    opts,
  );
}

/** 문의 상태/회신 갱신. 갱신된 원문(회신 통지 발송용)을 함께 돌려받는다. */
export function patchEventInquiry(
  eventId: string,
  inquiryId: string,
  input: { organizer_ref: string; status?: string; answer?: string },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ updated: boolean; inquiry: EventInquiryRow }>(
    "PATCH",
    `/api/v1/internal/events/${eventId}/inquiries/${encodeURIComponent(inquiryId)}`,
    input,
    opts,
  );
}

/** 용량 배정 1건. `product_ref` = go product id (= v2 seat_tiers.external_ref). */
export interface CapacityAssignmentRow {
  id: string;
  product_ref: string;
  product_name: string | null;
  capacity: number;
  used_capacity: number;
  status: string;
}

/** 용량 배정 목록. */
export function listCapacityAssignments(
  eventId: string,
  organizerRef: string,
  opts?: RequestOptions,
) {
  const qs = new URLSearchParams({ organizer_ref: organizerRef });
  return v2CommerceRequest<{ assignments: CapacityAssignmentRow[]; total: number }>(
    "GET",
    `/api/v1/internal/events/${eventId}/capacity-assignments?${qs.toString()}`,
    undefined,
    opts,
  );
}

/** 용량 배정 upsert((event, product_ref) 유니크). */
export function upsertCapacityAssignment(
  eventId: string,
  input: {
    organizer_ref: string;
    product_ref: string;
    capacity: number;
    used_capacity: number;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ id: string }>(
    "PUT",
    `/api/v1/internal/events/${eventId}/capacity-assignments`,
    input,
    opts,
  );
}

/** 파이널콜 규칙(설정값). ⚠️ v2 `final_calls`(실행 인스턴스)와 다른 원장. */
export interface FinalCallRuleRow {
  is_active: boolean;
  trigger_hours_before: number;
  discount_percent: number;
  min_remaining_percent: number;
  max_discount_tickets: number | null;
  notify_buyers: boolean;
}

/** 파이널콜 규칙 조회. 미설정이면 `configured:false` + 기본값(장애와 구분된다). */
export function getFinalCallRule(eventId: string, organizerRef: string, opts?: RequestOptions) {
  const qs = new URLSearchParams({ organizer_ref: organizerRef });
  return v2CommerceRequest<{ rule: FinalCallRuleRow; configured: boolean }>(
    "GET",
    `/api/v1/internal/events/${eventId}/final-call-rule?${qs.toString()}`,
    undefined,
    opts,
  );
}

/** 파이널콜 규칙 upsert(이벤트당 1행). */
export function putFinalCallRule(
  eventId: string,
  input: {
    organizer_ref: string;
    is_active: boolean;
    trigger_hours_before: number;
    discount_percent: number;
    min_remaining_percent: number;
    max_discount_tickets: number | null;
    notify_buyers: boolean;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ rule: FinalCallRuleRow; configured: boolean }>(
    "PUT",
    `/api/v1/internal/events/${eventId}/final-call-rule`,
    input,
    opts,
  );
}

/**
 * 제휴 **원자 생성** — 중복 코드는 v2 유니크 제약이 409 로 끊는다.
 *
 * ⚠️ 기존 `upsertAffiliates`(PUT, 배치)와 다르다: 그쪽은 code 로 매칭해 **덮어쓰기** 때문에
 *    "중복 코드 거부"를 표현할 수 없다(경합 시 남의 제휴 정의를 가로챈다). 신규 생성은
 *    반드시 이 함수를 쓴다. 수정/삭제는 기존 patchAffiliate/deleteAffiliate 그대로.
 */
export function createAffiliate(
  eventId: string,
  input: {
    organizer_ref: string;
    external_ref: string;
    name: string;
    code: string;
    commission_rate: number;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ affiliate_id: string; external_ref: string }>(
    "POST",
    `/api/v1/internal/events/${eventId}/affiliates`,
    input,
    opts,
  );
}

// ═════════════════════════════════════════════════════════════════════════════
// 레벨2 컷오버 W5-ATTENDEE — 참석자 **부속 원장** 클라이언트 (v2 정본)
//
// go DB 의 event_questions / event_invitations / invitation_dispatch / seat_watches /
// check_in_lists / check_in_logs 를 대체한다. 서버측 계약은
// `platform/backend/app/api/v1/internal_attendee_ledger.py` 참조.
//
// 🔴 실패 정책: 이 함수들은 전부 V2CommerceError 를 **throw** 한다. 호출부가 그걸
//    "빈 목록"·"0건"·"이미 없음" 으로 흡수하면 v2 장애가 성공으로 위장된다(참석자 0명,
//    체크인 미입장, 삭제 완료로 보이는 사고). 호출부는 503 으로 끊는다.
// ═════════════════════════════════════════════════════════════════════════════

const ATTENDEE_BASE = "/api/v1/internal";

/** 예매 설문 문항(정의). 응답은 `tickets.answers` 가 이 `id` 로 키잉한다. */
export interface V2EventQuestion {
  id: string;
  label: string;
  question_type: string;
  is_required: boolean;
  options: string[];
  sort_order: number;
  archived: boolean;
  created_at: string | null;
}

/**
 * 문항 목록.
 * @param accountId 생략 시 공개 조회(체크아웃 상세 빌더). 지정 시 소유 일치 강제.
 * @param includeArchived 보관 문항 포함 — 이미 수집된 응답의 **라벨 해석용**.
 */
export function listEventQuestions(
  eventId: string,
  opts: { accountId?: string; includeArchived?: boolean } = {},
  reqOpts?: RequestOptions,
) {
  const qs = new URLSearchParams();
  if (opts.accountId) qs.set("organizer_ref", opts.accountId);
  if (opts.includeArchived) qs.set("include_archived", "true");
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return v2CommerceRequest<{ questions: V2EventQuestion[] }>(
    "GET",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/questions${suffix}`,
    undefined,
    reqOpts,
  );
}

export interface EventQuestionWriteInput {
  label: string;
  question_type: string;
  is_required?: boolean;
  options?: string[];
  sort_order?: number | null;
  /** go id 승계용(마이그레이션 백필 경로). 미지정 시 v2 가 생성. */
  question_id?: string;
}

export function createEventQuestion(
  eventId: string,
  accountId: string,
  input: EventQuestionWriteInput,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ question: V2EventQuestion }>(
    "POST",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/questions`,
    { organizer_ref: goAccountRef(accountId), ...input },
    opts,
  );
}

export function patchEventQuestion(
  eventId: string,
  questionId: string,
  accountId: string,
  input: Partial<Omit<EventQuestionWriteInput, "question_id" | "sort_order">>,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ question: V2EventQuestion }>(
    "PATCH",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/questions/${encodeURIComponent(questionId)}`,
    { organizer_ref: goAccountRef(accountId), ...input },
    opts,
  );
}

/** 문항 보관(soft delete) — 이미 수집된 응답의 라벨이 살아남는다. */
export function archiveEventQuestion(
  eventId: string,
  questionId: string,
  accountId: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ deleted: boolean; id: string }>(
    "DELETE",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/questions/${encodeURIComponent(questionId)}?organizer_ref=${encodeURIComponent(accountId)}`,
    undefined,
    opts,
  );
}

export function reorderEventQuestions(
  eventId: string,
  accountId: string,
  orderedIds: string[],
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ reordered: number }>(
    "PUT",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/questions/order`,
    { organizer_ref: goAccountRef(accountId), ordered_ids: orderedIds },
    opts,
  );
}

// ── 초대권 원장 ───────────────────────────────────────────────────────────────

export interface V2EventInvitation {
  id: string;
  event_id: string;
  recipient_name: string;
  phone_normalized: string;
  phone_display: string;
  ticket_number: string | null;
  admission_day: string | null;
  admission_mode: string | null;
  token_version: number;
  status: string;
  failure_reason: string | null;
  sent_at: string | null;
  viewed_at: string | null;
  checked_in_at: string | null;
  revoked_at: string | null;
  created_at: string | null;
  /**
   * 발송 큐 상태 — `queued | sending | sent | failed`.
   *
   * 🔴 세 값을 **구분해야 한다**:
   *   · `undefined` — v2 가 아직 안 주는 구버전이다. 정보 없음(누락으로 단정 금지)
   *   · `null`      — 큐 행 자체가 없다. **영원히 안 나간다**
   *   · 문자열      — 큐에 있다
   *
   * 종전 응답에는 큐 정보가 하나도 없어 「순서 기다리는 중」과 「큐에 안 들어감」이
   * 같은 픽셀로 보였다(2026-08-04 실측 5건).
   */
  dispatch_status?: string | null;
  /**
   * 🔴 **보낸 대상이 지금 주인인가** (2026-08-12 실사고).
   *
   * 양도는 주인을 바꾸고 `sent_at` 을 지워 재발송 대상으로 되돌린다. 그런데 발송이
   * 옛 스냅샷 번호로 나가면서 `sent_at` 을 **다시 찍었다**. 화면은 "보냈다"로 읽어
   * 재발송 버튼을 감췄고, 손님은 못 받았는데 **복구 수단이 화면에서 사라졌다**
   * (prod 8건).
   *
   * ⚠️ `undefined` 는 **모름**이다(구버전 v2). 모름을 `false` 로 접지 마라.
   */
  dispatch_stale?: boolean;
  /** 재발송 세대. 주최자가 명시 재발송할 때만 +1 된다(crash 재시도와 구분). */
  send_epoch?: number | null;
  /**
   * 큐가 마지막으로 움직인 시각(ISO). **대기 경과는 이 값으로 잰다.**
   *
   * 🔴 `created_at`(초대권 생성)과 다르다. 어제 발급된 초대권을 방금 다시 큐에 넣으면
   *    대기 시간은 0분이다 — 생성 시각으로 재면 「1470분째 대기」가 되어, 재발송이
   *    성공했는데도 경보가 안 꺼진다(2026-08-04 실사고). 주최자가 한 번 더 누르면
   *    손님이 두 장 받는다.
   */
  dispatch_updated_at?: string | null;
}

export function listEventInvitations(
  eventId: string,
  accountId: string,
  opts: { status?: string | null; limit?: number } = {},
  reqOpts?: RequestOptions,
) {
  const qs = new URLSearchParams({ organizer_ref: accountId });
  if (opts.status) qs.set("status", opts.status);
  if (opts.limit) qs.set("limit", String(opts.limit));
  return v2CommerceRequest<{
    invitations: V2EventInvitation[];
    summary: Record<string, number>;
    active_count: number;
  }>(
    "GET",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/invitations?${qs.toString()}`,
    undefined,
    reqOpts,
  );
}

/**
 * 발권 **전** 원자 예약 — dedup·동시성의 유일한 집행 지점.
 * `created=true` 를 받은 호출자만 실제 발권(v2 주문 생성)을 진행한다.
 */
export function reserveInvitation(
  eventId: string,
  accountId: string,
  input: {
    invitation_id: string;
    recipient_name: string;
    phone_normalized: string;
    phone_display: string;
    admission_day?: string | null;
    admission_mode?: string | null;
    /**
     * 같은 번호의 몇 번째 초대권인가(1-base). 미지정은 1 — 구버전 호출자 하위호환.
     * ⚠️ **상한을 호출자가 세지 않는다.** 범위를 넘으면 v2 가 409 `INVITATION_LIMIT` 을
     *    돌려주고, 그것이 루프의 단일 종료 조건이다(동시 요청에 뚫리지 않게 DB 가 집행).
     */
    seq?: number;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ created: boolean; invitation: V2EventInvitation }>(
    "POST",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/invitations/reserve`,
    { organizer_ref: goAccountRef(accountId), ...input },
    opts,
  );
}

/**
 * 번호별 **다음 빈 순번**을 한 번에 조회한다 — 대량초대 왕복 축소용 (2026-08-09).
 *
 * 🔴 **힌트이지 권위가 아니다.** 상한 집행은 여전히 reserve 의 409 `INVITATION_LIMIT`
 *    이고, 이 값이 낡아도(동시 업로드) 루프가 거기서부터 올려가며 두드리므로 결과가 같다.
 *    ⟹ "상한 숫자를 호출자에 복제하지 않는다" 는 원칙을 깨지 않는다 — 세는 게 아니라
 *      **출발점만** 당긴다.
 *
 * 자리가 없는 번호는 `at_limit` 에 담겨 온다 — 호출자는 상한 숫자를 몰라도 알아보고
 * 그 번호를 아예 두드리지 않는다.
 */
export function invitationNextSeq(
  eventId: string,
  accountId: string,
  phones: readonly string[],
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ next: Record<string, number>; at_limit: string[] }>(
    "POST",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/invitations/next-seq`,
    { organizer_ref: goAccountRef(accountId), phones: [...phones] },
    opts,
  );
}

/** 발권 성공 반영 + 발송 큐 적재를 v2 한 트랜잭션으로. */
export function markInvitationIssued(
  invitationId: string,
  accountId: string,
  ticketNumber: string | null,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ invitation: V2EventInvitation; queued: boolean }>(
    "POST",
    `${ATTENDEE_BASE}/invitations/${encodeURIComponent(invitationId)}/issued`,
    { organizer_ref: goAccountRef(accountId), ticket_number: ticketNumber },
    opts,
  );
}

export function markInvitationFailedV2(
  invitationId: string,
  accountId: string,
  reason: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ invitation: V2EventInvitation }>(
    "POST",
    `${ATTENDEE_BASE}/invitations/${encodeURIComponent(invitationId)}/failed`,
    { organizer_ref: goAccountRef(accountId), reason },
    opts,
  );
}

export function revokeInvitationV2(
  invitationId: string,
  accountId: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ revoked: boolean; invitation: V2EventInvitation }>(
    "POST",
    `${ATTENDEE_BASE}/invitations/${encodeURIComponent(invitationId)}/revoke`,
    { organizer_ref: goAccountRef(accountId) },
    opts,
  );
}

export function resendInvitationV2(
  invitationId: string,
  /** go account id 또는 v2 organizer 지목. 공개 경로는 후자를 쓴다(세션이 없다). */
  accountIdOrRef: string | OrganizerRef,
  opts?: RequestOptions,
) {
  const ref =
    typeof accountIdOrRef === "string" ? goAccountRef(accountIdOrRef) : accountIdOrRef;
  return v2CommerceRequest<{ requeued: boolean; reason?: string }>(
    "POST",
    `${ATTENDEE_BASE}/invitations/${encodeURIComponent(invitationId)}/resend`,
    { organizer_ref: ref },
    opts,
  );
}

/**
 * 초대권 양도 — 받는 분 정보로 **제자리 갱신**하고 옛 딥링크를 죽인다.
 *
 * 🔴 v2 가 한 트랜잭션에서: 행 FOR UPDATE → 검사(회수·입장·자기번호·5장상한)
 *    → 이름/번호 교체 + `token_version++`(옛 링크 사망) → 발송표식 초기화
 *    → 티켓 QR 재바인딩(device_hash·totp_seed 초기화).
 *
 * 새 행을 만들지 않는 이유: `ticket_number` 가 원장 4곳(v2 tickets · event_invitations ·
 * check_in_logs · go attendees)의 키라, 새 행이면 같은 좌석이 명단에 두 벌이 된다.
 *
 * 409 코드: INVITATION_REVOKED · INVITATION_USED · INVITATION_SELF_TRANSFER · INVITATION_LIMIT
 */
export function transferInvitationV2(
  invitationId: string,
  ref: OrganizerRef,
  to: { name: string; phoneNormalized: string; phoneDisplay: string },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{
    transferred: boolean;
    invitation: V2EventInvitation;
    from: { recipient_name: string; phone_normalized: string };
  }>(
    "POST",
    `${ATTENDEE_BASE}/invitations/${encodeURIComponent(invitationId)}/transfer`,
    {
      organizer_ref: ref,
      to_name: to.name,
      to_phone_normalized: to.phoneNormalized,
      to_phone_display: to.phoneDisplay,
    },
    opts,
  );
}

/** 열람/입장 훅 — 티켓번호 매칭(초대권 아니면 0건, 무영향). */
export function markInvitationByTicketNumber(
  ticketNumber: string,
  state: "viewed" | "checked_in",
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ updated: number }>(
    "POST",
    `${ATTENDEE_BASE}/invitations/by-ticket-number/${encodeURIComponent(ticketNumber)}/mark`,
    { state },
    opts,
  );
}

// ── 초대권 발송 큐(드레인 워커 전용) ──────────────────────────────────────────

export interface V2DispatchItem {
  dispatch_id: string;
  invitation_id: string;
  event_id: string;
  phone: string;
  recipient_name: string;
  /** 외부 발송 멱등키의 **안정 시드**. 재클레임(crash 재시도)엔 불변, 재발송에만 +1. */
  send_epoch: number;
  attempt_count: number;
  ticket_number: string | null;
  admission_day: string | null;
  token_version: number;
  invitation_status: string;
}

export function claimInvitationDispatch(
  input: { claim_token: string; limit?: number; lease_minutes?: number },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ items: V2DispatchItem[] }>(
    "POST",
    `${ATTENDEE_BASE}/invitation-dispatch/claim`,
    input,
    opts,
  );
}

export function requeueInvitationDispatch(
  input: { claim_token: string; dispatch_ids: string[] },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ requeued: number }>(
    "POST",
    `${ATTENDEE_BASE}/invitation-dispatch/requeue`,
    input,
    opts,
  );
}

/**
 * 🔴 도달 확인이 안 된 발송 목록 — `status='sent'` 는 **접수됨**일 뿐이다.
 * 카카오 전달 거부(실측 3027)는 나중 조회로만 보이므로 워커가 이 목록을 훑는다.
 */
export function listPendingDeliveryCheck(
  input: { limit?: number } = {},
  opts?: RequestOptions,
) {
  const qs = input.limit ? `?limit=${input.limit}` : "";
  return v2CommerceRequest<{
    items: Array<{ dispatch_id: string; invitation_id: string; request_id: string; phone: string }>;
  }>("GET", `${ATTENDEE_BASE}/invitation-dispatch/pending-delivery-check${qs}`, undefined, opts);
}

/** 전달 상태 대사 결과 반영. 미도달은 sent → failed 로 내려간다(멱등). */
export function reportInvitationDeliveryResult(
  input: {
    checked: Array<{
      dispatch_id: string;
      invitation_id: string;
      delivered: boolean;
      code?: string | null;
      desc?: string | null;
    }>;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ marked: number; undelivered: number }>(
    "POST",
    `${ATTENDEE_BASE}/invitation-dispatch/delivery-result`,
    input,
    opts,
  );
}

export function completeInvitationDispatch(
  input: {
    claim_token: string;
    dispatch_ids: string[];
    invitation_ids: string[];
    sent: boolean;
    request_id?: string | null;
    error?: string | null;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ updated: number }>(
    "POST",
    `${ATTENDEE_BASE}/invitation-dispatch/complete`,
    input,
    opts,
  );
}

// ── 좌석 알림(찜) ────────────────────────────────────────────────────────────

export interface V2SeatWatch {
  id: string;
  event_id: string;
  seat_id: string;
  target_price: number | null;
  notify_at: string | null;
  created_at: string | null;
}

/** 찜 소유축 — v2 회원(userId) 또는 게스트 쿠키(sessionId). 둘 중 하나 필수. */
export type SeatWatchOwner = { userId: string } | { sessionId: string };

function seatWatchOwnerQuery(owner: SeatWatchOwner): string {
  return "userId" in owner
    ? `user_id=${encodeURIComponent(owner.userId)}`
    : `session_id=${encodeURIComponent(owner.sessionId)}`;
}

export function listSeatWatches(
  eventId: string,
  owner: SeatWatchOwner,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ watches: V2SeatWatch[] }>(
    "GET",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/seat-watches?${seatWatchOwnerQuery(owner)}&limit=100`,
    undefined,
    opts,
  );
}

export function upsertSeatWatch(
  eventId: string,
  input: {
    seat_id: string;
    user_id?: string | null;
    session_id?: string | null;
    account_ref?: string | null;
    target_price?: number | null;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ watch: V2SeatWatch }>(
    "POST",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/seat-watches`,
    input,
    opts,
  );
}

export function deleteSeatWatch(
  eventId: string,
  seatId: string,
  owner: SeatWatchOwner,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ deleted: number }>(
    "DELETE",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/seat-watches?seat_id=${encodeURIComponent(seatId)}&${seatWatchOwnerQuery(owner)}`,
    undefined,
    opts,
  );
}

export interface V2PendingSeatWatch {
  id: string;
  event_id: string;
  seat_id: string;
  account_ref: string | null;
  session_id: string | null;
  target_price: number | null;
}

export function listPendingSeatWatches(limit = 200, opts?: RequestOptions) {
  return v2CommerceRequest<{ watches: V2PendingSeatWatch[] }>(
    "GET",
    `${ATTENDEE_BASE}/seat-watches/pending?limit=${limit}`,
    undefined,
    opts,
  );
}

/** 발송 선점(조건부). true 를 받은 실행만 발송한다 — 동시 tick 이중발송 차단. */
export function claimSeatWatch(watchId: string, opts?: RequestOptions) {
  return v2CommerceRequest<{ claimed: boolean }>(
    "POST",
    `${ATTENDEE_BASE}/seat-watches/${encodeURIComponent(watchId)}/claim`,
    {},
    opts,
  );
}

/** 선점 해제 — 발송 실패 시 되돌리지 않으면 알림이 영구 유실된다. */
export function releaseSeatWatch(watchId: string, opts?: RequestOptions) {
  return v2CommerceRequest<{ released: boolean }>(
    "POST",
    `${ATTENDEE_BASE}/seat-watches/${encodeURIComponent(watchId)}/release`,
    {},
    opts,
  );
}

// ── 현장 체크인 명단 / 로그 ──────────────────────────────────────────────────

export interface V2CheckInList {
  id: string;
  name: string;
  status: string;
  product_ids: string[];
  opens_at: string | null;
  closes_at: string | null;
  created_at: string | null;
}

export function listCheckInLists(eventId: string, accountId: string, opts?: RequestOptions) {
  return v2CommerceRequest<{ lists: V2CheckInList[] }>(
    "GET",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/check-in-lists?organizer_ref=${encodeURIComponent(accountId)}`,
    undefined,
    opts,
  );
}

export function getCheckInList(
  eventId: string,
  listId: string,
  accountId: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ list: V2CheckInList }>(
    "GET",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/check-in-lists/${encodeURIComponent(listId)}?organizer_ref=${encodeURIComponent(accountId)}`,
    undefined,
    opts,
  );
}

export function createCheckInList(
  eventId: string,
  accountId: string,
  input: {
    name: string;
    product_ids?: string[];
    opens_at?: string | null;
    closes_at?: string | null;
    status?: string | null;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ list: V2CheckInList }>(
    "POST",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/check-in-lists`,
    { organizer_ref: goAccountRef(accountId), ...input },
    opts,
  );
}

export function patchCheckInList(
  eventId: string,
  listId: string,
  accountId: string,
  input: {
    name?: string;
    product_ids?: string[];
    opens_at?: string | null;
    closes_at?: string | null;
    status?: string;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ list: V2CheckInList }>(
    "PATCH",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/check-in-lists/${encodeURIComponent(listId)}`,
    { organizer_ref: goAccountRef(accountId), ...input },
    opts,
  );
}

export function deleteCheckInList(
  eventId: string,
  listId: string,
  accountId: string,
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ deleted: boolean }>(
    "DELETE",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/check-in-lists/${encodeURIComponent(listId)}?organizer_ref=${encodeURIComponent(accountId)}`,
    undefined,
    opts,
  );
}

export interface V2CheckInLog {
  id: string;
  ticket_id: string;
  attendee_name: string | null;
  ticket_number: string | null;
  method: string;
  note: string | null;
  attended_date: string | null;
  list_name: string | null;
  created_at: string | null;
}

export function listCheckInLogs(
  eventId: string,
  accountId: string,
  filter: { checkInListId?: string | null; ticketId?: string | null; limit?: number } = {},
  opts?: RequestOptions,
) {
  const qs = new URLSearchParams({ organizer_ref: accountId });
  if (filter.checkInListId) qs.set("check_in_list_id", filter.checkInListId);
  if (filter.ticketId) qs.set("ticket_id", filter.ticketId);
  if (filter.limit) qs.set("limit", String(filter.limit));
  return v2CommerceRequest<{ logs: V2CheckInLog[] }>(
    "GET",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/check-in-logs?${qs.toString()}`,
    undefined,
    opts,
  );
}

/**
 * 체크인 로그 기록 — **멱등**(ticket_id, attended_date 유니크).
 * 이미 있으면 `created=false`. 입장은 성공했는데 로그만 실패한 경우 다음 스캔이 복구한다.
 */
export function recordCheckInLog(
  eventId: string,
  accountId: string,
  input: {
    ticket_id: string;
    attended_date: string;
    check_in_list_id?: string | null;
    attendee_name?: string | null;
    ticket_number?: string | null;
    checked_in_by_ref?: string | null;
    method?: string;
    note?: string | null;
  },
  opts?: RequestOptions,
) {
  return v2CommerceRequest<{ created: boolean; id: string }>(
    "POST",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/check-in-logs`,
    { organizer_ref: goAccountRef(accountId), ...input },
    opts,
  );
}

export function deleteCheckInLogs(
  eventId: string,
  accountId: string,
  input: { ticketId: string; attendedDate: string },
  opts?: RequestOptions,
) {
  const qs = new URLSearchParams({
    organizer_ref: accountId,
    ticket_id: input.ticketId,
    attended_date: input.attendedDate,
  });
  return v2CommerceRequest<{ deleted: number }>(
    "DELETE",
    `${ATTENDEE_BASE}/events/${encodeURIComponent(eventId)}/check-in-logs?${qs.toString()}`,
    undefined,
    opts,
  );
}

/** 티켓번호로 회수되지 않은 초대 1건(표기값 + 딥링크 nonce). 없으면 null. */
export interface V2InvitationByTicket {
  id: string;
  recipient_name: string;
  admission_day: string | null;
  admission_mode: string | null;
  token_version: number;
  status: string;
}

export function getInvitationByTicketNumber(ticketNumber: string, opts?: RequestOptions) {
  return v2CommerceRequest<{ invitation: V2InvitationByTicket | null }>(
    "GET",
    `${ATTENDEE_BASE}/invitations/by-ticket-number/${encodeURIComponent(ticketNumber)}`,
    undefined,
    opts,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 레벨2 컷오버 T3 — 수수료 정본 read (go `platform_fee_plans` 대체)
//
// go 는 `platform_fee_plans INNER JOIN accounts` 로 요율을 읽었다. accounts 가 비워지면서
// 그 조회가 항상 NULL → **플랫폼 수수료 0원**으로 주문이 생성되던 경로다.
// 정본을 v2 `fee_schedules` 로 옮기고 여기서 유효 스케줄을 가져온다.
// 값 계약은 go 기존 그대로 — `feePercentage` 는 백분율(3.00 = 3%).
// ─────────────────────────────────────────────────────────────────────────────

/** v2 유효 fee schedule 1건(응답 원문). 없으면 null. */
export interface V2FeePlan {
  id: string;
  scope: "organizer" | "platform";
  fee_type: string;
  fee_percentage: number;
  fee_fixed: number;
  min_fee: number;
  max_fee: number | null;
}

/**
 * organizer 의 유효 수수료 플랜을 v2 에서 읽는다.
 * @throws V2CommerceError v2 조회 실패. 🔴 호출측은 이를 "수수료 0" 으로 흘리면 안 된다(fail-closed).
 */
export async function getOrganizerFeePlan(
  organizerRef: string,
  opts: RequestOptions = {},
): Promise<V2FeePlan | null> {
  const res = await v2CommerceRequest<{ fee_plan: V2FeePlan | null }>(
    "GET",
    `/api/v1/internal/organizers/${encodeURIComponent(organizerRef)}/fee-plan`,
    undefined,
    opts,
  );
  return res?.fee_plan ?? null;
}
