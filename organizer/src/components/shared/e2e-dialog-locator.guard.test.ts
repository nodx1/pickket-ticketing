/**
 * 이름 없는 `getByRole("dialog")` 금지 가드.
 *
 * ── 왜 테스트로 막나 ──
 * 이 함정은 이미 두 번 나왔다. 한 번은 실패로(작성창을 물어 전건 실패), 한 번은 자체검수로
 * (같은 파일 다른 테스트에 방어 이식 누락). **이식을 기억해야 하는 구조**가 원인이므로,
 * 잊을 수 없게 기계가 잡는다. 통로는 `helpers/dialog.ts` 하나다.
 *
 * ⚠️ vitest 가 도는 검사다 — Playwright 를 실행하지 않고 **소스만** 읽는다.
 *    경로가 틀리면 파일을 못 읽고 조용히 통과하므로 §0 에서 수집 결과가 비어있지 않음을 단언한다.
 *
 * 🔴 왜 `specs/` 가 아니라 `src/` 에 있나 — 두 러너 모두에 걸린다.
 *    · vitest: `include: ["src/**\/*.test.ts"]` + `exclude: ["specs/**"]` → specs 아래 두면 **안 돈다**
 *    · Playwright: `testDir: "./specs/e2e"` + 기본 testMatch 가 `*.test.ts` → specs 아래 두면
 *      Playwright 가 실행하려 들어 깨진다
 *    그래서 검사 대상(`specs/e2e`)과 검사 위치(`src/`)가 다르다.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const E2E_ROOT = path.join(__dirname, "..", "..", "..", "specs", "e2e");
/** 통로 자체(이름을 필수로 받는 헬퍼)는 예외다. */
const ALLOWLIST = new Set([path.join(E2E_ROOT, "helpers", "dialog.ts")]);

function specFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...specFiles(full));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

function stripComments(raw: string): string {
  return raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * `getByRole("dialog")` 중 **name 옵션이 없는** 호출을 찾는다.
 *
 * 두 번째 인자가 있는지만 본다 — `{ name: ... }` 형태를 정확히 파싱하려 들면 `{ name, exact }`
 * 같은 변형에서 오탐이 난다. 옵션 객체 자체가 없으면 이름이 없는 게 확실하다.
 */
const RAW_DIALOG = /getByRole\(\s*["'`]dialog["'`]\s*\)/g;

describe("이름 없는 getByRole(\"dialog\") 금지", () => {
  const files = specFiles(E2E_ROOT);

  it("§0 검사 대상 파일을 실제로 수집했다", () => {
    expect(files.length, "e2e 소스를 하나도 못 읽었다 — 경로 확인").toBeGreaterThan(10);
  });

  it("§0-A 판정 정규식이 실제로 동작한다 (합성 입력)", () => {
    expect(`page.getByRole("dialog")`.match(RAW_DIALOG)).toHaveLength(1);
    expect(`page.getByRole('dialog')`.match(RAW_DIALOG)).toHaveLength(1);
    // 이름이 붙은 형태는 잡지 않는다
    expect(`page.getByRole("dialog", { name: "x" })`.match(RAW_DIALOG)).toBeNull();
    expect(`page.getByRole("dialog", { name: /x/ })`.match(RAW_DIALOG)).toBeNull();
    // 다른 role 은 무관
    expect(`page.getByRole("button")`.match(RAW_DIALOG)).toBeNull();
  });

  /**
   * ── 기존 위반 기준선 (2026-07-30) ──
   *
   * 도입 시점에 이미 27건이 있었다. 이걸 한 번에 고치려면 다이얼로그 27개의 제목을 **추측**해야
   * 하는데, 해당 spec 들을 로컬에서 돌릴 수 없어 틀려도 모른 채 초록으로 넘어간다 —
   * 통과하던 테스트를 조용히 깨뜨리는 쪽이 더 나쁘다. 그래서 **줄어들기만 하는 톱니(ratchet)**
   * 로 둔다: 새 위반은 즉시 막고, 기존 것은 손볼 때 하나씩 줄인다.
   *
   * 규칙 두 가지 — 어느 쪽으로든 어긋나면 실패한다.
   *   ① 목록에 없는 파일에 위반이 생기면 실패 (새 위반 차단)
   *   ② 실제 건수가 기준선보다 **적어도** 실패 (고쳤으면 숫자를 내려야 한다 — 기준선이
   *      낡은 채 남아 "고쳤는데 여전히 27건인 척"이 되는 걸 막는다)
   */
  const BASELINE: Array<[string, number]> = [
    ["ui-forms/commerce-forms.spec.ts", 8],
    ["ui-forms/content-forms.spec.ts", 2],
    ["ui-forms/event-core-forms.spec.ts", 3],
    ["ui-forms/marketing-ops-forms.spec.ts", 5],
    ["ui-forms/orders-attendees-forms.spec.ts", 9],
  ];
  const baseline = new Map(BASELINE);

  function violationsByFile(): Map<string, number> {
    const out = new Map<string, number>();
    for (const file of files) {
      if (ALLOWLIST.has(file)) continue;
      const hits = stripComments(fs.readFileSync(file, "utf8")).match(RAW_DIALOG);
      if (hits) out.set(path.relative(E2E_ROOT, file).split(path.sep).join("/"), hits.length);
    }
    return out;
  }

  it("기준선에 없는 파일에 새 위반이 생기지 않았다", () => {
    const fresh = [...violationsByFile().keys()].filter((f) => !baseline.has(f));
    expect(
      fresh,
      `이름 없는 getByRole("dialog") 는 열려 있는 아무 창이나 문다(작성창을 물어 전건 실패한 ` +
        `전례 있음). specs/e2e/helpers/dialog.ts 의 expectDialog(page, 제목) 을 쓸 것:\n  ` +
        fresh.join("\n  "),
    ).toEqual([]);
  });

  it("기존 위반이 늘지 않았고, 줄었으면 기준선도 내려갔다", () => {
    const actual = violationsByFile();
    const drift: string[] = [];
    for (const [file, expected] of baseline) {
      const now = actual.get(file) ?? 0;
      if (now > expected) drift.push(`${file}: ${expected} → ${now} (늘었다)`);
      if (now < expected) drift.push(`${file}: ${expected} → ${now} (줄었다 — 기준선을 내릴 것)`);
    }
    expect(drift, drift.join("\n  ")).toEqual([]);
  });
});
