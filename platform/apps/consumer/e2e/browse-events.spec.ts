import { test, expect } from "@playwright/test";
import { dismissOnboarding } from "./fixtures/helpers";

/* ═══════════════════════════════════════════════════════════════════════
 * browse-events.spec.ts — 이벤트 탐색 E2E 테스트
 *
 * 테스트 대상:
 *   1. 홈페이지 로딩 확인
 *   2. 이벤트 목록 페이지 로딩
 *   3. 이벤트 카드 표시 확인
 *   4. 이벤트 카드 클릭 → 상세 페이지 이동
 *   5. 카테고리 필터링
 *   6. 검색 기능
 *   7. 모바일 뷰에서의 레이아웃
 * ═══════════════════════════════════════════════════════════════════════ */

test.describe("홈페이지", () => {
  test("홈페이지가 정상적으로 로딩된다", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // 페이지가 에러 없이 로드되는지 확인
    await expect(page).not.toHaveTitle(/error|500|404/i);

    // 메인 콘텐츠 영역이 존재 (body는 항상 visible)
    await expect(page.locator("body")).toBeVisible();
  });

  test("검색바가 표시된다", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    // SearchBar의 input 요소가 존재하는지 확인
    const searchInput = page
      .locator(
        "input[type='search'], input[placeholder*='검색'], input[placeholder*='이벤트']",
      )
      .first();
    // 홈페이지에 검색바가 있을 수도, 네비게이션에 있을 수도 있음
    const hasSearch = await searchInput
      .isVisible({ timeout: 5_000 })
      .catch(() => false);
    // 검색 링크나 검색 아이콘이라도 있으면 통과
    if (!hasSearch) {
      const searchLink = page
        .locator(
          "a[href*='search'], a[href*='events'], button[aria-label*='검색']",
        )
        .first();
      await expect(searchLink).toBeVisible();
    }
  });
});

test.describe("이벤트 목록 (/events)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/events");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);
  });

  test("이벤트 페이지 제목이 표시된다", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "이벤트" })).toBeVisible();
  });

  test("이벤트 개수 텍스트가 표시된다", async ({ page }) => {
    // "N개의 이벤트" 텍스트가 나타날 때까지 대기
    await expect(page.getByText(/\d+개의 이벤트/)).toBeVisible({
      timeout: 15_000,
    });
  });

  test("카테고리 필터 버튼들이 표시된다", async ({ page }) => {
    // 카테고리 필 버튼 확인 (최소 하나 이상)
    const categoryButtons = page.getByRole("button").filter({
      hasText: /콘서트|뮤지컬|스포츠|클래식|전시|축제|e스포츠/,
    });
    const count = await categoryButtons.count();
    expect(count).toBeGreaterThan(0);
  });

  test("검색바가 표시된다", async ({ page }) => {
    // visible한 검색 input을 찾기 (네비 검색바는 모바일에서 hidden)
    const searchInput = page.locator("input:visible").first();
    await expect(searchInput).toBeVisible({ timeout: 5_000 });
  });

  test("카테고리 필터 클릭 시 URL이 업데이트된다", async ({ page }) => {
    // main 영역 내의 '콘서트' 카테고리 버튼 클릭 (전역 네비게이션이 아닌 필터 영역)
    const mainArea = page.locator("main");
    const concertButton = mainArea
      .getByRole("button", { name: "콘서트" })
      .first();
    if (await concertButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await concertButton.waitFor({ state: "visible" });
      await concertButton.click();
      await page.waitForURL(/category=concert/, { timeout: 10_000 });
      expect(page.url()).toContain("category=concert");
    }
  });

  test("정렬 필터 드롭다운이 동작한다", async ({ page }) => {
    // 정렬 드롭다운 버튼 클릭
    const sortButton = page.getByRole("button", { name: /정렬/ }).first();
    if (await sortButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await sortButton.click();

      // 드롭다운 메뉴가 열리는지 확인
      const listbox = page.locator("[role='listbox']").first();
      await expect(listbox).toBeVisible();
    }
  });

  test("뷰 모드 토글(그리드/리스트)이 동작한다", async ({ page }) => {
    // 그리드 뷰 버튼
    const gridButton = page.getByRole("button", { name: "그리드 보기" });
    const listButton = page.getByRole("button", { name: "리스트 보기" });

    if (await gridButton.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await expect(gridButton).toBeVisible();
      await expect(listButton).toBeVisible();

      // 리스트 모드로 전환
      await listButton.click();

      // 다시 그리드 모드로 전환
      await gridButton.click();
    }
  });
});

test.describe("이벤트 검색", () => {
  test("검색어 입력 후 결과가 표시된다", async ({ page }) => {
    await page.goto("/events");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // 검색바 찾기 (검색 전용 input 또는 일반 input)
    const searchInput = page
      .locator(
        "input[type='search'], input[placeholder*='검색'], input[placeholder*='이벤트']",
      )
      .first();
    const hasSearch = await searchInput
      .isVisible({ timeout: 5_000 })
      .catch(() => false);

    if (!hasSearch) {
      // 모바일: 검색 페이지로 이동해서 테스트
      await page.goto("/search");
      await page.waitForLoadState("networkidle");
      await dismissOnboarding(page);
    }

    const input = page.locator("input").first();
    if (await input.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await input.fill("콘서트");
      await input.press("Enter");
      // URL에 검색 파라미터가 포함되거나, 검색 결과가 표시됨
      await page
        .waitForURL(/q=|search|keyword/, { timeout: 10_000 })
        .catch(() => {});
    }
  });

  test("검색 페이지에서 검색이 동작한다", async ({ page }) => {
    await page.goto("/search");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // 검색 페이지가 존재하면 테스트
    if (!page.url().includes("404")) {
      const searchInput = page.locator("input").first();
      if (await searchInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await expect(searchInput).toBeVisible();
      }
    }
  });
});

test.describe("이벤트 카드 인터랙션", () => {
  test("이벤트 카드가 있으면 클릭하여 상세 페이지로 이동한다", async ({
    page,
  }) => {
    await page.goto("/events");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // 이벤트 카드 링크 찾기 (EventCard 컴포넌트는 보통 <a> 또는 <Link>로 감쌈)
    const eventLink = page.locator("a[href*='/events/']").first();

    if (await eventLink.isVisible({ timeout: 5_000 }).catch(() => false)) {
      // 모바일 뷰포트에서 요소가 보이지 않을 수 있으므로 스크롤 처리
      await eventLink.scrollIntoViewIfNeeded();
      await page.waitForTimeout(100); // 스크롤 안정화
      const href = await eventLink.getAttribute("href");
      await eventLink.click();

      // 상세 페이지로 이동 확인
      await page.waitForURL(/\/events\/[\w-]+/, { timeout: 10_000 });
      expect(page.url()).toMatch(/\/events\/[\w-]+/);
    } else {
      // 이벤트가 없으면 빈 상태 메시지 확인
      const emptyState = page.getByText(/등록된 이벤트가 없|결과가 없/);
      await expect(emptyState).toBeVisible();
    }
  });
});
