import { describe, expect, it } from "vitest";

import {
  DETAIL_CAPTION_MAX,
  DETAIL_IMAGE_MAX,
  DETAIL_SECTION_MAX,
  detailImagesFor,
  normalizeDetailCaption,
  resolveDetailSection,
  toDetailImageViews,
} from "./detail-image";

describe("resolveDetailSection", () => {
  it.each(["intro", "transport", "parking", "contact"] as const)("알려진 섹션은 그대로 (%s)", (sec) => {
    expect(resolveDetailSection(sec)).toBe(sec);
  });

  it.each([undefined, null, "", "unknown", 0, {}, []])(
    "🔴 모르는 값·없는 값은 intro — 섹션 개념 이전에 저장된 이미지가 소개란에 남아야 마이그레이션이 없다 (%s)",
    (raw) => {
      expect(resolveDetailSection(raw)).toBe("intro");
    },
  );
});

describe("섹션 상한", () => {
  it("전체 상한은 섹션 상한의 합이다", () => {
    const sum = Object.values(DETAIL_SECTION_MAX).reduce((a, b) => a + b, 0);
    expect(DETAIL_IMAGE_MAX).toBe(sum);
  });

  it("🔴 섹션별로 따로 센다 — 전체 상한만 두면 한 섹션이 전부를 먹는다", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ url: `/i${i}.webp`, section: "intro" as const }));
    const views = toDetailImageViews(many, "T");
    expect(views).toHaveLength(DETAIL_SECTION_MAX.intro);
  });

  it("한 섹션이 가득 차도 다른 섹션은 받는다", () => {
    const raw = [
      ...Array.from({ length: 5 }, (_, i) => ({ url: `/a${i}.webp`, section: "intro" as const })),
      { url: "/t.webp", section: "transport" as const },
    ];
    const views = toDetailImageViews(raw, "T");
    expect(detailImagesFor(views, "intro")).toHaveLength(DETAIL_SECTION_MAX.intro);
    expect(detailImagesFor(views, "transport")).toHaveLength(1);
  });

  it("섹션별 최대치를 다 채우면 전체 상한과 같아진다", () => {
    const raw = Object.entries(DETAIL_SECTION_MAX).flatMap(([sec, max]) =>
      Array.from({ length: max }, (_, i) => ({ url: `/${sec}${i}.webp`, section: sec })),
    );
    expect(toDetailImageViews(raw, "T")).toHaveLength(DETAIL_IMAGE_MAX);
  });
});

describe("detailImagesFor", () => {
  const views = toDetailImageViews(
    [
      { url: "/a.webp", section: "intro" },
      { url: "/b.webp", section: "parking" },
      { url: "/c.webp", section: "intro" },
    ],
    "T",
  );

  it("해당 섹션만 골라낸다", () => {
    expect(detailImagesFor(views, "intro").map((v) => v.url)).toEqual(["/a.webp", "/c.webp"]);
    expect(detailImagesFor(views, "parking").map((v) => v.url)).toEqual(["/b.webp"]);
  });

  it("없는 섹션은 빈 배열 — 호출부가 렌더를 생략한다", () => {
    expect(detailImagesFor(views, "contact")).toEqual([]);
  });

  it("순서를 보존한다", () => {
    expect(detailImagesFor(views, "intro")[0].url).toBe("/a.webp");
  });
});

describe("섹션별 alt 번호", () => {
  it("🔴 번호를 섹션 안에서 센다 — 전체 순번을 쓰면 '주차 안내 5' 처럼 낭독기 안내가 어긋난다", () => {
    const views = toDetailImageViews(
      [
        { url: "/i1.webp", section: "intro" },
        { url: "/i2.webp", section: "intro" },
        { url: "/p1.webp", section: "parking" },
      ],
      "KLPGA",
    );
    expect(detailImagesFor(views, "parking")[0].alt).toBe("KLPGA 주차 안내 1");
    expect(detailImagesFor(views, "intro")[1].alt).toBe("KLPGA 이벤트 안내 2");
  });

  it("캡션이 있으면 캡션이 alt 다(섹션명 무관)", () => {
    const views = toDetailImageViews([{ url: "/p.webp", section: "parking", caption: "주차장 약도" }], "T");
    expect(views[0].alt).toBe("주차장 약도");
  });
});

