import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 상세 탭 카드가 **다시 갈라지지 않게** 막는다 (2026-07-31 대표 지적).
 *
 * ## 무슨 일이 있었나
 * 같은 상세 이미지인데 탭마다 다르게 보였다 — 장소·주차는 라벨 달린 안내 상자 안에,
 * 행사 소개는 맨몸으로. 원인은 카드 클래스가 `venue-map.tsx` 안에 **인라인으로만** 있었고
 * `page.tsx` 는 그걸 쓰지 않은 것이다.
 *
 * ## 🔴 왜 구조 가드인가
 * 렌더 결과를 스냅샷으로 잡으면 "같은 클래스인가" 는 못 본다 — 양쪽에 같은 문자열을
 * **복제**해도 스냅샷은 통과하고, 다음 사람이 한쪽만 고치면 조용히 다시 갈라진다.
 * 여기서 막아야 하는 것은 모양이 아니라 **출처가 하나인가** 다.
 *
 * ⚠️ 이 가드는 "카드가 예쁜가" 를 증명하지 않는다. 모양은 사람이 화면으로 본다.
 */
const DIR = path.join(process.cwd(), "src/app/(public)/e/[eventSlug]");
const read = (rel: string) => readFileSync(path.join(DIR, rel), "utf8");

/** 카드 클래스 원문 — 이 문자열이 detail-images.tsx 밖에 나타나면 복제다. */
const OUTER_CARD = "rounded-lg border border-border bg-muted p-5";
const INNER_BOX = "rounded-lg border border-border bg-background/40 p-4";

describe("상세 탭 카드는 단일 출처를 쓴다", () => {
  it("카드 클래스는 detail-images.tsx 에만 있다", () => {
    const source = read("_components/detail-images.tsx");
    expect(source).toContain(OUTER_CARD);
    expect(source).toContain(INNER_BOX);
  });

  it.each([
    ["page.tsx", "page.tsx"],
    ["venue-map.tsx", "_components/venue-map.tsx"],
  ])("%s 는 카드 클래스를 인라인으로 복제하지 않는다", (_label, rel) => {
    const source = read(rel);
    expect(
      source.includes(OUTER_CARD),
      `${rel} 에 바깥 카드 클래스가 인라인으로 있다 — DetailSectionCard 를 쓸 것`,
    ).toBe(false);
    expect(
      source.includes(INNER_BOX),
      `${rel} 에 안쪽 상자 클래스가 인라인으로 있다 — DetailImageBox 를 쓸 것`,
    ).toBe(false);
  });

  it.each([
    ["page.tsx", "page.tsx"],
    ["venue-map.tsx", "_components/venue-map.tsx"],
  ])("%s 는 공용 카드 컴포넌트를 import 한다", (_label, rel) => {
    expect(read(rel)).toMatch(/import \{[^}]*DetailSectionCard[^}]*\} from ".*detail-images"/);
  });

  /**
   * 🔴 라벨 텍스트를 지우지 못하게 한다. 이미지 안에 제목이 있어도 검색엔진과 낭독기는
   *    못 읽는다 — `venue-map.tsx` 상단 주석의 근거가 이 두 줄에 걸려 있다.
   */
  it("장소 탭의 두 안내 상자는 텍스트 라벨을 유지한다", () => {
    const source = read("_components/venue-map.tsx");
    expect(source).toContain('label="대중교통 안내"');
    expect(source).toContain('label="주차 안내"');
  });
});
