import { describe, expect, it } from "vitest";
import { SITE_NAME, TITLE_TEMPLATE, buildEventSeoTitles, withBrand } from "./site";

/** 루트 layout 의 template 이 하는 일을 흉내낸다 — 최종 `<title>` 을 계산해 본다. */
function applyTemplate(pageTitle: string): string {
  return TITLE_TEMPLATE.replace("%s", pageTitle);
}

describe("이벤트 상세 SEO 제목", () => {
  it("🔴 metadata.title 에 브랜드를 붙이지 않는다 — 붙이면 template 이 한 번 더 붙인다", () => {
    const { title } = buildEventSeoTitles({ eventTitle: "BC카드·한경 KLPGA 챔피언십" });
    expect(title).toBe("BC카드·한경 KLPGA 챔피언십");
    expect(title).not.toContain(SITE_NAME);
  });

  it("최종 <title> 에 브랜드가 정확히 한 번만 들어간다", () => {
    const { title } = buildEventSeoTitles({ eventTitle: "BC카드·한경 KLPGA 챔피언십" });
    const rendered = applyTemplate(title);
    expect(rendered).toBe("BC카드·한경 KLPGA 챔피언십 — PICKKET.GO");
    expect(rendered.match(/PICKKET\.GO/g)).toHaveLength(1);
  });

  it("og:title 은 template 을 안 타므로 브랜드를 직접 붙인다", () => {
    const { ogTitle } = buildEventSeoTitles({ eventTitle: "여름 페스티벌" });
    expect(ogTitle).toBe("여름 페스티벌 — PICKKET.GO");
    expect(ogTitle.match(/PICKKET\.GO/g)).toHaveLength(1);
  });

  it("주최자 seoTitle 이 있으면 그것을 쓰되, 브랜드를 덧붙이지 않는다", () => {
    const { title, ogTitle } = buildEventSeoTitles({
      eventTitle: "원래 제목",
      seoTitle: "검색용 제목",
    });
    expect(title).toBe("검색용 제목");
    expect(applyTemplate(title)).toBe("검색용 제목 — PICKKET.GO");
    expect(ogTitle).toBe("검색용 제목 — PICKKET.GO");
  });

  it("주최자 ogTitle 이 있으면 그대로 쓴다 (브랜드를 덧붙이지 않는다)", () => {
    const { ogTitle } = buildEventSeoTitles({ eventTitle: "원래", ogTitle: "공유용 문구" });
    expect(ogTitle).toBe("공유용 문구");
  });

  it("공백만 있는 seoTitle/ogTitle 은 없는 것으로 본다", () => {
    const { title, ogTitle } = buildEventSeoTitles({
      eventTitle: "원래 제목",
      seoTitle: "   ",
      ogTitle: "\t",
    });
    expect(title).toBe("원래 제목");
    expect(ogTitle).toBe("원래 제목 — PICKKET.GO");
  });

  it("주최자가 seoTitle 에 브랜드를 직접 넣은 경우는 지우지 않는다 (입력 데이터 존중)", () => {
    // 우리 코드가 자동으로 덧붙이는 것만 없앤다. 이건 주최자 의도일 수 있다.
    const { title } = buildEventSeoTitles({ eventTitle: "x", seoTitle: "직접 넣은 — PICKKET.GO" });
    expect(title).toBe("직접 넣은 — PICKKET.GO");
  });
});

describe("브랜드 문구 정본", () => {
  it("template 은 SITE_NAME 에서 파생된다 — 브랜드를 바꿔도 어긋나지 않는다", () => {
    expect(TITLE_TEMPLATE).toBe(`%s — ${SITE_NAME}`);
    expect(withBrand("X")).toBe(`X — ${SITE_NAME}`);
  });
});
