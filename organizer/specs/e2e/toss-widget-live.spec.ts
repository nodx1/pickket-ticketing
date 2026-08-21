/**
 * 토스 결제위젯 실 렌더 검증 — opt-in (기본 skip).
 *
 * 문서용 공개 위젯키(test_gck_docs_)로 실제 토스 SDK 를 로드해 결제수단 위젯이
 * 렌더되는지 확인한다. 네트워크(js.tosspayments.com) 의존 → RUN_TOSS_LIVE=1 로 실행:
 *   RUN_TOSS_LIVE=1 npx playwright test specs/e2e/toss-widget-live.spec.ts --project=chromium
 */
import { test, expect } from "@playwright/test";

const LIVE = Boolean(process.env.RUN_TOSS_LIVE);
const DOCS_WIDGET_KEY = "test_gck_docs_Ovk5rk1EwkEbP0W43n07xlzm";

test.describe("토스 결제위젯 실 렌더 (opt-in)", () => {
  test.skip(!LIVE, "RUN_TOSS_LIVE=1 로 실행");

  test("문서용 위젯키로 renderPaymentMethods + renderAgreement 렌더", async ({ page }) => {
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<div id="pm"></div><div id="ag"></div>
<script src="https://js.tosspayments.com/v2/standard"></script>
<script>
window.__r = "pending";
setTimeout(async () => {
  try {
    const w = TossPayments("${DOCS_WIDGET_KEY}").widgets({ customerKey: "guest_test_0001" });
    await w.setAmount({ currency: "KRW", value: 30000 });
    await w.renderPaymentMethods({ selector: "#pm", variantKey: "DEFAULT" });
    await w.renderAgreement({ selector: "#ag", variantKey: "AGREEMENT" });
    window.__r = "ok";
  } catch (e) {
    window.__r = "error:" + (e && e.message ? e.message : String(e));
  }
}, 900);
</script></body></html>`;

    await page.goto("data:text/html;charset=utf-8," + encodeURIComponent(html), { waitUntil: "load" });
    await expect
      .poll(async () => page.evaluate(() => (window as unknown as { __r: string }).__r), { timeout: 15_000 })
      .toBe("ok");

    // 위젯이 실제 DOM(iframe 등)을 그렸는지
    const childCount = await page.evaluate(() => document.getElementById("pm")?.childElementCount ?? 0);
    expect(childCount).toBeGreaterThan(0);
  });
});
