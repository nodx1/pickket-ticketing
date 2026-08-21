import { z } from "zod";
import { withRole } from "@/lib/auth/permissions";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { replayDeadLetteredWebhook } from "@/lib/webhooks/replay";

type Params = { deliveryId: string };
const schema = z.object({ reason: z.string().trim().min(5).max(1000), dryRun: z.boolean().optional() });

export const POST = withRole<Params>("owner", async (request, { session, params }) => {
  const bearer = /^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? "");
  const host = request.headers.get("host");
  const origin = request.headers.get("origin") ?? request.headers.get("referer");
  if (!bearer && (!host || !origin || (() => { try { return new URL(origin).host !== host; } catch { return true; } })())) {
    return errorResponse("동일 출처 관리자 요청만 허용됩니다", 403);
  }
  const operationKey = request.headers.get("idempotency-key")?.trim();
  if (!operationKey || operationKey.length > 200) return errorResponse("Idempotency-Key 헤더가 필요합니다", 400);
  let body: z.infer<typeof schema>;
  try { body = schema.parse(await request.json()); }
  catch (err) { return errorResponse(err instanceof z.ZodError ? (err.issues[0]?.message ?? "입력값을 확인해주세요") : "요청 본문을 해석할 수 없습니다", 400); }

  const result = await replayDeadLetteredWebhook({
    deliveryRowId: params.deliveryId,
    accountId: session.accountId,
    actorId: session.id,
    operationKey,
    reason: body.reason,
    dryRun: body.dryRun,
  });
  const status = result.status === "failed" && result.reason === "not_found" ? 404
    : result.status === "in_progress" ? 409
      : result.status === "quarantined" ? 422 : 200;
  return successResponse(result, status);
});
