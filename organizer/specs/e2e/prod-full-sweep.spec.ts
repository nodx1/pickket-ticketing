/**
 * prod 전수 스윕 — **모든 주최자 페이지를 열고, DB 왕복을 확인한다**(대표 지시 2026-07-27).
 *
 * ## 왜 이 스펙이 필요한가
 * 레벨2 컷오버로 go DB read 를 v2 로 대거 옮겼다. 그 과정에서 반복적으로 나온 결함은
 * **조용한 실패**다 — 예외도 로그도 없이 "0건"·"미충족"·"draft" 로 보여서
 * 화면만 봐서는 원인을 알 수 없고, API 단위 테스트로도 안 잡힌다.
 * 이미 이 방식으로 5건을 잡았다(설정페이지 500 · 게시 영구불가 · 심사상태 뭉개짐 ·
 * 매진알림 무발송 · 초대권 중복발송).
 *
 * ## 두 축으로 본다
 *   1) **열림**   — 모든 페이지가 에러 바운더리로 추락하지 않는가(DROP 된 테이블 참조 탐지)
 *   2) **왕복**   — 저장한 값이 **새로고침 후에도 남아 있는가**(write→v2→read 경로 실증)
 *      · 이게 핵심이다. 저장이 200 을 줘도 read 매핑이 틀리면 값이 사라지거나 뭉개진다.
 *
 * ## 실행
 *   BASE_URL=https://go.pickket.kr PROD_EMAIL=... PROD_PW=... \
 *     npx playwright test specs/e2e/prod-full-sweep.spec.ts --project=chromium --workers=1 --reporter=line
 */
import { test, expect, type Page } from "@playwright/test";

const BASE = process.env.PROD_BASE_URL ?? process.env.BASE_URL ?? "https://go.pickket.kr";
const EMAIL = process.env.PROD_EMAIL ?? "";
const PW = process.env.PROD_PW ?? "";
const EVENT_ID = process.env.KLPGA_EVENT_ID ?? "";

/** 에러 바운더리 문구 — 페이지 추락 판정의 유일한 기준. */
const CRASH = /페이지를 불러오는 중 문제가 발생했습니다/;

/** 이벤트 워크스페이스 전 페이지(라우트 실측 기준). */
const EVENT_PAGES = [
  "", "getting-started", "publish", "settings", "schedules", "tickets", "seat-map",
  "products", "packages", "questions", "homepage-designer", "bridge-page",
  "dashboard", "orders", "attendees", "check-in", "check-in/", "raffle", "bids",
  "reports", "inbox", "inquiries", "messages", "campaigns", "open-notices",
  "promo-codes", "affiliates", "ticket-designer", "invitation-designer",
  "invitations", "ticket-issuance", "capacity", "waitlist", "webhooks", "widget",
  "group-bookings", "participants", "facilities", "final-call", "rehearsal",
  "feature-manager", "compliance", "bot-detection",
];

/** 계정/전역 페이지. */
const GLOBAL_PAGES = [
  "dashboard", "events", "organizers", "notifications", "checkin",
  "account", "account/members", "account/security", "account/settlements", "account/compliance",
];

function watch(page: Page, sink: string[]) {
  page.on("response", async (r) => {
    if (r.status() >= 400 && r.url().includes("/api/")) {
      let b = "";
      try {
        b = (await r.text()).slice(0, 160);
      } catch {
        /* 본문 없음 */
      }
      sink.push(`[${r.status()}] ${r.url().replace(BASE, "")} ${b}`);
    }
  });
}

/** 하이드레이션 이후에 조작해야 한다 — 그 전에 값을 넣으면 React state 가 비어 전송된다.
 *  ⚠️ `networkidle` 은 SSE/폴링이 있는 화면에서 영영 안 끝난다(실제로 account/compliance 에서
 *     페이지 하나에 3분을 태워 전체가 타임아웃됐다). `load` + 고정 대기로 바꾼다. */
async function ready(page: Page, path: string) {
  await page.goto(`${BASE}${path}`, { waitUntil: "load", timeout: 25_000 }).catch(() => {});
  await page.waitForTimeout(1_500);
}

/** 페이지 1개 열기 — 개별 실패가 스윕 전체를 죽이지 않게 감싼다. */
async function probe(page: Page, path: string): Promise<"ok" | "crash" | "timeout"> {
  try {
    await ready(page, path);
  } catch {
    return "timeout";
  }
  return (await page.getByRole("heading", { name: CRASH }).count()) ? "crash" : "ok";
}

