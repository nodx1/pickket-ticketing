/**
 * F2 초대권 발송 큐 드레인 cron — invitation_dispatch 의 queued/스톨 sending 을 claim 해서
 * 알림톡 배치 발송. 상시 워커 없이 cron 주기(1분)로 처리. 동기 in-request 발송 없음.
 * 인증: Authorization: Bearer ${CRON_SECRET}. (기존 cron 라우트와 동일 패턴)
 *
 * 실발송은 게이트2(NCP SENS 자격) 후. dev/미설정은 stub(상태만 전이). 재시도·부분실패는
 * claim-lease(조건부 UPDATE)로 동시 안전 — cron 동시 2회 실행에도 이중발송 없음.
 *
 * W5-ATTENDEE: 발송 큐 원장이 v2 정본으로 이관됐다(go DB 미참조). 여기서 쓰는 `pool` 은
 * cron 실행 원장(`ops_cron_runs`, W3-OPS 소유)용이며 초대권 원장과 무관하다.
 */
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { getPool } from "@/lib/db/pool";
import { drainInvitationDispatch, reconcileInvitationDelivery } from "@/lib/server/invitations";
import { finishCronRun, startCronRun } from "@/lib/ops/cron-run";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  const authHeader = request.headers.get("authorization") ?? "";
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return errorResponse("인증 정보가 올바르지 않습니다", 401);
  }

  const pool = getPool();
  const cronRun = await startCronRun(pool, "dispatch-invitations");
  try {
    const result = await drainInvitationDispatch();
    // 🔴 발송 직후엔 도달 여부를 알 수 없다(SENS 가 전달결과를 아직 모른다). 같은 tick 에서
    //    **이전 발송분**의 전달 상태를 대사한다 — 이 단계가 없으면 카카오가 거부한 건이
    //    영구히 '발송됨' 으로 남는다(실측 3027: 접수 A000 · 전달 실패 · 미도달).
    //    대사 실패가 드레인 결과를 망가뜨리면 안 되므로 격리한다.
    let delivery: Awaited<ReturnType<typeof reconcileInvitationDelivery>> | { error: string };
    try {
      delivery = await reconcileInvitationDelivery();
    } catch (err: unknown) {
      delivery = { error: err instanceof Error ? err.message : "unknown" };
    }
    const payload = { ...result, delivery };
    await finishCronRun(pool, cronRun, "succeeded", payload);
    return successResponse(payload);
  } catch (error) {
    await finishCronRun(pool, cronRun, "failed", undefined, error);
    throw error;
  }
}
