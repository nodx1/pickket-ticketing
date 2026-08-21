import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import {
  CONTEXT_BANNER_MAX,
  contextBannerCacheKey,
  resolveContextBanner,
} from "./context-banner";

describe("resolveContextBanner", () => {
  it("주최자가 쓴 문구를 그대로 표시한다", () => {
    expect(resolveContextBanner("얼리버드 20% 할인 중")).toBe("얼리버드 20% 할인 중");
  });

  it("앞뒤 공백을 털어낸다", () => {
    expect(resolveContextBanner("  공지  ")).toBe("공지");
  });

  it.each([undefined, null, 0, {}, [], true])("문자열이 아니면 배너 없음 (%s)", (raw) => {
    expect(resolveContextBanner(raw)).toBeNull();
  });

  it.each(["", "   ", "\n\t"])(
    "🔴 공백만이면 배너 해제 — 스페이스 하나로 빈 띠가 남으면 '왜 안 지워지지' 가 된다 (%j)",
    (raw) => {
      expect(resolveContextBanner(raw)).toBeNull();
    },
  );

  it(`${CONTEXT_BANNER_MAX}자에서 자른다`, () => {
    expect(resolveContextBanner("가".repeat(CONTEXT_BANNER_MAX + 50))).toHaveLength(CONTEXT_BANNER_MAX);
  });
});

describe("contextBannerCacheKey", () => {
  it("이벤트별로 다른 키", () => {
    expect(contextBannerCacheKey("a")).not.toBe(contextBannerCacheKey("b"));
  });

  it("🔴 조회 API 와 무효화 지점이 같은 키를 쓴다 — 어긋나면 캐시가 영원히 안 지워진다", async () => {
    const [route, patch] = await Promise.all([
      readFile(
        new URL("../../app/api/events/[eventId]/public/context-banner/route.ts", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../../app/api/events/[eventId]/route.ts", import.meta.url), "utf8"),
    ]);
    const strip = (s: string) =>
      s
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");

    // 양쪽이 리터럴을 각자 적지 않고 **공용 함수**를 부르는지
    expect(strip(route)).toMatch(/contextBannerCacheKey\(/);
    expect(strip(patch)).toMatch(/contextBannerCacheKey\(/);
    // 리터럴 재등장(복붙 회귀) 금지
    expect(strip(route)).not.toMatch(/`ctxbanner:/);
    expect(strip(patch)).not.toMatch(/`ctxbanner:/);
  });
});

/**
 * 🔴 자동 생성이 되살아나지 않도록 고정한다.
 *
 * 종전 배너 API 는 `D-N · 날짜 · 잔여석 · 최저가` 를 스스로 계산했고, 그 계산에
 * 0원 comp 등급이 섞여 유료 대회에 **`₩0부터`** 가 표시됐다(2026-07-30 주최측 제보).
 * 주최자가 쓴 문구는 읽지도 않았다.
 */
describe("배너 API 배선", () => {
  async function body() {
    const source = await readFile(
      new URL("../../app/api/events/[eventId]/public/context-banner/route.ts", import.meta.url),
      "utf8",
    );
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
  }

  it("주최자 입력값(context_banner)을 읽는다", async () => {
    expect(await body()).toMatch(/resolveContextBanner\(\s*e\.context_banner\s*\)/);
  });

  it("🔴 최저가·잔여석을 스스로 계산하지 않는다 — 통제 못 하는 문구가 최상단에 뜬다", async () => {
    const code = await body();
    expect(code).not.toMatch(/getTiersByEvent/);
    expect(code).not.toMatch(/minPrice/);
    expect(code).not.toMatch(/formatKRW/);
  });

  it("🔴 D-day 를 스스로 계산하지 않는다", async () => {
    const code = await body();
    expect(code).not.toMatch(/D-\$\{/);
    expect(code).not.toMatch(/오늘 시작|내일 시작/);
  });
});
