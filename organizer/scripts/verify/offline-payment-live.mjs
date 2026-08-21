/**
 * 배포 후 검증 B·C·D — 무통장입금 선택지·계좌 3줄 실값·기한 문구.
 *
 * ## 🔴 판정 기준
 * "오류 화면이 없다"·"SSR 200" 으로 판정하지 않는다. 그 기준은 2026-07-30 에
 * 결함 2건을 통과시켰다. 여기서는 **화면에 있어야 할 문자열이 실제로 있는지**를 본다.
 *
 * 계좌 안내 블록은 무통장 라디오를 **고른 뒤**에만 렌더된다 ⟹ HTML 만 긁어서는
 * 검증되지 않는다(초기 HTML 엔 없다). 실제로 클릭해야 한다.
 *
 * ## ⚠️ prod 쓰기 없음
 * 결제 **제출 버튼을 누르지 않는다.** 주문은 제출 시점에 생기므로 이 스크립트는
 * prod 에 주문을 만들지 않는다(담기·정보입력·라디오 선택은 sessionStorage 뿐).
 *
 * 사용: SLUG=... node scripts/verify/offline-payment-live.mjs
 */
import { chromium } from "playwright";

const SLUG = process.env.SLUG;
const BASE = process.env.BASE ?? "https://go.pickket.kr";
if (!SLUG) { console.log("  사용법: SLUG=... node scripts/verify/offline-payment-live.mjs"); process.exit(2); }

const EV = `${BASE}/e/${encodeURIComponent(SLUG)}`;
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** 대표 지정 정본 — 이 세 값이 화면에 그대로 나와야 한다. */
const WANT = { bank: "신한은행", account: "140-016-400872", holder: "(주)노드엑스" };
/** 제거됐어야 하는 자리값 — 노출되면 구매자가 남의 계좌로 송금한다. */
const PLACEHOLDER = ["국민은행", "123-456-789012", "예금주: 픽켓", "예금주 픽켓"];

