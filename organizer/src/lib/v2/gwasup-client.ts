/**
 * 과업(가중치 추첨·공정성 증명서·현장 단말·PG 직결) v2 내부 API 클라이언트.
 *
 * 인증 규약은 기존 v2 내부 호출과 같다.
 *   - GET  : X-Pickket-Service-Token (+ 빈 본문 HMAC 병행) — lottery-stats 와 동일
 *   - 쓰기 : HMAC_SHA256(secret, `${ts}.${rawBody}`) + X-Pickket-Event / Delivery-Id — draw-event 와 동일
 * 시크릿은 GO_WEBHOOK_SECRET(= v2 GO_WEBHOOK_SECRET). 없으면 V2_EVENT_SYNC_SECRET.
 *
 * ⚠️ 이 모듈은 **서버 전용**이다. 라우트 핸들러에서 주최사 소유권(getOwnedEvent)을 확인한 뒤에만 부른다.
 */
import crypto from "node:crypto";

export class V2GwasupError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "V2GwasupError";
  }
}

function base(): string {
  const url = process.env.V2_INTERNAL_BASE_URL;
  if (!url) throw new V2GwasupError("v2 연결 설정이 없습니다 (V2_INTERNAL_BASE_URL)", 500);
  return url.replace(/\/$/, "");
}

function secret(): string {
  const s = process.env.GO_WEBHOOK_SECRET ?? process.env.V2_EVENT_SYNC_SECRET;
  if (!s) throw new V2GwasupError("v2 연결 설정이 없습니다 (GO_WEBHOOK_SECRET)", 500);
  return s;
}

async function parse<T>(res: Response, path: string): Promise<T> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  if (!res.ok) {
    const detail =
      body && typeof body === "object" && "detail" in body && typeof (body as { detail: unknown }).detail === "string"
        ? (body as { detail: string }).detail
        : `v2 ${path} 실패 (${res.status})`;
    throw new V2GwasupError(detail, res.status);
  }
  return body as T;
}

