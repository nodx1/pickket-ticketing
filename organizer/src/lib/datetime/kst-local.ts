/**
 * `<input type="datetime-local">` 값 ↔ ISO(UTC) 변환 — **KST 고정**.
 *
 * ## 🔴 왜 필요한가 (2026-07-31 실사고)
 * 주최자가 일정에 `07:00 ~ 18:00` 을 넣었는데 화면에 **오후 4시 ~ 다음날 새벽 3시**로 나왔다.
 * 정확히 9시간이 밀렸다.
 *
 * `datetime-local` 은 **시간대가 없는** 문자열을 준다(`"2026-08-20T07:00"`).
 * 그걸 `new Date(raw)` 로 파싱하면 **그 코드가 도는 곳의 로컬 시간대**로 해석된다.
 * organizer 컨테이너는 `TZ` 미설정이라 **UTC** 다(실측). 그래서
 *
 *     입력 07:00(KST 의도) → 07:00Z 로 저장 → 화면에서 KST 변환 → 16:00
 *
 * 이 된다. 저장값 자체가 9시간 틀렸으므로 화면만 고쳐선 안 된다.
 *
 * ## 왜 브라우저 시간대에 맡기지 않는가
 * 클라이언트에서 변환하면 **보는 사람의 PC 시간대**에 따라 달라진다. 같은 일정이
 * 해외 스태프에게 다른 시각으로 보인다. 한국에서 열리는 행사이고 v2 의 입장일 판정도
 * KST 고정(`admission-days.ts`)이므로 **여기도 KST 로 못박는다.**
 *
 * ## 왜 고정 오프셋(+9)인가
 * 한국은 1988년 이후 서머타임이 없다. `Intl` 로 매번 계산할 수도 있지만, 고정 오프셋이
 * **역변환이 정확**하고(왕복이 손실 없음) 테스트가 결정적이다.
 */

/** KST = UTC+9. 서머타임 없음. */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** `datetime-local` 형식인가 — 시간대 표기가 **없어야** 한다. */
const NAIVE_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * `"2026-08-20T07:00"`(KST 의도) → `"2026-08-19T22:00:00.000Z"`.
 *
 * 시간대가 붙은 값(`Z`·`+09:00`)은 **이미 확정된 시각**이므로 그대로 표준화만 한다.
 * 그래야 기존 저장분과 v2 응답을 다시 넣어도 두 번 밀리지 않는다.
 */
export function toIsoFromKstLocal(value: string | null | undefined): string | null {
  const raw = (value ?? "").trim();
  if (!raw) return null;

  const m = NAIVE_LOCAL.exec(raw);
  if (m) {
    const [, y, mo, d, h, mi, s] = m;
    const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? 0));
    const dt = new Date(asUtc - KST_OFFSET_MS);
    return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
  }

  const dt = new Date(raw);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
}

/**
 * `"2026-08-19T22:00:00.000Z"` → `"2026-08-20T07:00"` (datetime-local 에 그대로 넣는 값).
 *
 * 🔴 수정 폼에 이걸 안 쓰면, 저장된 UTC 가 그대로 입력칸에 들어가 **수정할 때마다 또 밀린다.**
 */
export function toKstLocalInput(iso: string | null | undefined): string {
  const raw = (iso ?? "").trim();
  if (!raw) return "";
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return "";
  return new Date(dt.getTime() + KST_OFFSET_MS).toISOString().slice(0, 16);
}

/** KST 기준 날짜 구성요소. 화면마다 표기 형식이 달라도 **변환은 여기 한 번**만 한다. */
export interface KstParts {
  year: number;
  /** 1~12 */
  month: number;
  day: number;
  /** 0=일 … 6=토 */
  weekday: number;
  hour: number;
  minute: number;
}

/**
 * ISO → KST 구성요소. 형식 문자열을 만드는 쪽이 조립한다.
 *
 * 🔴 `date.getFullYear()` 류를 화면에서 직접 쓰면 **서버 시간대(UTC)** 가 나온다.
 *    `+9` 를 더한 뒤 `getUTC*` 로 읽어야 보는 곳과 무관하게 한국시각이 된다.
 */
export function toKstParts(iso: string | null | undefined): KstParts | null {
  const raw = (iso ?? "").trim();
  if (!raw) return null;
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return null;
  const k = new Date(dt.getTime() + KST_OFFSET_MS);
  return {
    year: k.getUTCFullYear(),
    month: k.getUTCMonth() + 1,
    day: k.getUTCDate(),
    weekday: k.getUTCDay(),
    hour: k.getUTCHours(),
    minute: k.getUTCMinutes(),
  };
}

const kstDateTimeFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

/**
 * 화면 표시 — **보는 사람의 시간대와 무관하게** 한국시각으로 고정한다.
 * `toLocaleString` 을 `timeZone` 없이 쓰면 해외 스태프에게 다른 시각이 보인다.
 */
export function formatKstDateTime(iso: string | null | undefined): string {
  const raw = (iso ?? "").trim();
  if (!raw) return "-";
  const dt = new Date(raw);
  if (Number.isNaN(dt.getTime())) return "-";
  return kstDateTimeFormatter.format(dt);
}