const results = [];
const rec = (id, ok, note) => { results.push({ id, ok, note }); console.log(`  ${ok ? "✅" : "🔴"} ${id} — ${note}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA });
const page = await ctx.newPage();
const errs = [];
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 180)); });
page.on("pageerror", (e) => errs.push("pageerror: " + String(e.message).slice(0, 180)));
const path = () => decodeURIComponent(new URL(page.url()).pathname);

// ── 1. 장바구니 → 수량 +1 ────────────────────────────────────────────────
await page.goto(`${EV}/checkout`, { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(2000);
const guide = page.locator('button[aria-label="가이드 닫기"]');
if (await guide.count().catch(() => 0)) { await guide.first().click().catch(() => {}); await page.waitForTimeout(600); }

let clicked = false;
for (const cand of [page.locator('button[aria-label="수량 증가"]'), page.locator('button[aria-label*="증가"]')]) {
  const n = await cand.count().catch(() => 0);
  for (let i = 0; i < n; i++) {
    const el = cand.nth(i);
    if (await el.isVisible().catch(() => false) && await el.isEnabled().catch(() => false)) {
      await el.click().catch(() => {}); await page.waitForTimeout(700); clicked = true; break;
    }
  }
  if (clicked) break;
}
if (!clicked) { rec("B0", false, "수량 버튼을 못 찾음 — 이후 검증 불가"); await browser.close(); process.exit(1); }

// ── 2. 정보 입력 ─────────────────────────────────────────────────────────
const nexts = page.locator("button", { hasText: /^다음$/ });
for (let i = 0; i < await nexts.count().catch(() => 0); i++) {
  if (!(await nexts.nth(i).isDisabled().catch(() => true))) {
    await nexts.nth(i).click({ timeout: 8000 }).catch(() => {});
    await page.waitForURL(/\/checkout\/details/, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(1500); break;
  }
}
const fill = async (id, v) => { const el = page.locator(`#${id}`); if (await el.count().catch(() => 0)) await el.fill(v).catch(() => {}); };
await fill("buyer-name", "검증테스트"); await fill("buyer-email", "verify@example.test"); await fill("buyer-phone", "01000000000");
const boxes = page.locator('input[type="checkbox"], button[role="checkbox"]');
for (let i = 0; i < await boxes.count().catch(() => 0); i++) {
  const b = boxes.nth(i);
  if (await b.isVisible().catch(() => false)) await b.check({ force: true }).catch(() => b.click().catch(() => {}));
}
await page.waitForTimeout(500);

// ── 3. 결제 단계 ─────────────────────────────────────────────────────────
const pays = page.locator("button", { hasText: /결제|^다음$|계속|진행/ });
for (let i = 0; i < await pays.count().catch(() => 0); i++) {
  if (!(await pays.nth(i).isDisabled().catch(() => true))) {
    await pays.nth(i).click({ timeout: 8000 }).catch(() => {});
    await page.waitForURL(/\/checkout\/payment/, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(2500); break;
  }
}
const onPay = path().endsWith("/checkout/payment");
rec("A", onPay, `결제 페이지 머묾=${onPay} · ${path().split("/checkout")[1] || "?"}`);
if (!onPay) { await browser.close(); process.exit(1); }

// ── B. 무통장 선택지가 보이는가 ──────────────────────────────────────────
const offlineLabel = page.locator("label", { hasText: "무통장입금" });
const hasOffline = (await offlineLabel.count().catch(() => 0)) > 0;
rec("B", hasOffline, hasOffline ? "무통장입금 선택지 존재" : "선택지 없음 — fail-closed 가 걸렸다(계좌 정본 미적용)");
if (!hasOffline) {
  const body = (await page.textContent("body").catch(() => "")) || "";
  console.log("     결제수단 영역 텍스트:", body.replace(/\s+/g, " ").slice(0, 300));
  await browser.close(); process.exit(1);
}

// ── C·D. 선택 후 계좌 3줄 + 기한 문구 ────────────────────────────────────
await offlineLabel.first().click().catch(() => {});
await page.waitForTimeout(1200);
const body = ((await page.textContent("body").catch(() => "")) || "").replace(/\s+/g, " ");

rec("C1", body.includes(WANT.bank), `은행명 "${WANT.bank}" ${body.includes(WANT.bank) ? "표시" : "없음"}`);
rec("C2", body.includes(WANT.account), `계좌번호 "${WANT.account}" ${body.includes(WANT.account) ? "표시" : "없음"}`);
rec("C3", body.includes(WANT.holder), `예금주 "${WANT.holder}" ${body.includes(WANT.holder) ? "표시" : "없음"}`);
const dash = /은행명:\s*-|계좌번호:\s*-|예금주:\s*-/.test(body);
rec("C4", !dash, dash ? "계좌 칸에 '-' 가 있다 — bankInfo.ok=false" : "계좌 칸에 빈칸·'-' 없음");
const leaked = PLACEHOLDER.filter((p) => body.includes(p));
rec("C5", leaked.length === 0, leaked.length ? `🔴 자리값 노출: ${leaked.join(", ")}` : "자리값 계좌 노출 0건");

rec("D1", body.includes("1일(24시간)"), `기한 문구 "1일(24시간)" ${body.includes("1일(24시간)") ? "표시" : "없음"}`);
const old3 = body.includes("3일 이내") || body.includes("결제일로부터 3일");
rec("D2", !old3, old3 ? "🔴 옛 '3일' 문구가 남아있다" : "옛 3일 문구 없음");

const r185 = errs.filter((e) => e.includes("185") || e.includes("Maximum update depth"));
rec("E", r185.length === 0, `React #185/무한루프 콘솔에러 ${r185.length}건`);

await browser.close();
const failed = results.filter((r) => !r.ok);
console.log("");
console.log(`  ${failed.length === 0 ? "✅" : "🔴"} ${results.length - failed.length}/${results.length} 통과${failed.length ? " — 실패: " + failed.map((f) => f.id).join(", ") : ""}`);
if (errs.length) console.log(`     콘솔에러 ${errs.length}건: ${[...new Set(errs)].slice(0, 3).join(" / ").slice(0, 220)}`);
console.log("  ⚠️ 결제 제출 버튼은 누르지 않았다 — prod 주문 미생성");
if (failed.length) process.exitCode = 1;
