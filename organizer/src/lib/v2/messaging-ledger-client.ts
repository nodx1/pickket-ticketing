/**
 * W5-MSG: 발송 원장(메시지·delivery·attempt·캠페인·수신함) v2 클라이언트.
 *
 * 레벨2 컷오버로 go DB 를 제거하면서 발송 결과 원장 계열을 v2 로 이전한다. go 는 이
 * 클라이언트로만 원장을 읽고 쓴다(go DB SQL 0).
 *
 *   go 테이블                                    → v2 엔드포인트
 *   event_messages                               → /messaging/messages/{list,get}
 *   message_deliveries                           → /messaging/messages/deliveries,
 *                                                  /messaging/deliveries/*
 *   message_delivery_attempts                    → (deliveries/get·dlr·unknown 에 포함)
 *   message_delivery_operator_actions            → /messaging/deliveries/operator-action
 *   email_campaigns / email_campaign_recipients  → /messaging/campaigns/*
 *   inbound_emails                               → /messaging/inbound-emails/*
 *   reminder_sends                               → (없음 — 리마인더는 v2 Celery 전담)
 *
 * ⚠️ **fail-closed 계약** — 이 파일의 모든 함수는 실패 시 `V2MessagingLedgerError` 를 throw
 *   한다. 절대 빈 배열/null 로 강등하지 마라. 발송 원장에서 "조회 실패 → 빈 목록"은
 *     · 발송 상세가 "0명에게 보냄"으로 보이고(실제로는 확인 불가)
 *     · 미확정(unknown) 큐가 비어 보여 **수동검토가 필요한 건이 사라진다**
 *   과거 이 프로젝트에서 같은 실수가 두 번 났다(lotteryWon·productIds 세그먼트).
 *
 * 인증: commerce-client / messaging-compliance-client 와 동일한 HMAC 계약.
 *   sig = HMAC_SHA256(GO_WEBHOOK_SECRET, `${ts}.${rawBody}`).hex(), ts = ISO8601 UTC.
 * env 는 **호출 시점 lazy read**(모듈 로드 시점 캡처 금지 — cron/tsx 로더 순서 안전).
 */
import crypto from "node:crypto";

const BASE_PATH = "/api/v1/internal/messaging";
const TIMEOUT_MS = 15_000;

export class V2MessagingLedgerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "V2MessagingLedgerError";
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

