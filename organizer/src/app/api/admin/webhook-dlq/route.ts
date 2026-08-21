import { z } from "zod";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { replayDeadLetteredWebhook } from "@/lib/webhooks/replay";

const sameOriginOrBearer = (request: Request) => {
  if (/^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? "")) return true;
  const host = request.headers.get("host");
  const origin = request.headers.get("origin") ?? request.headers.get("referer");
  if (!host || !origin) return false;
  try { return new URL(origin).host === host; } catch { return false; }
};

export const GET = withRole("owner", async (request, { session }) => {
  const params = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(params.get("limit") ?? "50") || 50, 1), 100);
  const page = Math.max(Number(params.get("page") ?? "1") || 1, 1);
  const offset = (page - 1) * limit;
  const event = params.get("event");
  const values: unknown[] = [session.accountId, limit, offset];
  const eventClause = event ? "AND d.event = $4" : "";
  if (event) values.push(event);
  // ── 레벨2 컷오버 W3-OPS — go read 잔존 사유 + 순서 위험 ──
  // `inter_service_webhook_deliveries` 는 T3 **소멸군**이다(v2→go 주문상태 웹훅의 수신 멱등 원장.
  // go 커머스가 사라지면 존재 이유가 소멸 — v2 동형 테이블 생성은 금지. EXEC-PLAN §T3).
  //
  // 🔴 **순서 위험**: 이 테이블에는 `account_id` 가 없다(mig132). 아래 `JOIN orders … AND
  //    o.account_id = $1` 이 **유일한 테넌트 경계**이자 유일한 event_id 출처다. 따라서
  //    go `orders` 를 이 테이블보다 **먼저** 비우거나 DROP 하면 JOIN 이 0행이 되어 DLQ 가
  //    "0건"으로 보인다 — 즉 미처리 데드레터가 운영 화면에서 조용히 사라진다.
  //    LEFT JOIN 으로 낮출 수도 없다(경계가 사라져 크로스테넌트 누출). 소멸 순서는 반드시
  //    `inter_service_webhook_deliveries` DROP → `orders` DROP 이어야 한다.
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT d.id, d.delivery_id, d.event, d.status, d.error_message, d.dead_letter_reason,
            d.retry_count, d.created_at, d.dead_lettered_at, d.replay_status, d.replay_count,
            d.replay_requested_at, o.event_id, o.id AS order_id,
            COUNT(*) OVER()::int AS total_count
       FROM inter_service_webhook_deliveries d
       JOIN orders o ON o.v2_order_id::text = d.payload->>'order_id' AND o.account_id = $1
      WHERE d.direction = 'inbound' AND d.source = 'v2' AND d.status = 'dead_lettered'
        ${eventClause}
      ORDER BY d.dead_lettered_at NULLS FIRST, d.created_at
      LIMIT $2 OFFSET $3`,
    values,
  );
  const total = Number(rows[0]?.total_count ?? 0);
  return listResponse(rows.map(({ total_count: _totalCount, ...row }) => row), total, page, limit);
});

const bulkSchema = z.object({
  deliveryIds: z.array(z.string().regex(/^\d+$/)).min(1).max(20),
  reason: z.string().trim().min(5).max(1000),
  dryRun: z.boolean().optional(),
});

export const POST = withRole("owner", async (request, { session }) => {
  if (!sameOriginOrBearer(request)) return errorResponse("동일 출처 관리자 요청만 허용됩니다", 403);
  const baseKey = request.headers.get("idempotency-key")?.trim();
  if (!baseKey || baseKey.length > 180) return errorResponse("Idempotency-Key 헤더가 필요합니다", 400);
  let body: z.infer<typeof bulkSchema>;
  try { body = bulkSchema.parse(await request.json()); }
  catch (err) { return errorResponse(err instanceof z.ZodError ? (err.issues[0]?.message ?? "입력값을 확인해주세요") : "요청 본문을 해석할 수 없습니다", 400); }

  const results = [];
  for (const deliveryId of body.deliveryIds) {
    results.push(await replayDeadLetteredWebhook({
      deliveryRowId: deliveryId,
      accountId: session.accountId,
      actorId: session.id,
      operationKey: `${baseKey}:${deliveryId}`,
      reason: body.reason,
      dryRun: body.dryRun,
    }));
  }
  return successResponse({ dryRun: body.dryRun === true, count: results.length, results });
});
