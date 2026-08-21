/**
 * W3-MSG: 발송 컴플라이언스 원장(수신거부·수신동의) v2 클라이언트.
 *
 * 레벨2 컷오버로 go DB 를 제거하면서 억제(`message_suppressions`)·동의(`message_consents`)
 * 원장을 v2 로 이전한다. go 는 이 클라이언트로만 원장을 읽고 쓴다(go DB SQL 0).
 *
 * ⚠️ **fail-closed 계약** — 이 파일의 모든 조회는 실패 시 `V2MessagingComplianceError` 를
 *   throw 한다. 빈 집합/false 로 흘리면 다음이 벌어진다:
 *     · 억제 조회 실패 → "억제 없음" → **수신거부·블랙리스트 대상에게 발송**
 *     · 동의 조회 실패 → "동의 없음" 이면 안전하지만, 반대로 true 폴백은 무동의 광고발송
 *   과거 이 프로젝트에서 "조회 실패 → 빈 목록" 결함이 두 번 났다(lotteryWon·productIds
 *   세그먼트). 절대 catch 해서 기본값으로 바꾸지 말 것.
 *
 * 인증: commerce-client 와 동일한 HMAC 계약
 *   sig = HMAC_SHA256(GO_WEBHOOK_SECRET, `${ts}.${rawBody}`).hex(), ts = ISO8601 UTC.
 * env 는 **호출 시점 lazy read**(모듈 로드 시점 캡처 금지 — cron/tsx 로더 순서 안전).
 */
import crypto from "node:crypto";

/** compliance.ts 의 Channel 과 동일(순환 import 회피를 위해 여기서 재선언). */
export type ComplianceChannel = "email" | "sms" | "kakao";
export type SuppressionChannel = ComplianceChannel | "all";
export type SuppressionReason = "unsubscribe" | "bounce" | "complaint" | "manual";

const BASE_PATH = "/api/v1/internal/messaging";
const TIMEOUT_MS = 15_000;
/** v2 `_MAX_CONTACTS` 와 동일 상한 — 초과분은 청크로 나눠 보낸다. */
const MAX_CONTACTS_PER_CALL = 5000;

export class V2MessagingComplianceError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "V2MessagingComplianceError";
  }
}

function getBase(): string | undefined {
  return process.env.V2_INTERNAL_BASE_URL;
}
function getSecret(): string | undefined {
  return process.env.GO_WEBHOOK_SECRET ?? process.env.V2_EVENT_SYNC_SECRET;
}

interface Envelope<T> {
  ok?: boolean;
  data?: T;
  error?: { code?: string; message?: string };
}

