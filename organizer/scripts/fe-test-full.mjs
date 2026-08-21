import { chromium } from "playwright";

const results = [];
function log(category, test, status, detail = "") {
  const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "⚠️";
  results.push({ category, test, status, detail });
  console.log(`  ${icon} [${category}] ${test}${detail ? " — " + detail : ""}`);
}

const browser = await chromium.launch({ headless: true });

// ─── 데스크탑 테스트 ───
const desktop = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  baseURL: "http://localhost:3013",
});
const page = await desktop.newPage();

// 콘솔 에러 수집
const consoleErrors = [];
page.on("console", msg => {
  if (msg.type() === "error") {
    const text = msg.text();
    // 무시할 패턴
    if (/X-Frame-Options|404|next-devtools|Hot reload|Minified React/i.test(text)) return;
    consoleErrors.push(text);
  }
});

// 로그인
await page.goto("/login");
await page.fill('input[type="email"]', "organizer@pickket.kr");
await page.fill('input[type="password"]', "pickket1234");
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard|events/, { timeout: 10000 });
log("AUTH", "로그인", "PASS");

// 이벤트 ID/slug 확보
const eventsRes = await page.request.get("/api/events?limit=10&status=live&sort=latest");
const eventsBody = await eventsRes.json();
const eventId = eventsBody.data?.[0]?.id;
const eventSlug = eventsBody.data?.[0]?.slug;
log("DATA", "라이브 이벤트 확보", eventId ? "PASS" : "FAIL", eventId?.slice(0, 8));

// ═══════════════════════════════════════════
// 1. 빌더 페이지
// ═══════════════════════════════════════════
console.log("\n=== 1. 빌더 페이지 ===");
await page.goto(`/events/${eventId}/seat-map`);
await page.waitForTimeout(3000);

// 1.1 페이지 렌더링
const builderTitle = await page.locator("h2").first().textContent();
log("BUILDER", "페이지 렌더링", builderTitle?.includes("좌석") ? "PASS" : "WARN", builderTitle?.slice(0, 20));

// 1.2 격자 모드 / 시각 모드 탭
const gridTab = page.locator("text=격자 모드").first();
const visualTab = page.locator("text=시각 모드").first();
const hasGridTab = await gridTab.isVisible({ timeout: 2000 }).catch(() => false);
const hasVisualTab = await visualTab.isVisible({ timeout: 2000 }).catch(() => false);
log("BUILDER", "격자 모드 탭", hasGridTab ? "PASS" : "FAIL");
log("BUILDER", "시각 모드 탭", hasVisualTab ? "PASS" : "FAIL");

// 1.3 시각 빌더 전환
if (hasVisualTab) {
  await visualTab.click();
  await page.waitForTimeout(2000);

  // AI/SVG/Wizard 버튼 3개
  const aiBtn = page.locator("text=AI 도면").first();
  const svgBtn = page.locator("text=SVG 가져오기").first();
  const wizardBtn = page.locator("text=행/열 wizard").first();
  const hasAi = await aiBtn.isVisible({ timeout: 2000 }).catch(() => false);
  const hasSvg = await svgBtn.isVisible({ timeout: 2000 }).catch(() => false);
  const hasWizard = await wizardBtn.isVisible({ timeout: 2000 }).catch(() => false);
  log("BUILDER", "AI 도면 버튼", hasAi ? "PASS" : "FAIL");
  log("BUILDER", "SVG 가져오기 버튼", hasSvg ? "PASS" : "FAIL");
  log("BUILDER", "행/열 wizard 버튼", hasWizard ? "PASS" : "FAIL");

  // STAGE 표시
  const hasStage = await page.locator("text=STAGE").first().isVisible({ timeout: 2000 }).catch(() => false);
  log("BUILDER", "STAGE 표시", hasStage ? "PASS" : "FAIL");

  // Undo/Redo 버튼
  const hasUndo = await page.locator("text=Undo").first().isVisible({ timeout: 2000 }).catch(() => false);
  const hasRedo = await page.locator("text=Redo").first().isVisible({ timeout: 2000 }).catch(() => false);
  log("BUILDER", "Undo 버튼", hasUndo ? "PASS" : "FAIL");
  log("BUILDER", "Redo 버튼", hasRedo ? "PASS" : "FAIL");

  // 복사/붙여넣기/스냅
  const hasCopy = await page.locator("text=복사").first().isVisible({ timeout: 2000 }).catch(() => false);
  const hasPaste = await page.locator("text=붙여넣기").first().isVisible({ timeout: 2000 }).catch(() => false);
  const hasSnap = await page.locator("text=격자 스냅").first().isVisible({ timeout: 2000 }).catch(() => false);
  log("BUILDER", "복사 버튼", hasCopy ? "PASS" : "FAIL");
  log("BUILDER", "붙여넣기 버튼", hasPaste ? "PASS" : "FAIL");
  log("BUILDER", "격자 스냅 토글", hasSnap ? "PASS" : "FAIL");

  await page.screenshot({ path: "/tmp/fe-builder-visual.png", fullPage: false });
  log("BUILDER", "시각 빌더 스크린샷", "PASS");
}

