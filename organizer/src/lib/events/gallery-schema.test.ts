import { describe, expect, it } from "vitest";
import { z } from "zod";

import { GALLERY_MAX_IMAGES, galleryImagesSchema } from "./gallery-schema";
import { GALLERY_CAPTION_MAX } from "@/lib/public/gallery-item";

/**
 * 🔴 이 파일이 지키는 것: **캡션이 저장 경로에서 조용히 사라지지 않는 것.**
 *
 * zod 는 기본 strip 이라 스키마에 없는 필드를 **에러 없이 버린다**. 그래서 캡션이 빠져도
 * 저장은 성공하고 값만 없어진다 — 화면에도 로그에도 아무 흔적이 안 남는다.
 * 생성·수정 라우트가 같은 스키마 객체를 쓰는지까지 여기서 고정한다.
 */
const wrapped = z.object({ galleryImages: galleryImagesSchema });

describe("galleryImagesSchema", () => {
  it("🔴 캡션이 파싱을 통과해 살아남는다 — strip 되면 저장돼도 값이 사라진다", () => {
    const parsed = wrapped.parse({
      galleryImages: [{ url: "/a.webp", caption: "셔틀버스 승강장 약도" }],
    });
    expect(parsed.galleryImages?.[0].caption).toBe("셔틀버스 승강장 약도");
  });

  it("캡션 없이도 통과한다 — 기존 행사에 회귀가 없어야 한다", () => {
    const parsed = wrapped.parse({ galleryImages: [{ url: "/a.webp" }] });
    expect(parsed.galleryImages?.[0].caption).toBeUndefined();
  });

  it("렌디션 맵을 함께 싣는다", () => {
    const parsed = wrapped.parse({
      galleryImages: [{ url: "/a.webp", variants: { thumb: "/t.webp" }, caption: "설명" }],
    });
    expect(parsed.galleryImages?.[0]).toEqual({
      url: "/a.webp",
      variants: { thumb: "/t.webp" },
      caption: "설명",
    });
  });

  it("variants 가 null 이어도 통과한다", () => {
    expect(() => wrapped.parse({ galleryImages: [{ url: "/a.webp", variants: null }] })).not.toThrow();
  });

  it(`캡션 ${GALLERY_CAPTION_MAX}자는 통과, 초과하면 거부한다`, () => {
    const exact = "가".repeat(GALLERY_CAPTION_MAX);
    expect(() => wrapped.parse({ galleryImages: [{ url: "/a.webp", caption: exact }] })).not.toThrow();
    expect(() =>
      wrapped.parse({ galleryImages: [{ url: "/a.webp", caption: exact + "가" }] }),
    ).toThrow();
  });

  it(`${GALLERY_MAX_IMAGES}장을 넘으면 거부한다`, () => {
    const items = Array.from({ length: GALLERY_MAX_IMAGES + 1 }, (_, i) => ({ url: `/${i}.webp` }));
    expect(() => wrapped.parse({ galleryImages: items })).toThrow(/최대 4장/);
  });

  it("갤러리 자체가 없어도 통과한다 — optional", () => {
    expect(() => wrapped.parse({})).not.toThrow();
  });

  it("url 이 없으면 거부한다", () => {
    expect(() => wrapped.parse({ galleryImages: [{ caption: "설명만" }] })).toThrow();
  });
});

/**
 * 🔴 배선 검사 — 두 라우트가 **정말로** 공유 스키마를 쓰는지 소스로 확인한다.
 *
 * 모듈을 import 해 참조 동일성을 보는 방식은 이 프로젝트에서 세 번 헛돌았다:
 * 모듈 전체를 훑으면 `import` 문만으로 통과하고, 주석에 적힌 이름조차 통과시켰다.
 * 그래서 **주석과 import 를 걷어낸 뒤** 필드 정의 자리를 본다.
 */
describe("생성·수정 라우트 배선", () => {
  const ROUTES = [
    ["생성", "src/app/api/events/route.ts"],
    ["수정", "src/app/api/events/[eventId]/route.ts"],
  ] as const;

  it.each(ROUTES)("%s 라우트가 galleryImages 에 공유 스키마를 물린다", async (_label, rel) => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL(`../../../${rel}`, import.meta.url), "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//") && !line.trim().startsWith("import "))
      .join("\n");

    expect(code).toMatch(/galleryImages:\s*galleryImagesSchema/);
  });

  it.each(ROUTES)("%s 라우트에 갤러리 zod 가 복붙돼 있지 않다", async (_label, rel) => {
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(new URL(`../../../${rel}`, import.meta.url), "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");

    // 인라인 정의가 되살아나면(복붙 회귀) 여기서 잡는다.
    expect(code).not.toMatch(/galleryImages:\s*z\s*\n?\s*\.array/);
  });
});
