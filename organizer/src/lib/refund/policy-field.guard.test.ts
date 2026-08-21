import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 🔴 공개 상세가 환불 정책을 **올바른 필드명**으로 읽는지 고정한다 (2026-07-31 실사고).
 *
 * ## 무슨 일이 있었나
 * 하드코딩을 걷어내고 DB 값을 읽게 바꿨는데, 필드명을 `cancellationFeeTiers` /
 * `cancellation_fee_tiers` 로 **짐작**했다. 실제 공개 응답은 `cancellationPolicy` 이고
 * 이미 camelCase(`{daysBefore, feePct}`)로 변환돼 온다(`event-view.ts:toGoCancellationPolicy`).
 *
 * 결과: 배열이 **항상 비어** 규정이 있는 행사에 `"환불 규정이 설정되지 않았습니다"` 가 떴다.
 * tsc 는 `as` 캐스팅이라 못 잡았고, 단위 테스트는 순수 함수만 봐서 못 잡았다.
 * **prod 화면을 직접 긁어서** 발견했다.
 *
 * ## 왜 구조 가드인가
 * 순수 함수(`policy-display.ts`)는 입력이 옳다는 전제 위에서만 옳다. **배선이 틀리면
 * 함수가 아무리 맞아도 화면은 빈다.** 여기서 막아야 하는 건 계산이 아니라 **연결**이다.
 * (같은 이유로 IMG-2 도 순수함수 테스트를 통과하면서 배선 뮤테이션 4종이 전부 살아남았다)
 */
const PAGE = path.join(process.cwd(), "src/app/(public)/e/[eventSlug]/page.tsx");

describe("공개 상세는 환불 정책을 실제 응답 필드명으로 읽는다", () => {
  const source = readFileSync(PAGE, "utf8");

  it("🔴 `cancellationPolicy` 를 읽는다 — 이게 실제 공개 응답의 필드명이다", () => {
    expect(
      /\.cancellationPolicy\b/.test(source),
      "공개 응답(/api/public/events/{slug})은 `cancellationPolicy` 로 내려온다. " +
        "필드명을 바꾸려면 실제 응답을 먼저 찍어볼 것.",
    ).toBe(true);
  });

  it.each(["cancellationFeeTiers", "cancellation_fee_tiers"])(
    "존재하지 않는 필드명 `%s` 로 읽지 않는다 — 조용히 빈 배열이 된다",
    (wrong) => {
      expect(
        source.includes(`.${wrong}`),
        `\`${wrong}\` 는 공개 응답에 없다. 읽으면 항상 빈 배열이 되어 ` +
          `규정이 있는 행사에 "설정되지 않았습니다" 가 뜬다.`,
      ).toBe(false);
    },
  );

  it("옛 하드코딩 숫자가 되살아나지 않는다", () => {
    for (const dead of ["D-10 이전", "D-7 이전 <span", "90%</span>"]) {
      expect(source.includes(dead), `하드코딩 잔재: ${dead}`).toBe(false);
    }
  });
});
