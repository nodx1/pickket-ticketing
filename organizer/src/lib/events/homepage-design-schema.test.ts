import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { buildHomepageDesignPatch, homepageDesignSchema } from "./homepage-design-schema";
import {
  DETAIL_CAPTION_MAX,
  DETAIL_IMAGE_MAX,
  DETAIL_SECTION_LABELS,
  DETAIL_SECTION_MAX,
} from "@/lib/public/detail-image";

/** PUT 은 필수 필드가 있어 최소 본문이 필요하다. */
const BASE = { showCountdown: true, showVenueMap: true, showOrganizer: true };

describe("homepageDesignSchema — detailImages", () => {
  it("🔴 상세 이미지가 파싱을 통과해 살아남는다 — strip 되면 저장돼도 값이 사라진다", () => {
    const parsed = homepageDesignSchema.parse({
      ...BASE,
      detailImages: [{ url: "/a.webp", caption: "셔틀버스 안내" }],
    });
    expect(parsed.detailImages).toEqual([{ url: "/a.webp", caption: "셔틀버스 안내" }]);
  });

  it("🔴 디자이너가 저장해도 상세 이미지가 보존된다 — PUT 은 전체 교체다", () => {
    // 디자이너 화면은 GET 값을 통째로 펼쳐 state 에 담고 그대로 PUT 한다.
    // 스키마에 필드가 없으면 바로 이 지점에서 값이 조용히 증발한다.
    const fromServer = { ...BASE, backgroundColor: "#FAFBFF", detailImages: [{ url: "/keep.webp" }] };
    const roundTrip = homepageDesignSchema.parse({ ...fromServer });
    expect(roundTrip.detailImages).toEqual([{ url: "/keep.webp" }]);
  });

  it("🔴 section 이 파싱을 통과해 살아남는다 — strip 되면 섹션 지정이 조용히 사라진다", () => {
    // 어제 갤러리 캡션에서 정확히 이 함정에 빠질 뻔했다(zod 는 모르는 필드를 에러 없이 버린다).
    // 뮤테이션(스키마에서 section 제거)을 돌려보니 **아무 테스트도 안 죽었다** — 그래서 추가한다.
    const parsed = homepageDesignSchema.parse({
      ...BASE,
      detailImages: [{ url: "/a.webp", section: "parking" }],
    });
    expect(parsed.detailImages?.[0].section).toBe("parking");
  });

  it("모르는 section 값은 거부한다 — 오타가 조용히 intro 로 떨어지지 않게", () => {
    expect(() =>
      homepageDesignSchema.parse({ ...BASE, detailImages: [{ url: "/a.webp", section: "unknown" }] }),
    ).toThrow();
  });

  it("section 없이도 통과한다 — 섹션 개념 이전 데이터 호환", () => {
    const parsed = homepageDesignSchema.parse({ ...BASE, detailImages: [{ url: "/a.webp" }] });
    expect(parsed.detailImages?.[0].section).toBeUndefined();
  });

  it("캡션 없이도 통과한다", () => {
    const parsed = homepageDesignSchema.parse({ ...BASE, detailImages: [{ url: "/a.webp" }] });
    expect(parsed.detailImages?.[0].caption).toBeUndefined();
  });

  it("상세 이미지가 아예 없어도 통과한다 — 기존 행사에 회귀가 없어야 한다", () => {
    expect(() => homepageDesignSchema.parse(BASE)).not.toThrow();
  });

  it(`캡션 ${DETAIL_CAPTION_MAX}자 초과는 거부한다`, () => {
    const over = "가".repeat(DETAIL_CAPTION_MAX + 1);
    expect(() =>
      homepageDesignSchema.parse({ ...BASE, detailImages: [{ url: "/a.webp", caption: over }] }),
    ).toThrow();
  });

  it(`${DETAIL_IMAGE_MAX}장을 넘으면 거부한다`, () => {
    const many = Array.from({ length: DETAIL_IMAGE_MAX + 1 }, (_, i) => ({ url: `/${i}.webp` }));
    // 🔴 상한 숫자를 문자열로 하드코딩하지 않는다 — 어제 `/최대 10장/` 으로 박아뒀다가
    //    섹션별 상한 도입으로 8장이 되자 이 테스트만 깨졌다. 상수에서 만든다.
    expect(() => homepageDesignSchema.parse({ ...BASE, detailImages: many })).toThrow(
      new RegExp(`최대 ${DETAIL_IMAGE_MAX}장`),
    );
  });

  it("url 이 없으면 거부한다", () => {
    expect(() =>
      homepageDesignSchema.parse({ ...BASE, detailImages: [{ caption: "설명만" }] }),
    ).toThrow();
  });
});

