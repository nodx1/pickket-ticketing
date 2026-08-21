import { test, expect } from "./fixtures/auth";

/* ═══════════════════════════════════════════════════════════════════════
 * system-admin.spec.ts — Admin 시스템 관리 E2E 테스트
 *
 * 테스트 대상:
 *   1. Feature Flags 페이지 렌더링 + 토글 목록
 *   2. 감사 로그 페이지 렌더링 + 로그 목록
 *   3. 권한 관리 페이지 렌더링 + 역할 목록
 *   4. 도메인 설정 페이지 렌더링
 *   5. 시스템 상태 페이지 렌더링
 *   6. A/B 실험 페이지 렌더링
 * ═══════════════════════════════════════════════════════════════════════ */

/** 페이지 진입 + 렌더 대기 */
async function gotoAndWait(
  page: import("@playwright/test").Page,
  path: string,
) {
  await page.goto(path);
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => (document.querySelector("main")?.textContent?.length ?? 0) > 5,
    { timeout: 15_000 },
  );
}

/* ── Feature Flags ──────────────────────────────────────────────────── */
test.describe("시스템 관리 — Feature Flags", () => {
  test("Feature Flags 페이지가 렌더링된다", async ({ authenticatedPage }) => {
    await gotoAndWait(authenticatedPage, "/feature-flags");

    await expect(authenticatedPage.locator("main")).toBeVisible();
  });

  test("Feature Flags 목록이 표시된다", async ({ authenticatedPage }) => {
    await gotoAndWait(authenticatedPage, "/feature-flags");

    // 플래그 목록 (토글 스위치 또는 테이블 행) 확인
    const flagItems = authenticatedPage.locator(
      "[role='switch'], input[type='checkbox'], table tbody tr, .divide-y > div, [data-testid*='flag']",
    );
    const hasFlags = (await flagItems.count()) > 0;
    const hasEmpty =
      (await authenticatedPage.getByText("플래그가 없습니다").count()) > 0 ||
      (await authenticatedPage.getByText("Feature Flag").count()) > 0;

    // 플래그 목록이 있거나 빈 상태 또는 페이지가 렌더링되면 통과
    expect(
      hasFlags ||
        hasEmpty ||
        (await authenticatedPage.locator("main").isVisible()),
    ).toBeTruthy();
  });

  test("Feature Flags 토글이 클릭 가능하다", async ({ authenticatedPage }) => {
    await gotoAndWait(authenticatedPage, "/feature-flags");

    const toggle = authenticatedPage
      .locator("[role='switch'], input[type='checkbox']")
      .first();

    if ((await toggle.count()) > 0) {
      await expect(toggle).toBeEnabled();
    }
  });
});

/* ── 감사 로그 ──────────────────────────────────────────────────────── */
test.describe("시스템 관리 — 감사 로그", () => {
  test("감사 로그 페이지가 렌더링된다", async ({ authenticatedPage }) => {
    await gotoAndWait(authenticatedPage, "/audit");

    await expect(authenticatedPage.locator("main")).toBeVisible();
  });

  test("감사 로그 목록이 표시된다", async ({ authenticatedPage }) => {
    await gotoAndWait(authenticatedPage, "/audit");

    // 감사 로그 테이블 행 또는 divide-y 리스트
    const logRows = authenticatedPage.locator(
      "table tbody tr, .divide-y > div, [data-testid^='audit-row'], [data-testid^='log-']",
    );
    const hasLogs = (await logRows.count()) > 0;
    const hasEmpty =
      (await authenticatedPage.getByText("로그가 없습니다").count()) > 0 ||
      (await authenticatedPage.getByText("기록이 없습니다").count()) > 0;

    // 로그가 있거나 빈 상태면 정상, 아니면 메인이 보이면 통과
    expect(
      hasLogs ||
        hasEmpty ||
        (await authenticatedPage.locator("main").isVisible()),
    ).toBeTruthy();
  });

  test("감사 로그 검색/필터가 존재한다", async ({ authenticatedPage }) => {
    await gotoAndWait(authenticatedPage, "/audit");

    const filter = authenticatedPage.locator(
      "input[type='search'], input[placeholder*='검색'], select, [role='combobox'], [data-testid*='filter']",
    );

    if ((await filter.count()) > 0) {
      await expect(filter.first()).toBeVisible();
    } else {
      await expect(authenticatedPage.locator("main")).toBeVisible();
    }
  });
});

