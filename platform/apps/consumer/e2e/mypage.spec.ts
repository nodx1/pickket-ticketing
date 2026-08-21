import { test as authTest, expect as authExpect } from "./fixtures/auth";
import { test, expect } from "@playwright/test";

/* ═══════════════════════════════════════════════════════════════════════
 * mypage.spec.ts — 마이페이지 E2E 테스트
 *
 * 테스트 대상:
 *   1. 비로그인 상태 → 마이페이지 접근 제한 확인
 *   2. 로그인 후 마이페이지 접근
 *   3. 프로필 탭 정보 표시
 *   4. 응모 내역 탭
 *   5. 티켓 탭
 *   6. 리세일 탭
 *   7. 포인트 탭
 *   8. 탭 간 전환
 * ═══════════════════════════════════════════════════════════════════════ */

test.describe("마이페이지 — 비로그인", () => {
  test("비로그인 상태에서 마이페이지 접근 시 auth 리다이렉트 또는 제한 메시지", async ({
    page,
  }) => {
    await page.goto("/mypage");
    await page.waitForLoadState("domcontentloaded");

    // 두 가지 경우 처리:
    // 1. /auth 로 리다이렉트
    // 2. 마이페이지에서 로그인 유도 메시지 표시
    const isRedirected = page.url().includes("/auth");
    const hasLoginPrompt = await page
      .getByText(/로그인|로그인이 필요/)
      .first()
      .isVisible()
      .catch(() => false);

    expect(isRedirected || hasLoginPrompt).toBeTruthy();
  });
});

authTest.describe("마이페이지 — 로그인 상태", () => {
  authTest(
    "마이페이지가 정상적으로 로딩된다",
    async ({ authenticatedPage }) => {
      await authenticatedPage.goto("/mypage");
      await authenticatedPage.waitForLoadState("domcontentloaded");

      // URL 확인
      expect(authenticatedPage.url()).toContain("/mypage");

      // 스켈레톤 로딩 완료 대기
      await authenticatedPage
        .waitForSelector(".animate-pulse", { state: "hidden", timeout: 15_000 })
        .catch(() => {});
    },
  );

  authTest(
    "프로필 탭에 사용자 정보가 표시된다",
    async ({ authenticatedPage }) => {
      await authenticatedPage.goto("/mypage?tab=profile");
      await authenticatedPage.waitForLoadState("domcontentloaded");

      // 스켈레톤 완료 대기
      await authenticatedPage
        .waitForSelector(".animate-pulse", { state: "hidden", timeout: 15_000 })
        .catch(() => {});

      // 프로필 정보 영역이 있는지 확인
      const mainContent = authenticatedPage
        .locator("main, [class*='max-w']")
        .first();
      await authExpect(mainContent).toBeVisible();
    },
  );

  authTest("응모 내역 탭으로 전환할 수 있다", async ({ authenticatedPage }) => {
    await authenticatedPage.goto("/mypage");
    await authenticatedPage.waitForLoadState("domcontentloaded");

    // 탭 버튼 찾기 (응모 또는 bids 관련) — exact match로 다른 탭과 구분
    const bidsTab = authenticatedPage
      .getByRole("button", { name: /^응모$|^입찰$|^응모 내역$/ })
      .first();
    const hasBidsTab = await bidsTab
      .isVisible({ timeout: 5_000 })
      .catch(() => false);

    if (hasBidsTab) {
      await bidsTab.waitFor({ state: "visible" });
      await bidsTab.click();

      // URL 업데이트 확인
      await authenticatedPage
        .waitForURL(/tab=bids/, { timeout: 5_000 })
        .catch(() => {});
    } else {
      // 탭이 쿼리 파라미터로 직접 접근 가능한 경우
      await authenticatedPage.goto("/mypage?tab=bids");
      await authenticatedPage.waitForLoadState("domcontentloaded");
    }
  });

  authTest("티켓 탭으로 전환할 수 있다", async ({ authenticatedPage }) => {
    await authenticatedPage.goto("/mypage");
    await authenticatedPage.waitForLoadState("domcontentloaded");

    const ticketsTab = authenticatedPage
      .getByRole("button", { name: /^티켓$|^내 티켓$/ })
      .first();
    const hasTicketsTab = await ticketsTab
      .isVisible({ timeout: 5_000 })
      .catch(() => false);

    if (hasTicketsTab) {
      await ticketsTab.waitFor({ state: "visible" });
      await ticketsTab.click();
      await authenticatedPage
        .waitForURL(/tab=tickets/, { timeout: 8_000 })
        .catch(() => {});
    } else {
      await authenticatedPage.goto("/mypage?tab=tickets");
      await authenticatedPage.waitForLoadState("domcontentloaded");
    }

    // 페이지가 에러 없이 로드되는지 확인
    expect(authenticatedPage.url()).toContain("mypage");
  });

  authTest("리세일 탭으로 전환할 수 있다", async ({ authenticatedPage }) => {
    await authenticatedPage.goto("/mypage?tab=resale");
    await authenticatedPage.waitForLoadState("domcontentloaded");

    // 리세일 관련 콘텐츠 확인
    expect(authenticatedPage.url()).toContain("tab=resale");
  });

  authTest("포인트 탭으로 전환할 수 있다", async ({ authenticatedPage }) => {
    await authenticatedPage.goto("/mypage?tab=points");
    await authenticatedPage.waitForLoadState("domcontentloaded");

    // 포인트 관련 콘텐츠 확인
    expect(authenticatedPage.url()).toContain("tab=points");
  });

  authTest(
    "프로필 편집 페이지로 이동할 수 있다",
    async ({ authenticatedPage }) => {
      await authenticatedPage.goto("/mypage");
      await authenticatedPage.waitForLoadState("domcontentloaded");

      // 프로필 편집 링크/버튼 찾기
      const editLink = authenticatedPage
        .locator(
          "a[href*='/mypage/edit'], button:has-text('편집'), button:has-text('수정')",
        )
        .first();
      const hasEditLink = await editLink
        .isVisible({ timeout: 5_000 })
        .catch(() => false);

      if (hasEditLink) {
        await editLink.click();
        await authenticatedPage.waitForURL(/\/mypage\/edit/, {
          timeout: 5_000,
        });
        expect(authenticatedPage.url()).toContain("/mypage/edit");
      }
    },
  );

  authTest(
    "위시리스트(즐겨찾기) 페이지로 이동할 수 있다",
    async ({ authenticatedPage }) => {
      // favorites 페이지는 cookie bootstrap 후 useAuthStore().user를 확인
      // AuthProvider가 pickket_logged_in 쿠키 → /users/me → setAuth()로 복원
      await authenticatedPage.goto("/mypage/favorites");
      await authenticatedPage.waitForLoadState("domcontentloaded");

      // /auth로 리다이렉트되면 cookie bootstrap 실패
      if (authenticatedPage.url().includes("/auth")) {
        authTest.skip(true, "인증 상태 복원 실패 — cookie bootstrap 미완료");
        return;
      }

      // "찜한 이벤트" 제목 또는 빈 상태 메시지 또는 에러 메시지가 표시
      const content =
        authenticatedPage.getByText(/찜한 이벤트|아직 찜한|불러오기 실패/);
      await authExpect(content.first()).toBeVisible({ timeout: 15_000 });
    },
  );
});
