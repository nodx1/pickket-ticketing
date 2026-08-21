/**
 * 초대권 입장일 정책 — **초대권에는 입장일을 지정하지 않는다.**
 *
 * ## 요건 (2026-07-30 대표 확정)
 * > 하루에 한 장만 사용 가능하지만 **날짜를 지정해서 보내면 안 됨**
 *
 * 받은 사람이 대회 기간 중 **원하는 하루**에 오면 되고, 우리가 미리 날짜를 못 박지 않는다.
 * 선물로 넘겨도 받은 사람이 자기 일정에 맞춰 쓸 수 있어야 한다.
 *
 * ## 종전 동작 (결함)
 * 행사가 `admission_mode = "daypass"` 면 대량초대 화면이
 * `"지정일권 행사입니다. 수신자마다 … 입장일이 필요합니다"` 로 **사람마다 날짜를 요구**하고
 * 그 값을 `event_invitations.admission_day` 에 박아 넣었다.
 * prod 초대권 3건이 전부 `admission_day = 2026-08-20` 으로 고정돼 있었다(실측).
 *
 * ## 왜 null 이 안전한가 — 입장 로직이 이미 준비돼 있다
 * `platform/backend/app/services/admission_service.py`:
 *   · `admission_mode == "daypass" && ticket.admission_day is None` → **첫 입장 스캔 때 그 날로 고정**
 *   · 이후 다른 날 스캔은 `admission_day` 불일치로 **거부**
 * ⟹ "하루 한 장만 사용 가능" 이 그대로 성립한다. 날짜만 미리 정하지 않는 것이다.
 *
 * 초대권 등급(`초대권`, 0원)은 `tier_metadata.admission_days` 가 **비어 있어**
 * 등급 제한도 걸리지 않는다 ⟹ 대회 기간 중 아무 날 하루(실측 확인).
 *
 * ## 알림톡 문구
 * `admission_day` 가 없으면 발송 본문의 대회일자가 **행사 전체 기간**으로 나간다
 * (`invitations.ts` — `formatEventDateKo(ev.startsAt, ev.endsAt)`).
 * prod 는 `event_date 2026-08-20 ~ event_date_end 2026-08-23` 이 v2 에서 내려오므로
 * "8월 20일 ~ 8월 23일" 로 표시된다.
 *
 * ⚠️ 과거 `admission_day = null` 이 발송 드레인을 크래시시킨 적이 있다
 *    (`toYmd` 가 Date 객체에서 `.slice` 를 호출 → tick 전체 중단 → 미발송).
 *    **그 결함은 수정돼 있다**(`toYmd` 가 Date·문자열 양쪽 처리). 이 정책을 켤 때
 *    다시 확인한 사실이다 — null 경로가 죽으면 초대권이 **한 장도 안 나간다.**
 */

/**
 * 대량초대 입력에서 입장일을 요구하는가 — **항상 false**.
 *
 * 🔴 상수로 둔 이유: 종전엔 `requireAdmissionDay: isDaypass` 였다. 행사 설정이
 *    정책을 바꿔버리는 구조라, daypass 행사를 만들면 다시 날짜를 요구하게 된다.
 *    초대권 정책은 **행사 설정과 무관**하다.
 */
export const INVITATION_REQUIRES_ADMISSION_DAY = false as const;

/** 주최자에게 보여줄 안내 — 날짜를 못 정하는 게 실수가 아니라 정책임을 알린다. */
export const INVITATION_ADMISSION_NOTICE =
  "초대권은 입장일을 지정하지 않습니다. 받으신 분이 대회 기간 중 원하는 하루에 입장하며, 첫 입장한 날로 자동 확정됩니다(하루 1회).";

/**
 * 초대권 수신자에서 입장일을 제거한다 — **서버측 최종 관문**.
 *
 * 🔴 화면에서 입력을 없애는 것만으로는 부족하다. 낡은 클라이언트·직접 API 호출이
 *    `admissionDay` 를 보내면 그대로 박힌다. 서버가 마지막에 떨어낸다.
 *
 * @returns 입장일이 제거된 사본과, 제거된 건수(로그·집계용)
 */
export function stripAdmissionDay<T extends { admissionDay?: string | null }>(
  recipients: readonly T[],
): { recipients: Array<Omit<T, "admissionDay"> & { admissionDay: null }>; stripped: number } {
  let stripped = 0;
  const out = recipients.map((r) => {
    if (r.admissionDay != null) stripped += 1;
    return { ...r, admissionDay: null as null };
  });
  return { recipients: out, stripped };
}
