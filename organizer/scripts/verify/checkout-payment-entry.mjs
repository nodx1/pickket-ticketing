/**
 * 결제 진입 검증 — 배포 후 V1 (씨딩 방식, 결정적).
 *
 * ## 🔴 판정 기준
 * **"오류 화면이 없다" 가 아니라 "있어야 할 곳에 있다"** 로 판정한다.
 * 2026-07-30 에 오류화면 기준으로 **4/4 통과**가 나왔고, `머묾` 단언을 넣자
 * **10/10 실패**로 뒤집혔다. 결제 페이지에서 튕기면 문제 코드를 안 거치므로
 * "오류 없음" 이 자동 성립한다 — SSR 200 도 같은 이유로 근거가 아니다.
 *
 * ## ⚠️ prod 쓰기 없음
 * 결제 페이지의 `fetch` 는 전부 제출 핸들러 안이다(`/api/checkout/initiate`·`/complete`).
 * 담기·정보입력·진입은 sessionStorage 뿐 ⟹ 주문이 생기지 않는다.
 * **결제 완료 후 뒤로가기(V1-4)만 실결제가 필요해 여기서 제외**한다.
 *
 * ## 씨딩 주의
 * `eventId` 를 반드시 채운다. 비우면 튕겨 도착한 장바구니가 `resetForEvent` 로
 * 저장값을 비워, "저장값이 없어서 튕겼다" 는 **결과를 원인으로 읽는** 오독이 생긴다.
 * 값은 장바구니 페이지가 스스로 써 넣는 것을 읽어 쓴다(DB 불필요).
 *
 * ## 사용
 *   SLUG="<이벤트 슬러그>" PRODUCT_ID="<seat_tier id>" \
 *     node scripts/verify/checkout-payment-entry.mjs
 *   BASE 를 넘기면 대상 호스트를 바꿀 수 있다(기본 https://go.pickket.kr).
 *
 * 실 UI 클릭 경로 검증은 `checkout-payment-entry-realui.mjs` 가 담당한다(씨딩 없음).
 */
import { chromium } from "playwright";

const SLUG = process.env.SLUG;
const PID = process.env.PRODUCT_ID;
const BASE = process.env.BASE ?? "https://go.pickket.kr";
if (!SLUG || !PID) {
  console.log("  사용법: SLUG=... PRODUCT_ID=... node scripts/verify/checkout-payment-entry.mjs");
  process.exit(2);
}

const EV = `${BASE}/e/${encodeURIComponent(SLUG)}`;
const PAY_PATH = `/e/${encodeURIComponent(SLUG)}/checkout/payment`;
// Cloudflare 가 기본 UA 를 막는다 — 브라우저 UA 필수.
const UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const K = "pickket-checkout";

const results = [];
const allErrors = [];
const rec = (id, ok, note) => {
  results.push({ id, ok });
  console.log(`  ${ok ? "✅" : "🔴"} ${id}  ${note}`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ userAgent: UA });

/** 모든 페이지의 콘솔 에러를 모은다 — V1-6 은 실행 전체를 대상으로 판정한다. */
function watch(page, tag) {
  page.on("console", (m) => {
    if (m.type() === "error") allErrors.push(`[${tag}] ${m.text().slice(0, 200)}`);
  });
  page.on("pageerror", (e) =>
    allErrors.push(`[${tag}] pageerror: ${String(e.message).slice(0, 200)}`),
  );
}

// ── eventId 획득 ─────────────────────────────────────────────────────────
const p0 = await ctx.newPage();
watch(p0, "probe");
await p0.goto(`${EV}/checkout`, { waitUntil: "domcontentloaded", timeout: 45000 });
await p0.waitForTimeout(2000);
const eventId = await p0.evaluate((k) => {
  const raw = sessionStorage.getItem(k);
  return raw ? (JSON.parse(raw).state?.eventId ?? null) : null;
}, K);
await p0.close();
if (!eventId) {
  console.log("  🔴 eventId 를 못 얻음 — 판정 보류(장바구니 페이지가 결속을 안 썼다)");
  await browser.close();
  process.exit(1);
}
console.log(`  eventId ${eventId}\n`);

/** "담기 + 정보입력까지 끝낸" 실사용자와 동일한 저장값. */
const seed = () =>
  JSON.stringify({
    state: {
      selectedItems: [{ productId: PID, name: "검증권", price: 15000, quantity: 1 }],
      buyerInfo: {
        buyerName: "검증",
        buyerEmail: "verify@example.test",
        buyerPhone: "01000000000",
        identityNumber: "",
      },
      answers: {},
      selectedSeatIds: [],
      orderId: null,
      orderNumber: null,
      promoCode: null,
      discountAmount: 0,
      marketingConsent: false,
      checkoutToken: null,
      eventId,
      itemsSignature: `${PID}:1`,
      step: 3,
    },
    version: 0,
  });

