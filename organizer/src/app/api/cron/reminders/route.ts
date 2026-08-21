/**
 * 공연 리마인더 cron(D-7/D-1/당일) — **v2 위임 스텁**(레벨2 컷오버 W5-MSG).
 *
 * 🔴 무조건 위임 — 리마인더 멱등 원장 `reminder_sends` 가 v2 로 이관됐다(orgmsg_0724 모델,
 *   go 마이그 250 이 원본 DROP). 발송 대상 해석(참석자·주문 상태)도 v2 가 SoT 다
 *   (app/services/messaging/reminders.py). go 에는 claim 할 원장도, 조회할 참석자 정본도 없다.
 *
 * 🔴 이중발송 0 — v2 Celery beat `messaging-reminders`
 *   (app.tasks.messaging_dispatch.reminders, 15:00 UTC = 00:00 KST)가 단독 소유한다.
 *   과거 go 원장과 v2 원장이 **서로 다른 DB** 라 상대의 발송을 못 봐서, 두 경로가 동시에
 *   켜지면 멱등 원장이 있어도 수신자에게 2회 나갔다. 원장을 단일화해 그 창을 닫는다.
 *   flag 조건부가 아니라 무조건 위임인 이유가 이것이다 — flag 값과 무관하게 go 는 보내지 않는다.
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
    owner: "v2:app.tasks.messaging_dispatch.reminders",
    sent: 0,
    skipped: 0,
    failedAll: 0,
  });
}
