import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: "http://localhost:3013" });
const page = await ctx.newPage();

await page.goto("/login");
await page.fill('input[type="email"]', "organizer@pickket.kr");
await page.fill('input[type="password"]', "pickket1234");
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard|events/, { timeout: 10000 });

// 시드 이벤트 중 좌석맵 있는 이벤트의 실제 public 페이지 시도
// pickket-music-night 이벤트가 좌석맵 있음
await page.goto("/e/pickket-music-night-copy-120807/checkout");
await page.waitForTimeout(4000);
await page.screenshot({ path: "/tmp/ss-checkout2.png", fullPage: true });
console.log("✅ ss-checkout2.png (music-night)");

// itzy 이벤트
await page.goto("/e/itzy-2026-born-to-be-encore-in-seoul-df97017b/checkout");
await page.waitForTimeout(4000);
await page.screenshot({ path: "/tmp/ss-checkout3.png", fullPage: true });
console.log("✅ ss-checkout3.png (itzy)");

// KBO 이벤트 public 페이지 (404가 아닌 checkout)
const slug = "2026-신한-sol뱅크-kbo-올스타전-b6503729";
await page.goto("/e/" + encodeURIComponent(slug));
await page.waitForTimeout(3000);
await page.screenshot({ path: "/tmp/ss-public-event.png", fullPage: true });
console.log("✅ ss-public-event.png (KBO 상세)");

await browser.close();
