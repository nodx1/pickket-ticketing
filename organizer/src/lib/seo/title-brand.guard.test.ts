/**
 * `metadata.title` 에 브랜드명을 직접 쓰지 못하게 막는다.
 *
 * ── 무엇을 막나 ──
 * 루트 `layout.tsx` 의 `title.template`(`"%s — PICKKET.GO"`)이 자식 페이지의 평문 `title`
 * 뒤에 브랜드를 붙인다. 그래서 자식이 `"제목 — PICKKET.GO"` 를 주면
 * **`제목 — PICKKET.GO — PICKKET.GO`** 가 된다. 실제로 `/e/{slug}` 가 그 상태였다.
 *
 * ── 무엇은 막지 않나 ──
 * `openGraph.title`·`twitter.title` 은 template 을 **안 타므로** 브랜드가 있어야 정상이다.
 * (그 비대칭이 원인을 확정해 준 단서였다.) 그래서 중첩 깊이를 보고 최상위 `title` 만 본다.
 * `title: { absolute: ... }` 도 template 을 끊는 정식 방법이라 대상이 아니다.
 *
 * 주석은 대상이 아니다 — 이 파일들의 설명 주석에 브랜드명이 들어 있다.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { SITE_NAME } from "./site";

const APP = path.join(__dirname, "..", "..", "app");

function stripComments(raw: string): string {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * 브랜드명을 담은 **최상위** `title:` 값을 찾는다.
 *
 * `openGraph:`/`twitter:` 블록 안에 들어간 것은 제외한다 — 키 스택을 유지해 판별한다.
 */
export function offendingTitles(src: string): string[] {
  const out: string[] = [];
  const stack: string[] = [];
  const re = /(\w+)\s*:\s*(\{|"[^"]*"|`[^`]*`)|(\})/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[3]) {
      stack.pop();
      continue;
    }
    const [, key, value] = m;
    if (value === "{") {
      stack.push(key!);
      continue;
    }
    if (key !== "title") continue;
    // og/twitter 안이면 브랜드가 있어야 정상이다
    if (stack.includes("openGraph") || stack.includes("twitter")) continue;
    if (value!.includes(SITE_NAME)) out.push(value!);
  }
  return out;
}

function appFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...appFiles(full));
    else if (e.name === "page.tsx" || e.name === "layout.tsx") out.push(full);
  }
  return out;
}

describe("metadata.title 브랜드명 중복 방지", () => {
  const files = appFiles(APP);

  it("§0 대상을 실제로 수집했다", () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it("§0-A 판정기가 동작한다 (합성 입력)", () => {
    // 최상위 title 에 브랜드 → 위반
    expect(offendingTitles(`export const metadata = { title: "회사 소개 — PICKKET.GO" };`)).toHaveLength(1);
    // 브랜드 없음 → 정상
    expect(offendingTitles(`export const metadata = { title: "회사 소개" };`)).toHaveLength(0);
    // openGraph 안 → 정상(template 을 안 탄다)
    expect(
      offendingTitles(`const m = { title: "X", openGraph: { title: "X — PICKKET.GO" } };`),
      "og 안의 브랜드까지 잡으면 오탐이다",
    ).toHaveLength(0);
    // twitter 안 → 정상
    expect(offendingTitles(`const m = { twitter: { title: "X — PICKKET.GO" } };`)).toHaveLength(0);
    // og 블록이 닫힌 뒤의 최상위 title → 위반
    expect(
      offendingTitles(`const m = { openGraph: { title: "ok" }, title: "뒤 — PICKKET.GO" };`),
      "블록이 닫힌 뒤를 여전히 og 안으로 보면 위반을 놓친다",
    ).toHaveLength(1);
    // 템플릿 리터럴도 잡는다
    expect(offendingTitles('const m = { title: `X — PICKKET.GO` };')).toHaveLength(1);
  });

  it("어느 page/layout 도 최상위 title 에 브랜드명을 쓰지 않는다", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const hits = offendingTitles(stripComments(fs.readFileSync(f, "utf8")));
      if (hits.length) offenders.push(`${path.relative(APP, f)}: ${hits.join(" / ")}`);
    }
    expect(
      offenders,
      `루트 layout 의 title.template 이 브랜드를 붙인다 — 여기서 또 쓰면 두 번 붙는다.\n  ` +
        offenders.join("\n  "),
    ).toEqual([]);
  });
});
