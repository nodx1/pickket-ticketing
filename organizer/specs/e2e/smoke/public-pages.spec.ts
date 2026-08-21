import { test, expect } from "@playwright/test";
import { expectNoCriticalConsoleErrors, trackCriticalConsoleErrors } from "../helpers/assertions";
import { publicRoutes } from "../helpers/routes";

for (const route of publicRoutes) {
  test(`공개 페이지 정상 렌더링: ${route}`, async ({ page }) => {
    const errors = trackCriticalConsoleErrors(page);
    await page.goto(route);
    await expect(page).toHaveURL(new RegExp(route === "/" ? "/$" : route.replaceAll("/", "\\/")));
    await expect(page.locator("body")).toBeVisible();
    await expectNoCriticalConsoleErrors(errors);
  });
}

test("헬스체크 API 정상 응답", async ({ request }) => {
  const response = await request.get("/api/health");
  expect(response.ok()).toBeTruthy();
});