async function request<T>(path: string, body: unknown): Promise<T> {
  const base = getBase();
  const secret = getSecret();
  if (!base || !secret) {
    // 미설정도 **실패**다. "설정이 없으니 억제 없음"으로 흘리면 수신거부자에게 발송된다.
    throw new V2MessagingComplianceError(
      "커머스 연동이 설정되지 않아 수신거부/수신동의를 확인할 수 없습니다",
    );
  }
  const raw = JSON.stringify(body);
  const timestamp = new Date().toISOString();
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");

  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/$/, "")}${BASE_PATH}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pickket-Signature": signature,
        "X-Pickket-Timestamp": timestamp,
        "X-Pickket-Service-Token": secret,
      },
      body: raw,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err: unknown) {
    throw new V2MessagingComplianceError(
      `수신거부/수신동의 조회 중 커머스 연결에 실패했습니다: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
  if (!res.ok) {
    throw new V2MessagingComplianceError(
      `수신거부/수신동의 처리에 실패했습니다 (커머스 응답 ${res.status})`,
      res.status,
    );
  }
  let envelope: Envelope<T>;
  try {
    envelope = (await res.json()) as Envelope<T>;
  } catch {
    throw new V2MessagingComplianceError("커머스 응답을 해석할 수 없습니다");
  }
  if (envelope.ok === false || envelope.data === undefined) {
    throw new V2MessagingComplianceError(
      envelope.error?.message ?? "커머스가 수신거부/수신동의 요청을 거부했습니다",
    );
  }
  return envelope.data;
}

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length <= size) return items.length ? [items] : [];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * 억제(수신거부·바운스·블랙리스트) 배치 판정.
 * 반환 = **정규화된** 연락처 집합(이메일 소문자 / 전화 숫자만). 호출자도 같은 정규화로 비교한다.
 * 실패는 throw(fail-closed).
 */
export async function fetchSuppressedContacts(
  accountId: string,
  channel: ComplianceChannel,
  contacts: string[],
  opts: { undeliverableOnly?: boolean } = {},
): Promise<Set<string>> {
  const suppressed = new Set<string>();
  for (const part of chunk(contacts, MAX_CONTACTS_PER_CALL)) {
    const data = await request<{ suppressed?: string[] }>("/suppressions/filter", {
      go_account_id: accountId,
      channel,
      contacts: part,
      undeliverable_only: opts.undeliverableOnly ?? false,
    });
    for (const c of data.suppressed ?? []) suppressed.add(c);
  }
  return suppressed;
}

/** 억제 등록(수신거부·하드바운스·수동 차단). accountId=null 이면 전역 억제. */
export async function upsertSuppression(
  accountId: string | null,
  channel: SuppressionChannel,
  contact: string,
  reason: SuppressionReason,
): Promise<void> {
  await request<{ suppressed: boolean }>("/suppressions", {
    go_account_id: accountId,
    channel,
    contact,
    reason,
  });
}

export interface ConsentState {
  consented: boolean;
  nightConsented: boolean;
}

/**
 * 수신동의 배치 조회. 반환 Map 의 키는 정규화된 연락처.
 * **행이 없는 연락처는 Map 에 없다** = 미동의(부재를 동의로 승격 금지).
 */
export async function fetchConsents(
  accountId: string,
  channel: ComplianceChannel,
  contacts: string[],
): Promise<Map<string, ConsentState>> {
  const out = new Map<string, ConsentState>();
  for (const part of chunk(contacts, MAX_CONTACTS_PER_CALL)) {
    const data = await request<{
      consents?: Array<{ contact: string; consented: boolean; night_consented: boolean }>;
    }>("/consents/filter", { go_account_id: accountId, channel, contacts: part });
    for (const row of data.consents ?? []) {
      out.set(row.contact, {
        consented: Boolean(row.consented),
        nightConsented: Boolean(row.night_consented),
      });
    }
  }
  return out;
}

/** 수신동의 취득(grant). 원 동의시점·문구버전 보존은 v2 가 담당. */
export async function grantConsent(
  accountId: string,
  channel: ComplianceChannel,
  contact: string,
  opts: {
    consented?: boolean;
    nightConsented?: boolean;
    source?: string;
    wordingVersion?: string;
  } = {},
): Promise<void> {
  const consented = opts.consented ?? true;
  // consented=false 여도 action 은 'grant'(=현재상태 upsert) 로 보낸다. v2 record_consent 가
  // consented=False 를 그대로 저장하고 원장에는 'withdraw' 로 남긴다. 'withdraw' 액션은
  // UPDATE-only 라 행이 없으면 아무것도 남지 않아 go recordConsent(consented:false) 와 다르다.
  await request<{ action: string }>("/consents", {
    go_account_id: accountId,
    channel,
    contact,
    action: "grant",
    consented,
    night_consented: opts.nightConsented ?? false,
    source: opts.source ?? null,
    wording_version: opts.wordingVersion ?? null,
  });
}

/** 수신동의 철회(withdraw) — 수신거부와 연동. */
export async function revokeConsent(
  accountId: string,
  channel: ComplianceChannel,
  contact: string,
  source = "unsubscribe",
): Promise<void> {
  await request<{ action: string }>("/consents", {
    go_account_id: accountId,
    channel,
    contact,
    action: "withdraw",
    consented: false,
    source,
  });
}
