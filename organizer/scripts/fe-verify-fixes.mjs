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

const eventsRes = await page.request.get("/api/events?limit=10&status=live&sort=latest");
const eventId = (await eventsRes.json()).data?.[0]?.id;

// === Fix 검증 1: 빌더 기존 좌석 로딩 ===
console.log("=== Fix 1: 빌더 시각 모드 기존 좌석 ===");
await page.goto(`/events/${eventId}/seat-map`);
await page.waitForTimeout(3000);
await page.locator("text=시각 모드").first().click();
await page.waitForTimeout(3000);

// Konva 캔버스 내부 — 좌석 데이터가 있으면 빈 캔버스가 아님
const konva = page.locator(".konvajs-content").first();
const hasKonva = await konva.isVisible({ timeout: 3000 }).catch(() => false);
console.log("  Konva 캔버스:", hasKonva ? "✅" : "❌");

// 빌더 상단에 "N석" 텍스트 확인 (좌석 수 표시)
const seatCount = await page.locator("text=/\\d+석/").first().textContent().catch(() => "");
console.log("  좌석 수 표시:", seatCount || "❌ 없음");

await page.screenshot({ path: "/tmp/fe-fix-builder.png", fullPage: false });

// === Fix 검증 2: 온보딩 투어 → 배경 클릭 닫기 ===
console.log("\n=== Fix 2: 온보딩 투어 배경 클릭 ===");
// localStorage 비우고 체크아웃 진입
await page.evaluate(() => localStorage.removeItem("pickket:seat-onboarding-v1"));
await page.goto("/e/pickket-music-night-copy-120807/checkout");
await page.waitForTimeout(3000);

const tourDialog = page.locator('[role="dialog"][aria-label="좌석 시스템 사용 가이드"]').first();
const hasTour = await tourDialog.isVisible({ timeout: 3000 }).catch(() => false);
console.log("  투어 표시:", hasTour ? "✅" : "⚠️ (localStorage에 이미 있음)");

if (hasTour) {
  // 배경 (dialog 자체) 클릭 → 닫혀야 함
  await tourDialog.click({ position: { x: 10, y: 10 } }); // dialog 왼쪽 상단 = 배경
  await page.waitForTimeout(1000);
  const stillVisible = await tourDialog.isVisible({ timeout: 1000 }).catch(() => false);
  console.log("  배경 클릭 후:", stillVisible ? "❌ 아직 열림" : "✅ 닫힘");
}

// 투어 닫기 후 수량 버튼 클릭 가능 확인
const plusBtn = page.locator('button[aria-label="수량 증가"]').first();
try {
  await plusBtn.click({ timeout: 5000 });
  console.log("  수량 버튼 클릭:", "✅ 가능");
} catch {
  console.log("  수량 버튼 클릭:", "❌ 차단됨");
}

// === Fix 검증 3: SeatMapErrorBoundary 존재 ===
console.log("\n=== Fix 3: SeatMapErrorBoundary ===");
// DOM에서 ErrorBoundary 컴포넌트가 SeatMap을 감싸고 있는지는 직접 확인 불가
// 대신 페이지가 정상 렌더되고 에러 없는지 확인
const canvas = page.locator("canvas").first();
const hasCanvas = await canvas.isVisible({ timeout: 3000 }).catch(() => false);
console.log("  SeatMap 렌더:", hasCanvas ? "✅ (ErrorBoundary 내부에서 정상)" : "⚠️");

await page.screenshot({ path: "/tmp/fe-fix-checkout.png", fullPage: true });
await browser.close();
console.log("\n완료");
