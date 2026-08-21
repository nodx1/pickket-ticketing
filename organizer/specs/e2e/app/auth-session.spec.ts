import { expect, test } from "@playwright/test";
import { loginAsDemo } from "../helpers/auth";
import { expectNoCriticalConsoleErrors, trackCriticalConsoleErrors } from "../helpers/assertions";

test("데모 계정 로그인과 로그아웃이 정상 동작한다", async ({ page }) => {
  const errors = trackCriticalConsoleErrors(page);

  await loginAsDemo(page);
  // "이벤트" 는 네비에 여러 링크(이벤트/이벤트 관리 등)로 존재 → strict-mode 회피 위해 first().
  // 의도: 로그인 성공 후 대시보드 네비가 렌더됐는지 확인.
  await expect(page.getByRole("link", { name: "이벤트" }).first()).toBeVisible();

  await Promise.all([
    page.waitForURL(/\/login$/),
    page.getByRole("button", { name: "로그아웃" }).click(),
  ]);
  await expect(page).toHaveURL(/\/login$/);
  await expectNoCriticalConsoleErrors(errors);
});
