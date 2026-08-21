/**
 * F1 daypass 지정일 입력 지원 — 대회 기간(starts_at~ends_at) 내 KST 날짜 목록 산출.
 *
 * 주최자가 daypass(지정일권) 발권 시 참석자별 입장 지정일을 이 목록에서 고른다.
 * 서버·클라이언트 공용(순수 함수). 타임존은 KST(Asia/Seoul) 고정 — v2 admission_day 판정과 일치.
 */

const KST_DATE = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** ISO/Date → KST 'YYYY-MM-DD'. 유효하지 않으면 null. */
export function toKstDay(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return KST_DATE.format(d); // en-CA → YYYY-MM-DD
}

export interface AdmissionDayOption {
  /** YYYY-MM-DD (KST) — v2 admission_day 로 전송할 값 */
  value: string;
  /** 화면 표기: "10월 3일 (금)" */
  label: string;
}

const DOW = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * 기간 내 하루 단위 옵션 목록. 시작~종료(포함) KST 날짜를 열거.
 * 최대 60일로 제한(비정상 입력 방어). 단일일(같은 날)이면 1개 반환.
 */
export function listAdmissionDays(
  startsAt: string | Date | null | undefined,
  endsAt: string | Date | null | undefined,
): AdmissionDayOption[] {
  const startDay = toKstDay(startsAt);
  const endDay = toKstDay(endsAt) ?? startDay;
  if (!startDay || !endDay) return [];

  const options: AdmissionDayOption[] = [];
  // KST 정오 기준으로 하루씩 증가(자정 경계·DST 없는 KST 안전).
  const cursor = new Date(`${startDay}T12:00:00+09:00`);
  const last = new Date(`${endDay}T12:00:00+09:00`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(last.getTime())) return [];

  let guard = 0;
  while (cursor.getTime() <= last.getTime() && guard < 60) {
    const day = toKstDay(cursor);
    if (day) {
      const [yyyy, mm, dd] = day.split("-");
      // 요일은 KST 날짜에서 UTC 기준으로 계산(러너 타임존 무관 — getDay() 오차 방지).
      const dowIdx = new Date(Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd))).getUTCDay();
      const dow = DOW[dowIdx] ?? "";
      options.push({ value: day, label: `${Number(mm)}월 ${Number(dd)}일 (${dow})` });
    }
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }
  return options;
}
