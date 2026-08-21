import { z } from "zod";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { enqueueAuditOutbox } from "@/lib/audit/outbox";
import { refundOrder } from "@/lib/v2/commerce-client";
import { logger } from "@/lib/logger";
import { auditClientIp } from "@/lib/request-ip";

type Params = { actionId: string };

const actionSchema = z.object({
  action: z.enum(["manual_review", "confirm_completed", "confirm_not_refunded", "cancel", "reconcile"]),
  reason: z.string().trim().min(5).max(1000),
  evidenceId: z.string().trim().min(1).max(200).optional(),
  providerRefundId: z.string().trim().min(1).max(200).optional(),
});

type RecoveryAction = z.infer<typeof actionSchema>["action"];

function isSameOriginOrBearer(request: Request): boolean {
  if (/^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? "")) return true;
  const cookie = request.headers.get("cookie")?.match(/(?:^|;\s*)pickket_csrf=([^;]+)/)?.[1];
  const csrf = request.headers.get("x-csrf-token");
  if (cookie && (!csrf || csrf !== decodeURIComponent(cookie))) return false;
  const host = request.headers.get("host");
  const origin = request.headers.get("origin") ?? request.headers.get("referer");
  if (!host || !origin) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function allowed(action: RecoveryAction, status: string): boolean {
  if (action === "manual_review") return ["pending", "processing", "failed", "failed_retryable", "unknown", "manual_review"].includes(status);
  if (action === "reconcile") return status === "unknown" || status === "manual_review";
  if (action === "confirm_completed" || action === "confirm_not_refunded") return status === "unknown" || status === "manual_review";
  return ["pending", "failed", "failed_retryable", "unknown", "manual_review"].includes(status);
}

export const GET = withRole<Params>("owner", async (_request, { session, params }) => {
  const pool = getPool();
  const { rows } = await pool.query(
    // 🔴 테넌트 앵커는 **orders.account_id** 다. `payment_compensation_actions` 에는
    //    account_id 컬럼이 존재하지 않는다(196 생성문에 없음 · prod 실측 0건).
    //    예전 쿼리는 `a.account_id` 를 참조해 매 호출이 42703(undefined_column) → 500 이었고,
    //    단위테스트가 pool 을 모킹해 SQL 을 실행하지 않아 끝까지 드러나지 않았다.
    //    order_id 는 NOT NULL + FK(ON DELETE CASCADE) 라 INNER JOIN 이 행을 떨구지 않는다.
    `SELECT a.id, a.order_id, o.account_id, a.v2_order_id, a.status, a.reason,
            a.requested_amount, a.confirmed_refund_amount, a.attempts, a.attempt_count,
            a.max_attempts, a.provider_reference, a.provider_refund_id,
            a.provider_request_id, a.provider_status, a.provider_name,
            (a.provider_payment_key IS NOT NULL) AS has_provider_payment_key,
            a.provider_cancel_id, a.provider_last_lookup_at, a.provider_last_lookup_status,
            a.last_error_summary,
            a.manual_review_reason, a.unknown_since, a.first_attempted_at,
            a.last_attempted_at, a.completed_at, a.created_at, a.updated_at,
            o.event_id,
            -- 🔴 이 서브쿼리는 **한 번도 파싱된 적이 없었다**(재검수에서 발견).
            --    ① COALESCE( 가 끝까지 닫히지 않아 42601 syntax error,
            --    ② 닫아도 서브쿼리에 FROM 절과 op 상관조건이 없어 "missing FROM-clause entry for op".
            --    account_id 결함과 별개의 결함이 같은 쿼리에 겹쳐 있었다.
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                'id', op.id, 'action', op.action, 'fromStatus', op.from_status,
                'toStatus', op.to_status, 'reason', op.reason, 'evidenceId', op.evidence_id,
                'providerRefundId', op.provider_refund_id, 'createdAt', op.created_at
              ) ORDER BY op.created_at)
                FROM payment_compensation_operator_actions op
               WHERE op.action_id = a.id
            ), '[]'::jsonb) AS operator_actions
       FROM payment_compensation_actions a
       JOIN orders o ON o.id = a.order_id
      WHERE a.id = $1 AND o.account_id = $2
      LIMIT 1`,
    [params.actionId, session.accountId],
  );
  if (!rows[0]) return errorResponse("환불 보상 작업을 찾을 수 없습니다", 404);
  return successResponse(rows[0]);
});