describe("normalizeDetailCaption", () => {
  it("앞뒤 공백을 털어낸다", () => {
    expect(normalizeDetailCaption("  대회 안내  ")).toBe("대회 안내");
  });

  it.each([undefined, null, 0, {}, [], true])("문자열이 아니면 null (%s)", (raw) => {
    expect(normalizeDetailCaption(raw)).toBeNull();
  });

  it.each(["", "   ", "\n\t"])("공백뿐이면 null (%j)", (raw) => {
    expect(normalizeDetailCaption(raw)).toBeNull();
  });

  it("최대 길이에서 자른다 — JSONB 라 zod 를 안 거친 값이 들어올 수 있다", () => {
    expect(normalizeDetailCaption("가".repeat(DETAIL_CAPTION_MAX + 30))).toHaveLength(DETAIL_CAPTION_MAX);
  });
});

describe("toDetailImageViews", () => {
  const TITLE = "KLPGA 챔피언십";

  it.each([undefined, null, "", 0, {}])("배열이 아니면 빈 목록 (%s)", (raw) => {
    expect(toDetailImageViews(raw, TITLE)).toEqual([]);
  });

  it("캡션이 있으면 그것이 alt 다 — 낭독기·검색엔진에는 이 문장만 남는다", () => {
    const [view] = toDetailImageViews([{ url: "/a.webp", caption: "  셔틀버스 운행 안내  " }], TITLE);
    expect(view).toEqual({ url: "/a.webp", alt: "셔틀버스 운행 안내", section: "intro" });
  });

  it("캡션이 없으면 행사명 + **섹션명** + 번호로 떨어진다", () => {
    const [view] = toDetailImageViews([{ url: "/a.webp" }], TITLE);
    expect(view.alt).toBe(`${TITLE} 이벤트 안내 1`);
  });

  it("🔴 마스터 URL 을 그대로 쓴다 — 축소 렌디션은 상세 이미지의 글자를 뭉갠다", () => {
    const [view] = toDetailImageViews([{ url: "/master.webp", variants: { thumb: "/t.webp" } }], TITLE);
    expect(view.url).toBe("/master.webp");
  });

  it("문자열 요소도 받는다", () => {
    expect(toDetailImageViews(["/a.webp"], TITLE)).toEqual([
      { url: "/a.webp", alt: `${TITLE} 이벤트 안내 1`, section: "intro" },
    ]);
  });

  it.each([
    ["url 없음", { caption: "설명만" }],
    ["url 이 빈 문자열", { url: "" }],
    ["url 이 문자열이 아님", { url: 123 }],
    ["null 요소", null],
    ["숫자 요소", 7],
  ])("url 이 없는 요소는 버린다 — 본문 한가운데가 뚫려 보인다 (%s)", (_label, entry) => {
    expect(toDetailImageViews([entry], TITLE)).toEqual([]);
  });

  it("🔴 버려진 요소가 번호를 밀지 않는다", () => {
    const views = toDetailImageViews([{ url: "" }, { url: "/a.webp" }, { url: "/b.webp" }], TITLE);
    expect(views.map((v) => v.alt)).toEqual([`${TITLE} 이벤트 안내 1`, `${TITLE} 이벤트 안내 2`]);
  });

  it("섹션 미지정이 몰리면 intro 상한에서 잘린다 — JSONB 라 서버 검증을 우회한 값이 올 수 있다", () => {
    const many = Array.from({ length: DETAIL_IMAGE_MAX + 5 }, (_, i) => ({ url: `/${i}.webp` }));
    expect(toDetailImageViews(many, TITLE)).toHaveLength(DETAIL_SECTION_MAX.intro);
  });

  it("순서를 보존한다 — 세로로 이어 붙이므로 순서가 곧 문서 흐름이다", () => {
    const views = toDetailImageViews([{ url: "/1.webp" }, { url: "/2.webp" }, { url: "/3.webp" }], TITLE);
    expect(views.map((v) => v.url)).toEqual(["/1.webp", "/2.webp", "/3.webp"]);
  });
});
