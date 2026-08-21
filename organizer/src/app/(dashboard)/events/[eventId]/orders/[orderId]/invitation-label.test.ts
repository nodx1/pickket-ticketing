import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

/**
 * 🔴 화면이 실제로 `isInvitation` 을 보고 갈리는가 (2026-08-04)
 *
 * 서버 배선(`orders.test.ts`)이 값을 올려도, 화면이 그 값을 안 읽으면 아무 일도 안 일어난다.
 * ⚠️ "초대권 이라는 글자가 파일에 있다" 는 아무것도 증명하지 않는다 — 주석에도 있다.
 *    **관계**를 본다: 조건이 `detail.isInvitation === true` 이고, 그 참일 때만 초대권 문구가
 *    나오며, 거짓일 때 `paymentMethodLabel` 로 되돌아가는가.
 */
async function pageBody() {
  const src = await readFile(new URL("./page.tsx", import.meta.url), "utf8");
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/**
 * ⚠️ **계약이 바뀌었다** (2026-08-11). 종전 이 가드는 화면에 박힌 **중첩 삼항**을
 *    정규식으로 못박았다. 그런데 목록에도 같은 판정이 필요해지면서 판정·문구를
 *    `@/lib/orders/issue-source` 로 뺐다 — 화면에 삼항이 없으니 옛 정규식은 깨진다.
 *
 * 🔴 그래서 가드를 **지우지 않고 새 계약으로 바꾼다**: 화면이 판정을 **다시 적지 않고**
 *    공통 함수를 쓰는지. 여기서 조건을 다시 적으면 목록과 갈리고, 그게 이 변경의
 *    이유였다(오늘 v2ErrorCode 가 정확히 그렇게 두 벌로 갈려 죽어 있었다).
 *
 * ⚠️ 이 파일은 **소스 문자열 검사**다 — 되돌리는 커밋을 막는 용도이지 동작 증명이 아니다.
 *    동작은 `lib/orders/issue-source.test.ts`(판정)와
 *    `orders/issue-source-screens.test.tsx`(목록 렌더·문구 일치)가 본다.
 */
describe("주문 상세 화면 — 초대권 분기", () => {
  it("🔴 판정을 화면에 다시 적지 않고 공통 함수를 쓴다", async () => {
    const body = await pageBody();
    expect(body).toMatch(/resolveIssueSource\(\s*\{/);
    expect(body).toMatch(/isInvitation:\s*detail\.isInvitation/);
    expect(body).toMatch(/isManualIssue:\s*detail\.isManualIssue/);
  });

  it("🔴 문구를 화면에 박지 않는다 — 목록과 갈리는 자리다", async () => {
    const body = await pageBody();
    expect(body, "화면이 초대권 문구를 직접 적었다").not.toMatch(/"초대권 \(무료\)"/);
    expect(body, "화면이 수동발권 문구를 직접 적었다").not.toMatch(/"주최자 수동발권"/);
  });

  it("🔴 결제수단 라벨 폴백이 사라지지 않았다 — 실판매 주문의 표시", async () => {
    const body = await pageBody();
    expect(body).toMatch(/paymentMethodLabel\(detail\.paymentMethod/);
    // 실판매 갈래에서만 폴백한다(공통 함수가 "sale" 을 줄 때).
    expect(body).toMatch(/kind\s*===\s*"sale"/);
  });

  it("🔴 느슨한 판정(truthy)으로 새지 않았다 — 판정은 공통 함수 안에 있다", async () => {
    const body = await pageBody();
    expect(body).not.toMatch(/\{detail\.isInvitation\s*\?/);
    expect(body).not.toMatch(/detail\.isManualIssue\s*\?/);
  });
});