export const POST = withRole<Params>("owner", async (request, { session, params }) => {
  if (!isSameOriginOrBearer(request)) return errorResponse("동일 출처 관리자 요청만 허용됩니다", 403);
  const operationKey = request.headers.get("idempotency-key")?.trim();
  if (!operationKey || operationKey.length > 200) return errorResponse("Idempotency-Key 헤더가 필요합니다", 400);

  let input: z.infer<typeof actionSchema>;
  try {
    input = actionSchema.parse(await request.json());
  } catch (err) {
    return errorResponse(err instanceof z.ZodError ? (err.issues[0]?.message ?? "입력값을 확인해주세요") : "요청 본문을 해석하지 못했습니다", 400);
  }

  const pool = getPool();

  // ── confirm_completed: v2 를 **먼저** 맞춘다 (레벨2 컷오버 T2) ──
  // 예전엔 go `orders.payment_status='refunded'` 만 쓰고 v2 를 전혀 호출하지 않아
  // v2 는 CONFIRMED + 티켓 ACTIVE 로 남았다(환불받고도 입장 가능 · 정산 과대계상).
  // go 트랜잭션 안에서 외부 호출을 하지 않기 위해 잠금 전에 v2 를 반영하고,
  // 🔴 v2 반영이 실패하면 completed 로 만들지 않고 manual_review 로 남긴다(부분성공 위장 금지).
  // 멱등키는 워커와 동일한 `payment-compensation:{actionId}` — 워커가 이미 환불했어도 2회 환불 없음.
  if (input.action === "confirm_completed") {
    const pre = await pool.query<{ v2_order_id: string | null; status: string }>(
      // 테넌트 스코프는 orders 경유(위 GET 주석 참고 — a.account_id 는 존재하지 않는 컬럼이었다).
      `SELECT a.v2_order_id, a.status
         FROM payment_compensation_actions a
         JOIN orders o ON o.id = a.order_id
        WHERE a.id = $1 AND o.account_id = $2
        LIMIT 1`,
      [params.actionId, session.accountId],
    );
    const preRow = pre.rows[0];
    if (!preRow) return errorResponse("환불 보상 작업을 찾을 수 없습니다", 404);
    if (!allowed("confirm_completed", preRow.status)) {
      return errorResponse("현재 상태에서는 해당 작업을 수행할 수 없습니다", 409);
    }
    if (!preRow.v2_order_id) {
      return errorResponse(
        "v2 주문 앵커가 없어 환불을 v2 에 반영할 수 없습니다. manual_review 로 처리해주세요",
        409,
      );
    }
    try {
      await refundOrder(
        preRow.v2_order_id,
        // 🔴 T16: confirm_completed 는 "provider 에서 이미 환불이 나갔다" 는 **운영자 확정**이다.
        //    v2 가 PG 를 또 부르면 이중 환불이므로 켠다.
        { full: true, reason: `operator_confirm_completed: ${input.reason}`, pg_already_voided: true },
        { idempotencyKey: `payment-compensation:${params.actionId}` },
      );
    } catch (err: unknown) {
      // 돈은 provider 에서 이미 나갔다는 운영자 확정이므로 재시도 루프로 돌리지 않는다.
      await pool.query(
        `UPDATE payment_compensation_actions
            SET status = 'manual_review', manual_review_reason = 'v2_propagation_failed',
                provider_refund_id = COALESCE($2, provider_refund_id),
                lease_token = NULL, lease_expires_at = NULL, updated_at = NOW()
          WHERE id = $1 AND status NOT IN ('completed', 'cancelled')`,
        [params.actionId, input.providerRefundId ?? null],
      );
      logger.error("[payment-compensation] 운영자 확정 — v2 반영 실패로 manual_review 전환", {
        actionId: params.actionId,
        v2OrderId: preRow.v2_order_id,
        error: err instanceof Error ? err.message : String(err),
      });
      return errorResponse(
        "v2 환불 반영에 실패해 완료 처리하지 않았습니다. manual_review 로 전환했습니다",
        502,
      );
    }
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<{
      id: string;
      order_id: string;
      account_id: string;
      v2_order_id: string;
      status: string;
      requested_amount: string | number;
      max_attempts: number;
      attempt_count: number;
      event_id: string;
    }>(
      `SELECT a.id, a.order_id, o.account_id, a.v2_order_id, a.status,
              a.requested_amount, a.max_attempts, a.attempt_count, o.event_id
         FROM payment_compensation_actions a
         JOIN orders o ON o.id = a.order_id
        WHERE a.id = $1 AND o.account_id = $2
        FOR UPDATE OF a`,
      [params.actionId, session.accountId],
    );
    const row = locked.rows[0];
    if (!row) {
      await client.query("ROLLBACK");
      return errorResponse("환불 보상 작업을 찾을 수 없습니다", 404);
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO payment_compensation_operator_actions
         (action_id, account_id, actor_id, operation_key, action, from_status, to_status, reason, evidence_id, provider_refund_id)
       VALUES ($1, $2, $3, $4, $5, $6, $6, $7, $8, $9)
       ON CONFLICT (account_id, operation_key) DO NOTHING
       RETURNING id`,
      [params.actionId, session.accountId, session.id, operationKey, input.action, row.status, input.reason, input.evidenceId ?? null, input.providerRefundId ?? null],
    );
    if (inserted.rows.length === 0) {
      const prior = await client.query<{ action_id: string; action: RecoveryAction; result: unknown }>(
        `SELECT action_id, action, result FROM payment_compensation_operator_actions WHERE account_id = $1 AND operation_key = $2`,
        [session.accountId, operationKey],
      );
      await client.query("ROLLBACK");
      if (!prior.rows[0] || prior.rows[0].action_id !== params.actionId || prior.rows[0].action !== input.action) {
        return errorResponse("Idempotency-Key가 다른 환불 작업에 사용되었습니다", 409);
      }
      return successResponse({ ...(typeof prior.rows[0].result === "object" && prior.rows[0].result !== null ? prior.rows[0].result : {}), idempotent: true });
    }

    if (!allowed(input.action, row.status)) throw new RecoveryError("현재 상태에서는 해당 작업을 수행할 수 없습니다", 409);
    if (input.action === "confirm_completed" && !input.providerRefundId && !input.evidenceId) {
      throw new RecoveryError("completed 확정에는 provider 환불 ID 또는 증빙 ID가 필요합니다", 400);
    }

    const targetStatus = input.action === "confirm_completed"
      ? "completed"
      : input.action === "confirm_not_refunded"
        ? row.attempt_count >= row.max_attempts ? "manual_review" : "failed_retryable"
        : input.action === "manual_review"
          ? "manual_review"
          : input.action === "cancel"
            ? "cancelled"
            : row.status;

    if (input.action === "reconcile") {
      await client.query(
        `UPDATE payment_compensation_actions SET next_retry_at = NOW(), manual_review_reason = $2, updated_at = NOW()
          WHERE id = $1 AND status IN ('unknown', 'manual_review')`,
        [params.actionId, `operator_requested:${input.reason}`],
      );
    } else {
      await client.query(
        `UPDATE payment_compensation_actions
            SET status = $2, manual_review_reason = CASE WHEN $2 = 'manual_review' THEN $3 ELSE manual_review_reason END,
                provider_refund_id = COALESCE($4, provider_refund_id),
                confirmed_refund_amount = CASE WHEN $2 = 'completed' THEN requested_refund_amount ELSE confirmed_refund_amount END,
                reviewed_by = CASE WHEN $2 IN ('manual_review', 'completed', 'cancelled') THEN $5::uuid ELSE reviewed_by END,
                reviewed_at = CASE WHEN $2 IN ('manual_review', 'completed', 'cancelled') THEN NOW() ELSE reviewed_at END,
                lease_token = NULL, lease_expires_at = NULL,
                next_retry_at = CASE WHEN $2 = 'failed_retryable' THEN NOW() ELSE NULL END,
                next_attempt_at = CASE WHEN $2 = 'failed_retryable' THEN NOW() ELSE next_attempt_at END,
                updated_at = NOW()
          WHERE id = $1 AND status NOT IN ('completed', 'cancelled')`,
        [params.actionId, targetStatus, input.reason, input.providerRefundId ?? null, session.id],
      );
      if (targetStatus === "completed") {
        await client.query(
          `UPDATE orders SET payment_status = 'refunded',
                  refund_amount = GREATEST(COALESCE(refund_amount, 0), $2), updated_at = NOW()
            WHERE id = $1 AND account_id = $3`,
          [row.order_id, Number(row.requested_amount) || 0, session.accountId],
        );
      }
    }

    const result = {
      actionId: params.actionId,
      action: input.action,
      previousStatus: row.status,
      status: targetStatus,
      eventId: row.event_id,
    };
    await client.query(
      `UPDATE payment_compensation_operator_actions SET to_status = $2, result = $3::jsonb WHERE id = $1`,
      [inserted.rows[0]!.id, targetStatus, JSON.stringify(result)],
    );
    // 트랜잭션 아웃박스(P1): go audit_logs 직접쓰기 → 동일 txn 아웃박스 적재 → v2 드레인.
    // dedup_key = operationKey 로 조작 1건당 감사 1행만 enqueue(재시도/동시성 중복 차단).
    await enqueueAuditOutbox(client, {
      action: "update",
      tableName: "payment_compensation_actions",
      userId: session.id,
      accountId: session.accountId,
      recordId: params.actionId,
      changes: { operationKey, ...result, reason: input.reason, evidenceId: input.evidenceId ?? null, providerRefundId: input.providerRefundId ?? null },
      ipAddress: auditClientIp(request.headers),
      dedupKey: `payment-comp:${session.accountId}:${operationKey}`,
    });
    await client.query("COMMIT");
    return successResponse(result);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    if (err instanceof RecoveryError) return errorResponse(err.message, err.status);
    return errorResponse(err instanceof Error ? err.message : "환불 보상 복구 작업에 실패했습니다", 500);
  } finally {
    client.release();
  }
});

class RecoveryError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}
