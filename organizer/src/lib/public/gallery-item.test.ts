import { describe, expect, it } from "vitest";

import {
  GALLERY_CAPTION_MAX,
  GALLERY_MAX_IMAGES,
  normalizeGalleryCaption,
  resolveGalleryAlt,
  toGalleryViews,
} from "./gallery-item";

describe("normalizeGalleryCaption", () => {
  it("앞뒤 공백을 털어낸다", () => {
    expect(normalizeGalleryCaption("  갤러리 에티켓 안내  ")).toBe("갤러리 에티켓 안내");
  });

  it.each([undefined, null, 0, {}, [], true])("문자열이 아니면 null (%s)", (raw) => {
    expect(normalizeGalleryCaption(raw)).toBeNull();
  });

  it.each(["", "   ", "\n\t"])("공백뿐이면 null — 빈 캡션 줄이 생기면 안 된다 (%j)", (raw) => {
    expect(normalizeGalleryCaption(raw)).toBeNull();
  });

  it("최대 길이에서 자른다 — JSONB 라 zod 를 안 거친 값이 들어올 수 있다", () => {
    const long = "가".repeat(GALLERY_CAPTION_MAX + 40);
    expect(normalizeGalleryCaption(long)).toHaveLength(GALLERY_CAPTION_MAX);
  });

  it("경계값 120자는 그대로 둔다", () => {
    const exact = "나".repeat(GALLERY_CAPTION_MAX);
    expect(normalizeGalleryCaption(exact)).toBe(exact);
  });
});

describe("resolveGalleryAlt", () => {
  it("캡션이 있으면 캡션이 곧 alt 다", () => {
    expect(resolveGalleryAlt("셔틀버스 승강장 약도", "KLPGA 챔피언십", 0)).toBe("셔틀버스 승강장 약도");
  });

  it("캡션이 없으면 행사명 + 번호로 떨어진다 — 종전 동작", () => {
    expect(resolveGalleryAlt(null, "KLPGA 챔피언십", 2)).toBe("KLPGA 챔피언십 갤러리 3");
  });
});

describe("toGalleryViews", () => {
  const TITLE = "KLPGA 챔피언십";

  it.each([undefined, null, "", 0, {}])("배열이 아니면 빈 목록 (%s)", (raw) => {
    expect(toGalleryViews(raw, TITLE)).toEqual([]);
  });

  it("썸네일 렌디션이 있으면 그리드에 그것을 쓴다", () => {
    const [view] = toGalleryViews([{ url: "/master.webp", variants: { thumb: "/thumb.webp" } }], TITLE);
    expect(view.thumbUrl).toBe("/thumb.webp");
  });

  it("🔴 라이트박스는 썸네일이 아니라 마스터를 쓴다 — 확대의 이유가 사라진다", () => {
    const [view] = toGalleryViews([{ url: "/master.webp", variants: { thumb: "/thumb.webp" } }], TITLE);
    expect(view.url).toBe("/master.webp");
  });

  it.each([
    ["렌디션 없음", { url: "/only.webp" }],
    ["variants 가 null", { url: "/only.webp", variants: null }],
    ["thumb 가 빈 문자열", { url: "/only.webp", variants: { thumb: "" } }],
    ["thumb 가 문자열이 아님", { url: "/only.webp", variants: { thumb: 42 } }],
  ])("썸네일을 못 고르면 마스터로 떨어진다 — %s", (_label, item) => {
    const [view] = toGalleryViews([item], TITLE);
    expect(view.thumbUrl).toBe("/only.webp");
  });

  it("캡션을 정규화해 싣는다", () => {
    const [view] = toGalleryViews([{ url: "/a.webp", caption: "  주차 안내  " }], TITLE);
    expect(view.caption).toBe("주차 안내");
    expect(view.alt).toBe("주차 안내");
  });

  it("캡션이 없으면 null 이고 alt 는 폴백 — 기존 행사에 회귀가 없어야 한다", () => {
    const [view] = toGalleryViews([{ url: "/a.webp" }], TITLE);
    expect(view.caption).toBeNull();
    expect(view.alt).toBe(`${TITLE} 갤러리 1`);
  });

  it("문자열 요소도 받는다 — 초대권 화면이 이미 그 형태를 전제한다", () => {
    expect(toGalleryViews(["/a.webp"], TITLE)).toEqual([
      { url: "/a.webp", thumbUrl: "/a.webp", caption: null, alt: `${TITLE} 갤러리 1` },
    ]);
  });

  it.each([
    ["url 없음", { caption: "설명만 있음" }],
    ["url 이 빈 문자열", { url: "" }],
    ["url 이 문자열이 아님", { url: 123 }],
    ["null 요소", null],
    ["숫자 요소", 7],
  ])("url 이 없는 요소는 버린다 — 빈 칸이 생기면 안 된다 (%s)", (_label, entry) => {
    expect(toGalleryViews([entry], TITLE)).toEqual([]);
  });

  it("🔴 버려진 요소가 번호를 밀지 않는다 — alt 가 실제 순서와 어긋나면 낭독기가 틀린다", () => {
    const views = toGalleryViews([{ url: "" }, { url: "/a.webp" }, { url: "/b.webp" }], TITLE);
    expect(views.map((v) => v.alt)).toEqual([`${TITLE} 갤러리 1`, `${TITLE} 갤러리 2`]);
  });

  it("캡션 있는 것과 없는 것이 섞여도 각자 알맞은 alt 를 갖는다", () => {
    const views = toGalleryViews(
      [{ url: "/a.webp", caption: "약도" }, { url: "/b.webp" }],
      TITLE,
    );
    expect(views.map((v) => v.alt)).toEqual(["약도", `${TITLE} 갤러리 2`]);
  });
});

/**
 * 🔴 상한 숫자가 한 곳에서만 나오는지 고정한다.
 *
 * 종전에는 4 가 세 곳에 흩어져 있었다 — zod 스키마 · 업로드 컴포넌트 기본값 ·
 * 폼 라벨 문자열("최대 4장"). 하나만 고치면 나머지가 거짓말을 한다.
 * (어제 상세 이미지 테스트에 `/최대 10장/` 을 박아뒀다가 상한이 8이 되자 그것만 깨졌다.)
 */
describe("갤러리 상한 단일화", () => {
  it("정본 상수가 존재한다", () => {
    expect(typeof GALLERY_MAX_IMAGES).toBe("number");
    expect(GALLERY_MAX_IMAGES).toBeGreaterThan(0);
  });

  it("🔴 업로드 컴포넌트가 숫자를 하드코딩하지 않는다", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      new URL("../../components/shared/gallery-upload.tsx", import.meta.url),
      "utf8",
    );
    const body = src.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
    expect(body).toMatch(/max = GALLERY_MAX_IMAGES/);
    expect(body).not.toMatch(/max = \d/);
  });

  it("🔴 폼 라벨이 숫자를 하드코딩하지 않는다", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../../components/forms/event-form.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/최대 \$\{GALLERY_MAX_IMAGES\}장/);
    expect(src).not.toMatch(/최대 4장/);
  });

  it("🔴 zod 스키마가 정본 상수를 쓴다", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../events/gallery-schema.ts", import.meta.url), "utf8");
    const body = src.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
    expect(body).toMatch(/\.max\(GALLERY_MAX_IMAGES/);
    expect(body).not.toMatch(/GALLERY_MAX_IMAGES = \d/);
  });
});
