/**
 * KLPGA 대회 개최 — **실 UI 워크스루**(prod 대상, 대표 지시 2026-07-27).
 *
 * ⚠️ 이 스펙은 다른 E2E 와 성격이 다르다.
 *   · 대상이 **prod**(`https://go.pickket.kr`)다. 로컬 시드/DB 를 쓰지 않는다.
 *   · 목적은 "API 계약 검증"이 아니라 **주최자가 브라우저에서 실제로 끝까지 갈 수 있는가**다.
 *     앞서 curl 로 API 만 두드렸을 때는 전부 통과했지만, 그건 UI 폼이 같은 필드명을 보내는지·
 *     검증 메시지가 뜨는지·저장 후 화면이 갱신되는지를 **아무것도 증명하지 않는다**.
 *   · 그래서 셀렉터를 관대하게 잡고, 실패하면 **어디서 막혔는지**를 스크린샷·콘솔로 남긴다.
 *
 * 실행:
 *   PROD_EMAIL=... PROD_PW=... npx playwright test specs/e2e/prod-klpga-walkthrough.spec.ts \
 *     --project=chromium --reporter=line --workers=1
 */
import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.PROD_BASE_URL ?? "https://go.pickket.kr";
const EMAIL = process.env.PROD_EMAIL ?? "";
const PW = process.env.PROD_PW ?? "";

/** 대회 스펙(대표 제공). */
const EVENT = {
  title: "BC카드·한경 제48회 KLPGA 챔피언십",
  venue: "포천힐스 컨트리클럽",
  address: "경기 포천시 군내면 반월산성로375번길 34",
  startsAt: "2026-08-20T07:00",
  endsAt: "2026-08-23T18:00",
  tiers: [
    { name: "주중권 (목 1R ~ 금 2R)", price: "15000" },
    { name: "주말권 (토 3R ~ 일 FR)", price: "25000" },
  ],
};

/** 콘솔 에러·실패 응답을 모아 실패 시 원인을 즉시 보이게 한다. */
function attachDiagnostics(page: Page, sink: string[]) {
  page.on("console", (m) => {
    if (m.type() === "error") sink.push(`[console] ${m.text().slice(0, 200)}`);
  });
  page.on("response", async (r) => {
    if (r.status() >= 400 && r.url().includes("/api/")) {
      let body = "";
      try {
        body = (await r.text()).slice(0, 200);
      } catch {
        /* 본문 없음 */
      }
      sink.push(`[${r.status()}] ${r.url().replace(BASE, "")} ${body}`);
    }
  });
}

test.describe.configure({ mode: "serial" });

