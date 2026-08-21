/**
 * 수신동의 2년 재확인 — **v2 위임 스텁**(§3-2 · 정보통신망법 시행령 제62조의3).
 *
 * 레벨2 컷오버(W3-OPS × W3-MSG 접합):
 *   W3-MSG 가 동의 원장(`message_consents` / `message_consent_events`)을 **v2 로 완전히 옮겼다**.
 *   `recordConsent`·`withdrawConsent` 는 이제 **flag 와 무관하게** v2 로만 쓴다.
 *   ⟹ go `message_consents` 는 **더 이상 write 를 받지 않는 스테일 사본**이다.
 *
 * 따라서 옛 스캔 로직(2년 경과 동의 식별 + reconfirm_requested_at 표시)은
 *   · flag 와 무관하게 항상 잘못된 원장을 본다(누락 또는 유령 표식),
 *   · 법무 확정 후 여기에 "재확인 안내 발송"이 붙는 순간 v2 celery beat
 *     `messaging-consent-reconfirm`(app.tasks.messaging_dispatch.consent_reconfirm)과
 *     **이중발송**이 된다.
 * 그래서 스캔을 제거하고 위임 스텁만 남긴다. 재확인의 정본은 v2 beat 다.
 *
 * ⚠️ 이 라우트를 다시 "동작"시키려면 v2 쪽 태스크를 고쳐야 한다 — 여기에 로직을 되살리지 말 것.
 * 인증: Authorization: Bearer ${CRON_SECRET}.
 */
import { errorResponse, successResponse } from "@/lib/apiResponse";

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  if (!cronSecret || (request.headers.get("authorization") ?? "") !== `Bearer ${cronSecret}`) {
    return errorResponse("인증 정보가 올바르지 않습니다", 401);
  }

  return successResponse({
    delegatedToV2: true,
    flagged: 0,
    note: "동의 원장 정본 = v2. 재확인은 celery beat messaging-consent-reconfirm 이 수행한다.",
  });
}