export async function v2Get<T>(path: string, timeoutMs = 8_000): Promise<T> {
  const s = secret();
  const ts = new Date().toISOString();
  const sig = crypto.createHmac("sha256", s).update(`${ts}.`).digest("hex");
  const res = await fetch(`${base()}/api/v1${path}`, {
    method: "GET",
    headers: {
      "X-Pickket-Service-Token": s,
      "X-Pickket-Signature": sig,
      "X-Pickket-Timestamp": ts,
      Accept: "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return parse<T>(res, path);
}

export async function v2Write<T>(
  method: "POST" | "PUT" | "PATCH",
  path: string,
  payload: Record<string, unknown>,
  eventName: string,
  timeoutMs = 15_000,
): Promise<T> {
  const s = secret();
  const body = JSON.stringify(payload);
  const ts = new Date().toISOString();
  const sig = crypto.createHmac("sha256", s).update(`${ts}.${body}`).digest("hex");
  const res = await fetch(`${base()}/api/v1${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Pickket-Signature": sig,
      "X-Pickket-Timestamp": ts,
      "X-Pickket-Event": eventName,
      "X-Pickket-Delivery-Id": crypto.randomUUID(),
    },
    body,
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
  });
  return parse<T>(res, path);
}

/** 공개 API(인증 불필요) — 증명서 PDF 프록시 등에 쓴다. */
export async function v2Public(path: string, timeoutMs = 15_000): Promise<Response> {
  return fetch(`${base()}/api/v1${path}`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) });
}

/** 브라우저가 직접 붙는 실시간 게이트웨이 주소(공개). */
export function realtimeBaseUrl(): string {
  return (process.env.NEXT_PUBLIC_V2_REALTIME_URL ?? process.env.V2_PUBLIC_BASE_URL ?? process.env.V2_INTERNAL_BASE_URL ?? "").replace(/\/$/, "");
}

// ───────── 타입 ─────────

export interface WeightPolicy {
  algorithm: "weighted_lottery" | "weighted_allocation";
  base_weight: number;
  ap_scale: number;
  ap_cap: number;
  fan_coef: number;
  pity_coef: number;
  tenure_coef: number;
  vcg_stabilization_lambda: number;
  version: number;
}

export interface PolicyRecordView {
  id: string;
  preset: string;
  policy: WeightPolicy;
  policy_hash: string;
  updated_by: string | null;
  updated_at: string | null;
}

export interface EventPolicyView {
  event_id: string;
  defaults: WeightPolicy;
  presets: Record<string, WeightPolicy>;
  event_policy: PolicyRecordView | null;
  tiers: Array<{
    tier_id: string;
    name: string;
    sale_mode: string;
    policy: PolicyRecordView | null;
    locked_pool: { pool_id: string; status: string; policy_hash: string | null; locked_at: string | null; policy: WeightPolicy | null } | null;
  }>;
}

export interface SimulationResult {
  algorithm: string;
  policy_hash: string;
  seats: number;
  applicants: number;
  competition_ratio: number | null;
  profiles: Array<{
    key: string;
    label: string;
    count: number;
    weight: number;
    weight_share: number;
    win_probability: number;
    expected_winners: number;
  }>;
}

export interface FairnessPool {
  pool_id: string;
  tier_id: string;
  tier_name: string;
  status: string;
  applicants: number;
  capacity: number;
  algorithm: string;
  policy_hash: string | null;
  timeline: {
    policy_locked_at: string | null;
    seed_committed_at: string | null;
    entries_root_at: string | null;
    drawn_at: string | null;
    results_root_at: string | null;
    certificate_issued_at: string | null;
  };
  seed_commitment: string | null;
  entries_root: string | null;
  results_root: string | null;
  certificate: { cert_no: string; issued_at: string } | null;
}

export interface CertificateView {
  cert_no: string;
  payload: Record<string, unknown> & {
    counts: Record<string, number>;
    event: { id: string; title: string };
    tier: { id: string; name: string };
    verify_url: string;
  };
  canonical_payload: string;
  payload_hash: string;
  signature: string;
  signature_algorithm: string;
  key_id: string;
  public_key: string | null;
  issued_at: string;
  checks: Record<string, boolean>;
}

export interface MaskedEntry {
  entry_id: string;
  name: string;
  phone: string;
  result: string;
  invested_ap: number;
  weight: number | null;
  group_size: number;
  applied_at: string | null;
}

export interface OnsiteOverview {
  event_id: string;
  totals: { tickets: number; admitted_tickets: number; by_result: Record<string, number> };
  by_gate: Record<string, { admitted: number; reentry_ok: number; rejected: number }>;
  terminals: Array<{
    id: string;
    name: string;
    kind: string;
    kind_label: string;
    gate: string;
    allowed_tiers: Array<{ id: string; name: string }>;
    status: string;
    online: boolean;
    last_seen_at: string | null;
    key_prefix: string;
  }>;
  tiers: Array<{ id: string; name: string }>;
  recent: Array<{ at: string; gate: string | null; ticket_no: string | null; result: string; code: string; message: string; fraud: boolean }>;
  blocklist: { blocked: Array<{ ticket_no: string; reason: string }>; sanctioned: string[]; version: number };
}

export interface SanctionMonitor {
  event_id: string;
  counts: Record<string, number>;
  items: Array<{
    id: string;
    user: string;
    name: string;
    scope: string;
    action: string;
    reason_code: string;
    reason_label: string;
    ap_burned: number;
    disqualify_until: string | null;
    active: boolean;
    lifted: boolean;
    evidence: Record<string, unknown>;
    created_by: string | null;
    created_at: string | null;
  }>;
}

export interface SettlementOverview {
  event_id: string;
  mode: "platform" | "direct";
  fee_rate: number;
  account: PgAccountView | null;
  accounts: PgAccountView[];
  direct_orders: number;
  direct_gross: number;
  platform_fee_due: number;
  ledger: Array<{ id: number; at: string; operation: string; status: string; latency_ms: number | null; response: Record<string, unknown> }>;
}

export interface PgAccountView {
  id: string;
  provider: string;
  mode: "test" | "live";
  label: string;
  client_key: string;
  secret_hint: string;
  status: string;
  verified_at: string | null;
  last_error: string | null;
}

export interface TimeseriesView {
  mode: string;
  buckets: Array<{ bucket: string; gate?: string | null; result?: string; kind?: string; n: number; ap_sum?: number }>;
}