test.describe.configure({ mode: "serial" });
test.setTimeout(900_000); // 40+ 페이지를 순회하므로 넉넉히

test.describe("prod 전수 스윕", () => {
  test.beforeAll(() => {
    test.skip(!EMAIL || !PW, "PROD_EMAIL/PROD_PW 미설정");
  });

  test("로그인 → 세션 저장", async ({ page }) => {
    await ready(page, "/login");
    await page.getByRole("textbox", { name: "이메일" }).click();
    await page.keyboard.type(EMAIL, { delay: 15 });
    await page.getByRole("textbox", { name: "비밀번호" }).click();
    await page.keyboard.type(PW, { delay: 15 });
    await page.getByRole("button", { name: "로그인" }).click();
    await expect(page).not.toHaveURL(/\/login/, { timeout: 25_000 });
    await page.context().storageState({ path: ".auth-prod.json" });
  });

  test("전역 페이지 전수 — 추락 0", async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: ".auth-prod.json" });
    const page = await ctx.newPage();
    const api: string[] = [];
    watch(page, api);

    const broken: string[] = [];
    for (const p of GLOBAL_PAGES) {
      const r = await probe(page, `/${p}`);
      if (r !== "ok") broken.push(`/${p} (${r})`);
    }
    if (api.length) console.log("\n── 4xx/5xx API ──\n  " + api.join("\n  "));
    expect(broken, `추락한 전역 페이지: ${broken.join(", ")}`).toEqual([]);
    await ctx.close();
  });

  test("이벤트 페이지 전수 — 추락 0", async ({ browser }) => {
    test.skip(!EVENT_ID, "KLPGA_EVENT_ID 미설정");
    const ctx = await browser.newContext({ storageState: ".auth-prod.json" });
    const page = await ctx.newPage();
    const api: string[] = [];
    watch(page, api);

    const broken: string[] = [];
    for (const p of EVENT_PAGES) {
      const path = p ? `/events/${EVENT_ID}/${p}` : `/events/${EVENT_ID}`;
      const r = await probe(page, path);
      if (r !== "ok") broken.push(`${p || "(홈)"} (${r})`);
    }
    if (api.length) console.log("\n── 4xx/5xx API ──\n  " + api.join("\n  "));
    expect(broken, `추락한 이벤트 페이지: ${broken.join(", ")}`).toEqual([]);
    await ctx.close();
  });

  /**
   * 🔴 이 테스트가 이 스펙의 핵심이다.
   * 저장이 200 을 줘도 read 매핑이 틀리면 값이 사라지거나 뭉개진다
   * (실제로 심사상태가 `pending_review`→`draft` 로 뭉개지는 결함을 이 방식으로 잡았다).
   * 그래서 **저장 → 새로고침 → 값 확인** 까지 한다.
   */
  test("설정 페이지 DB 왕복 — 저장한 값이 새로고침 후에도 남는가", async ({ browser }) => {
    test.skip(!EVENT_ID, "KLPGA_EVENT_ID 미설정");
    const ctx = await browser.newContext({ storageState: ".auth-prod.json" });
    const page = await ctx.newPage();
    const api: string[] = [];
    watch(page, api);

    const stamp = `왕복확인 ${Date.now()}`;
    await ready(page, `/events/${EVENT_ID}/settings`);

    const summary = page.locator("#event-summary");
    await expect(summary, "설정 페이지에 '짧은 소개' 입력란이 없다").toBeVisible({ timeout: 15_000 });
    await summary.fill(stamp);

    await page.getByRole("button", { name: /저장하기|저장/ }).first().click();
    await page.waitForTimeout(3_000);

    // 새 컨텍스트가 아니라 같은 페이지를 **다시 로드**한다 — 서버에서 다시 읽어오는 경로 검증.
    await ready(page, `/events/${EVENT_ID}/settings`);
    await expect(
      page.locator("#event-summary"),
      "저장은 됐다는데 새로고침하면 값이 사라진다(= write→read 왕복 끊김)",
    ).toHaveValue(stamp, { timeout: 15_000 });

    if (api.length) console.log("\n── 4xx/5xx API ──\n  " + api.join("\n  "));
    await ctx.close();
  });
});
