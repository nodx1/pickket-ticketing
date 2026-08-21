/**
 * v2 주최자 대기열(Waitlist) internal API 클라이언트 — 레벨2 컷오버(스코프A).
 *
 * go `events/[eventId]/waitlist/**` 라우트가 go DB 를 직접 read/write 하던 것을 이 클라이언트로
 * 대체(프록시)한다. v2 = 대기열 정본(SSOT). go 는 v2 테이블을 직접참조하지 않는다(API 경유).
 *
 * 서명 계약은 commerce-client 와 동일:
 *   sig = HMAC_SHA256(GO_WEBHOOK_SECRET, `${ts}.${rawBody}`).hex(), ts = ISO8601 UTC.
 *   GET/무본문 = rawBody "" 로 서명. 전환기 토큰(X-Pickket-Service-Token) 병행.
 * (commerce-client 의 코어 요청 함수는 모듈 private 이라 재사용 불가 → 서명/요청을 자립 구현.
 *  V2CommerceError 만 공유 import 해 호출부 에러 처리를 통일한다.)
 */
import crypto from "node:crypto";
import { logger } from "@/lib/logger";
import { V2CommerceError } from "@/lib/v2/commerce-client";

function getV2Base(): string | undefined {
  return process.env.V2_INTERNAL_BASE_URL;
}
function getServiceToken(): string | undefined {
  return process.env.GO_WEBHOOK_SECRET ?? process.env.V2_EVENT_SYNC_SECRET;
}

const RETRY_BACKOFF_MS = [0, 500, 2000];

interface RequestOptions {
  idempotencyKey?: string;
  retries?: number;
}

function signRequest(rawBody: string): { signature: string; timestamp: string } | null {
  const token = getServiceToken();
  if (!token) return null;
  const timestamp = new Date().toISOString();
  const signature = crypto.createHmac("sha256", token).update(`${timestamp}.${rawBody}`).digest("hex");
  return { signature, timestamp };
}

/** v2 봉투 { ok, data, ... } 를 벗겨 data(T)를 반환. 실패 시 V2CommerceError. */
async function v2WaitlistRequest<T>(
  method: "POST" | "PATCH" | "DELETE" | "GET",
  path: string,
  body?: unknown,
  opts: RequestOptions = {},
): Promise<T> {
  const V2_BASE = getV2Base();
  const SERVICE_TOKEN = getServiceToken();
  if (!V2_BASE || !SERVICE_TOKEN) {
    throw new V2CommerceError(
      "v2 대기열 클라이언트 미설정 (V2_INTERNAL_BASE_URL / GO_WEBHOOK_SECRET)",
      500,
    );
  }

  const url = `${V2_BASE.replace(/\/$/, "")}${path}`;
  const idempotencyKey = opts.idempotencyKey ?? crypto.randomUUID();
  const retries = opts.retries ?? 2;
  const payload = body === undefined ? undefined : JSON.stringify(body);

  let lastErr: V2CommerceError | null = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, RETRY_BACKOFF_MS[attempt] ?? 2000));
    }
    try {
      const signed = signRequest(payload ?? "");
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Pickket-Service-Token": SERVICE_TOKEN,
        "Idempotency-Key": idempotencyKey,
        "User-Agent": "pickket-go-waitlist/1.0",
      };
      if (signed) {
        headers["X-Pickket-Signature"] = signed.signature;
        headers["X-Pickket-Timestamp"] = signed.timestamp;
      }
      const res = await fetch(url, { method, headers, body: payload });
      const text = await res.text();
      let env: { ok?: boolean; data?: T; error?: { code?: string; message?: string } } | null = null;
      try {
        env = text ? JSON.parse(text) : null;
      } catch {
        env = null;
      }
      if (res.ok && env?.ok) {
        return env.data as T;
      }
      const errMsg = env?.error?.message ?? `v2 대기열 ${method} ${path} 실패`;
      // 4xx 는 즉시 throw(재시도 안 함), 5xx 는 재시도.
      if (res.status >= 400 && res.status < 500) {
        throw new V2CommerceError(errMsg, res.status, text);
      }
      lastErr = new V2CommerceError(errMsg, res.status, text);
      logger.warn("v2 대기열 5xx — 재시도", { path, status: res.status, attempt });
    } catch (err: unknown) {
      if (err instanceof V2CommerceError) {
        if (err.status >= 400 && err.status < 500) throw err;
        lastErr = err;
      } else {
        lastErr = new V2CommerceError(
          err instanceof Error ? err.message : `v2 대기열 ${method} ${path} 네트워크 오류`,
          0,
        );
        logger.warn("v2 대기열 네트워크 오류 — 재시도", { path, attempt });
      }
    }
  }
  throw lastErr ?? new V2CommerceError(`v2 대기열 ${method} ${path} 실패`, 0);
}

