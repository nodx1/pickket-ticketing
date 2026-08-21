/**
 * V1-1 강화 — **씨딩 없이 실제 UI 클릭**으로 결제 페이지까지 간다.
 *
 * 왜: 앞선 5/5 는 sessionStorage 를 직접 심어 만든 조건이다. 씨딩 모양이 실제와
 * 어긋나 있으면(예: 필드 누락) 결함 자리를 비껴갈 수 있다 — 오늘 이미 한 번 그랬다.
 * 실제 사용자 경로로 도달하면 그 의심이 사라진다.
 *
 * ⚠️ prod 쓰기 없음 — 결제 **제출 버튼은 누르지 않는다.** 주문은 제출 시점에 생긴다.
 */
import { chromium } from "playwright";

const SLUG = process.env.SLUG;
const BASE = "https://go.pickket.kr";
const EV = `${BASE}/e/${encodeURIComponent(SLUG)}`;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA });
const page = await ctx.newPage();
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 180)); });
page.on("pageerror", (e) => errs.push("pageerror: " + String(e.message).slice(0, 180)));

const path = () => decodeURIComponent(new URL(page.url()).pathname);
const step = (n, s) => console.log(`  ${n}. ${s}`);

await page.goto(`${EV}/checkout`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2000);
step(1, `장바구니 진입 · ${path().split("/checkout")[1] || "/(장바구니)"}`);

// 첫 방문 오버레이("좌석 시스템 사용 가이드")가 클릭을 가로챈다 — 닫는다.
const guide = page.locator('button[aria-label="가이드 닫기"]');
if (await guide.count().catch(() => 0)) {
  await guide.first().click().catch(() => {});
  await page.waitForTimeout(600);
  step("1b", "가이드 오버레이 닫음");
}

// ── 수량 증가 버튼을 찾는다(라벨/aria 어느 쪽이든) ─────────────────────
const plusCandidates = [
  page.locator('button[aria-label="수량 증가"]'),
  page.locator('button[aria-label*="증가"]'),
];
let clicked = false;
for (const cand of plusCandidates) {
  const n = await cand.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = cand.nth(i);
    if (await el.isVisible().catch(() => false) && await el.isEnabled().catch(() => false)) {
      await el.click().catch(() => {});
      await page.waitForTimeout(700);
      clicked = true;
      break;
    }
  }
  if (clicked) break;
}
step(2, clicked ? "티켓 수량 +1 클릭" : "🔴 수량 버튼을 못 찾음");
if (!clicked) {
  const btns = await page.locator("button").allTextContents();
  console.log("     버튼 목록:", btns.filter(Boolean).slice(0, 14).map((s) => s.trim().slice(0, 14)).join(" | "));
  await browser.close();
  process.exit(1);
}

// ── 다음 단계 ───────────────────────────────────────────────────────────
// "다음" 이 여러 개다(비활성 CTA + 가이드 캐러셀). **활성화된 것**을 누른다.
const nexts = page.locator("button", { hasText: /^다음$/ });
const nc = await nexts.count().catch(() => 0);
for (let i = 0; i < nc; i++) {
  if (!(await nexts.nth(i).isDisabled().catch(() => true))) {
    await nexts.nth(i).click({ timeout: 8000 }).catch(() => {});
    await page.waitForURL(/\/checkout\/details/, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500);
    break;
  }
}
step(3, `정보 입력 단계로 · ${path().split("/checkout")[1] || "?"}`);
if (!path().includes("/details")) {
  const btns = await page.locator("button").allTextContents();
  console.log("     버튼 목록:", btns.filter(Boolean).slice(0, 14).map((s) => s.trim().slice(0, 14)).join(" | "));
  await browser.close();
  process.exit(1);
}

// ── 구매자 정보 입력 ────────────────────────────────────────────────────
const fill = async (id, value) => {
  const el = page.locator(`#${id}`);
  if (await el.count().catch(() => 0)) await el.fill(value).catch(() => {});
};
await fill("buyer-name", "검증테스트");
await fill("buyer-email", "verify@example.test");
await fill("buyer-phone", "01000000000");
await page.waitForTimeout(500);
step(4, "이름·이메일·연락처 입력");

// 필수 동의 체크박스가 있으면 모두 체크
const boxes = page.locator('input[type="checkbox"], button[role="checkbox"]');
const bn = await boxes.count().catch(() => 0);
for (let i = 0; i < bn; i++) {
  const b = boxes.nth(i);
  if (await b.isVisible().catch(() => false)) await b.check({ force: true }).catch(() => b.click().catch(() => {}));
}
step(5, `동의 항목 ${bn}개 처리`);

// ── 결제 단계로 ─────────────────────────────────────────────────────────
const pays = page.locator("button", { hasText: /결제|^다음$|계속|진행/ });
const pc = await pays.count().catch(() => 0);
for (let i = 0; i < pc; i++) {
  if (!(await pays.nth(i).isDisabled().catch(() => true))) {
    await pays.nth(i).click({ timeout: 8000 }).catch(() => {});
    await page.waitForURL(/\/checkout\/payment/, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500);
    break;
  }
}
const onPay = path().endsWith("/checkout/payment");
step(6, `결제 단계 · ${path().split("/checkout")[1] || "?"} · 머묾=${onPay}`);

let refreshOk = 0;
if (onPay) {
  // 실제 경로로 도달한 상태에서 새로고침 5회 — 씨딩본과 같은 결론이 나오는지 본다.
  for (let i = 0; i < 5; i++) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1500);
    if (path().endsWith("/checkout/payment")) refreshOk++;
  }
  step(7, `실경로 상태에서 새로고침 머묾 ${refreshOk}/5`);
}

const body = (await page.textContent("body").catch(() => "")) || "";
const errScreen = body.includes("오류 발생") || body.includes("페이지를 불러올 수 없습니다");
const r185 = errs.filter((e) => e.includes("185") || e.includes("Maximum update depth"));

await browser.close();

console.log("");
const pass = onPay && refreshOk === 5 && !errScreen && r185.length === 0;
console.log(`  ${pass ? "✅" : "🔴"} 실 UI 경로: 결제 도달=${onPay} · 새로고침 ${refreshOk}/5 · 오류화면=${errScreen} · #185=${r185.length}`);
if (errs.length) console.log(`     콘솔에러 ${errs.length}건: ${[...new Set(errs)].slice(0, 3).join(" / ").slice(0, 200)}`);
console.log("  ⚠️ 결제 제출 버튼은 누르지 않았다 — prod 주문 미생성");
if (!pass) process.exitCode = 1;
