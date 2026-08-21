// timeZone 고정(Asia/Seoul) — 미지정 시 서버 런타임(UTC)의 달력일로 렌더돼
// KST 대비 하루 밀림(예: 2026-08-19T23:00Z → UTC "8월 19일" vs KST "8월 20일").
// 소비자 앱은 Asia/Seoul 고정이므로 go 도 맞춰 정합성 확보.
const dateFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "long",
  day: "numeric",
});

/**
 * 🔴 KST 표시 포맷은 **여기 하나만** 쓴다 (2026-08-01 전수 정리).
 *
 * ## 왜 모으나
 * 같은 규칙이 다섯 곳에 흩어져 있었고, 화면 20곳은 아예 `timeZone` 을 안 줬다.
 * `timeZone` 이 없으면 **그 코드가 도는 곳의 시간대**로 렌더된다 —
 * 개발기·현재 서버가 KST 라 **지금은 차이가 0 이고 눈으로 안 보인다.**
 * 컨테이너가 재배치돼 서버가 UTC 가 되는 순간 한꺼번에 하루씩 밀린다:
 *
 *     행사 실제      2026-08-20 07:00 KST
 *     UTC 로 읽으면   2026년 8월 19일 오후 10:00     ← 하루 밀림
 *
 * 주중권(목~금)/주말권(토~일)처럼 **날짜로 갈리는 상품**에서는 그대로 오구매다.
 *
 * ⚠️ 각 화면에 `timeZone: "Asia/Seoul"` 을 20번 적는 방식으로 풀지 않았다 —
 *    21번째에서 또 빠진다. `datetime.guard.test.ts` 가 새로 빠지는 자리를 막는다.
 * ⚠️ 서버 `TZ` 환경변수로 푸는 것도 아니다. 환경 의존이 남아 같은 사고가 재발한다.
 */
const KST = "Asia/Seoul" as const;

/** `2026년 8월 20일 오후 3:04` — 목록·이력에서 가장 흔한 모양. */
const dateTimeFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: KST,
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

/** `오후 3:04` — 같은 날 안에서만 쓰는 자리(체크인 기록 등). */
const timeFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: KST,
  hour: "numeric",
  minute: "2-digit",
});

/**
 * `2026. 8. 20. 오전 7:04:33` — **ko-KR 기본 표기 + 초**.
 *
 * 🔴 `toLocaleString("ko-KR")` 을 옵션 없이 쓰던 자리를 **그대로 옮기기 위한** 것이다.
 *    기본값에는 **초가 있다.** 감사 로그·체크인 기록에서 초는 의미가 있고(같은 분에 여러 건),
 *    이번 작업은 **시간대를 붙이는 것**이지 표기를 바꾸는 게 아니다.
 *    표기를 바꾸려면 별건으로 판단받아야 한다.
 */
const dateTimeSecFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: KST,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

/** `오전 7:04:33` — `toLocaleTimeString("ko-KR")` 기본값과 같은 모양(초 포함). */
const timeSecFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: KST,
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
});

/** `2026. 08. 20. 오전 07:04` — 2자리 고정. 명시적으로 그 모양을 쓰던 자리용. */
const dateTime2DigitFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: KST,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/** `2026. 8. 20.` — 표 칸처럼 좁은 자리. */
const dateShortFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: KST,
  year: "numeric",
  month: "numeric",
  day: "numeric",
});

/** `목` — 요일만. 주중권/주말권 구분에 필요하다. */
const weekdayFormatter = new Intl.DateTimeFormat("ko-KR", { timeZone: KST, weekday: "short" });

const currencyFormatter = new Intl.NumberFormat("ko-KR", {
  style: "currency",
  currency: "KRW",
  maximumFractionDigits: 0,
});

export function formatKRW(amount: number): string {
  return currencyFormatter.format(amount);
}

/**
 * 값 → `Date`. 못 읽으면 `null`.
 *
 * ⚠️ 여기서 던지지 않는다 — 날짜 하나가 깨졌다고 화면 전체를 떨어뜨리지 않는다.
 *    호출부는 `null` 을 받아 대체 문구(`"-"`)를 쓴다.
 */
function parseDate(value: string | number | Date | null | undefined): Date | null {
  if (value == null || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(date: string | Date | null | undefined): string {
  const parsed = parseDate(date);
  return parsed ? dateFormatter.format(parsed) : "";
}

/** `2026년 8월 20일 오후 3:04` (KST). 못 읽으면 `fallback`. */
export function formatDateTimeKst(
  value: string | number | Date | null | undefined,
  fallback = "-",
): string {
  const d = parseDate(value);
  return d ? dateTimeFormatter.format(d) : fallback;
}

/** `2026. 8. 20. 오전 7:04:33` (KST) — 기본 표기 + 초. 못 읽으면 `fallback`. */
export function formatDateTimeSecKst(
  value: string | number | Date | null | undefined,
  fallback = "-",
): string {
  const d = parseDate(value);
  return d ? dateTimeSecFormatter.format(d) : fallback;
}

/** `오전 7:04:33` (KST) — 초 포함. 못 읽으면 `fallback`. */
export function formatTimeSecKst(
  value: string | number | Date | null | undefined,
  fallback = "-",
): string {
  const d = parseDate(value);
  return d ? timeSecFormatter.format(d) : fallback;
}

/** `2026. 08. 20. 오전 07:04` (KST) — 2자리 고정. 못 읽으면 `fallback`. */
export function formatDateTime2DigitKst(
  value: string | number | Date | null | undefined,
  fallback = "-",
): string {
  const d = parseDate(value);
  return d ? dateTime2DigitFormatter.format(d) : fallback;
}

/** `오후 3:04` (KST). 못 읽으면 `fallback`. */
export function formatTimeKst(
  value: string | number | Date | null | undefined,
  fallback = "-",
): string {
  const d = parseDate(value);
  return d ? timeFormatter.format(d) : fallback;
}

/** `2026. 8. 20.` (KST). 못 읽으면 `fallback`. */
export function formatDateShortKst(
  value: string | number | Date | null | undefined,
  fallback = "-",
): string {
  const d = parseDate(value);
  return d ? dateShortFormatter.format(d) : fallback;
}

/** `2026년 8월 20일` (KST). 못 읽으면 `fallback`. */
export function formatDateKst(
  value: string | number | Date | null | undefined,
  fallback = "-",
): string {
  const d = parseDate(value);
  return d ? dateFormatter.format(d) : fallback;
}

/** `목` — 요일만 (KST). 못 읽으면 빈 문자열. */
export function formatWeekdayKst(value: string | number | Date | null | undefined): string {
  const d = parseDate(value);
  return d ? weekdayFormatter.format(d) : "";
}
