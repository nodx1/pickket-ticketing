/**
 * 조직자 메시징 v2 재배선 flag — 레벨2 3.4a.
 *
 * ⚠️ **W5-MSG(발송 원장 v2 이관) 이후 이 flag 의 의미는 크게 줄었다.**
 *
 *   발송 원장(`event_messages` / `message_deliveries` / `message_delivery_attempts` /
 *   `email_campaigns` / `email_campaign_recipients` / `inbound_emails` / `reminder_sends`)이
 *   전부 v2 로 이관됐고 go 원본은 마이그 250 에서 DROP 된다. 원장이 하나뿐이므로
 *   **소유권을 flag 로 나눌 대상이 더 이상 없다.** 다음은 전부 flag 를 보지 않는다:
 *     · 메시지/캠페인 생성·재발송·조회·발송상세  → 항상 v2
 *     · dispatch-messages / dispatch-campaigns / reminders / consent-reconfirm cron
 *       → **무조건** v2 위임 스텁(flag 조건부로 두면 flag OFF 에서 없는 테이블을 조회한다)
 *     · 억제/동의 원장(W3-MSG)                     → 항상 v2
 *
 *   남은 유일한 소비자는 `events/[id]/messages/test`(본인 테스트 발송)다. v2 내부 라우터
 *   `internal_messaging.test_send` 가 같은 flag(v2 settings)로 409 를 내므로, go 쪽에서
 *   미리 판정해 사용자에게 "미개시"를 알려주기 위해 대칭으로 남겨 둔다.
 *
 * 🔴 되살리지 말 것: 이 flag 로 "go 발송경로"를 다시 켜는 분기를 추가하면, 원장이 없는
 *   go DB 를 조회해 크래시하거나(테이블 DROP 후) v2 Celery 와 같은 수신자에게 2회 발송한다.
 *
 * ORGANIZER_MESSAGING_V2_ENABLED (env, 기본 OFF):
 *   OFF = v2 단발 테스트 발송 미개시. ON = 개시.
 *
 * env 는 호출 시점 lazy read(모듈 로드 시점 캡처 금지 — cron/tsx 로더 순서 안전).
 */
export function isOrganizerMessagingV2Enabled(): boolean {
  const raw = (process.env.ORGANIZER_MESSAGING_V2_ENABLED ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}
