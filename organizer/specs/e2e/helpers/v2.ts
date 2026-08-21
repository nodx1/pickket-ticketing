/**
 * v2 internal API 헬퍼 — cross-product 양면검증용(go 투영 == v2 SoT).
 *
 * 빅뱅 cutover 후 커머스 SoT = v2. go E2E 가 go API 만 검증하면 seam 버그(go↔v2 불일치)를 놓친다
 * (2026-06 실증이 증명: 발견 버그 ~20개 전부 제품경계). 이 헬퍼로 v2 canonical 상태를 직접 읽어
 * go 응답과 양면 비교한다.
 *
 * 인증: HMAC 서명(commerce-client 와 동일 계약) — sig = HMAC_SHA256(GO_WEBHOOK_SECRET, `${ts}.${rawBody}`).
 */
import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

// 테스트 러너 process.env 에 .env.local 이 없을 수 있어(webServer 에만 전달) 직접 로드.
(() => {
  const p = path.join(process.cwd(), ".env.local");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (!process.env[k]) process.env[k] = v;
  }
})();

const V2_BASE = (process.env.V2_INTERNAL_BASE_URL ?? "http://localhost:8021").replace(/\/$/, "");
const SECRET = process.env.GO_WEBHOOK_SECRET ?? process.env.V2_EVENT_SYNC_SECRET ?? "";

function sign(rawBody: string): { sig: string; ts: string } {
  const ts = new Date().toISOString();
  const sig = crypto.createHmac("sha256", SECRET).update(`${ts}.${rawBody}`).digest("hex");
  return { sig, ts };
}

/** v2 internal 호출(HMAC). 응답 봉투 { ok, data } 의 data 반환. */
export async function v2Call<T = unknown>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T | null; raw: string }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const { sig, ts } = sign(payload ?? "");
  const res = await fetch(`${V2_BASE}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Pickket-Service-Token": SECRET,
      "X-Pickket-Signature": sig,
      "X-Pickket-Timestamp": ts,
      "Idempotency-Key": crypto.randomUUID(),
    },
    body: payload,
    signal: AbortSignal.timeout(10_000),
  });
  const raw = await res.text();
  let data: T | null = null;
  try {
    const env = JSON.parse(raw);
    data = (env?.data ?? env) as T;
  } catch {
    /* 비-JSON */
  }
  return { status: res.status, data, raw };
}

/** v2 canonical 이벤트(상태/sales_paused 등). */
export async function v2GetEvent(v2EventId: string) {
  return v2Call<{ event_id: string; status: string; status_v2: string }>(
    "GET",
    `/api/v1/internal/events/${v2EventId}`,
  );
}

/** v2 canonical 주문(상태/환불액/티켓). */
export async function v2GetOrder(v2OrderId: string) {
  return v2Call<{
    order_id: string;
    status: string;
    status_v2: string;
    total_refunded: number;
    tickets: Array<{ ticket_id: string; status: string }>;
  }>("GET", `/api/v1/internal/orders/${v2OrderId}`);
}

/** v2 canonical 좌석(SoT status). status_counts 포함. */
export async function v2ListSeats(v2EventId: string) {
  return v2Call<{
    seats: Array<{ seat_id: string; external_ref: string | null; status: string }>;
    status_counts: Record<string, number>;
  }>("GET", `/api/v1/internal/events/${v2EventId}/seats?limit=2000`);
}
