/**
 * Owner-only 발송 건 상세 + 복구 액션(manual_review/confirm_sent/confirm_failed/resend/reconcile).
 *
 * 원장은 v2 소유(레벨2 컷오버 W5-MSG). message_deliveries / _attempts /
 * _operator_actions go SQL 0 — 상태 전이·멱등·부모 재계산은 v2 가 한 트랜잭션으로 수행한다.
 *
 * 🔴 멱등 계약: 클라이언트의 `Idempotency-Key` 를 **그대로** v2 operation_key 로 넘긴다.
 *   v2 는 (account_id, operation_key) 유니크로 재시도를 최초 결과 재생으로 처리하고,
 *   같은 키를 다른 delivery/action 에 재사용하면 409 로 막는다. 여기서 새 UUID 를 만들면
 *   멱등이 깨져 같은 조작이 두 번 기록되고 상태가 두 번 전이된다.
 *
 * 🔴 감사: v2 전이 **성공 후** go audit_outbox 에 적재한다(dedup_key = operationKey).
 *   go 로컬 트랜잭션과 v2 상태변경을 하나로 묶을 수 없으므로 순서를 고정한다 —
 *   전이 성공 → 감사 적재. 감사 적재가 실패하면 로그로 승격시키되 사용자에게는 성공을
 *   알린다(상태는 이미 바뀌었다. 실패로 위장하면 운영자가 같은 조작을 반복한다).
 */
import { z } from "zod";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { enqueueAuditOutbox } from "@/lib/audit/outbox";
import { logger } from "@/lib/logger";
import { auditClientIp } from "@/lib/request-ip";
import {
  getDeliveryDetail,
  ledgerErrorStatus,
  runDeliveryOperatorAction,
  V2MessagingLedgerError,
  type DeliveryOperatorAction,
} from "@/lib/v2/messaging-ledger-client";

type Params = { deliveryId: string };

const actionSchema = z.object({
  action: z.enum(["manual_review", "confirm_sent", "confirm_failed", "resend", "reconcile"]),
  reason: z.string().trim().min(5).max(1000),
  providerRequestId: z.string().trim().min(1).max(200).optional(),
});

function isSameOriginOrBearer(request: Request): boolean {
  const authorization = request.headers.get("authorization") ?? "";
  if (/^Bearer\s+\S+$/i.test(authorization)) return true;

  const csrfCookie = request.headers.get("cookie")?.match(/(?:^|;\s*)pickket_csrf=([^;]+)/)?.[1];
  const csrfHeader = request.headers.get("x-csrf-token");
  if (csrfCookie && (!csrfHeader || csrfHeader !== decodeURIComponent(csrfCookie))) return false;

  const host = request.headers.get("host");
  const origin = request.headers.get("origin");
  const referer = request.headers.get("referer");
  const candidate = origin ?? referer;
  if (!host || !candidate) return false;
  try {
    return new URL(candidate).host === host;
  } catch {
    return false;
  }
}

function requestIp(request: Request): string | null {
  // ⚠️ x-real-ip 폴백을 뺐다 — 우리 nginx 설정에서 그 값은 **CF 엣지 IP** 라
  //    같은 PoP 사용자가 전부 같은 값으로 기록된다(감사 원장에 무의미한 IP).
  //    판정 실패는 null 로 남긴다. 자세한 근거는 lib/request-ip.ts 상단.
  return auditClientIp(request.headers);
}

export const GET = withRole<Params>("owner", async (_request, { session, params }) => {
  try {
    const detail = await getDeliveryDetail(session.accountId, params.deliveryId);
    if (!detail) return errorResponse("발송 건을 찾을 수 없습니다", 404);
    return successResponse({ ...detail.delivery, attempts: detail.attempts });
  } catch (err: unknown) {
    if (err instanceof V2MessagingLedgerError) {
      return errorResponse(err.message, ledgerErrorStatus(err));
    }
    return errorResponse("발송 건 조회에 실패했습니다", 500);
  }
});

export const POST = withRole<Params>("owner", async (request, { session, params }) => {
  if (!isSameOriginOrBearer(request)) return errorResponse("동일 출처 관리자 요청만 허용됩니다", 403);

  const operationKey = request.headers.get("idempotency-key")?.trim();
  if (!operationKey || operationKey.length > 200) {
    return errorResponse("Idempotency-Key 헤더가 필요합니다", 400);
  }

  let input: z.infer<typeof actionSchema>;
  try {
    input = actionSchema.parse(await request.json());
  } catch (err: unknown) {
    return errorResponse(
      err instanceof z.ZodError
        ? (err.issues[0]?.message ?? "입력값을 확인해주세요")
        : "요청 본문을 해석하지 못했습니다",
      400,
    );
  }

  let result: Awaited<ReturnType<typeof runDeliveryOperatorAction>>;
  try {
    result = await runDeliveryOperatorAction({
      accountId: session.accountId,
      actorId: session.id,
      deliveryId: params.deliveryId,
      operationKey,
      action: input.action as DeliveryOperatorAction,
      reason: input.reason,
      providerRequestId: input.providerRequestId ?? null,
    });
  } catch (err: unknown) {
    if (err instanceof V2MessagingLedgerError) {
      if (err.status === 404) return errorResponse("발송 건을 찾을 수 없습니다", 404);
      if (err.status === 409) return errorResponse(err.message, 409);
      if (err.status === 400) return errorResponse(err.message, 400);
      return errorResponse(err.message, ledgerErrorStatus(err));
    }
    return errorResponse("관리자 복구 작업에 실패했습니다", 500);
  }

  // 멱등 재생(이미 처리된 조작)이면 감사는 최초 1회분만 존재한다 — dedup_key 로 중복 적재도 차단.
  try {
    const pool = getPool();
    await enqueueAuditOutbox(pool, {
      action: "update",
      tableName: "message_deliveries",
      userId: session.id,
      accountId: session.accountId,
      recordId: params.deliveryId,
      changes: {
        operationKey,
        action: input.action,
        fromStatus: result.previous_status,
        toStatus: result.status,
        reason: input.reason,
        providerRequestId: input.providerRequestId ?? null,
      },
      ipAddress: requestIp(request),
      dedupKey: `message-delivery:${session.accountId}:${operationKey}`,
    });
  } catch (err: unknown) {
    // 🔴 상태는 v2 에서 이미 바뀌었다. 감사 적재 실패를 500 으로 돌리면 운영자가 같은 조작을
    //   반복해 혼란만 커진다 — 실패를 크게 로깅하고 결과는 성공으로 반환한다.
    logger.error("발송 복구 감사 적재 실패 — 수동 확인 필요", {
      deliveryId: params.deliveryId,
      operationKey,
      error: err instanceof Error ? err.message : "unknown",
    });
  }

  return successResponse({
    deliveryId: result.delivery_id,
    action: result.action,
    previousStatus: result.previous_status,
    status: result.status,
    parentStatus: result.parent_status,
    requeued: result.requeued,
    ...(result.idempotent ? { idempotent: true } : {}),
  });
});
