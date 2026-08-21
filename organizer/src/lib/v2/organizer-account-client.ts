/**
 * 주최자 계정/설정/알림 — v2 `organizer_profiles` 정본 클라이언트 (레벨2 컷오버 T1).
 *
 * go 는 `users INNER JOIN accounts` 로 이 화면들을 그렸다. 컷오버로 go `accounts` 가
 * 비워지면서 `/api/account`·`/settings`·`/notifications` 가 **전부 404** 로 파손됐다.
 * 정본을 v2 로 옮기고 go 는 이 클라이언트만 쓴다.
 *
 * 🔴 실패 의미 구분(파손의 근본 원인이었다):
 *   - 프로필이 없음(v2 404)      → `null` 반환 → 라우트가 404
 *   - v2 를 읽지 못함(장애·5xx)  → `V2AccountError` throw → 라우트가 **503**
 *   "데이터가 없다"와 "읽지 못했다"를 같은 404 로 뭉개면 원인을 추적할 수 없다.
 */
import crypto from "node:crypto";

// business-verification-client 와 동일 규약: v2 `_internal_auth` 는
// sig = HMAC-SHA256(GO_WEBHOOK_SECRET, `${ts}.${rawBody}`), GET 은 빈 본문으로 서명한다.
function getV2Base(): string | undefined {
  return process.env.V2_INTERNAL_BASE_URL;
}
function getSecret(): string | undefined {
  return process.env.GO_WEBHOOK_SECRET ?? process.env.V2_EVENT_SYNC_SECRET;
}

export class V2AccountError extends Error {
  constructor(message: string, readonly status: number, readonly body?: string) {
    super(message);
    this.name = "V2AccountError";
  }
}

/** v2 가 내려주는 계정 화면 페이로드(스네이크 케이스 원문). */
export interface V2OrganizerAccount {
  id: string;
  name: string;
  email: string;
  phone: string | null;
  company_name: string;
  business_number: string | null;
  representative_name: string | null;
  contact_email: string;
  contact_phone: string | null;
  slug: string | null;
  status: string;
  timezone: string;
  currency: string;
  is_active: boolean;
  notification_prefs: Record<string, boolean>;
  created_at: string | null;
  updated_at: string | null;
}

export interface V2OrganizerAccountPatch {
  name?: string;
  phone?: string | null;
  company_name?: string;
  business_number?: string | null;
  representative_name?: string | null;
  contact_email?: string;
  contact_phone?: string | null;
  timezone?: string;
  currency?: string;
  notification_prefs?: Record<string, boolean>;
}

const TIMEOUT_MS = 8000;

async function call(
  method: "GET" | "PATCH",
  organizerRef: string,
  body?: unknown,
): Promise<V2OrganizerAccount | null> {
  const base = getV2Base();
  const secret = getSecret();
  if (!base || !secret) {
    throw new V2AccountError("v2 내부 API 설정(V2_INTERNAL_BASE_URL/GO_WEBHOOK_SECRET)이 없습니다", 0);
  }
  const raw = body === undefined ? "" : JSON.stringify(body);
  const timestamp = new Date().toISOString();
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  const url = `${base.replace(/\/$/, "")}/api/v1/internal/organizers/${encodeURIComponent(organizerRef)}/account`;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Pickket-Service-Token": secret,
        "X-Pickket-Signature": signature,
        "X-Pickket-Timestamp": timestamp,
        "Idempotency-Key": `organizer-account:${method}:${organizerRef}:${timestamp}`,
      },
      body: body === undefined ? undefined : raw,
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err: unknown) {
    // 네트워크/타임아웃 = 장애. 절대 "없음(404)" 으로 뭉개지 않는다.
    throw new V2AccountError(
      `v2 계정 조회 네트워크 오류: ${err instanceof Error ? err.message : "unknown"}`,
      0,
    );
  }

  if (res.status === 404) return null; // 진짜 없음
  if (!res.ok) {
    throw new V2AccountError(`v2 계정 ${method} 실패`, res.status, (await res.text()).slice(0, 300));
  }
  const json = (await res.json()) as { data?: V2OrganizerAccount } | V2OrganizerAccount;
  const data = (json as { data?: V2OrganizerAccount }).data ?? (json as V2OrganizerAccount);
  return data ?? null;
}

/** 계정 화면 전체(사용자·조직·설정·알림)를 v2 에서 읽는다. 없으면 null, 장애면 throw. */
export function fetchOrganizerAccount(organizerRef: string): Promise<V2OrganizerAccount | null> {
  return call("GET", organizerRef);
}

/** 전달된 필드만 v2 에 반영하고 갱신된 계정을 돌려준다. */
export function patchOrganizerAccount(
  organizerRef: string,
  patch: V2OrganizerAccountPatch,
): Promise<V2OrganizerAccount | null> {
  return call("PATCH", organizerRef, patch);
}
