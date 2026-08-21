/**
 * 도달결과(DLR) 대사 — provider 상태조회 API 로 접수→도달 상태를 교정한다.
 * sent(접수됨) 이지만 delivered_at 이 비어있는 발송을 requestId 단위로 조회해
 * COMPLETED → delivered, FAILED → failed 로 갱신.
 *
 * ── 레벨2 컷오버 W5-MSG: go DB SQL 0 ────────────────────────────────────────
 * 발송 원장은 v2 로 이관됐다. 이 모듈은 **provider 조회만** 담당하고 원장 read/write 는
 * 전부 v2 내부 API(`messaging-ledger-client`)를 경유한다.
 *
 * 🔴 왜 v2 celery 로 통째로 넘기지 않았나
 *   v2 `reconcile_deliveries` 태스크는 "DLR 은 알림톡 세션 소유부"라며 **provider 조회를 하지
 *   않는다**(lease 만료 sending 스윕만 한다). 여기까지 스텁으로 만들면 sent→delivered 정정
 *   경로가 통째로 끊겨 모든 발송이 영원히 "발송중"으로 남는다. 기능을 죽이지 않으려면
 *   provider 조회 능력이 있는 쪽(go)이 사실을 물어오고 판정·기록은 v2 가 하는 분업이 맞다.
 *
 * 🔴 이중처리 없음 — v2 celery 는 `status='sending'` + lease 만료만 손대고, 이 경로는
 *   `status='sent'`(DLR) 와 `status='unknown'`(대사)만 손댄다. 상태 집합이 서로 소다.
 *   unknown claim 은 v2 가 next_reconcile_at 을 밀어 동시 2회 실행 시 두 번째가 빈손이 된다.
 *
 * 🔴 fail-closed — v2 원장 호출 실패는 throw 한다. 빈 목록으로 흘리면 "대사할 게 없다"로
 *   보여 미확정 발송이 조용히 방치된다.
 */
import { getRuntimeEnv } from "@/lib/env.runtime";
import { getNcpCreds, ncpJsonRequest, NCP_MAILER_HOST, NCP_SENS_HOST } from "@/lib/ncp/client";
import { logger } from "@/lib/logger";
import {
  applyDlrResults,
  applyUnknownResults,
  claimUnknownDeliveries,
  fetchDlrPending,
} from "@/lib/v2/messaging-ledger-client";

interface SensStatusMessage {
  to?: string;
  status?: string; // RESERVED | SENDING | COMPLETED | FAILED
  statusName?: string;
  statusCode?: string;
}

export type ProviderDeliveryState = "processing" | "sent" | "delivered" | "failed" | "unknown";

export interface ProviderDeliveryStatus {
  provider: "sens" | "mailer";
  requestId: string;
  recipient: string;
  state: ProviderDeliveryState;
  providerCode?: string;
  providerLabel?: string;
}

/** SMS/알림톡 requestId 의 개별 메시지 상태 조회(채널별 서비스 경로). */
export async function fetchSensStatus(
  channel: "sms" | "kakao",
  requestId: string,
): Promise<SensStatusMessage[] | null> {
  const creds = getNcpCreds();
  if (!creds) return null;
  const serviceId =
    channel === "sms"
      ? getRuntimeEnv("SENS_SMS_SERVICE_ID")
      : getRuntimeEnv("SENS_ALIMTALK_SERVICE_ID");
  if (!serviceId) return null;

  const base = channel === "sms" ? "sms" : "alimtalk";
  const uri = `/${base}/v2/services/${serviceId}/messages?requestId=${encodeURIComponent(requestId)}`;
  try {
    const res = await ncpJsonRequest<{ messages?: SensStatusMessage[] }>(
      NCP_SENS_HOST,
      "GET",
      uri,
      undefined,
      creds,
    );
    return res.messages ?? [];
  } catch (err) {
    logger.warn("DLR 조회 실패", { channel, requestId, error: err instanceof Error ? err.message : "unknown" });
    return null;
  }
}