// 1.4 등급 관리 (TierManager)
const tierSection = page.locator("text=좌석 등급").first();
const hasTier = await tierSection.isVisible({ timeout: 2000 }).catch(() => false);
log("BUILDER", "좌석 등급 관리 표시", hasTier ? "PASS" : "WARN");

// ═══════════════════════════════════════════
// 2. 체크아웃 좌석 선택 페이지
// ═══════════════════════════════════════════
console.log("\n=== 2. 체크아웃 좌석 선택 ===");
const encodedSlug = encodeURIComponent(eventSlug);

// 좌석맵 있는 이벤트 시도
const checkoutUrls = [
  `/e/pickket-music-night-copy-120807/checkout`,
  `/e/${encodedSlug}/checkout`,
  `/e/itzy-2026-born-to-be-encore-in-seoul-df97017b/checkout`,
];

let checkoutLoaded = false;
for (const url of checkoutUrls) {
  await page.goto(url);
  await page.waitForTimeout(3000);
  const has404 = await page.locator("text=404").first().isVisible({ timeout: 1000 }).catch(() => false);
  if (!has404) {
    checkoutLoaded = true;
    log("CHECKOUT", "페이지 로드", "PASS", url.slice(0, 40));
    break;
  }
}
if (!checkoutLoaded) {
  log("CHECKOUT", "페이지 로드", "FAIL", "모든 URL 404");
}

if (checkoutLoaded) {
  // 2.1 1단계 · 티켓 선택 표시
  const step1 = await page.locator("text=1단계").first().isVisible({ timeout: 2000 }).catch(() => false);
  log("CHECKOUT", "1단계 · 티켓 선택 표시", step1 ? "PASS" : "FAIL");

  // 2.2 수량 +/- 버튼
  const plusBtn = page.locator('button[aria-label="수량 증가"]').first();
  const hasPlus = await plusBtn.isVisible({ timeout: 2000 }).catch(() => false);
  log("CHECKOUT", "수량 +/- 버튼", hasPlus ? "PASS" : "FAIL");

  // 2.3 좌석 캔버스 (SeatMap)
  const seatCanvas = page.locator("canvas").first();
  const hasCanvas = await seatCanvas.isVisible({ timeout: 2000 }).catch(() => false);
  log("CHECKOUT", "좌석 캔버스 (SeatMap)", hasCanvas ? "PASS" : "WARN", hasCanvas ? "" : "좌석맵 없는 이벤트일 수 있음");

  // 2.4 좌석 선택 섹션 (좌석맵 있는 경우)
  const seatSection = page.locator("text=좌석 선택").first();
  const hasSeatSection = await seatSection.isVisible({ timeout: 2000 }).catch(() => false);
  log("CHECKOUT", "좌석 선택 섹션", hasSeatSection ? "PASS" : "WARN");

  // 2.5 Best Available 버튼
  const bestBtn = page.locator("text=최적 좌석 자동 선택").first();
  const hasBest = await bestBtn.isVisible({ timeout: 2000 }).catch(() => false);
  log("CHECKOUT", "Best Available 버튼", hasSeatSection && hasBest ? "PASS" : "WARN", hasSeatSection ? "" : "좌석 섹션 미표시");

  // 2.6 프로모코드 입력
  const promoInput = page.locator('input[placeholder="프로모코드 입력"]').first();
  const hasPromo = await promoInput.isVisible({ timeout: 2000 }).catch(() => false);
  log("CHECKOUT", "프로모코드 입력", hasPromo ? "PASS" : "FAIL");

  // 2.7 다음 버튼
  const nextBtn = page.locator("text=다음").last();
  const hasNext = await nextBtn.isVisible({ timeout: 2000 }).catch(() => false);
  log("CHECKOUT", "다음 버튼", hasNext ? "PASS" : "FAIL");

  // 2.8 floating 버튼 (친구/비교/관심) — 좌석 선택 섹션 있을 때만
  if (hasSeatSection) {
    const friendBtn = page.locator("text=친구와 함께").first();
    const hasFriend = await friendBtn.isVisible({ timeout: 2000 }).catch(() => false);
    log("CHECKOUT", "친구와 함께 floating 버튼", hasFriend ? "PASS" : "WARN");
  }

  // 2.9 범례 (SeatMapLegend)
  const legend = page.locator("text=선택 가능").first();
  const hasLegend = await legend.isVisible({ timeout: 2000 }).catch(() => false);
  log("CHECKOUT", "좌석 범례 (선택 가능/판매 완료)", hasLegend ? "PASS" : "WARN");

  // 2.10 온보딩 투어 (첫 진입 시 — localStorage 있으면 안 뜸)
  // → 여기서는 localStorage 비우지 않으므로 투어 안 뜰 수 있음
  log("CHECKOUT", "온보딩 투어", "WARN", "localStorage 상태에 따라 표시/미표시");

  await page.screenshot({ path: "/tmp/fe-checkout.png", fullPage: true });
  log("CHECKOUT", "체크아웃 스크린샷", "PASS");
}

