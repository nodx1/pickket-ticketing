import { describe, expect, it } from "vitest";

import {
  appendToSection,
  countInSection,
  indicesOfSection,
  moveWithinSection,
  remainingSlots,
  type SectionedImage,
} from "./detail-image-order";
import { DETAIL_SECTION_MAX } from "@/lib/public/detail-image";

/** `a1` = intro 1번 … 라벨로 순서를 눈으로 확인한다. */
function img(section: SectionedImage["section"], n: number): SectionedImage {
  return { url: `/${section ?? "none"}${n}.webp`, section };
}
const urls = (items: readonly SectionedImage[]) => items.map((i) => i.url);

describe("indicesOfSection / countInSection", () => {
  const items = [img("intro", 1), img("parking", 1), img("intro", 2), img("transport", 1)];

  it("평평한 배열에서 그 섹션의 인덱스를 순서대로 뽑는다", () => {
    expect(indicesOfSection(items, "intro")).toEqual([0, 2]);
    expect(indicesOfSection(items, "parking")).toEqual([1]);
    expect(indicesOfSection(items, "contact")).toEqual([]);
  });

  it("🔴 section 미지정은 intro 로 센다 — 옛 데이터가 어디에도 안 세어지면 상한이 뚫린다", () => {
    const legacy = [img(undefined, 1), img("intro", 1)];
    expect(countInSection(legacy, "intro")).toBe(2);
    expect(countInSection(legacy, "transport")).toBe(0);
  });
});

describe("remainingSlots", () => {
  it("빈 상태에서는 섹션 상한만큼", () => {
    expect(remainingSlots([], "intro")).toBe(DETAIL_SECTION_MAX.intro);
    expect(remainingSlots([], "contact")).toBe(DETAIL_SECTION_MAX.contact);
  });

  it("가득 차면 0 — 추가 버튼을 감추는 근거다", () => {
    const full = Array.from({ length: DETAIL_SECTION_MAX.parking }, (_, i) => img("parking", i));
    expect(remainingSlots(full, "parking")).toBe(0);
  });

  it("🔴 다른 섹션이 차 있어도 이 섹션의 잔여는 줄지 않는다 — 총합이 아니라 섹션별이다", () => {
    const introFull = Array.from({ length: DETAIL_SECTION_MAX.intro }, (_, i) => img("intro", i));
    expect(remainingSlots(introFull, "parking")).toBe(DETAIL_SECTION_MAX.parking);
  });
});

describe("moveWithinSection", () => {
  /**
   * 🔴 이 배치의 핵심. 종전 구현은 전체 배열을 스왑해서 섹션 경계를 넘으면
   *    **화면은 그대로인데 dirty 만 켜졌다.**
   */
  const items = [img("intro", 1), img("parking", 1), img("intro", 2), img("intro", 3)];

  it("같은 섹션의 이웃과 자리를 바꾼다 — 사이에 다른 섹션이 끼어 있어도", () => {
    // intro1(0) 을 아래로 → 같은 섹션의 다음은 intro2(2). parking1(1) 은 건너뛴다.
    const next = moveWithinSection(items, 0, 1);
    expect(next).not.toBeNull();
    expect(urls(next!)).toEqual(["/intro2.webp", "/parking1.webp", "/intro1.webp", "/intro3.webp"]);
  });

  it("위로도 같은 규칙", () => {
    const next = moveWithinSection(items, 2, -1);
    expect(urls(next!)).toEqual(["/intro2.webp", "/parking1.webp", "/intro1.webp", "/intro3.webp"]);
  });

  it("🔴 그룹의 처음에서 위로는 null — 섹션 경계를 넘지 않는다", () => {
    expect(moveWithinSection(items, 0, -1)).toBeNull();
  });

  it("🔴 그룹의 끝에서 아래로는 null", () => {
    expect(moveWithinSection(items, 3, 1)).toBeNull();
  });

  it("🔴 그룹에 혼자면 어느 쪽도 null — 무의미한 dirty 가 생기면 안 된다", () => {
    expect(moveWithinSection(items, 1, -1)).toBeNull();
    expect(moveWithinSection(items, 1, 1)).toBeNull();
  });

  it("다른 섹션의 순서는 건드리지 않는다", () => {
    const next = moveWithinSection(items, 0, 1)!;
    expect(next[1].url).toBe("/parking1.webp"); // 제자리
  });

  it("범위 밖 인덱스는 null", () => {
    expect(moveWithinSection(items, 99, 1)).toBeNull();
    expect(moveWithinSection(items, -1, 1)).toBeNull();
  });
});

describe("appendToSection", () => {
  it("누른 그룹의 섹션으로 들어간다 — 기본값(intro) 개념이 없다", () => {
    const { next, accepted, dropped } = appendToSection([], "parking", [{ url: "/new.webp" }]);
    expect(accepted).toBe(1);
    expect(dropped).toBe(0);
    expect(next[0].section).toBe("parking");
  });

  it("🔴 그 섹션의 잔여만큼만 받고 나머지는 버린 수를 돌려준다", () => {
    const existing = Array.from({ length: DETAIL_SECTION_MAX.parking - 1 }, (_, i) =>
      img("parking", i),
    );
    const uploaded = [{ url: "/a.webp" }, { url: "/b.webp" }, { url: "/c.webp" }];
    const { next, accepted, dropped } = appendToSection(existing, "parking", uploaded);
    expect(accepted).toBe(1);
    expect(dropped).toBe(2);
    expect(countInSection(next, "parking")).toBe(DETAIL_SECTION_MAX.parking);
  });

  it("가득 찬 섹션에는 하나도 안 들어간다", () => {
    const full = Array.from({ length: DETAIL_SECTION_MAX.contact }, (_, i) => img("contact", i));
    const { next, accepted, dropped } = appendToSection(full, "contact", [{ url: "/x.webp" }]);
    expect(accepted).toBe(0);
    expect(dropped).toBe(1);
    expect(next).toHaveLength(full.length);
  });

  it("caption 을 보존한다", () => {
    const { next } = appendToSection([], "intro", [{ url: "/a.webp", caption: "약도" }]);
    expect(next[0]).toEqual({ url: "/a.webp", caption: "약도", section: "intro" });
  });
});
