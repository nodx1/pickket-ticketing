/**
 * 🔴 날짜를 **시간대 없이** 포맷하는 자리를 막는다 (2026-08-01 전수 정리).
 *
 * ## 왜 이 가드가 본체인가
 * 20곳을 고치는 것보다 **21번째를 막는 것**이 중요하다. 각 화면에
 * `timeZone: "Asia/Seoul"` 을 스무 번 적는 방식이었으면 다음 화면에서 또 빠진다.
 *
 * ## 왜 눈으로는 안 보이나
 *
 *     서버 TZ = KST · 브라우저 TZ = KST  →  차이가 0
 *
 * 개발기에서도 현재 서버에서도 **결과가 같다.** 컨테이너가 재배치되거나 리전이 바뀌어
 * 서버가 UTC 가 되는 순간 한꺼번에 밀린다:
 *
 *     행사 실제      2026-08-20 07:00 KST
 *     UTC 로 읽으면   2026년 8월 19일 오후 10:00      ← 하루 밀림
 *
 * 주중권(목~금)/주말권(토~일)처럼 **날짜로 갈리는 상품**에서는 그대로 오구매다.
 *
 * ## 판정 규칙 — 좁게 쓴다
 * 숫자 포맷(`amount.toLocaleString()`)은 **정상**이고 45곳이 있다. 그걸 잘못 잡으면
 * 이 가드는 쓸모없어진다(사람이 무시하기 시작한다). 그래서:
 *
 *   ① `toLocaleDateString` · `toLocaleTimeString` → **Date 에만 있는 메서드**다.
 *      숫자에는 존재하지 않으므로 **무조건** `timeZone` 을 요구한다. 거짓 양성 0.
 *   ② `toLocaleString` → Date 와 Number 둘 다 갖는다. **날짜라는 증거**가 있을 때만
 *      요구한다: 수신자가 `new Date(...)` 이거나, 옵션에 날짜 조각
 *      (`year`·`month`·`day`·`hour`…)이 있을 때.
 *
 * ## 🔴 `Intl.DateTimeFormat` 도 본다 (뮤테이션이 생존해서 추가)
 * 20곳을 `lib/format.ts` 하나로 모았으므로 **거기서 `timeZone` 이 빠지면 20곳이 한꺼번에
 * 무너진다.** 처음엔 `.toLocale*` 만 스캔해서 그 변경이 **조용히 통과**했다.
 * `Intl.DateTimeFormat` 은 날짜 전용이라(숫자는 `Intl.NumberFormat`) 무조건 요구해도
 * 거짓 양성이 없다.
 *
 * ⚠️ 옵션을 **스프레드(`{...opts}`)로 넘기면 여기서 못 읽는다.** 그래서 코드 쪽에서
 *    스프레드를 쓰지 않기로 했다(`event-when-where.ts` 를 그렇게 고쳤다). 스프레드가
 *    다시 등장하면 이 가드는 그 자리를 **놓친다** — 알고 있는 한계다.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.join(__dirname, "..", "..");

/** 옵션 객체에 날짜/시각 조각이 들어 있나 — `toLocaleString` 이 날짜라는 증거. */
const DATE_PART_KEYS = /\b(year|month|day|weekday|hour|minute|second|dateStyle|timeStyle|era|timeZoneName|hour12)\s*:/;

interface Hit {
  file: string;
  line: number;
  kind: "String" | "DateString" | "TimeString" | "Intl";
  hasTimeZone: boolean;
  isDate: boolean;
  snippet: string;
}

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(full));
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

/** 호출 인자 문자열을 괄호 균형으로 잘라낸다(정규식만으로는 중첩 객체에서 끊긴다). */
function argsOf(src: string, from: number): string {
  let i = from;
  let depth = 1;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "(") depth += 1;
    else if (c === ")") depth -= 1;
    i += 1;
  }
  return src.slice(from, i - 1);
}

/**
 * 제외 목록 — **사유 없이 늘리지 말 것.**
 *
 * 두 파일 다 "시간대 없는 호출" 을 **일부러** 적는다:
 *   · 이 가드 파일 자체 — 판정 규칙 예시 문자열
 *   · parity 테스트   — 종전 표기와 같은지 비교하려면 옛 호출을 그대로 불러야 한다
 *
 * ⚠️ 화면 코드는 절대 여기 넣지 말 것. 넣는 순간 그 자리는 영원히 안 보인다.
 */
const EXCLUDED = ["timezone.guard.test.ts", "format.timezone-parity.test.ts"] as const;

