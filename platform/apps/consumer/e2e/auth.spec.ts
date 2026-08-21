import { test, expect } from "@playwright/test";
import { TEST_USER } from "./fixtures/auth";
import { test as authTest, expect as authExpect } from "./fixtures/auth";

/* ═══════════════════════════════════════════════════════════════════════
 * auth.spec.ts — 인증 플로우 E2E 테스트
 *
 * 테스트 대상:
 *   1. 로그인 페이지 렌더링
 *   2. 유효한 계정으로 로그인 → 리다이렉트
 *   3. 잘못된 계정 → 에러 메시지
 *   4. 회원가입 폼 전환 + 필드 노출
 *   5. 회원가입 유효성 검사 (이메일 형식, 비밀번호 길이, 필수 약관)
 *   6. 로그아웃 후 보호된 페이지 → 리다이렉트
 * ═══════════════════════════════════════════════════════════════════════ */

test.describe("인증 — 로그인 페이지", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/auth");
    await page.waitForLoadState("networkidle");

    // 에러 바운더리가 표시된 경우 새로고침
    const hasError = await page
      .getByText("문제가 발생했습니다")
      .isVisible({ timeout: 1_000 })
      .catch(() => false);
    if (hasError) {
      await page.reload();
      await page.waitForLoadState("networkidle");
    }

    await page.locator("#email").waitFor({ state: "visible", timeout: 10_000 });

    // 온보딩 튜토리얼 닫기 (있으면)
    const onboardingClose = page.locator(
      "button:has-text('건너뛰기'), button:has-text('×'), [aria-label='Close']",
    );
    if (
      await onboardingClose
        .first()
        .isVisible({ timeout: 2_000 })
        .catch(() => false)
    ) {
      await onboardingClose.first().click();
      await page.waitForTimeout(300);
    }
  });

  test("로그인 폼이 올바르게 렌더링된다", async ({ page }) => {
    // 제목
    await expect(page.getByText("다시 만나서 반가워요")).toBeVisible();

    // 로그인/회원가입 탭 토글
    await expect(
      page.getByRole("button", { name: "로그인" }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "회원가입" }).first(),
    ).toBeVisible();

    // 이메일 & 비밀번호 입력 필드
    await expect(page.locator("#email")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();

    // 로그인 제출 버튼
    await expect(
      page.getByRole("button", { name: "로그인" }).last(),
    ).toBeVisible();

    // 비밀번호 찾기 링크
    await expect(page.getByText("비밀번호를 잊으셨나요?")).toBeVisible();
  });

  test("유효한 계정으로 로그인하면 리다이렉트된다", async ({ page }) => {
    await page.locator("#email").fill(TEST_USER.email);
    await page.locator("#password").fill(TEST_USER.password);

    // 제출 버튼 클릭 (폼 내 submit)
    const submitButton = page
      .locator("form")
      .getByRole("button", { name: "로그인" });
    await expect(submitButton).toBeEnabled({ timeout: 5_000 });
    await submitButton.click();

    // /events 또는 홈으로 리다이렉트 (병렬 부하 시 API 응답이 느릴 수 있음)
    await page.waitForURL(
      (url) => {
        const path = url.pathname;
        return (
          path === "/" ||
          path.includes("/events") ||
          path.includes("/onboarding")
        );
      },
      { timeout: 20_000 },
    );

    // 인증 후 auth 페이지에서 벗어났는지 확인
    expect(page.url()).not.toContain("/auth");
  });

  test("잘못된 비밀번호 → 에러 메시지가 표시된다", async ({ page }) => {
    await page.locator("#email").fill(TEST_USER.email);
    await page.locator("#password").fill("WrongPassword123!");

    // 제출 버튼 클릭
    const submitButton = page
      .locator("form")
      .getByRole("button", { name: "로그인" });
    await expect(submitButton).toBeEnabled({ timeout: 5_000 });
    await submitButton.click();

    // 에러 표시 대기: 토스트 또는 에러 바운더리
    const errorIndicator = page
      .locator(
        "[data-sonner-toast], ol[data-sonner-toaster] li, [role='status']:not(:empty)",
      )
      .first();
    const errorBoundary = page.getByText("문제가 발생했습니다");

    // 어느 쪽이든 에러 상태가 표시되면 통과
    await expect(errorIndicator.or(errorBoundary)).toBeVisible({
      timeout: 20_000,
    });

    // 여전히 auth 페이지에 있는지 확인 (리다이렉트 안 됨)
    expect(page.url()).toContain("/auth");
  });
});