// ═══════════════════════════════════════════
// 3. 공개 이벤트 상세 페이지
// ═══════════════════════════════════════════
console.log("\n=== 3. 공개 이벤트 상세 ===");
await page.goto("/e/pickket-music-night-copy-120807");
await page.waitForTimeout(3000);
const eventTitle = await page.locator("h1").first().textContent().catch(() => "");
const hasEventTitle = eventTitle && eventTitle.length > 2;
log("PUBLIC", "이벤트 상세 렌더링", hasEventTitle ? "PASS" : "FAIL", eventTitle?.slice(0, 30));
await page.screenshot({ path: "/tmp/fe-public-event.png", fullPage: false });

// ═══════════════════════════════════════════
// 4. 모바일 반응형 테스트
// ═══════════════════════════════════════════
console.log("\n=== 4. 모바일 반응형 (iPhone 14) ===");
await desktop.close();

const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
  baseURL: "http://localhost:3013",
  isMobile: true,
  hasTouch: true,
});
const mPage = await mobile.newPage();

// 로그인 스킵 — 공개 페이지만 테스트
await mPage.goto("/e/pickket-music-night-copy-120807/checkout");
await mPage.waitForTimeout(4000);
const mobileTitle = await mPage.locator("text=1단계").first().isVisible({ timeout: 3000 }).catch(() => false);
log("MOBILE", "체크아웃 페이지 렌더링", mobileTitle ? "PASS" : "WARN");

// 모바일 좌석 캔버스
const mCanvas = mPage.locator("canvas").first();
const mHasCanvas = await mCanvas.isVisible({ timeout: 2000 }).catch(() => false);
log("MOBILE", "좌석 캔버스 표시", mHasCanvas ? "PASS" : "WARN");

// 모바일 수량 버튼
const mPlus = mPage.locator('button[aria-label="수량 증가"]').first();
const mHasPlus = await mPlus.isVisible({ timeout: 2000 }).catch(() => false);
log("MOBILE", "수량 +/- 버튼", mHasPlus ? "PASS" : "FAIL");

await mPage.screenshot({ path: "/tmp/fe-mobile-checkout.png", fullPage: true });
log("MOBILE", "모바일 체크아웃 스크린샷", "PASS");

// 모바일 이벤트 상세
await mPage.goto("/e/pickket-music-night-copy-120807");
await mPage.waitForTimeout(3000);
await mPage.screenshot({ path: "/tmp/fe-mobile-event.png", fullPage: false });
log("MOBILE", "모바일 이벤트 상세 스크린샷", "PASS");

await mobile.close();

// ═══════════════════════════════════════════
// 5. 콘솔 에러 요약
// ═══════════════════════════════════════════
console.log("\n=== 5. 콘솔 에러 요약 ===");
if (consoleErrors.length === 0) {
  log("CONSOLE", "콘솔 에러", "PASS", "0건");
} else {
  log("CONSOLE", "콘솔 에러", "WARN", `${consoleErrors.length}건`);
  consoleErrors.slice(0, 5).forEach((e, i) => console.log(`    ${i + 1}. ${e.slice(0, 120)}`));
}

// ═══════════════════════════════════════════
// 결과 요약
// ═══════════════════════════════════════════
console.log("\n=== 결과 요약 ===");
const pass = results.filter(r => r.status === "PASS").length;
const fail = results.filter(r => r.status === "FAIL").length;
const warn = results.filter(r => r.status === "WARN").length;
console.log(`PASS: ${pass} | FAIL: ${fail} | WARN: ${warn} | 합계: ${results.length}`);

if (fail > 0) {
  console.log("\n❌ FAIL 항목:");
  results.filter(r => r.status === "FAIL").forEach(r => console.log(`  - [${r.category}] ${r.test}: ${r.detail}`));
}
if (warn > 0) {
  console.log("\n⚠️ WARN 항목:");
  results.filter(r => r.status === "WARN").forEach(r => console.log(`  - [${r.category}] ${r.test}: ${r.detail}`));
}

await browser.close();