/** Stable adapter result for operator tooling; provider-specific payload stays inside this module. */
export async function lookupSensDeliveryStatus(
  channel: "sms" | "kakao",
  requestId: string,
): Promise<ProviderDeliveryStatus[]> {
  const messages = await fetchSensStatus(channel, requestId);
  if (!messages) return [];
  return messages.filter((message) => message.to).map((message) => {
    const raw = String(message.status ?? message.statusName ?? "").toUpperCase();
    const state: ProviderDeliveryState = raw === "COMPLETED" ? "delivered"
      : raw === "FAILED" ? "failed"
        : raw === "SENDING" || raw === "RESERVED" ? "processing" : "unknown";
    return {
      provider: "sens",
      requestId,
      recipient: message.to!,
      state,
      providerCode: message.statusCode,
      providerLabel: message.statusName,
    };
  });
}

interface MailerRecipientStatus {
  status?: { code?: string; label?: string };
  sendResultCode?: string;
}

interface MailerRequestStatus {
  requestId?: string;
  readyCompleted?: boolean;
  allSentSuccess?: boolean;
  requestCount?: number;
  sentCount?: number;
  finishCount?: number;
  countsByStatus?: Array<{ status?: { code?: string; label?: string }; count?: number }>;
}

/**
 * Cloud Outbound Mailer request status. Individual email dispatch uses one
 * request per recipient, so a single completed request can be mapped safely.
 * Batch requests are deliberately left unresolved because an aggregate result
 * cannot prove the state of a specific recipient.
 */
export async function fetchMailerStatus(requestId: string, _recipient: string): Promise<MailerRecipientStatus | null> {
  const creds = getNcpCreds();
  if (!creds) return null;
  const uri = `/api/v1/mails/requests/${encodeURIComponent(requestId)}/status`;
  try {
    const result = await ncpJsonRequest<MailerRequestStatus>(NCP_MAILER_HOST, "GET", uri, undefined, creds);
    if (result.requestCount !== 1 || !result.readyCompleted || result.finishCount !== result.requestCount) return null;
    if (result.allSentSuccess === true && result.sentCount === 1) return { status: { code: "S", label: "sent" } };
    if (result.allSentSuccess === false && result.sentCount === 0) {
      const codes = (result.countsByStatus ?? []).map((item) => item.status?.code).filter(Boolean);
      if (codes.length > 0 && codes.every((code) => ["F", "U", "C"].includes(code!))) {
        return { status: { code: "F", label: "failed" }, sendResultCode: codes.join(",") };
      }
    }
    return null;
  } catch (err) {
    logger.warn("Mailer DLR 조회 실패", { requestId, error: err instanceof Error ? err.message : "unknown" });
    return null;
  }
}

export async function lookupMailerDeliveryStatus(
  requestId: string,
  recipient: string,
): Promise<ProviderDeliveryStatus> {
  const result = await fetchMailerStatus(requestId, recipient);
  const code = result?.status?.code;
  const state: ProviderDeliveryState = code === "S" ? "delivered"
    : code === "F" ? "failed" : result ? "processing" : "unknown";
  return {
    provider: "mailer",
    requestId,
    recipient,
    state,
    providerCode: code,
    providerLabel: result?.status?.label,
  };
}

const digits = (v: string) => v.replace(/[^0-9]/g, "");

/**
 * 접수 후 미도달 발송을 requestId 단위로 대사. 최대 maxRequests 건 처리(한 tick).
 *
 * 원장은 v2 소유: 대상 requestId 를 v2 에서 받아 provider 에 물어보고, 확정된 도달/실패만
 * v2 로 되돌린다. provider 응답이 없으면(자격증명 미설정·조회 실패) **아무것도 보내지 않는다**
 * — 추측으로 실패 처리하면 실제로 도달한 건을 실패로 기록한다.
 */
