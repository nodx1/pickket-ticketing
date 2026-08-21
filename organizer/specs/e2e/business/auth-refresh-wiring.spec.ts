/**
 * access 쿠키가 사라진 뒤에도 대시보드 저장이 살아남는가 (실동작).
 *
 * ── 재현하는 상황 ──
 * access 쿠키는 `max_age` 5분이라 **브라우저가 지운다**. refresh(7일)·logged_in(7일)은 남아
 * 화면은 로그인 상태로 보이고, 이미 그려진 페이지는 재검증되지 않는다.
 * 그래서 사용자는 **저장을 누른 순간** 처음 만료를 알고, 그땐 입력이 날아간다.
 *
 * 5분을 기다릴 수 없으므로 **쿠키를 지워** 같은 상태를 만든다. 만료와 구분되지 않는다 —
 * 서버 입장에서 둘 다 "access 쿠키 없음" 이다.
 */
import { expect, test } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { expectDialog } from "../helpers/dialog";

/** access 쿠키만 지운다(만료 재현). 나머지 쿠키는 그대로 둬야 화면이 로그인 상태로 남는다. */
async function dropAccessCookie(context: import("@playwright/test").BrowserContext) {
  const all = await context.cookies();
  const kept = all.filter((c) => c.name !== "pickket_access");
  expect(all.length - kept.length, "pickket_access 쿠키가 애초에 없었다 — 재현 실패").toBe(1);
  await context.clearCookies();
  await context.addCookies(kept);
  expect(
    (await context.cookies()).some((c) => c.name === "pickket_refresh"),
    "refresh 쿠키까지 지워지면 갱신 자체가 불가능해 실험이 무의미하다",
  ).toBe(true);
}

test.describe("5분 만료 후 저장 (인증 갱신 배선)", () => {
  test.use({ viewport: { width: 1440, height: 1200 } });

  test("access 쿠키가 없어도 상품 수정 저장이 성공한다 (refresh 경유)", async ({ page, context }) => {
    await loginAsDemoApi(page.request);

    // 상품이 있는 이벤트를 찾는다 — 수정 대상이 있어야 실험이 성립한다.
    const evs = (await (await page.request.get("/api/events?limit=50")).json()).data ?? [];
    let eventId: string | null = null;
    for (const e of evs.slice(0, 15)) {
      const r = await page.request.get(`/api/events/${e.id}/products`);
      if (r.ok() && (((await r.json()).data ?? []).length > 0)) { eventId = e.id; break; }
    }
    test.skip(!eventId, "상품이 있는 이벤트를 찾지 못해 건너뜀");

    await page.goto(`/events/${eventId}/products`);
    const editBtn = page.getByRole("button", { name: "수정" }).first();
    await expect(editBtn, "상품 목록이 안 뜬다 — 로드 실패이지 인증 문제가 아니다").toBeVisible({
      timeout: 15_000,
    });
    await editBtn.click();

    const dialog = await expectDialog(page, "상품 수정");
    const submit = dialog.getByRole("button", { name: "저장" });
    await expect(submit).toBeEnabled({ timeout: 10_000 });

    // ── 여기서 만료를 만든다 ──
    // ⚠️ 이 시점 이후로는 **네비게이션을 하면 안 된다** — (dashboard) layout 의
    //    getServerSession() 이 /login 으로 튕겨서 클라이언트 갱신 경로를 못 본다.
    //    사용자가 겪는 상황도 똑같다: 이미 떠 있는 화면에서 저장을 누르는 것.
    await dropAccessCookie(context);

    let refreshCalls = 0;
    let saveCalls = 0;
    page.on("request", (req) => {
      const u = new URL(req.url()).pathname;
      if (u === "/api/auth/refresh") refreshCalls += 1;
      if (/\/products(\/[^/]+)?$/.test(u) && req.method() !== "GET") saveCalls += 1;
    });

    // 값을 바꾸지 않고 그대로 저장한다 — 데이터는 그대로 두고 경로만 태운다.
    await submit.click();

    // 종전엔 여기서 401 → 저장 실패였고, 사용자는 그때 처음 만료를 알았다(입력이 날아갔다).
    await expect(
      page.getByText(/상품이 수정되었습니다/).first(),
      "access 쿠키가 없다고 저장이 죽었다 — 갱신 배선이 안 걸렸다",
    ).toBeVisible({ timeout: 15_000 });

    expect(refreshCalls, "갱신을 거치지 않고 성공했다면 이 테스트는 아무것도 증명하지 않는다").toBeGreaterThan(0);
    expect(saveCalls, "저장 요청이 재시도돼야 한다(첫 401 + 갱신 후 1회)").toBeGreaterThanOrEqual(2);
  });
});
