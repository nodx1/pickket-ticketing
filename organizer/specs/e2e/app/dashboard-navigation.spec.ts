import { expect, test } from "@playwright/test";
import { loginAsDemo } from "../helpers/auth";
import { expectNoCriticalConsoleErrors, trackCriticalConsoleErrors } from "../helpers/assertions";

const dashboardRoutes = [
  { path: "/events", text: "모든 이벤트" },
  { path: "/organizers", text: "주최자" },
  { path: "/notifications", text: "알림" },
  { path: "/account", text: "계정 설정" },
  { path: "/account/settlements", text: "정산" },
  { path: "/account/members", text: "팀 멤버" },
  { path: "/admin", text: "시스템 어드민" },
];

for (const route of dashboardRoutes) {
  test(`운영 화면 이동 스모크: ${route.path}`, async ({ page }) => {
    const errors = trackCriticalConsoleErrors(page);
    await loginAsDemo(page);
    await page.goto(route.path);
    await expect(page).toHaveURL(new RegExp(route.path.replaceAll("/", "\\/")));
    await expect(page.getByText(route.text, { exact: false }).first()).toBeVisible();
    await expectNoCriticalConsoleErrors(errors);
  });
}
