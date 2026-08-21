import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 🔴 공개 상세의 **문의 탭에 공유 버튼이 되살아나지 않게** 고정한다 (2026-07-31 대표 지시).
 *
 * ## 왜 뺐나
 * 문의 탭 안에 카카오톡·네이버·X 공유와 링크복사 버튼 넷이 들어 있었다. 두 가지가 문제였다.
 *
 *  1. **성격이 다르다.** 이 탭은 문의 창구이고 앞으로 **리뷰 게시판**이 들어올 자리다.
 *     공유 버튼이 섞이면 무슨 탭인지 흐려진다.
 *  2. **닿지도 않았다.** 라벨이 길어 이 탭이 모바일에서 잘려 있었다(`event-tabs.width.test.ts`).
 *     기능이 있는데 화면 밖이라 아무도 못 눌렀다.
 *
 * 공유 자체를 없앤 게 아니다 — **구매완료 페이지에는 그대로 있다.** 거기가 실제로 공유가
 * 일어나는 지점이다(내가 산 걸 알리는 순간). 상세 페이지의 공유는 눌리지도 않는 장식이었다.
 *
 * ## 왜 구조 가드인가
 * 이건 계산이 아니라 **배치 판단**이다. 단위 테스트가 볼 수 있는 함수가 없다.
 * 나중에 "공유 버튼이 없네" 하고 되돌리는 걸 막을 수 있는 건 이 파일뿐이다.
 */
const DETAIL_PAGE = path.join(process.cwd(), "src/app/(public)/e/[eventSlug]/page.tsx");
const COMPLETE_PAGE = path.join(
  process.cwd(),
  "src/app/(public)/e/[eventSlug]/checkout/complete/page.tsx",
);

describe("공개 상세 문의 탭", () => {
  const detail = readFileSync(DETAIL_PAGE, "utf8");

  it("🔴 공유 버튼을 렌더하지 않는다 — 문의 탭은 문의·리뷰 자리다", () => {
    expect(
      /<ShareButtons/.test(detail),
      "상세 페이지에서 공유 버튼을 뺀 것은 2026-07-31 대표 판단이다. " +
        "되살리려면 먼저 배치를 다시 정할 것(문의 탭 안은 아니다).",
    ).toBe(false);
  });

  it("공유 컴포넌트를 import 하지도 않는다 — 죽은 import 를 남기지 않는다", () => {
    expect(detail.includes("share-buttons")).toBe(false);
  });

  it("구매완료 페이지의 공유는 그대로 산다 — 여기까지 지우면 과잉이다", () => {
    expect(readFileSync(COMPLETE_PAGE, "utf8")).toMatch(/<ShareButtons/);
  });
});
