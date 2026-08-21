import { describe, it, expect } from "vitest";

import { mapHomepageDesignToEventPage, type HomepageDesign } from "./homepage-design-mapping";

describe("mapHomepageDesignToEventPage", () => {
  it("색토큰 hex → page_theme(bg/text/accent) 매핑", () => {
    const design: HomepageDesign = {
      backgroundColor: "#FAFBFF",
      textColor: "#1A1D2E",
      accentColor: "#6C5CE7",
    };
    const out = mapHomepageDesignToEventPage(design);
    expect(out.page_theme).toEqual({ bg: "#FAFBFF", text: "#1A1D2E", accent: "#6C5CE7" });
  });

  it("무효 hex 는 drop(SVG/CSS 인젝션 차단·v2 검증 정합)", () => {
    const out = mapHomepageDesignToEventPage({
      backgroundColor: "red",
      accentColor: "#6C5CE7",
      textColor: "rgba(0,0,0,1)",
    });
    expect(out.page_theme).toEqual({ accent: "#6C5CE7" });
  });

  it("색이 하나도 없으면 page_theme=null(병합 시 무영향)", () => {
    const out = mapHomepageDesignToEventPage({});
    expect(out.page_theme).toBeNull();
  });

  it("히어로 카피/커버 → Puck HeroBanner page_data 구성", () => {
    const out = mapHomepageDesignToEventPage({
      heroHeadline: "메인 헤드라인",
      heroSubtext: "부제목",
      ctaText: "예매하기",
      coverImageUrl: "https://cdn/cover.jpg",
    });
    expect(out.page_data).not.toBeNull();
    const content = (out.page_data as { content: Array<Record<string, unknown>> }).content;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("HeroBanner");
    expect(content[0].props).toMatchObject({
      title: "메인 헤드라인",
      subtitle: "부제목",
      ctaText: "예매하기",
      imageUrl: "https://cdn/cover.jpg",
    });
  });

  it("히어로 필드 전무 시 page_data=null(빈 Puck 미생성 → 기본 랜딩 유지)", () => {
    const out = mapHomepageDesignToEventPage({ backgroundColor: "#FAFBFF" });
    expect(out.page_data).toBeNull();
  });

  it("공백만 있는 카피는 무시(trim 후 빈값)", () => {
    const out = mapHomepageDesignToEventPage({ heroHeadline: "   ", heroSubtext: "" });
    expect(out.page_data).toBeNull();
  });

  it("손실/미매핑 필드는 white_label_config.homepage_design_meta 로 원본 보존", () => {
    const design: HomepageDesign = {
      templateId: "kpop",
      sections: ["event", "products"],
      showCountdown: true,
      showVenueMap: false,
      showOrganizer: true,
      sectionDescriptions: { event: "설명" },
      heroFit: "contain",
      coverImageUrl: "https://cdn/c.jpg",
      aiGenerated: true,
    };
    const out = mapHomepageDesignToEventPage(design);
    const meta = (out.white_label_config as { homepage_design_meta: Record<string, unknown> })
      .homepage_design_meta;
    expect(meta.template_id).toBe("kpop");
    expect(meta.sections).toEqual(["event", "products"]);
    expect(meta.show_countdown).toBe(true);
    expect(meta.show_venue_map).toBe(false);
    expect(meta.hero_fit).toBe("contain");
    expect(meta.cover_image_url).toBe("https://cdn/c.jpg");
    expect(meta.ai_generated).toBe(true);
  });

  it("F7: heroFit → HeroBanner.fit prop 으로 소비(카피 없이 fit 만 있어도 HeroBanner 생성)", () => {
    const out = mapHomepageDesignToEventPage({ heroFit: "contain", coverImageUrl: "https://cdn/c.jpg" });
    const content = (out.page_data as { content: Array<Record<string, unknown>> }).content;
    const hero = content.find((b) => b.type === "HeroBanner");
    expect(hero).toBeDefined();
    expect((hero!.props as Record<string, unknown>).fit).toBe("contain");
  });

  it("F7: heroFit=cover 도 fit prop 으로 전달", () => {
    const out = mapHomepageDesignToEventPage({ heroFit: "cover", heroHeadline: "제목" });
    const content = (out.page_data as { content: Array<Record<string, unknown>> }).content;
    const hero = content.find((b) => b.type === "HeroBanner");
    expect((hero!.props as Record<string, unknown>).fit).toBe("cover");
  });

  it("F7: showCountdown=true → CountdownBlock append(소비자 렌더 즉시 소비)", () => {
    const out = mapHomepageDesignToEventPage({ heroHeadline: "제목", showCountdown: true });
    const content = (out.page_data as { content: Array<Record<string, unknown>> }).content;
    expect(content.map((b) => b.type)).toEqual(["HeroBanner", "CountdownBlock"]);
    const countdown = content.find((b) => b.type === "CountdownBlock")!;
    expect((countdown.props as Record<string, unknown>).id).toBe("countdown-1");
  });

  it("F7: showCountdown=true 이고 히어로 필드 전무면 CountdownBlock 단독 생성(page_data 유효)", () => {
    const out = mapHomepageDesignToEventPage({ showCountdown: true });
    const content = (out.page_data as { content: Array<Record<string, unknown>> }).content;
    expect(content.map((b) => b.type)).toEqual(["CountdownBlock"]);
  });

  it("F7: showCountdown=false/미지정 이면 CountdownBlock 미생성", () => {
    const out = mapHomepageDesignToEventPage({ heroHeadline: "제목", showCountdown: false });
    const content = (out.page_data as { content: Array<Record<string, unknown>> }).content;
    expect(content.map((b) => b.type)).toEqual(["HeroBanner"]);
  });

  it("F7: heroFit·showCountdown 은 소비 반영과 별개로 meta 에도 계속 보존(감사)", () => {
    const out = mapHomepageDesignToEventPage({ heroFit: "contain", showCountdown: true });
    const meta = (out.white_label_config as { homepage_design_meta: Record<string, unknown> })
      .homepage_design_meta;
    expect(meta.hero_fit).toBe("contain");
    expect(meta.show_countdown).toBe(true);
  });

  it("page_published=true 고정(go 저장=게시, published 만 by-subdomain 노출)", () => {
    expect(mapHomepageDesignToEventPage({}).page_published).toBe(true);
  });

  it("subdomain_slug 는 미전송(v2 최초 생성서 event.slug 파생·재호출 URL 안정)", () => {
    const out = mapHomepageDesignToEventPage({ accentColor: "#6C5CE7" });
    expect(out.subdomain_slug).toBeUndefined();
  });
});
