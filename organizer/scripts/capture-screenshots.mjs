import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: "http://localhost:3013" });
const page = await ctx.newPage();

await page.goto("/login");
await page.fill('input[type="email"]', "organizer@pickket.kr");
await page.fill('input[type="password"]', "pickket1234");
await page.click('button[type="submit"]');
await page.waitForURL(/dashboard|events/, { timeout: 10000 });
console.log("✅ 로그인");

const eventsRes = await page.request.get("/api/events?limit=10&status=live&sort=latest");
const eventsBody = await eventsRes.json();
const eventId = eventsBody.data?.[0]?.id;
const eventSlug = eventsBody.data?.[0]?.slug;
console.log("이벤트:", eventId, eventSlug);

// 빌더
await page.goto("/events/" + eventId + "/seat-map");
await page.waitForTimeout(4000);
await page.screenshot({ path: "/tmp/ss-builder.png", fullPage: true });
console.log("✅ ss-builder.png");

// 시각 빌더 탭
try {
  const tab = page.locator("text=시각 모드").first();
  if (await tab.isVisible({ timeout: 2000 })) {
    await tab.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: "/tmp/ss-visual.png", fullPage: true });
    console.log("✅ ss-visual.png");
  } else {
    console.log("⚠️ 시각 모드 탭 미표시");
  }
} catch(e) { console.log("⚠️ 시각 모드 탭 에러:", e.message); }

// 체크아웃
await page.goto("/e/" + encodeURIComponent(eventSlug) + "/checkout");
await page.waitForTimeout(4000);
await page.screenshot({ path: "/tmp/ss-checkout.png", fullPage: true });
console.log("✅ ss-checkout.png");

await browser.close();
console.log("완료");
