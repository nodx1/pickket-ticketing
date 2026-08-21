/**
 * 착지 화면의 「행사 페이지로」 링크 (2026-08-01 지시서 ②).
 *
 * ## 🔴 문자열 존재 검사로는 부족하다
 * 지시서가 못박은 대로 **렌더 결과의 `href` 값**을 단언한다. "파일에 행사 페이지로 라는
 * 글자가 있다" 는 한 줄로 우회된다 — 오늘 그 형태의 가드가 실제로 뚫리는 걸 확인했다.
 *
 * ⚠️ 렌더는 `react-dom/server` 로 한다. `@testing-library/react` 는 이 리포에 없고,
 *    vitest 가 `.tsx` 를 수집하지 않는다. 이미 있는 의존성만 쓴다.
 */
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { eventPagePath } from "./event-path";

describe("eventPagePath", () => {
  it("🔴 슬러그가 없으면 null — /e/undefined 로 보내지 않는다", () => {
    for (const bad of [undefined, null, "", "   "]) {
      expect(eventPagePath(bad), `${JSON.stringify(bad)} 에서 링크를 만들었다`).toBeNull();
    }
  });

  it("🔴 값이 유실돼 'undefined'·'null' 문자열로 흘러와도 링크를 안 만든다", () => {
    expect(eventPagePath("undefined")).toBeNull();
    expect(eventPagePath("null")).toBeNull();
  });

  it("🔴 한글 슬러그를 인코딩한다 — 안 하면 404 로 간다(2026-07-27 실사고)", () => {
    expect(eventPagePath("bc카드한경-klpga-챔피언십")).toBe(
      "/e/bc%EC%B9%B4%EB%93%9C%ED%95%9C%EA%B2%BD-klpga-%EC%B1%94%ED%94%BC%EC%96%B8%EC%8B%AD",
    );
  });

  it("영문 슬러그는 그대로다", () => {
    expect(eventPagePath("klpga-2026")).toBe("/e/klpga-2026");
  });

  it("앞뒤 공백은 털어낸다", () => {
    expect(eventPagePath("  klpga-2026  ")).toBe("/e/klpga-2026");
  });
});

/**
 * 🔴 환불완료 착지 — **실제로 렌더해서 href 를 본다.**
 *
 * 종전엔 「환불이 완료되었습니다」만 뜨고 **버튼이 하나도 없었다.** 뒤로가기 말고는
 * 갈 데가 없었다 — 환불한 사람이 다른 날짜로 다시 사는 길이 막혀 있었다.
 *
 * ⚠️ 문자열 존재 검사가 아니라 **렌더 결과의 `href` 값**을 단언한다(지시서 요구).
 */
describe("환불완료 착지 — 렌더 결과의 href", () => {
  async function render(eventSlug: string | null) {
    const { RefundLandingActions } = await import(
      "@/app/(public)/my-tickets/[ticketNumber]/refund/refund-landing-actions"
    );
    return renderToStaticMarkup(createElement(RefundLandingActions, { eventSlug }));
  }

  it("🔴 「내 티켓 조회」는 슬러그와 무관하게 항상 있다", async () => {
    for (const slug of [null, "klpga-2026"]) {
      expect(await render(slug), "막다른 화면이 된다").toMatch(/href="\/my-tickets"/);
    }
  });

  it("🔴 슬러그가 있으면 행사 링크 href 가 **인코딩된** 경로다", async () => {
    const html = await render("bc카드한경-klpga-챔피언십");
    expect(html).toContain(
      'href="/e/bc%EC%B9%B4%EB%93%9C%ED%95%9C%EA%B2%BD-klpga-%EC%B1%94%ED%94%BC%EC%96%B8%EC%8B%AD"',
    );
    expect(html).toContain("행사 페이지로");
  });

  it("🔴 슬러그가 없으면 행사 링크를 아예 안 만든다 — /e/undefined 금지", async () => {
    const html = await render(null);
    expect(html).not.toContain("/e/undefined");
    expect(html.match(/href="\/e\//g) ?? [], "슬러그 없이 행사 링크를 만들었다").toEqual([]);
    expect(html).not.toContain("행사 페이지로");
  });

  it("🔴 버튼을 지우면 이 검사가 죽는다 — 두 링크가 실제로 <a href> 로 나온다", async () => {
    const html = await render("klpga-2026");
    const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(hrefs.sort()).toEqual(["/e/klpga-2026", "/my-tickets"]);
  });
});

/**
 * 완료(예약내역) 페이지 — 슬러그를 **날것으로 끼우지 않는지**.
 *
 * ⚠️ 이 페이지는 서버 컴포넌트라 렌더 검사가 어렵다(v2 조회가 들어 있다).
 *    대신 **날것 보간이 남아 있지 않은지**를 본다 — 그 형태가 2026-07-27 에
 *    한글 슬러그 404 를 만든 원인이다.
 */
describe("완료 페이지 — 날것 슬러그 보간 금지", () => {
  it("🔴 `/e/${eventSlug}` 를 직접 만들지 않고 eventPagePath 를 쓴다", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "app", "(public)", "e", "[eventSlug]", "checkout", "complete", "page.tsx"),
      "utf8",
    );
    const code = src.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\/.*$/gm, "");
    expect(code, "인코딩 없이 슬러그를 경로에 끼우면 한글 행사가 404 로 간다").not.toMatch(
      /`\/e\/\$\{eventSlug\}`/,
    );
    expect(code).toContain("eventPagePath");
  });
});