describe("homepageDesignSchema — 부분 병합(PATCH)", () => {
  it("🔴 partial 은 상세 이미지만 보내는 것을 허용한다 — 설정 화면은 디자인 전체를 모른다", () => {
    const parsed = homepageDesignSchema.partial().parse({ detailImages: [{ url: "/a.webp" }] });
    expect(parsed.detailImages).toHaveLength(1);
    expect(parsed.showCountdown).toBeUndefined();
  });

  it("partial 이어도 값 검증은 그대로다 — 형식이 틀리면 거부", () => {
    expect(() => homepageDesignSchema.partial().parse({ backgroundColor: "red" })).toThrow();
  });

  it("🔴 병합이 기존 키를 지우지 않는다 — 라우트의 { ...current, ...patch } 계약", () => {
    // ⚠️ current 에 sections 를 반드시 넣는다. 처음 이 테스트는 sections 없는 픽스처를 써서
    //    아래 P0(기본값이 기존 값을 덮어쓰는 결함)을 정확히 비껴갔다 — 그린인데 무검증이었다.
    const current = {
      showCountdown: true,
      backgroundColor: "#FAFBFF",
      heroOverlay: false,
      sections: ["organizer", "event"],
    };
    const patch = buildHomepageDesignPatch({ detailImages: [{ url: "/a.webp" }] });
    const merged = { ...current, ...patch };
    expect(merged.backgroundColor).toBe("#FAFBFF");
    expect(merged.heroOverlay).toBe(false);
    expect(merged.sections).toEqual(["organizer", "event"]);
    expect(merged.detailImages).toHaveLength(1);
  });
});

describe("buildHomepageDesignPatch — .default() 가 기존 값을 덮어쓰지 않게", () => {
  it("🔴 요청에 없는 sections 를 패치에 담지 않는다 — zod .default() 가 .partial() 을 뚫는다", () => {
    // 실측: homepageDesignSchema.partial().parse({detailImages:[…]}) 는
    //       sections 를 기본값으로 **채워서** 돌려준다. 그대로 병합하면 기존 값이 날아간다.
    const raw = homepageDesignSchema.partial().parse({ detailImages: [{ url: "/a.webp" }] });
    expect(raw.sections).toBeDefined(); // ← zod 의 실제 동작(이게 결함의 원인)

    const patch = buildHomepageDesignPatch({ detailImages: [{ url: "/a.webp" }] });
    expect(patch.sections).toBeUndefined();
    expect(Object.keys(patch)).toEqual(["detailImages"]);
  });

  it("🔴 상세 이미지를 저장할 때마다 sections 가 리셋되지 않는다 — 매 저장마다 발화하던 결함", () => {
    const current = { sections: ["organizer", "venue"], showCountdown: true };
    const merged = { ...current, ...buildHomepageDesignPatch({ detailImages: [] }) };
    expect(merged.sections).toEqual(["organizer", "venue"]);
  });

  it("명시적으로 보낸 sections 는 정상 반영된다 — 무조건 거르는 게 아니다", () => {
    const patch = buildHomepageDesignPatch({ sections: ["event"] });
    expect(patch.sections).toEqual(["event"]);
  });

  it("여러 키를 함께 보내면 그 키들만 담는다", () => {
    const patch = buildHomepageDesignPatch({ heroOverlay: false, backgroundColor: "#000000" });
    expect(Object.keys(patch).sort()).toEqual(["backgroundColor", "heroOverlay"]);
  });

  it("값 검증은 그대로다 — 형식이 틀리면 거부", () => {
    expect(() => buildHomepageDesignPatch({ backgroundColor: "red" })).toThrow();
  });

  it.each([null, "문자열", 42, ["배열"]])("객체가 아닌 본문은 거부한다 (%s)", (raw) => {
    expect(() => buildHomepageDesignPatch(raw)).toThrow();
  });
});

