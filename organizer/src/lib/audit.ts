import crypto from "node:crypto";
import type { AuditAction, ID, JsonValue } from "@/lib/types";
import { logger } from "@/lib/logger";

/**
 * 감사 로그 기록 — 레벨2 2차 D4: go DB 직접쓰기 → v2 정본(AuditLog) 프록시.
 *
 * SSOT: 감사 로그 정본은 v2. go 는 v2 내부 감사 엔드포인트로 프록시한다(API 경유, DB 직접참조 금지).
 * 인증: X-Pickket-Service-Token + HMAC 서명(commerce-client 와 동일 계약).
 *
 * 실패 정책: 감사 기록 실패가 상위 트랜잭션(주문/환불/체크인 등)을 깨면 안 된다 —
 *   fire-and-forget 성격이므로 실패는 경고 로그만 남기고 삼킨다(swallow).
 *   호출부 시그니처(logAudit)는 불변 → 14개 소비자 무수정.
 */

interface LogAuditParams {
  userId: ID | null;
  accountId: ID | null;
  action: AuditAction;
  tableName: string;
  recordId?: ID | null;
  changes?: JsonValue | null;
  ipAddress?: string | null;
}

function getV2Base(): string | undefined {
  return process.env.V2_INTERNAL_BASE_URL;
}
function getSecret(): string | undefined {
  return process.env.GO_WEBHOOK_SECRET ?? process.env.V2_EVENT_SYNC_SECRET;
}

export async function logAudit({
  userId,
  accountId,
  action,
  tableName,
  recordId = null,
  changes = null,
  ipAddress = null,
}: LogAuditParams) {
  const base = getV2Base();
  const secret = getSecret();
  if (!base || !secret) {
    // 미설정(dev/tsx 초기화 등) — 감사 유실 방지 위해 경고만. 상위 로직은 계속.
    logger.warn("감사 로그 — v2 클라이언트 미설정, 스킵", { action, tableName });
    return;
  }

  const payload = JSON.stringify({
    action,
    table_name: tableName,
    user_id: userId,
    account_id: accountId,
    record_id: recordId,
    changes,
    ip_address: ipAddress,
  });
  const ts = new Date().toISOString();
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${payload}`).digest("hex");

  try {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/v1/internal/audit-logs`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pickket-Service-Token": secret,
        "X-Pickket-Signature": sig,
        "X-Pickket-Timestamp": ts,
        "User-Agent": "pickket-go-audit/1.0",
      },
      body: payload,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      logger.warn("감사 로그 — v2 프록시 비정상 응답", {
        action,
        tableName,
        status: res.status,
      });
    }
  } catch (err: unknown) {
    // 감사 실패는 상위 트랜잭션을 깨지 않는다(swallow).
    logger.warn("감사 로그 — v2 프록시 실패", {
      action,
      tableName,
      error: err instanceof Error ? err.message : "unknown",
    });
  }
}
