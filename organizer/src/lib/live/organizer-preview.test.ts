import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

/**
 * 🔴 리허설 통과는 **주최자 경로에서만** 열린다.
 *
 * 관중 경로가 함께 열리면 BC카드 티켓에 다른 대회 순위가 뜬다 — 빈 화면보다 나쁘다.
 * ⚠️ "organizerEventId 라는 글자가 있다" 는 아무것도 증명하지 않는다.
 *    **관계**를 본다: 게이트 우회가 그 값에 걸려 있는가, 티켓 경로는 안 넘기는가.
 */
async function src(p: string) {
  const s = await readFile(new URL(p, import.meta.url), "utf8");
  return s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}

describe("🔴 리허설 우회는 주최자 경로에만", () => {
  it("게이트 우회가 organizerEventId 에 걸려 있다", async () => {
    const s = await src("../../app/(public)/tickets/[ticketNumber]/_components/live/live-view.tsx");
    expect(
      /const safe =[^;]*organizerEventId !== undefined[^;]*isSpectatorSafe\(summary\)/.test(s),
      "게이트가 organizerEventId 와 무관하게 열리면 관중에게 리허설이 샌다",
    ).toBe(true);
  });

  it("🔴 티켓 페이지는 organizerEventId 를 넘기지 않는다", async () => {
    const s = await src("../../app/(public)/tickets/[ticketNumber]/page.tsx");
    expect(s.includes("organizerEventId"), "공개 경로가 이 값을 넘기면 우회가 생긴다").toBe(false);
  });

  it("🔴 쿼리·헤더로 켜지지 않는다 — 서버 컴포넌트가 params 로만 준다", async () => {
    const s = await src("../../app/(dashboard)/events/[eventId]/live-preview/page.tsx");
    expect(/organizerEventId=\{eventId\}/.test(s)).toBe(true);
    expect(/searchParams|rehearsal=1|headers\(\)/.test(s), "쿼리 우회를 만들지 않는다").toBe(false);
  });

  /**
   * 🔴 URL 이 「어느 라우트를 가리키는가」를 라우트 **내용**으로 판정한다.
   *
   * 앞선 판은 `/live` 로 정규식을 잡아 `/live/summary` 와 구별하지 못했고,
   * 훅이 SSE 스트림을 가리킨 채로 초록이었다. `res.json()` 이 스트림에서
   * 영원히 안 끝나 화면이 로딩에 고착했다(2026-08-07 실사고).
   */
  it("🔴 주최자 피드 URL 이 SSE 스트림이 아니라 JSON 요약을 가리킨다", async () => {
    const hook = await src("./use-live-summary.ts");
    const m = hook.match(/`\/api\/events\/\$\{encodeURIComponent\(src\.eventId\)\}([^`]*)`/);
    expect(m, "주최자 피드 URL 을 찾지 못했다").not.toBeNull();
    const tail = m![1]; // 예: "/live/summary"

    const sse = await src("../../app/api/events/[eventId]/live/route.ts");
    const json = await src("../../app/api/events/[eventId]/live/summary/route.ts");
    expect(sse.includes("createSSEStream"), "/live 는 SSE 스트림이라는 전제").toBe(true);
    expect(json.includes("successResponse"), "/live/summary 는 JSON 이라는 전제").toBe(true);

    expect(tail, "훅이 SSE 라우트를 가리키면 res.json() 이 끝나지 않는다").toBe("/live/summary");
  });
});