// ── 타입 ────────────────────────────────────────────────────────────────
export interface WaitlistEntry {
  id: string;
  account_id: string;
  event_id: string;
  product_id: string;
  name: string;
  email: string;
  phone: string | null;
  status: "waiting" | "offered" | "converted" | "cancelled" | "expired";
  offered_at: string | null;
  expires_at: string | null;
  offer_token_version: number;
  converted_order_id: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface WaitlistListResult {
  items: WaitlistEntry[];
  total: number;
}

export interface ClaimBeginResult {
  claimed: boolean;
  already_claimed: boolean;
  converted_order_id: string | null;
  entry: WaitlistEntry | null;
}

// ── API ─────────────────────────────────────────────────────────────────
export function createWaitlistEntry(
  input: { account_id: string; event_id: string; product_id: string; name: string; email: string; phone?: string | null },
  opts?: RequestOptions,
): Promise<WaitlistEntry> {
  return v2WaitlistRequest<WaitlistEntry>("POST", "/api/v1/internal/waitlist/entries", input, opts);
}

export function listWaitlistEntries(
  params: { account_id: string; event_id: string; status?: string },
): Promise<WaitlistListResult> {
  const qs = new URLSearchParams({ account_id: params.account_id, event_id: params.event_id });
  if (params.status) qs.set("status", params.status);
  return v2WaitlistRequest<WaitlistListResult>("GET", `/api/v1/internal/waitlist/entries?${qs.toString()}`);
}

export function transitionWaitlistEntry(
  entryId: string,
  input: { account_id: string; event_id: string; status: string },
): Promise<WaitlistEntry> {
  return v2WaitlistRequest<WaitlistEntry>("PATCH", `/api/v1/internal/waitlist/entries/${entryId}`, input);
}

export function deleteWaitlistEntry(
  entryId: string,
  accountId: string,
  eventId: string,
): Promise<{ deleted: boolean }> {
  const qs = new URLSearchParams({ account_id: accountId, event_id: eventId });
  return v2WaitlistRequest<{ deleted: boolean }>("DELETE", `/api/v1/internal/waitlist/entries/${entryId}?${qs.toString()}`);
}

export function getWaitlistEntry(entryId: string): Promise<WaitlistEntry> {
  return v2WaitlistRequest<WaitlistEntry>("GET", `/api/v1/internal/waitlist/entries/${entryId}`);
}

export function claimBegin(entryId: string): Promise<ClaimBeginResult> {
  return v2WaitlistRequest<ClaimBeginResult>("POST", `/api/v1/internal/waitlist/entries/${entryId}/claim-begin`);
}

export function claimCommit(entryId: string, orderId: string): Promise<{ converted_order_id: string | null; committed: boolean }> {
  return v2WaitlistRequest<{ converted_order_id: string | null; committed: boolean }>(
    "POST",
    `/api/v1/internal/waitlist/entries/${entryId}/claim-commit`,
    { order_id: orderId },
  );
}

export function claimAbort(entryId: string): Promise<unknown> {
  return v2WaitlistRequest<unknown>("POST", `/api/v1/internal/waitlist/entries/${entryId}/claim-abort`);
}