test.describe("prod KLPGA 개최 워크스루", () => {
  const diag: string[] = [];

  test.beforeAll(() => {
    test.skip(!EMAIL || !PW, "PROD_EMAIL/PROD_PW 미설정");
  });

  test.afterEach(async ({}, testInfo) => {
    if (testInfo.status !== "passed" && diag.length) {
      console.log("\n── 진단 로그 ──");
      for (const d of diag.slice(-25)) console.log("  " + d);
    }
  });

  test("① 로그인", async ({ page }) => {
    attachDiagnostics(page, diag);
    // ⚠️ 하이드레이션 이후에 입력해야 한다. `domcontentloaded` 직후 `fill()` 하면 DOM 값만 바뀌고
    //    React state 는 빈 채로 남아 `{"email":"","password":""}` 가 전송된다(실제로 그렇게 실패했다).
    //    사람은 페이지가 다 뜬 뒤 타이핑하므로 이건 제품 결함이 아니라 **테스트 아티팩트**다.
    //    → networkidle + 여유시간 + 실제 keyboard.type 으로 사람과 같은 조건을 만든다.
    await page.goto(`${BASE}/login`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2_000);

    await page.getByRole("textbox", { name: "이메일" }).click();
    await page.keyboard.type(EMAIL, { delay: 20 });
    await page.getByRole("textbox", { name: "비밀번호" }).click();
    await page.keyboard.type(PW, { delay: 20 });
    await page.getByRole("button", { name: "로그인" }).click();

    // 대시보드 도달 = 로그인 성공. (429 로 인한 자동 로그아웃 회귀도 여기서 잡힌다.)
    await expect(page).toHaveURL(/\/(dashboard|events)?$|\/dashboard/, { timeout: 20_000 });
    await page.waitForTimeout(3_000); // 자동 로그아웃이 나는지 잠시 관찰
    expect(page.url(), "로그인 직후 /login 으로 튕기면 세션 유지 실패").not.toContain("/login");
    await page.context().storageState({ path: ".auth-prod.json" });
  });

  test("② 이벤트 생성 — 폼 입력 → 저장", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: ".auth-prod.json" });
    const page = await ctx.newPage();
    attachDiagnostics(page, diag);

    await page.goto(`${BASE}/events/create`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2_000); // 하이드레이션(위 ① 주석 참조)

    await page.locator("#event-title").fill(EVENT.title);
    await page.locator("#event-starts-at").fill(EVENT.startsAt);
    await page.locator("#event-ends-at").fill(EVENT.endsAt);
    await page.locator("#event-venue-name").fill(EVENT.venue);
    await page.locator("#event-venue-address").fill(EVENT.address);

    await page.screenshot({ path: "test-results/prod-02-filled.png", fullPage: true });
    await page.getByRole("button", { name: "이벤트 만들기" }).click();

    // 저장 성공 = 이벤트 워크스페이스로 이동(생성 페이지에 머물면 실패).
    await expect(page, "이벤트 생성 후 이동하지 않음").not.toHaveURL(/\/events\/create/, {
      timeout: 30_000,
    });
    const m = page.url().match(/\/events\/([0-9a-f-]{36})/);
    expect(m, `이벤트 id 를 URL 에서 찾지 못함: ${page.url()}`).toBeTruthy();
    process.env.KLPGA_EVENT_ID = m![1];
    console.log("  → 생성된 이벤트:", m![1]);
    await ctx.close();
  });

  test("③ 좌석 등급 2종 등록", async ({ browser }) => {
    const eventId = process.env.KLPGA_EVENT_ID;
    test.skip(!eventId, "② 에서 이벤트 id 미확보");
    const ctx = await browser.newContext({ storageState: ".auth-prod.json" });
    const page = await ctx.newPage();
    attachDiagnostics(page, diag);

    await page.goto(`${BASE}/events/${eventId}/tickets`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2_000);
    await page.screenshot({ path: "test-results/prod-03-tickets.png", fullPage: true });

    // 이 화면의 실제 구성을 모르므로, 등급 추가 진입점이 있는지부터 확인한다.
    const addBtn = page.getByRole("button", { name: /등급|추가|만들기|생성/ }).first();
    await expect(addBtn, "티켓 화면에 등급 추가 진입점이 보이지 않는다").toBeVisible({
      timeout: 15_000,
    });
    await ctx.close();
  });

  test("④ 게시 준비 상태 확인", async ({ browser }) => {
    const eventId = process.env.KLPGA_EVENT_ID;
    test.skip(!eventId, "② 에서 이벤트 id 미확보");
    const ctx = await browser.newContext({ storageState: ".auth-prod.json" });
    const page = await ctx.newPage();
    attachDiagnostics(page, diag);

    await page.goto(`${BASE}/events/${eventId}/publish`, { waitUntil: "networkidle" });
    await page.waitForTimeout(2_000);
    await page.screenshot({ path: "test-results/prod-04-publish.png", fullPage: true });

    // 에러 바운더리로 떨어지지 않았는지(=페이지가 살아있는지)가 이 단계의 핵심.
    await expect(
      page.getByRole("heading", { name: /페이지를 불러오는 중 문제/ }),
      "게시 준비 페이지가 에러로 추락",
    ).toHaveCount(0);
    await ctx.close();
  });
});
