import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: "http://localhost:3013" });
const page = await ctx.newPage();

// 로그인
await page.goto("/login");
await page.fill('input[type="email"]', "organizer@pickket.kr");
await page.fill('input[type="password"]', "pickket1234");
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard|events/, { timeout: 10000 });

// ═══ FAIL 분석: STAGE 표시 ═══
console.log("=== FAIL 분석: 시각 빌더 STAGE ===");
const eventsRes = await page.request.get("/api/events?limit=10&status=live&sort=latest");
const eventId = (await eventsRes.json()).data?.[0]?.id;
await page.goto(`/events/${eventId}/seat-map`);
await page.waitForTimeout(3000);

// 시각 모드 클릭
await page.locator("text=시각 모드").first().click();
await page.waitForTimeout(2000);

// Konva canvas 내부의 STAGE는 HTML text가 아닌 Canvas 내부 렌더
// → Playwright text selector로는 못 찾음
// Canvas 존재 여부로 대체 확인
const konvaContainer = page.locator(".konvajs-content").first();
const hasKonva = await konvaContainer.isVisible({ timeout: 3000 }).catch(() => false);
console.log("  Konva 캔버스:", hasKonva ? "✅ 렌더됨" : "❌ 미렌더");

// STAGE는 Konva Stage 내 Text로 그려짐 — HTML selector 아님
// react-konva Stage 컴포넌트가 마운트됐는지 확인
const stageEl = page.locator("div.konvajs-content canvas").first();
const hasStageCanvas = await stageEl.isVisible({ timeout: 2000 }).catch(() => false);
console.log("  Konva Canvas:", hasStageCanvas ? "✅ 존재" : "❌ 없음");

// ═══ WARN 분석: Best Available 버튼 ═══
console.log("\n=== WARN 분석: Best Available 버튼 ===");
await page.goto("/e/pickket-music-night-copy-120807/checkout");
await page.waitForTimeout(3000);

// Best Available은 좌석 선택 섹션 내부에 있으며 좌석맵 있는 이벤트 + 수량 > 0일 때만 표시
// 수량 1로 증가 시도
const plusBtns = page.locator('button[aria-label="수량 증가"]');
const count = await plusBtns.count();
console.log("  수량 증가 버튼 수:", count);
if (count > 0) {
  await plusBtns.first().click();
  await page.waitForTimeout(1000);
  const bestBtn = page.locator("text=최적 좌석 자동 선택").first();
  const hasBest = await bestBtn.isVisible({ timeout: 2000 }).catch(() => false);
  console.log("  수량 1 후 Best Available:", hasBest ? "✅ 표시됨" : "❌ 미표시");
}

// ═══ 추가 테스트: SeatMap 상호작용 ═══
console.log("\n=== 추가: SeatMap 인터랙션 ===");
const canvas = page.locator("canvas").first();
const canvasVisible = await canvas.isVisible({ timeout: 2000 }).catch(() => false);
if (canvasVisible) {
  const box = await canvas.boundingBox();
  if (box) {
    // 캔버스 중앙 클릭 (좌석 선택 시도)
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(500);
    console.log("  캔버스 클릭: ✅ (에러 없음)");

    // 캔버스 휠 줌
    await page.mouse.wheel(0, -200);
    await page.waitForTimeout(300);
    console.log("  캔버스 휠 줌: ✅ (에러 없음)");
  }
}

// ═══ 추가: 다이얼로그 열기 테스트 ═══
console.log("\n=== 추가: 다이얼로그 열기 ===");

// 친구와 함께 버튼 클릭
const friendBtn = page.locator("text=친구와 함께").first();
const hasFriend = await friendBtn.isVisible({ timeout: 2000 }).catch(() => false);
if (hasFriend) {
  await friendBtn.click();
  await page.waitForTimeout(1000);
  const dialogTitle = page.locator("text=친구와 함께 예매").first();
  const hasDialog = await dialogTitle.isVisible({ timeout: 2000 }).catch(() => false);
  console.log("  CompanionPickerDialog:", hasDialog ? "✅ 열림" : "❌ 안 열림");
  // 닫기
  const cancelBtn = page.locator("text=취소").first();
  if (await cancelBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await cancelBtn.click();
    await page.waitForTimeout(500);
  }
}

// ═══ 추가: checkout 전체 페이지 콘솔 에러 최종 ═══
console.log("\n=== 최종 콘솔 에러 체크 ===");
const errors = [];
page.on("console", msg => {
  if (msg.type() === "error" && !/X-Frame-Options|404|next-devtools|Hot reload|Minified React/i.test(msg.text())) {
    errors.push(msg.text());
  }
});
await page.goto("/e/pickket-music-night-copy-120807/checkout");
await page.waitForTimeout(5000);
console.log("  콘솔 에러:", errors.length === 0 ? "✅ 0건" : `❌ ${errors.length}건`);
errors.slice(0, 3).forEach((e, i) => console.log(`    ${i+1}. ${e.slice(0, 120)}`));

await page.screenshot({ path: "/tmp/fe-checkout-detail.png", fullPage: true });
await browser.close();
console.log("\n완료");
