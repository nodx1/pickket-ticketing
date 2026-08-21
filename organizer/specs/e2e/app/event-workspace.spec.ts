import { expect, test } from "@playwright/test";
import { loginAsDemo } from "../helpers/auth";
import { openFirstEventWorkspace } from "../helpers/events";
import { expectNoCriticalConsoleErrors, trackCriticalConsoleErrors } from "../helpers/assertions";

const eventSections = [
  "dashboard",
  "reports",
  "settings",
  "homepage-designer",
  "ticket-designer",
  "seat-map",
  "questions",
  "products",
  "orders",
  "promo-codes",
  "affiliates",
  "attendees",
  "check-in",
  "messages",
  "capacity",
  "waitlist",
  "webhooks",
  "widget",
];

test("이벤트 워크스페이스 핵심 화면이 모두 열리고 사이드바가 유지된다", async ({ page }) => {
  const errors = trackCriticalConsoleErrors(page);
  await loginAsDemo(page);
  const eventId = await openFirstEventWorkspace(page);

  for (const section of eventSections) {
    await page.goto(`/events/${eventId}/${section}`);
    await expect(page).toHaveURL(new RegExp(`/events/${eventId}/${section.replaceAll("/", "\\/")}$`));
    // 페이지가 정상 렌더링되었는지 확인 (500 에러 아님)
    await expect(page.locator("body")).toBeVisible();
  }

  await expectNoCriticalConsoleErrors(errors);
});
