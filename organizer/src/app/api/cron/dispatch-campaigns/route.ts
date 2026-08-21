/**
 * 이메일 캠페인 드레인 cron — **v2 위임 스텁**(레벨2 컷오버 W5-MSG).
 *
 * 🔴 무조건 위임 — `email_campaigns` / `email_campaign_recipients` 원장이 v2 로 이관됐다
 *   (alembic w5msg_0727, go 마이그 250 DROP). go DB 에 드레인할 수신자 큐가 없다.
 *   flag(`ORGANIZER_MESSAGING_V2_ENABLED`) 조건부로 두면 flag OFF 에서 없는 테이블을 조회한다.
 *
 * 🔴 이중발송 0 — 실제 드레인은 v2 Celery beat `messaging-dispatch-campaigns`
 *   (app.tasks.messaging_dispatch.dispatch_campaigns, 광고성 EventMessage 서브셋)가 단독 소유.
 *   go 캠페인 발송(`campaigns/[id]/send`)은 v2 광고성 EventMessage 를 큐잉하는 것으로 끝난다.
 *
 * 크론 계약 유지를 위해 엔드포인트는 남기되 인증은 그대로 강제한다.
 */
import { errorResponse, successResponse } from "@/lib/apiResponse";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  if (!cronSecret || (request.headers.get("authorization") ?? "") !== `Bearer ${cronSecret}`) {
    return errorResponse("인증 정보가 올바르지 않습니다", 401);
  }

  return successResponse({
    delegatedToV2: true,
    owner: "v2:app.tasks.messaging_dispatch.dispatch_campaigns",
    claimed: 0,
    processed: 0,
    sent: 0,
    failed: 0,
    unknown: 0,
  });
}
