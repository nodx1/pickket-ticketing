import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 🔴 API 라우트가 `datetime-local` 입력을 **서버 시간대로 해석하지 않게** 막는다.
 *
 * ## 무슨 일이 있었나 (2026-07-31, 두 번)
 * `<input type="datetime-local">` 은 시간대 없는 문자열을 준다(`"2026-08-20T07:00"`).
 * `new Date(raw).toISOString()` 은 **그 코드가 도는 곳**의 시간대로 해석하는데,
 * organizer 컨테이너는 `TZ` 미설정 = **UTC** 다. 그래서 한국시각 07:00 이 07:00Z 로 저장되고
 * 화면에서 KST 변환이 한 번 더 걸려 **9시간 밀린다.**
 *
 * **1차 수정에서 나는 읽기 경로(`parseV2Schedules`)만 고쳤다.** 진짜 저장 지점은
 * API 라우트의 `new Date(body.startsAt).toISOString()` 이었고 **18곳**이었다.
 * 대표가 일정을 다시 넣었는데도 여전히 밀려 있어서 알았다 — 코드를 읽고 고쳤다고
 * 믿었지만 **저장 경로를 안 봤다.**
 *
 * ## 왜 구조 가드인가
 * 단위 테스트는 `toIsoFromKstLocal` 만 본다. 그 함수가 아무리 옳아도 **라우트가 안 쓰면**
 * 저장은 틀린다. 여기서 막아야 하는 건 계산이 아니라 **호출 여부**다.
 */
const API_ROOT = path.join(process.cwd(), "src/app/api");

/** `new Date(body.…).toISOString()` — 서버 시간대로 해석하는 패턴. */
const SERVER_TZ_PARSE = /new Date\(\s*body\.[A-Za-z]+/;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (name.endsWith(".ts") && !name.includes(".test.")) out.push(full);
  }
  return out;
}

describe("API 라우트는 시간 입력을 KST 로 해석한다", () => {
  const files = walk(API_ROOT);

  it("스캔 대상이 실제로 있다 — 경로가 틀리면 이 가드는 조용히 통과한다", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("🔴 `new Date(body.…)` 로 시간 입력을 파싱하는 라우트가 없다", () => {
    const bad = files
      .filter((f) => SERVER_TZ_PARSE.test(readFileSync(f, "utf8")))
      .map((f) => path.relative(API_ROOT, f));

    expect(
      bad,
      `서버 시간대(UTC)로 해석돼 한국시각 입력이 9시간 밀린다. ` +
        `\`toIsoFromKstLocal(body.x)\` 를 쓸 것:\n  ${bad.join("\n  ")}`,
    ).toEqual([]);
  });

  it("시간을 저장하는 라우트는 kst-local 을 import 한다", () => {
    const writers = files.filter((f) => /toIsoFromKstLocal/.test(readFileSync(f, "utf8")));
    // 2026-07-31 기준 9개 라우트. 줄어들면 누가 되돌린 것이다.
    expect(writers.length).toBeGreaterThanOrEqual(9);
  });
});
