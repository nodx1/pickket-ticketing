/**
 * S3 실동작 검증 — `useConfirmAction` 으로 새로 잠근 확인창.
 *
 * 22곳을 한 번에 바꿨다. 전수 배선 검사(`confirm-dialog-wiring.test.ts` §9)는 prop 전달만
 * 본다 — **요청 완료 전에 창이 닫혀버리면 pending 은 보이지도 않는다**(S3 에서 12곳이 그랬다).
 * 그래서 그 12곳 유형 중 하나를 실제 브라우저로 확인한다.
 *
 * 대상: 상품 삭제(`event-products-client`). 파괴적 동작이고 지연 주입이 쉽다.
 */
import { expect, test } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { expectDialog } from "../helpers/dialog";

test.describe("확인창 잠금 — S3 신규 배선", () => {
  test.use({ viewport: { width: 1440, height: 1200 } });

  test("상품 삭제: 요청 중 버튼이 잠기고, 재클릭해도 요청이 늘지 않는다", async ({ page }) => {
    await loginAsDemoApi(page.request);
    const evs = (await (await page.request.get("/api/events?limit=50")).json()).data ?? [];

    // 상품이 있는 이벤트를 찾는다 — 없으면 삭제 버튼 자체가 없다.
    let target: { eventId: string } | null = null;
    for (const e of evs.slice(0, 15)) {
      const r = await page.request.get(`/api/events/${e.id}/products`);
      if (!r.ok()) continue;
      const rows = (await r.json()).data ?? [];
      if (rows.length) { target = { eventId: e.id }; break; }
    }
    test.skip(!target, "상품이 있는 이벤트를 찾지 못해 건너뜀");

    let deleteCalls = 0;
    await page.route(`**/api/events/${target!.eventId}/products/*`, async (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      deleteCalls += 1;
      await new Promise((r) => setTimeout(r, 2000));
      await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "테스트용 지연" }) });
    });

    await page.goto(`/events/${target!.eventId}/products`);
    const trigger = page.getByRole("button", { name: "삭제" }).first();
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();

    const dialog = await expectDialog(page, "상품을 삭제할까요?");
    await dialog.getByRole("button", { name: "삭제하기" }).click();

    // 종전엔 여기서 창이 그대로 있고 버튼도 계속 눌렸다.
    const pendingBtn = dialog.getByRole("button", { name: "처리 중..." });
    await expect(pendingBtn, "확인 버튼이 '처리 중...' 으로 바뀌지 않았다").toBeVisible();
    await expect(pendingBtn).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "취소" })).toBeDisabled();

    await pendingBtn.click({ force: true }).catch(() => undefined);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    expect(deleteCalls, "요청 중 재클릭으로 삭제가 중복 발사됐다").toBe(1);

    await page.waitForTimeout(2200);
    expect(deleteCalls).toBe(1);
  });

  /**
   * 🔴 네트워크 단절 — HTTP 오류와 **다른 경로**다.
   *
   * 호출 핸들러 21개 중 11개는 `!response.ok` 만 처리하고 fetch 자체의 거부는 처리하지 않는다.
   * 1차 구현에서는 그 거부가 `void runGuarded(...)` 에 버려져 **아무 표시도 없었다** —
   * HTTP 500 은 토스트가 뜨는데 단절은 무음이라 실패마다 반응이 달랐다. 그리고 pending 은
   * 풀리므로 사용자는 "안 눌렸나" 하고 다시 누른다(현장 모바일에서 실제로 날 그림).
   */
  test("네트워크가 끊기면 무음이 아니라 오류 문구가 뜬다", async ({ page }) => {
    await loginAsDemoApi(page.request);
    const evs = (await (await page.request.get("/api/events?limit=50")).json()).data ?? [];
    let target: { eventId: string } | null = null;
    for (const e of evs.slice(0, 15)) {
      const r = await page.request.get(`/api/events/${e.id}/products`);
      if (!r.ok()) continue;
      if (((await r.json()).data ?? []).length) { target = { eventId: e.id }; break; }
    }
    test.skip(!target, "상품이 있는 이벤트를 찾지 못해 건너뜀");

    // HTTP 오류가 아니라 **연결 실패**. `handleDelete` 에 catch 가 없어 그대로 던진다.
    await page.route(`**/api/events/${target!.eventId}/products/*`, async (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      await route.abort("failed");
    });

    await page.goto(`/events/${target!.eventId}/products`);
    const trigger = page.getByRole("button", { name: "삭제" }).first();
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();

    const dialog = await expectDialog(page, "상품을 삭제할까요?");
    await dialog.getByRole("button", { name: "삭제하기" }).click();

    // 훅의 기본 실패 문구가 뜬다(호출부에 catch 가 없어도).
    await expect(
      page.getByText(/처리 중 문제가 발생했습니다/),
      "네트워크 단절인데 사용자에게 아무 표시도 없다 — 무음 실패",
    ).toBeVisible({ timeout: 10_000 });

    // 잠금은 풀려서 재시도할 수 있어야 한다(영영 잠기면 창을 닫지도 못한다).
    await expect(dialog.getByRole("button", { name: "삭제하기" })).toBeEnabled();
  });
});