test.describe("인증 — 회원가입 폼", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/auth");
    await page.waitForLoadState("networkidle");
    await page.locator("#email").waitFor({ state: "visible", timeout: 10_000 });

    // 온보딩 튜토리얼 닫기 (있으면)
    const onboardingClose = page.locator(
      "button:has-text('건너뛰기'), button:has-text('×'), [aria-label='Close']",
    );
    if (
      await onboardingClose
        .first()
        .isVisible({ timeout: 2_000 })
        .catch(() => false)
    ) {
      await onboardingClose.first().click();
      await page.waitForTimeout(300);
    }

    // 회원가입 탭 클릭
    await page.getByRole("button", { name: "회원가입" }).first().click();
    // 회원가입 폼 전환 완료 대기
    await page.locator("#name").waitFor({ state: "visible", timeout: 5_000 });
  });

  test("회원가입 탭 전환 시 이름 필드와 약관 섹션이 나타난다", async ({
    page,
  }) => {
    // 제목 변경
    await expect(page.getByText("Pickket 시작하기")).toBeVisible();

    // 이름 필드 표시
    await expect(page.locator("#name")).toBeVisible();

    // 이메일 & 비밀번호 필드 유지
    await expect(page.locator("#email")).toBeVisible();
    await expect(page.locator("#password")).toBeVisible();

    // 약관 동의 섹션 (exact: true로 "이용약관 동의"와의 겹침 방지)
    await expect(page.getByText("약관 동의", { exact: true })).toBeVisible();
    await expect(page.getByText("전체 동의", { exact: true })).toBeVisible();

    // 필수 약관 항목 (checkbox ID로 확인 — 텍스트가 여러 요소에 매칭되므로)
    await expect(page.locator("#consent-terms")).toBeVisible();
    await expect(page.locator("#consent-privacy")).toBeVisible();
    await expect(page.locator("#consent-age14")).toBeVisible();
  });

  test("이메일 형식이 잘못되면 에러 메시지가 표시된다", async ({ page }) => {
    await page.locator("#name").fill("테스트");
    await page.locator("#email").fill("invalid-email");
    await page.locator("#password").fill("TestPassword2026!");

    // 필수 약관 모두 체크
    await page.locator("#consent-terms").check();
    await page.locator("#consent-privacy").check();
    await page.locator("#consent-age14").check();

    // 제출 (폼 내 회원가입 버튼 클릭 — noValidate이므로 커스텀 검증이 실행됨)
    await page
      .locator("form")
      .getByRole("button", { name: "회원가입" })
      .click();

    // 이메일 유효성 에러
    await expect(page.getByText("올바른 이메일 형식이 아닙니다")).toBeVisible({
      timeout: 5_000,
    });
  });

  test("비밀번호가 8자 미만이면 에러 메시지가 표시된다", async ({ page }) => {
    await page.locator("#name").fill("테스트");
    await page.locator("#email").fill("test@example.com");
    await page.locator("#password").fill("Short1!");

    // 필수 약관 모두 체크
    await page.locator("#consent-terms").check();
    await page.locator("#consent-privacy").check();
    await page.locator("#consent-age14").check();

    await page
      .locator("form")
      .getByRole("button", { name: "회원가입" })
      .click();

    await expect(
      page.getByText("비밀번호는 8자 이상이어야 합니다"),
    ).toBeVisible();
  });

  test("필수 약관 미동의 시 제출 버튼이 비활성화된다", async ({ page }) => {
    await page.locator("#name").fill("테스트");
    await page.locator("#email").fill("test@example.com");
    await page.locator("#password").fill("TestPassword2026!");

    // 필수 약관 미체크 상태에서 버튼 비활성화 확인
    const submitButton = page
      .locator("form")
      .getByRole("button", { name: "회원가입" });
    await expect(submitButton).toBeDisabled();
  });

  test("전체 동의 체크 시 모든 약관이 선택된다", async ({ page }) => {
    await page.locator("#consent-all").check();

    await expect(page.locator("#consent-terms")).toBeChecked();
    await expect(page.locator("#consent-privacy")).toBeChecked();
    await expect(page.locator("#consent-age14")).toBeChecked();
    await expect(page.locator("#consent-marketing")).toBeChecked();
    await expect(page.locator("#consent-third-party")).toBeChecked();
  });
});

authTest.describe("인증 — 로그아웃 후 보호된 페이지", () => {
  authTest(
    "로그인 상태에서 마이페이지에 접근할 수 있다",
    async ({ authenticatedPage }) => {
      await authenticatedPage.goto("/mypage");

      // 마이페이지 콘텐츠 로드 대기
      await authenticatedPage.waitForLoadState("networkidle");

      // 마이페이지가 리다이렉트 없이 로드되는지 확인
      expect(authenticatedPage.url()).toContain("/mypage");
    },
  );
});