function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const file of tsFiles(SRC)) {
    if (EXCLUDED.some((e) => file.endsWith(e))) continue;
    const src = fs.readFileSync(file, "utf8");
    const lines = src.split("\n");
    const re = /\.toLocale(String|DateString|TimeString)\s*\(/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const args = argsOf(src, re.lastIndex);
      const before = src.slice(Math.max(0, m.index - 160), m.index);
      const kind = m[1] as Hit["kind"];
      const receiverIsNewDate = /new\s+Date\s*\([^;]*\)\s*$/.test(before);
      const isDate = kind !== "String" || DATE_PART_KEYS.test(args) || receiverIsNewDate;
      const line = src.slice(0, m.index).split("\n").length;
      hits.push({
        file: path.relative(SRC, file).split(path.sep).join("/"),
        line,
        kind,
        hasTimeZone: /\btimeZone\s*:/.test(args),
        isDate,
        snippet: (lines[line - 1] ?? "").trim().slice(0, 90),
      });
    }

    // 🔴 `new Intl.DateTimeFormat(...)` — 날짜 전용 생성자다(숫자는 `Intl.NumberFormat`).
    //    공용 포맷터가 여기 있으므로 이걸 안 보면 **근원에서 빠지는 것을 못 잡는다.**
    const intlRe = /new\s+Intl\.DateTimeFormat\s*\(/g;
    let n: RegExpExecArray | null;
    while ((n = intlRe.exec(src))) {
      const args = argsOf(src, intlRe.lastIndex);
      const line = src.slice(0, n.index).split("\n").length;
      hits.push({
        file: path.relative(SRC, file).split(path.sep).join("/"),
        line,
        kind: "Intl",
        hasTimeZone: /\btimeZone\s*:/.test(args),
        isDate: true,
        snippet: (lines[line - 1] ?? "").trim().slice(0, 90),
      });
    }
  }
  return hits;
}

describe("날짜 포맷은 시간대를 명시한다", () => {
  const hits = scan();

  it("§0 스캐너가 실제로 코드를 읽었다 (경로 오타로 조용히 통과 방지)", () => {
    expect(hits.length, "toLocale* 호출을 하나도 못 찾았다 — 스캔이 안 돈 것").toBeGreaterThan(20);
    expect(
      hits.some((h) => h.kind === "Intl"),
      "Intl.DateTimeFormat 을 하나도 못 찾았다 — 공용 포맷터를 안 보고 있다",
    ).toBe(true);
    expect(hits.some((h) => h.isDate), "날짜 포맷을 하나도 못 알아봤다").toBe(true);
    expect(hits.some((h) => !h.isDate), "숫자 포맷을 하나도 못 알아봤다 — 판정이 너무 넓다").toBe(true);
  });

  it("🔴 timeZone 없이 날짜를 포맷하는 자리가 없다", () => {
    const bad = hits.filter((h) => h.isDate && !h.hasTimeZone);
    expect(
      bad.map((b) => `${b.file}:${b.line}  ${b.snippet}`),
      "시간대를 안 주면 **그 코드가 도는 곳**의 시간대로 렌더된다.\n" +
        "  지금은 서버·개발기가 모두 KST 라 차이가 0 이라 눈에 안 보이지만,\n" +
        "  컨테이너 재배치로 서버가 UTC 가 되면 하루씩 밀린다.\n" +
        "  `@/lib/format` 의 formatDateKst · formatDateTimeKst · formatTimeKst · formatDateShortKst 를 쓸 것:\n  ",
    ).toEqual([]);
  });

  /**
   * 🔴 거짓 양성 방지 — 숫자 포맷 45곳을 잘못 잡으면 이 가드는 무시당한다.
   */
  it("🔴 숫자 포맷(`금액.toLocaleString()`)을 날짜로 오인하지 않는다", () => {
    const numeric = hits.filter((h) => !h.isDate);
    expect(numeric.length, "숫자 포맷을 전부 날짜로 오인하고 있다").toBeGreaterThan(30);
    // 숫자 포맷에는 timeZone 이 없는 게 정상이다 — 그런데도 통과해야 한다.
    expect(numeric.some((h) => !h.hasTimeZone), "숫자 포맷 표본이 없다").toBe(true);
  });

  it("🔴 제외 목록이 늘지 않았다 — 화면 코드가 들어오면 영원히 안 보인다", () => {
    expect(EXCLUDED.length, "제외를 늘렸다면 사유를 주석에 남기고 이 수를 고칠 것").toBe(2);
    for (const e of EXCLUDED) {
      expect(e.endsWith(".test.ts"), `${e} 는 테스트 파일이 아니다 — 화면 코드를 제외했다`).toBe(true);
    }
  });

  it("판정 규칙이 의도대로 동작한다 (합성 입력)", () => {
    // 이 테스트는 scan() 의 분류 규칙을 직접 확인한다 — 규칙을 넓히면 여기서 걸린다.
    const isDateLike = (kind: string, args: string, before: string) =>
      kind !== "String" || DATE_PART_KEYS.test(args) || /new\s+Date\s*\([^;]*\)\s*$/.test(before);

    expect(isDateLike("DateString", '"ko-KR"', "x"), "Date 전용 메서드는 무조건 날짜").toBe(true);
    expect(isDateLike("TimeString", '"ko-KR"', "x")).toBe(true);
    expect(isDateLike("String", '"ko-KR"', "amount"), "숫자 포맷은 날짜가 아니다").toBe(false);
    expect(isDateLike("String", '"ko-KR"', "new Date(iso)"), "new Date 수신자는 날짜").toBe(true);
    expect(isDateLike("String", '"ko-KR", { year: "numeric" }', "d"), "날짜 옵션이 있으면 날짜").toBe(true);
    expect(
      isDateLike("String", '"ko-KR", { minimumFractionDigits: 2 }', "price"),
      "숫자 옵션을 날짜로 오인하면 안 된다",
    ).toBe(false);
  });
});
