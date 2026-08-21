/**
 * `NODE_ENV === "production" && PLAYWRIGHT_TEST !== "1"` 인라인 복제 금지 가드.
 *
 * 이 식은 네 곳에 각자 적혀 있었고(쿠키 2 + 결제 self-complete 1 + env 하드체크 1), 그중
 * 하나(`checkout/complete`)는 **감사 P0-5 를 닫는 방어**였는데 아무도 그게 같은 식인 줄 몰랐다.
 * 통로를 `isProdRuntime()` 하나로 모았으니, 다시 흩어지지 못하게 기계가 잡는다.
 *
 * ⚠️ 톱니가 아니라 **0 이 기준선**이다 — 이번에 전부 정리했으므로 예외를 둘 이유가 없다.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const SRC = path.join(__dirname, "..", "..");
/** 정의부와, 판정식을 합성입력으로 검증하는 이 파일만 예외. */
const ALLOWLIST = new Set([
  path.join(SRC, "lib", "env", "runtime.ts"),
  path.join(SRC, "lib", "env", "runtime.guard.test.ts"),
]);

/** `NODE_ENV`·`PLAYWRIGHT_TEST` 를 한 식에서 함께 보는 형태를 찾는다(공백/줄바꿈 허용). */
const INLINE =
  /process\.env\.NODE_ENV\s*===\s*["']production["']\s*&&\s*process\.env\.PLAYWRIGHT_TEST\s*!==\s*["']1["']/g;

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(full));
    else if (/\.tsx?$/.test(e.name)) out.push(full);
  }
  return out;
}

function stripComments(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("프로덕션 런타임 판정 인라인 복제 금지", () => {
  const files = tsFiles(SRC);

  it("§0 검사 대상을 실제로 수집했다", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("§0-A 판정 정규식이 동작한다 (합성 입력)", () => {
    const yes = `const x = process.env.NODE_ENV === "production" && process.env.PLAYWRIGHT_TEST !== "1";`;
    expect(yes.match(INLINE)).toHaveLength(1);
    // 줄바꿈이 낀 형태도 잡는다 — 실제로 그렇게 적힌 곳이 있었다
    const wrapped = `const x =\n  process.env.NODE_ENV === "production" &&\n  process.env.PLAYWRIGHT_TEST !== "1";`;
    expect(wrapped.match(INLINE)).toHaveLength(1);
    // NODE_ENV 만 보는 건 대상이 아니다(별개 판정)
    expect(`process.env.NODE_ENV === "production"`.match(INLINE)).toBeNull();
  });

  it("정의부(env/runtime.ts) 외에는 인라인 복제가 없다", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (ALLOWLIST.has(f)) continue;
      const hits = stripComments(fs.readFileSync(f, "utf8")).match(INLINE);
      if (hits) offenders.push(`${path.relative(SRC, f)} (${hits.length}건)`);
    }
    expect(
      offenders,
      `\`isProdRuntime()\` 을 쓸 것 — 이 식이 흩어지면 무엇이 걸려 있는지 아무도 모른다\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});
