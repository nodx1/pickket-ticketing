import { errorResponse, successResponse } from "@/lib/apiResponse";
import { getPool } from "@/lib/db/pool";
import { finishCronRun, startCronRun } from "@/lib/ops/cron-run";
import { processPendingOrderWebhooks } from "@/app/api/internal/orders/state-changed/route";

/** 주문 생성 순서 역전으로 보류된 v2 웹훅 inbox 재처리. 1분 주기 권장. */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  const authHeader = request.headers.get("authorization") ?? "";
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return errorResponse("인증 정보가 올바르지 않습니다", 401);
  }

  const pool = getPool();
  const cronRun = await startCronRun(pool, "retry-order-webhooks");
  try {
    const result = await processPendingOrderWebhooks(50);
    await finishCronRun(pool, cronRun, "succeeded", result);
    return successResponse(result);
  } catch (error) {
    await finishCronRun(pool, cronRun, "failed", undefined, error);
    return errorResponse("보류 웹훅 재처리에 실패했습니다", 500);
  }
}