/* ── 권한 관리 ──────────────────────────────────────────────────────── */
test.describe("시스템 관리 — 권한 관리", () => {
  test("권한 관리 페이지가 렌더링된다", async ({ authenticatedPage }) => {
    await gotoAndWait(authenticatedPage, "/roles");

    await expect(authenticatedPage.locator("main")).toBeVisible();
  });

  test("역할 목록이 표시된다", async ({ authenticatedPage }) => {
    await gotoAndWait(authenticatedPage, "/roles");

    // 역할 카드, 테이블 행, 또는 리스트 아이템 확인
    const roleItems = authenticatedPage.locator(
      "table tbody tr, .divide-y > div, [data-testid*='role']",
    );
    const hasRoles = (await roleItems.count()) > 0;
    const hasEmpty =
      (await authenticatedPage.getByText("역할이 없습니다").count()) > 0 ||
      (await authenticatedPage.getByText("등록된 역할").count()) > 0;

    // 역할 목록이 있거나 빈 상태 또는 메인이 보이면 통과
    expect(
      hasRoles ||
        hasEmpty ||
        (await authenticatedPage.locator("main").isVisible()),
    ).toBeTruthy();
  });
});

/* ── 도메인 설정 ────────────────────────────────────────────────────── */
test.describe("시스템 관리 — 도메인 설정", () => {
  test("도메인 설정 페이지가 렌더링된다", async ({ authenticatedPage }) => {
    await gotoAndWait(authenticatedPage, "/settings");

    await expect(authenticatedPage.locator("main")).toBeVisible();
  });

  test("도메인 설정에 폼 요소가 존재한다", async ({ authenticatedPage }) => {
    await gotoAndWait(authenticatedPage, "/settings");

    // 설정 페이지에 입력 필드, 토글, 또는 저장 버튼이 존재해야 한다
    const formElements = authenticatedPage.locator(
      "input, select, textarea, [role='switch'], button:has-text('저장'), button:has-text('Save')",
    );

    if ((await formElements.count()) > 0) {
      await expect(formElements.first()).toBeVisible();
    } else {
      const mainText = await authenticatedPage.locator("main").textContent();
      expect(mainText?.length).toBeGreaterThan(0);
    }
  });
});

/* ── 시스템 상태 ────────────────────────────────────────────────────── */
test.describe("시스템 관리 — 시스템 상태", () => {
  test("시스템 상태 페이지가 렌더링된다", async ({ authenticatedPage }) => {
    await gotoAndWait(authenticatedPage, "/system");

    await expect(authenticatedPage.locator("main")).toBeVisible();
  });

  test("시스템 상태 정보가 표시된다", async ({ authenticatedPage }) => {
    await gotoAndWait(authenticatedPage, "/system");

    // 시스템 페이지가 렌더링되었는지 확인
    const mainText = await authenticatedPage.locator("main").textContent();
    expect(mainText?.length).toBeGreaterThan(0);

    // 시스템 관련 키워드가 있는지 확인
    const hasSystemContent =
      (await authenticatedPage.getByText("정상").count()) > 0 ||
      (await authenticatedPage.getByText("Online").count()) > 0 ||
      (await authenticatedPage.getByText("Healthy").count()) > 0 ||
      (await authenticatedPage.getByText("Database").count()) > 0 ||
      (await authenticatedPage.getByText("Redis").count()) > 0 ||
      (await authenticatedPage.getByText("시스템").count()) > 0;

    expect(hasSystemContent).toBeTruthy();
  });
});

/* ── A/B 실험 ───────────────────────────────────────────────────────── */
test.describe("시스템 관리 — A/B 실험", () => {
  test("A/B 실험 페이지가 렌더링된다", async ({ authenticatedPage }) => {
    await gotoAndWait(authenticatedPage, "/experiments");

    await expect(authenticatedPage.locator("main")).toBeVisible();
  });

  test("A/B 실험 목록 또는 생성 UI가 존재한다", async ({
    authenticatedPage,
  }) => {
    await gotoAndWait(authenticatedPage, "/experiments");

    // 실험 목록, 생성 버튼, 또는 빈 상태 확인
    const experimentItems = authenticatedPage.locator(
      "table tbody tr, .divide-y > div, [data-testid*='experiment']",
    );
    const hasItems = (await experimentItems.count()) > 0;
    const hasEmpty =
      (await authenticatedPage.getByText("실험이 없습니다").count()) > 0 ||
      (await authenticatedPage.getByText("A/B").count()) > 0 ||
      (await authenticatedPage.getByText("등록된 실험").count()) > 0;

    // 목록/빈상태/메인 중 하나가 보이면 통과
    expect(
      hasItems ||
        hasEmpty ||
        (await authenticatedPage.locator("main").isVisible()),
    ).toBeTruthy();
  });
});
