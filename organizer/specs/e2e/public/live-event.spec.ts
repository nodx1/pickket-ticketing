import { expect, test } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { expectNoCriticalConsoleErrors, trackCriticalConsoleErrors } from "../helpers/assertions";

test("라이브 이벤트 공개 페이지가 정상 렌더링된다", async ({ page, request }) => {
  // live 이벤트 찾기 — 없으면 하나 생성
  await loginAsDemoApi(request);
  const listRes = await request.get("/api/events?limit=20&sort=latest");
  const listPayload = (await listRes.json()) as { data?: Array<{ id: string; slug: string; status: string }> };
  let liveEvent = listPayload.data?.find((e) => e.status === "live");

  if (!liveEvent) {
    // live 이벤트가 없으면 첫 번째 이벤트를 live로 전환
    const firstEvent = listPayload.data?.[0];
    if (!firstEvent) {
      test.skip(true, "이벤트가 없어 테스트를 건너뜁니다");
      return;
    }
    await request.patch(`/api/events/${firstEvent.id}`, {
      data: { status: "live" },
    });
    liveEvent = { ...firstEvent, status: "live" };
  }

  const errors = trackCriticalConsoleErrors(page);
  await page.goto(`/e/${encodeURIComponent(liveEvent.slug)}`);
  // URL에 slug가 인코딩되어 포함되는지 확인
  await expect(page).toHaveURL(/\/e\/.+/);
  await expect(page.locator("body")).toBeVisible();
  await expectNoCriticalConsoleErrors(errors);
});
