/**
 * 발송 큐 드레인 cron — **v2 위임 스텁**(레벨2 컷오버 W5-MSG).
 *
 * 🔴 왜 무조건 위임인가
 *   발송 원장(`event_messages` / `message_deliveries` / `message_delivery_attempts`)이 v2 로
 *   이관됐다(alembic w5msg_0727, go 마이그 250 이 원본 테이블 DROP). go DB 에는 드레인할
 *   큐 자체가 **존재하지 않는다**. 따라서 이 라우트는 `ORGANIZER_MESSAGING_V2_ENABLED` flag
 *   조건이 아니라 **무조건** no-op 이다 — 원장이 옮겨간 이상 flag 는 소유권 판단에 무의미하고,
 *   flag OFF 로 옛 경로가 되살아나면 없는 테이블을 조회해 크래시한다.
 *
 * 🔴 이중발송 0
 *   실제 드레인은 v2 Celery beat `messaging-dispatch-messages`
 *   (app.tasks.messaging_dispatch.dispatch_messages, 60s)가 단독 소유한다. go 가 여기서
 *   아무것도 하지 않으므로 두 소유자가 같은 수신자에게 보내는 경로가 성립하지 않는다.
 *   (과거 consent-reconfirm 이 실제로 그랬다 — 같은 실수를 구조적으로 봉인한다.)
 *
 * 이 엔드포인트는 **크론 계약 유지**를 위해 남긴다(OS crontab 이 계속 호출해도 200). 인증은
 * 그대로 강제한다 — 인증 없는 200 은 외부에 내부 상태를 알려주는 신호가 된다.
 */
import { errorResponse, successResponse } from "@/lib/apiResponse";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  const authHeader = request.headers.get("authorization") ?? "";
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return errorResponse("인증 정보가 올바르지 않습니다", 401);
  }

  return successResponse({
    delegatedToV2: true,
    owner: "v2:app.tasks.messaging_dispatch.dispatch_messages",
    claimed: 0,
    processed: 0,
    sent: 0,
    failed: 0,
    unknown: 0,
  });
}