/**
 * 🔴 배선 검사 — 라우트가 **정말로** 공유 스키마를 쓰는지 소스로 확인한다.
 * 모듈 import 로 참조 동일성을 보는 방식은 이 리포에서 세 번 헛돌았다
 * (모듈 전체를 훑으면 import 문만으로 통과하고, 주석의 이름조차 통과시켰다).
 */
describe("homepage-design 라우트 배선", () => {
  const ROUTE = "src/app/api/events/[eventId]/homepage-design/route.ts";

  async function routeSource() {
    return readFile(new URL(`../../../${ROUTE}`, import.meta.url), "utf8");
  }

  /** 주석만 걷어낸다. **import 는 남긴다** — 남기지 않으면 배선이 끊긴 걸 볼 수가 없다. */
  async function routeCode() {
    const source = await routeSource();
    return source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
  }

  /** 주석·import 를 뺀 본문 — "코드가 실제로 무엇을 호출하는가" 만 본다. */
  async function routeBody() {
    return (await routeCode())
      .split("\n")
      .filter((line) => !line.trim().startsWith("import "))
      .join("\n");
  }

  it("🔴 공유 스키마 모듈을 실제로 import 한다 — 끊기면 로컬 재정의로 갈라진다", async () => {
    // ⚠️ 처음 이 검사는 import 줄을 필터로 날려버려, 참조가 끊겨도 통과했다(적대검수 지적).
    expect(await routeCode()).toMatch(
      /import\s*\{[^}]*homepageDesignSchema[^}]*\}\s*from\s*["']@\/lib\/events\/homepage-design-schema["']/,
    );
  });

  it("PUT 이 공유 스키마로 파싱한다", async () => {
    expect(await routeBody()).toMatch(/homepageDesignSchema\.parse\(/);
  });

  it("🔴 PATCH 가 존재하고 buildHomepageDesignPatch 를 쓴다", async () => {
    const code = await routeBody();
    expect(code).toMatch(/export const PATCH\b/);
    expect(code).toMatch(/buildHomepageDesignPatch\(/);
  });

  it("🔴 PATCH 가 .partial().parse() 를 직접 쓰지 않는다 — .default() 가 기존 값을 덮어쓴다", async () => {
    expect(await routeBody()).not.toMatch(/homepageDesignSchema\.partial\(\)\.parse\(/);
  });

  it("🔴 PATCH 가 기존 값을 읽어 병합한다 — 덮어쓰면 PUT 과 다를 게 없다", async () => {
    const code = await routeBody();
    expect(code).toMatch(/homepage_design\s*\?\?\s*\{\}/);
    expect(code).toMatch(/\{\s*\.\.\.current,\s*\.\.\.patch\s*\}/);
  });

  it("🔴 라우트가 zod 스키마를 로컬로 재정의하지 않았다 — 변수명을 바꿔도 잡는다", async () => {
    // 처음 검사는 `const schema = z.object` 라는 옛 변수명만 찾아서,
    // `const homepageDesignSchema = z.object(...)` 로 재정의하면 그대로 통과했다.
    expect(await routeBody()).not.toMatch(/z\.object\s*\(/);
  });
});

/**
 * 🔴 섹션별 상한 — 총합만 보면 한 섹션이 전부를 먹는다.
 *
 * 실측(2026-07-30): 업로드·저장은 총합만 보고 렌더는 섹션별로 버려서,
 * intro 5장을 저장하면 **저장 성공 + 랜딩 3장**이 됐다. 주최자는 2장이 왜 안 나오는지
 * 알 방법이 없다(편집 화면엔 5장이 보인다).
 */
describe("detailImages 섹션별 상한", () => {
  const img = (section: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({ url: `/i${section}${i}.webp`, section }));

  it.each([
    ["intro", DETAIL_SECTION_MAX.intro],
    ["transport", DETAIL_SECTION_MAX.transport],
    ["parking", DETAIL_SECTION_MAX.parking],
    ["contact", DETAIL_SECTION_MAX.contact],
  ])("%s 는 상한(%i)까지 통과한다", (section, max) => {
    expect(() => homepageDesignSchema.parse({ ...BASE, detailImages: img(section, max) })).not.toThrow();
  });

  it.each([
    ["intro", DETAIL_SECTION_MAX.intro + 1],
    ["transport", DETAIL_SECTION_MAX.transport + 1],
    ["parking", DETAIL_SECTION_MAX.parking + 1],
    ["contact", DETAIL_SECTION_MAX.contact + 1],
  ])("🔴 %s 가 상한을 넘으면 거부한다 (%i장)", (section, n) => {
    expect(() => homepageDesignSchema.parse({ ...BASE, detailImages: img(section, n) })).toThrow();
  });

  it("섹션을 섞어 총합을 채우는 것은 통과한다 — 총합 상한과 별개다", () => {
    const mixed = [
      ...img("intro", DETAIL_SECTION_MAX.intro),
      ...img("transport", DETAIL_SECTION_MAX.transport),
      ...img("parking", DETAIL_SECTION_MAX.parking),
      ...img("contact", DETAIL_SECTION_MAX.contact),
    ];
    expect(mixed).toHaveLength(DETAIL_IMAGE_MAX);
    expect(() => homepageDesignSchema.parse({ ...BASE, detailImages: mixed })).not.toThrow();
  });

  /**
   * ⚠️ 여기서 "거부되는가" 만 보면 부족하다 — 폴백을 transport 로 바꿔도 그 상한(2)에
   *    걸려 똑같이 거부되므로 **뮤테이션이 살아남는다**(실제로 그랬다).
   *    어느 섹션으로 세어졌는지는 **문구**로만 드러난다.
   */
  it("🔴 section 미지정은 **intro** 로 세어진다 — 옛 데이터가 상한을 우회하면 안 된다", () => {
    const legacy = Array.from({ length: DETAIL_SECTION_MAX.intro + 1 }, (_, i) => ({
      url: `/legacy${i}.webp`,
    }));
    try {
      homepageDesignSchema.parse({ ...BASE, detailImages: legacy });
      throw new Error("통과하면 안 된다");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain(DETAIL_SECTION_LABELS.intro);
      expect(message).toContain(String(DETAIL_SECTION_MAX.intro));
      // 다른 섹션으로 세어졌으면 그 이름이 나온다 — 폴백이 바뀌면 여기서 죽는다.
      expect(message).not.toContain(DETAIL_SECTION_LABELS.transport);
    }
  });

  it("intro 상한 이하의 옛 데이터(section 없음)는 통과한다", () => {
    const legacy = Array.from({ length: DETAIL_SECTION_MAX.intro }, (_, i) => ({
      url: `/ok${i}.webp`,
    }));
    expect(() => homepageDesignSchema.parse({ ...BASE, detailImages: legacy })).not.toThrow();
  });

  it("거부 문구에 섹션 이름과 상한이 들어간다 — 주최자가 무엇을 줄일지 알아야 한다", () => {
    try {
      homepageDesignSchema.parse({ ...BASE, detailImages: img("parking", DETAIL_SECTION_MAX.parking + 1) });
      throw new Error("통과하면 안 된다");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain(DETAIL_SECTION_LABELS.parking);
      expect(message).toContain(String(DETAIL_SECTION_MAX.parking));
    }
  });
});