async function request<T>(
  path: string,
  body: unknown,
  opts: { idempotencyKey?: string } = {},
): Promise<T> {
  const base = getBase();
  const secret = getSecret();
  if (!base || !secret) {
    // 미설정도 **실패**다. "설정이 없으니 원장이 비었다"로 흘리면 미확정 발송이 증발한다.
    throw new V2MessagingLedgerError("커머스 연동이 설정되지 않아 발송 원장을 조회할 수 없습니다");
  }
  const raw = JSON.stringify(body);
  const timestamp = new Date().toISOString();
  const signature = crypto.createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Pickket-Signature": signature,
    "X-Pickket-Timestamp": timestamp,
    "X-Pickket-Service-Token": secret,
  };
  if (opts.idempotencyKey) headers["Idempotency-Key"] = opts.idempotencyKey;

  let res: Response;
  try {
    res = await fetch(`${base.replace(/\/$/, "")}${BASE_PATH}${path}`, {
      method: "POST",
      headers,
      body: raw,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err: unknown) {
    throw new V2MessagingLedgerError(
      `발송 원장 조회 중 커머스 연결에 실패했습니다: ${err instanceof Error ? err.message : "unknown"}`,
    );
  }
  let envelope: Envelope<T> | null = null;
  try {
    envelope = (await res.json()) as Envelope<T>;
  } catch {
    envelope = null;
  }
  if (!res.ok || envelope?.ok === false || envelope?.data === undefined) {
    throw new V2MessagingLedgerError(
      envelope?.error?.message ?? `발송 원장 처리에 실패했습니다 (커머스 응답 ${res.status})`,
      res.status,
    );
  }
  return envelope.data as T;
}

/** v2 응답 status 를 HTTP 로 옮길 때 쓰는 공통 규칙 — 404 만 404, 나머지는 503(재시도 가능). */
export function ledgerErrorStatus(err: V2MessagingLedgerError): number {
  return err.status === 404 ? 404 : 503;
}

// ── 메시지 조회 ──────────────────────────────────────────────────────────────

export interface V2EventMessage {
  id: string;
  title: string;
  channel: string;
  status: string;
  body: string;
  message_type: string;
  recipient_filter: string;
  template_code: string | null;
  sent_count: number;
  failed_count: number;
  delivered_count: number;
  opened_count: number;
  clicked_count: number;
  result_meta: Record<string, unknown> | null;
  scheduled_at: string | null;
  sent_at: string | null;
  created_at: string | null;
}

export async function listEventMessages(
  accountId: string,
  eventId: string,
  status?: string | null,
): Promise<V2EventMessage[]> {
  const data = await request<{ messages: V2EventMessage[] }>("/messages/list", {
    go_account_id: accountId,
    event_id: eventId,
    status: status ?? null,
  });
  return data.messages ?? [];
}

/** 미존재는 null(404 는 정상 결과) — 그 외 실패는 throw. */
export async function getEventMessage(
  accountId: string,
  eventId: string,
  messageId: string,
): Promise<V2EventMessage | null> {
  try {
    const data = await request<{ message: V2EventMessage }>("/messages/get", {
      go_account_id: accountId,
      event_id: eventId,
      message_id: messageId,
    });
    return data.message;
  } catch (err: unknown) {
    if (err instanceof V2MessagingLedgerError && err.status === 404) return null;
    throw err;
  }
}

export interface V2DeliveryRow {
  contact_masked: string;
  status: string;
  reason: string | null;
  channel: string;
  delivered_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  updated_at: string | null;
}

export interface V2DeliverySummary {
  total: number;
  sent: number;
  delivered: number;
  failed: number;
  skipped: number;
  opened: number;
  clicked: number;
}

/** 미존재(비소유) 메시지는 null — 목록 조회 실패와 구분한다. */
export async function listMessageDeliveries(
  accountId: string,
  eventId: string,
  messageId: string,
  opts: { status?: string | null; limit: number; offset: number },
): Promise<{ items: V2DeliveryRow[]; total: number; summary: V2DeliverySummary } | null> {
  try {
    return await request<{ items: V2DeliveryRow[]; total: number; summary: V2DeliverySummary }>(
      "/messages/deliveries",
      {
        go_account_id: accountId,
        event_id: eventId,
        message_id: messageId,
        status: opts.status ?? null,
        limit: opts.limit,
        offset: opts.offset,
      },
    );
  } catch (err: unknown) {
    if (err instanceof V2MessagingLedgerError && err.status === 404) return null;
    throw err;
  }
}

// ── 발송 건 운영(owner) ──────────────────────────────────────────────────────

export interface V2DeliveryQueueItem {
  id: string;
  message_id: string;
  channel: string;
  status: string;
  reason: string | null;
  request_id: string | null;
  reconcile_attempts: number;
  created_at: string | null;
  updated_at: string | null;
  event_id: string;
  title: string;
  contact_masked: string;
}

export async function listDeliveryQueue(
  accountId: string,
  status: string,
  limit: number,
): Promise<V2DeliveryQueueItem[]> {
  const data = await request<{ items: V2DeliveryQueueItem[] }>("/deliveries/queue", {
    go_account_id: accountId,
    status,
    limit,
  });
  return data.items ?? [];
}

export interface V2DeliveryAttempt {
  id: string;
  attempt_no: number;
  provider: string;
  idempotency_key: string;
  provider_request_id: string | null;
  http_status: number | null;
  result_status: string;
  timeout_stage: string | null;
  ambiguous: boolean;
  started_at: string | null;
  finished_at: string | null;
  provider_error_code: string | null;
  provider_error_summary: string | null;
}

export async function getDeliveryDetail(
  accountId: string,
  deliveryId: string,
): Promise<{ delivery: Record<string, unknown>; attempts: V2DeliveryAttempt[] } | null> {
  try {
    return await request<{ delivery: Record<string, unknown>; attempts: V2DeliveryAttempt[] }>(
      "/deliveries/get",
      { go_account_id: accountId, delivery_id: deliveryId },
    );
  } catch (err: unknown) {
    if (err instanceof V2MessagingLedgerError && err.status === 404) return null;
    throw err;
  }
}

export type DeliveryOperatorAction =
  | "manual_review"
  | "confirm_sent"
  | "confirm_failed"
  | "resend"
  | "reconcile";

export interface DeliveryOperatorResult {
  delivery_id: string;
  action: DeliveryOperatorAction;
  previous_status: string;
  status: string;
  parent_status: string;
  requeued: boolean;
  idempotent?: boolean;
}

/**
 * 복구 액션 실행. `operationKey` 는 **호출자가 준 안정 키**를 그대로 전달한다
 * (v2 가 (account_id, operation_key) 유니크로 재시도를 멱등 처리). 매 호출 새 UUID 를
 * 만들면 같은 조작이 여러 번 기록되고 상태 전이가 두 번 일어난다 — 멱등이 아니다.
 */
export function runDeliveryOperatorAction(input: {
  accountId: string;
  actorId: string;
  deliveryId: string;
  operationKey: string;
  action: DeliveryOperatorAction;
  reason: string;
  providerRequestId?: string | null;
}): Promise<DeliveryOperatorResult> {
  return request<DeliveryOperatorResult>("/deliveries/operator-action", {
    go_account_id: input.accountId,
    actor_id: input.actorId,
    delivery_id: input.deliveryId,
    operation_key: input.operationKey,
    action: input.action,
    reason: input.reason,
    provider_request_id: input.providerRequestId ?? null,
  });
}

export interface V2MessageRecoverySummary {
  inflight: number;
  unknown: number;
  manual_review: number;
  failed: number;
  oldest_unknown_age_seconds: number;
  parent_stuck: number;
}

export function getMessageRecoverySummary(accountId: string): Promise<V2MessageRecoverySummary> {
  return request<V2MessageRecoverySummary>("/deliveries/recovery-summary", {
    go_account_id: accountId,
  });
}

export interface V2MessagingMetrics {
  queues: Array<{ status: string; count: number; oldest_age_seconds: number | null }>;
  provider_errors: Array<{ error_class: string; count: number }>;
}

export function getMessagingMetrics(staleMinutes = 15): Promise<V2MessagingMetrics> {
  return request<V2MessagingMetrics>("/metrics", { stale_minutes: staleMinutes });
}

// ── DLR 대사 브리지 ──────────────────────────────────────────────────────────
// provider 상태조회(NCP SENS/Mailer) 클라이언트는 go 에만 있고 v2 celery 는 DLR 을 하지
// 않는다. 원장 read/write 는 v2 가, provider 조회만 go 가 담당한다.

export function fetchDlrPending(
  limit: number,
): Promise<Array<{ request_id: string; channel: string }>> {
  return request<{ requests: Array<{ request_id: string; channel: string }> }>(
    "/deliveries/dlr/pending",
    { limit },
  ).then((d) => d.requests ?? []);
}

export function applyDlrResults(
  results: Array<{
    request_id: string;
    contact: string;
    channel: "sms" | "kakao";
    state: "delivered" | "failed";
    detail?: string | null;
  }>,
): Promise<{ delivered: number; failed: number }> {
  return request<{ delivered: number; failed: number }>("/deliveries/dlr/apply", { results });
}

export interface V2UnknownDelivery {
  id: string;
  message_id: string;
  channel: "email" | "sms" | "kakao";
  contact: string;
  request_id: string | null;
  reconcile_attempts: number;
  created_at: string | null;
}

export function claimUnknownDeliveries(limit: number): Promise<V2UnknownDelivery[]> {
  return request<{ items: V2UnknownDelivery[] }>("/deliveries/unknown/claim", { limit }).then(
    (d) => d.items ?? [],
  );
}

export function applyUnknownResults(
  items: Array<{
    delivery_id: string;
    outcome: "delivered" | "sent" | "failed" | "unresolved";
    reason?: string | null;
  }>,
): Promise<{ checked: number; resolved: number; manual_review: number; remaining: number }> {
  return request<{ checked: number; resolved: number; manual_review: number; remaining: number }>(
    "/deliveries/unknown/apply",
    { items },
  );
}

// ── 오픈/클릭 트래킹 ─────────────────────────────────────────────────────────

/** opened_at/clicked_at 최초 1회 기록(멱등). message_id 는 메시지 또는 캠페인 id. */
export function recordEmailTracking(
  messageId: string,
  contact: string,
  clicked: boolean,
): Promise<{ delivery: boolean; campaign_recipient: boolean }> {
  return request<{ delivery: boolean; campaign_recipient: boolean }>("/tracking", {
    message_id: messageId,
    contact,
    clicked,
  });
}

// ── 이메일 캠페인 ────────────────────────────────────────────────────────────

export interface V2Campaign {
  id: string;
  subject: string;
  status: string;
  stats: Record<string, unknown> | null;
  scheduled_at: string | null;
  sent_at: string | null;
  created_at: string | null;
}

export function listCampaigns(accountId: string, eventId: string): Promise<V2Campaign[]> {
  return request<{ campaigns: V2Campaign[] }>("/campaigns/list", {
    go_account_id: accountId,
    event_id: eventId,
  }).then((d) => d.campaigns ?? []);
}

export interface V2CampaignDetail {
  campaign: {
    id: string;
    subject: string;
    body_html: string;
    status: string;
    message_type: string;
    segment: Record<string, unknown> | null;
    stats: Record<string, unknown> | null;
    scheduled_at: string | null;
    sent_at: string | null;
  };
  total_recipients: number;
  sent: number;
  opened: number;
  clicked: number;
}

export async function getCampaign(
  accountId: string,
  eventId: string,
  campaignId: string,
): Promise<V2CampaignDetail | null> {
  try {
    return await request<V2CampaignDetail>("/campaigns/get", {
      go_account_id: accountId,
      event_id: eventId,
      campaign_id: campaignId,
    });
  } catch (err: unknown) {
    if (err instanceof V2MessagingLedgerError && err.status === 404) return null;
    throw err;
  }
}

/** draft → sent 전이. 이미 draft 가 아니면 409(중복 발송 차단) — 호출자가 구분해 처리. */
export function markCampaignSent(
  accountId: string,
  eventId: string,
  campaignId: string,
): Promise<{ campaign_id: string; status: string }> {
  return request<{ campaign_id: string; status: string }>("/campaigns/mark-sent", {
    go_account_id: accountId,
    event_id: eventId,
    campaign_id: campaignId,
  });
}

// ── 인바운드 이메일(수신함) ──────────────────────────────────────────────────

export interface V2InboundEmailSummary {
  id: string;
  from_email: string;
  from_name: string | null;
  subject: string | null;
  status: string;
  excerpt: string | null;
  has_ai_draft: boolean;
  created_at: string | null;
}

export function listInboundEmails(
  accountId: string,
  eventId: string,
  status: string,
): Promise<V2InboundEmailSummary[]> {
  return request<{ emails: V2InboundEmailSummary[] }>("/inbound-emails/list", {
    go_account_id: accountId,
    event_id: eventId,
    status,
  }).then((d) => d.emails ?? []);
}

export interface V2InboundEmail {
  id: string;
  from_email: string;
  from_name: string | null;
  subject: string | null;
  body_text: string | null;
  body_html: string | null;
  status: string;
  ai_draft: string | null;
  assigned_to: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export async function getInboundEmail(
  accountId: string,
  eventId: string,
  emailId: string,
): Promise<V2InboundEmail | null> {
  try {
    const data = await request<{ email: V2InboundEmail }>("/inbound-emails/get", {
      go_account_id: accountId,
      event_id: eventId,
      email_id: emailId,
    });
    return data.email;
  } catch (err: unknown) {
    if (err instanceof V2MessagingLedgerError && err.status === 404) return null;
    throw err;
  }
}

export async function patchInboundEmail(
  accountId: string,
  eventId: string,
  emailId: string,
  patch: { status?: string; assignedTo?: string | null },
): Promise<{ id: string } | null> {
  try {
    return await request<{ id: string }>("/inbound-emails/patch", {
      go_account_id: accountId,
      event_id: eventId,
      email_id: emailId,
      status: patch.status ?? null,
      assigned_to: patch.assignedTo ?? null,
      clear_assignee: patch.assignedTo === null,
    });
  } catch (err: unknown) {
    if (err instanceof V2MessagingLedgerError && err.status === 404) return null;
    throw err;
  }
}

export async function recordInboundReply(
  accountId: string,
  eventId: string,
  emailId: string,
  replyBody: string,
  repliedBy: string,
): Promise<{ id: string } | null> {
  try {
    return await request<{ id: string }>("/inbound-emails/record-reply", {
      go_account_id: accountId,
      event_id: eventId,
      email_id: emailId,
      reply_body: replyBody,
      replied_by: repliedBy,
    });
  } catch (err: unknown) {
    if (err instanceof V2MessagingLedgerError && err.status === 404) return null;
    throw err;
  }
}

/**
 * 인바운드 웹훅 적재. `idempotencyKey` 는 **메일 내용에서 유도한 안정 키**여야 한다 —
 * provider 웹훅 재시도가 같은 메일을 두 통으로 만들면 안 된다.
 */
export function ingestInboundEmail(
  input: {
    accountId?: string | null;
    eventId?: string | null;
    fromEmail: string;
    fromName?: string | null;
    subject?: string | null;
    bodyText?: string | null;
    bodyHtml?: string | null;
  },
  idempotencyKey: string,
): Promise<{ id: string }> {
  return request<{ id: string }>(
    "/inbound-emails/ingest",
    {
      account_id: input.accountId ?? null,
      event_id: input.eventId ?? null,
      from_email: input.fromEmail,
      from_name: input.fromName ?? null,
      subject: input.subject ?? null,
      body_text: input.bodyText ?? null,
      body_html: input.bodyHtml ?? null,
    },
    { idempotencyKey },
  );
}