const onPay = (page) =>
  decodeURIComponent(new URL(page.url()).pathname) === decodeURIComponent(PAY_PATH);
const bodyOf = async (page) => (await page.textContent("body").catch(() => "")) || "";
const hasErrorScreen = (b) => b.includes("오류 발생") || b.includes("페이지를 불러올 수 없습니다");

async function enterPayment(tag) {
  const page = await ctx.newPage();
  watch(page, tag);
  await page.goto(EV, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), [K, seed()]);
  await page.goto(`${BASE}${PAY_PATH}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2200);
  return page;
}

// ── V1-1 ─────────────────────────────────────────────────────────────────
{
  const page = await enterPayment("V1-1");
  const b = await bodyOf(page);
  // 머물기만 하고 빈 화면이면 통과가 아니다 — 결제수단 UI 존재도 본다.
  const hasPayUi = /결제\s*수단|카드|계좌|간편결제|결제하기/.test(b);
  rec(
    "V1-1 담기+정보 후 진입",
    onPay(page) && !hasErrorScreen(b) && hasPayUi,
    `머묾=${onPay(page)} · 오류화면=${hasErrorScreen(b)} · 결제UI=${hasPayUi}`,
  );
  await page.close();
}

// ── V1-2 새로고침 10회 ───────────────────────────────────────────────────
// 🔴 10회를 줄이지 말 것: 07-28 의 결제 성공 1건이 미설명이라 타이밍 의존 가능성이 남아 있다.
{
  const page = await enterPayment("V1-2");
  let stayed = 0;
  const bounced = [];
  for (let i = 1; i <= 10; i++) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(1500);
    if (onPay(page) && !hasErrorScreen(await bodyOf(page))) {
      stayed++;
    } else {
      bounced.push(i);
      // 튕기면 장바구니가 저장값을 비운다 → 다음 회차 조건이 오염된다. 복구 후 계속.
      await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), [K, seed()]);
      await page.goto(`${BASE}${PAY_PATH}`, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(1200);
    }
  }
  rec(
    "V1-2 새로고침 10회",
    stayed === 10,
    `머묾 ${stayed}/10${bounced.length ? ` · 튕긴 회차 ${bounced.join(",")}` : ""}`,
  );
  await page.close();
}

// ── V1-3 뒤로 → 앞으로 ──────────────────────────────────────────────────
{
  const page = await enterPayment("V1-3");
  const before = onPay(page);
  await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(1000);
  await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(2000);
  const b = await bodyOf(page);
  rec(
    "V1-3 뒤로→앞으로",
    before && onPay(page) && !hasErrorScreen(b),
    `복귀 머묾=${onPay(page)} · 오류화면=${hasErrorScreen(b)}`,
  );
  await page.close();
}

// ── V1-5 빈 장바구니 진입 + 과잉발동 검사 ────────────────────────────────
{
  const page = await ctx.newPage();
  watch(page, "V1-5");
  await page.goto(EV, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.evaluate((k) => sessionStorage.removeItem(k), K);
  await page.goto(`${BASE}${PAY_PATH}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2000);
  const b1 = await bodyOf(page);
  const toCart = /\/checkout\/?$/.test(new URL(page.url()).pathname);

  // 🔴 `redirectedRef` 2차 방어가 **정상 진입까지 고정**하면 그게 회귀의 재발이다.
  //    같은 탭에서 저장값을 채우고 다시 결제로 들어가 본다.
  await page.evaluate(([k, v]) => sessionStorage.setItem(k, v), [K, seed()]);
  await page.goto(`${BASE}${PAY_PATH}`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(2000);
  const recovered = onPay(page);

  rec(
    "V1-5 빈 장바구니 진입 + 이후 정상진입",
    toCart && !hasErrorScreen(b1) && recovered,
    `장바구니로=${toCart} · 오류화면=${hasErrorScreen(b1)} · 이후 정상진입 머묾=${recovered}`,
  );
  await page.close();
}

await browser.close();

// ── V1-6 콘솔 (실행 전체) ────────────────────────────────────────────────
const r185 = allErrors.filter((e) => e.includes("185") || e.includes("Maximum update depth"));
rec("V1-6 React #185", r185.length === 0, `#185 ${r185.length}건 · 전체 콘솔에러 ${allErrors.length}건`);
if (allErrors.length) {
  const uniq = [...new Set(allErrors.map((e) => e.replace(/\[[^\]]+\]\s*/, "")))].slice(0, 5);
  console.log("     콘솔에러 표본:");
  uniq.forEach((e) => console.log(`       · ${e.slice(0, 150)}`));
}

const failed = results.filter((r) => !r.ok);
console.log(`\n  ⟹ ${results.length - failed.length}/${results.length} 통과`);
if (failed.length) {
  console.log("  🔴 실패: " + failed.map((f) => f.id).join(", "));
  process.exitCode = 1;
}
console.log("  ⚠️ V1-4(결제 완료 후 뒤로가기)는 실결제 필요 — 사람 확인 몫");
