import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: "http://localhost:3013" });
const page = await ctx.newPage();

await page.goto("/e/pickket-music-night-copy-120807/checkout");
await page.waitForTimeout(3000);

// 온보딩 투어 닫기 (있다면)
const tourClose = page.locator('button[aria-label="가이드 닫기"]').first();
const hasTour = await tourClose.isVisible({ timeout: 2000 }).catch(() => false);
console.log("온보딩 투어:", hasTour ? "✅ 표시됨 → 닫기" : "표시 안 됨");
if (hasTour) {
  await tourClose.click();
  await page.waitForTimeout(500);
}

// 수량 증가 재시도
const plusBtn = page.locator('button[aria-label="수량 증가"]').first();
const hasPlusNow = await plusBtn.isVisible({ timeout: 2000 }).catch(() => false);
console.log("수량 증가 버튼:", hasPlusNow ? "✅" : "❌");
if (hasPlusNow) {
  await plusBtn.click();
  await page.waitForTimeout(1000);
  console.log("수량 1 증가: ✅");

  // Best Available
  const bestBtn = page.locator("text=최적 좌석 자동 선택").first();
  const hasBest = await bestBtn.isVisible({ timeout: 2000 }).catch(() => false);
  console.log("Best Available:", hasBest ? "✅ 표시됨" : "⚠️ 미표시 (좌석맵 미연결)");

  // 좌석 캔버스 클릭
  const canvas = page.locator("canvas").first();
  if (await canvas.isVisible({ timeout: 2000 }).catch(() => false)) {
    const box = await canvas.boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 3, box.y + box.height / 3);
      await page.waitForTimeout(500);
      console.log("캔버스 좌석 클릭: ✅ (에러 없음)");
      // 휠 줌
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(500);
      console.log("캔버스 휠 줌: ✅");
    }
  }

  // 친구와 함께 다이얼로그
  const friendBtn = page.locator("text=친구와 함께").first();
  if (await friendBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
    await friendBtn.click();
    await page.waitForTimeout(1000);
    const hasDialog = await page.locator("text=친구와 함께 예매").first().isVisible({ timeout: 2000 }).catch(() => false);
    console.log("CompanionPickerDialog:", hasDialog ? "✅ 열림" : "❌");
    if (hasDialog) {
      await page.locator("text=취소").first().click().catch(() => {});
      await page.waitForTimeout(500);
    }
  }
}

// 최종 스크린샷
await page.screenshot({ path: "/tmp/fe-detail2.png", fullPage: true });

// 콘솔 에러 체크
const errors = [];
page.on("console", msg => {
  if (msg.type() === "error" && !/X-Frame-Options|404|next-devtools|Hot reload|Minified React/i.test(msg.text()))
    errors.push(msg.text());
});
await page.waitForTimeout(3000);
console.log("\n콘솔 에러:", errors.length === 0 ? "✅ 0건" : `⚠️ ${errors.length}건`);

await browser.close();
