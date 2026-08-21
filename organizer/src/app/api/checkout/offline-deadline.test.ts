import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

/**
 * 🔴 무통장인데 15분 만에 만료됐다 (2026-08-21 실사고).
 *
 * 주문 생성 시 만료는 `checkout/initiate` 가 정한다. 카드로 시작했다면 15분이 박히고,
 * 손님이 그 뒤 무통장을 고르면 **결제수단만 바뀌고 만료는 그대로**였다.
 * 은행 갈 시간도 없이 만료돼, 입금이 확인돼도 주최자가 승인할 수 없다.
 * 실측: 박희진 19분 · 김지민 15분 · 무통장 만료 9건 225,000원.
 */
async function src() {
  return readFile("src/app/api/checkout/complete/route.ts", "utf8");
}

describe("🔴 무통장 전환 시 입금 기한", () => {
  it("🔴 만료를 다시 잡는다 — 결제수단만 바꾸면 15분짜리로 남는다", async () => {
    const s = await src();
    expect(s, "만료 연장이 없다 — 은행 갈 시간이 없다").toMatch(/expires_at\s*=\s*GREATEST/);
  });

  it("🔴 줄이지 않는다 — 이미 24시간짜리를 덮으면 안 된다", async () => {
    const s = await src();
    const i = s.indexOf("expires_at = GREATEST");
    expect(s.slice(i, i + 200)).toMatch(/COALESCE\(expires_at/);
  });

  it("🔴 안내 문구와 **같은 상수**를 쓴다 — 둘이 갈리면 손님이 속는다", async () => {
    const s = await src();
    expect(s).toMatch(/OFFLINE_PAYMENT_DEADLINE_HOURS/);
    expect(s, "숫자를 손으로 박으면 안내와 어긋난다").not.toMatch(/'24 hours'/);
  });

  it("안내 문구 상수가 24시간이다", async () => {
    const s = await readFile("src/lib/checkout/offline-payment.ts", "utf8");
    expect(s).toMatch(/OFFLINE_PAYMENT_DEADLINE_HOURS\s*=\s*24/);
    expect(s).toMatch(/주문일로부터 1일\(24시간\)/);
  });
});