export async function reconcileDeliveries(
  maxRequests = 50,
): Promise<{ checked: number; delivered: number; failed: number }> {
  const reqs = await fetchDlrPending(maxRequests);
  const results: Array<{
    request_id: string;
    contact: string;
    channel: "sms" | "kakao";
    state: "delivered" | "failed";
    detail?: string | null;
  }> = [];

  for (const req of reqs) {
    const channel: "sms" | "kakao" = req.channel === "sms" ? "sms" : "kakao";
    const messages = await fetchSensStatus(channel, req.request_id);
    if (!messages) continue;
    for (const m of messages) {
      if (!m.to || !m.status) continue;
      if (m.status === "COMPLETED") {
        results.push({ request_id: req.request_id, contact: digits(m.to), channel, state: "delivered" });
      } else if (m.status === "FAILED") {
        results.push({
          request_id: req.request_id,
          contact: digits(m.to),
          channel,
          state: "failed",
          detail: m.statusName ?? m.statusCode ?? "failed",
        });
      }
    }
  }

  if (results.length === 0) return { checked: reqs.length, delivered: 0, failed: 0 };
  const applied = await applyDlrResults(results);
  return { checked: reqs.length, delivered: applied.delivered, failed: applied.failed };
}

export interface UnknownReconciliationSummary {
  checked: number;
  resolved: number;
  manualReview: number;
  remaining: number;
}

/**
 * 응답 유실로 unknown 이 된 delivery 만 대사한다. request ID 와 수신자까지 provider 에서
 * 정확히 일치할 때만 sent/delivered/failed 로 확정하며, 그렇지 않으면 사유와 함께
 * `unresolved` 로 되돌린다(backoff·manual_review 승격 판정은 v2 가 소유).
 *
 * ⚠️ unknown 은 **자동 재발송하지 않는다** — 이미 나갔을 수 있는 건을 또 보내면 이중발송이다.
 */
export async function reconcileUnknownDeliveries(limit = 50): Promise<UnknownReconciliationSummary> {
  const claimed = await claimUnknownDeliveries(limit);
  if (claimed.length === 0) {
    return { checked: 0, resolved: 0, manualReview: 0, remaining: 0 };
  }

  const items: Array<{
    delivery_id: string;
    outcome: "delivered" | "sent" | "failed" | "unresolved";
    reason?: string | null;
  }> = [];

  for (const row of claimed) {
    let outcome: "delivered" | "sent" | "failed" | "unresolved" = "unresolved";
    let reason: string | null = null;

    if (!row.request_id) {
      reason = "provider_request_id_missing";
    } else if (row.channel === "email") {
      const mail = await fetchMailerStatus(row.request_id, row.contact);
      const code = mail?.status?.code;
      if (code === "S") outcome = "sent";
      else if (["F", "U", "C"].includes(code ?? "")) {
        outcome = "failed";
        reason = `mailer:${mail?.status?.label ?? code}`;
      } else if (!mail) reason = "mailer_recipient_not_exactly_matched";
    } else {
      const messages = await fetchSensStatus(row.channel === "sms" ? "sms" : "kakao", row.request_id);
      const exact = messages?.find((message) => digits(message.to ?? "") === digits(row.contact));
      if (exact?.status === "COMPLETED") outcome = "delivered";
      else if (exact?.status === "FAILED") {
        outcome = "failed";
        reason = `sens:${exact.statusName ?? exact.statusCode ?? "failed"}`;
      } else if (messages && !exact) reason = "sens_recipient_not_exactly_matched";
      else if (!messages) reason = "sens_status_unavailable";
    }

    items.push({ delivery_id: row.id, outcome, reason });
  }

  const applied = await applyUnknownResults(items);
  logger.info("unknown delivery 대사", applied);
  return {
    checked: applied.checked,
    resolved: applied.resolved,
    manualReview: applied.manual_review,
    remaining: applied.remaining,
  };
}
