import { test, expect } from "@playwright/test";
import { protectedRoutes } from "../helpers/routes";

for (const route of protectedRoutes) {
  test(`비로그인 사용자는 보호 경로 접근 불가: ${route}`, async ({ page }) => {
    const response = await page.goto(route);
    expect(response).not.toBeNull();
    await expect(page).toHaveURL(/\/login|\/dashboard/);
  });
}

test("비로그인 사용자는 보호 API 접근 시 차단", async ({ request }) => {
  const response = await request.get("/api/notifications");
  expect([401, 403]).toContain(response.status());
});
