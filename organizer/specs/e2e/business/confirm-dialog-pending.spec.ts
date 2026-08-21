/**
 * S1/S1b 실동작 검증 — 확인창 재클릭 차단 · 발송 전 수신자 확정.
 *
 * ── 왜 E2E 인가 ──
 * `pending` 은 UI prop 이라 순수 판정 함수가 없다. 단위/배선 검사는 "소스에 prop 이 적혀
 * 있다"까지만 증명한다. **버튼이 실제로 잠기는가**는 렌더된 DOM 을 봐야 안다.
 * (배선 검사: `src/components/shared/confirm-dialog-wiring.test.ts`)
 *
 * ── 응답을 느리게 만드는 방법 ──
 * `page.route` 로 대상 API 를 가로채 지연시킨다. 실제 서버를 느리게 만들 수 없고,
 * 지연 없이는 "요청 중" 창이 순식간에 지나가 잠금 여부를 관측할 수 없다.
 *
 * ── 로컬 실행법 ──
 *   BASE_URL=http://localhost:PORT \
 *   E2E_REFUND_TARGET=<eventId>/<orderId> \
 *   npx playwright test specs/e2e/business/confirm-dialog-pending.spec.ts
 * `E2E_REFUND_TARGET` 이 없으면 환불 테스트는 자동탐색을 시도하고, 실패하면 skip 한다
 * (이유는 `gotoRefundableOrder` 주석 참고).
 *
 * ── 여기서 다루지 않는 것 ──
 * **입금확정**(`order-deposit-confirm-action.tsx`)의 실동작. 조건이 "offline 결제 + PG 결제
 * 없음 + pending" 인데 로컬 데이터에 해당 주문이 없다. 소스 수준 계약은 배선 검사가 지킨다.
 */
import { expect, test } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { expectDialog, expectNoDialog } from "../helpers/dialog";

// ⚠️ `request` 픽스처는 page 와 **다른 컨텍스트**다. 브라우저로 이동할 테스트는 반드시
//    `page.request` 로 로그인해야 쿠키가 page 컨텍스트에 붙는다(처음 이걸로 전건 실패했다).

type Ctx = import("@playwright/test").APIRequestContext;

async function listEvents(request: Ctx) {
  const res = await request.get("/api/events?limit=50");
  if (!res.ok()) return [];
  const body = (await res.json()) as { data?: Array<{ id: string; status?: string }> };
  return body.data ?? [];
}

/** 데모 계정의 첫 이벤트 id. 없으면 해당 테스트를 skip 한다(시드 의존 회피). */
async function firstEventId(request: Ctx) {
  return (await listEvents(request))[0]?.id ?? null;
}

/**
 * **삭제 버튼이 실제로 렌더되는** 이벤트 id.
 *
 * ⚠️ 위험영역 카드는 `draft | rejected | pending_review` 에서만 렌더된다
 *    (`event-danger-zone.tsx` 의 early return). 첫 이벤트를 그냥 집으면 대개 `live` 라
 *    버튼이 아예 없고, 테스트가 "버튼 못 찾음"으로 죽는다 — 실제로 그렇게 실패했다.
 */
const DELETABLE = new Set(["draft", "rejected", "pending_review"]);
async function deletableEventId(request: Ctx) {
  const found = (await listEvents(request)).find((e) => DELETABLE.has(e.status ?? ""));
  return found?.id ?? null;
}

/**
 * **환불 카드가 실제로 렌더되는** 주문으로 이동한다. 찾으면 그 주문을, 없으면 null.
 *
 * ⚠️ 목록의 `status === "completed"` 만 보고 집으면 안 된다. 상세 페이지는 `getOrderDetail`
 *    이 비면 목록으로 **redirect** 하고(page.tsx:53), 그러면 테스트는 "버튼 없음"이 아니라
 *    엉뚱한 화면에서 죽는다 — 실제로 그렇게 실패했다(0원 RSVP 주문).
 *
 * ⚠️ 그렇다고 `request.get(상세 URL)` 로 HTML 을 미리 받아 판별하면 안 된다. API 컨텍스트로
 *    받은 문서는 **정상 페이지(`/settings` 포함)까지 전부 404 쉘**로 돌아온다(실측).
 *    그래서 판별은 반드시 **실제 네비게이션**으로 한다.
 */
async function gotoRefundableOrder(page: import("@playwright/test").Page, maxTries = 8) {
  // ── 명시 지정 경로 ──
  // 로컬에서는 자동탐색이 **구조적으로** 실패한다: 주문 목록 API 는 v2 가 원천이고, 상세는
  // go DB + v2 단건을 둘 다 타는데, 로컬 v2 DB 가 초기화돼 "목록에 뜨는 주문"과 "상세가 열리는
  // 주문"의 교집합이 비어 있다. 그럴 때 `E2E_REFUND_TARGET=<eventId>/<orderId>` 로 지정한다.
  const explicit = process.env.E2E_REFUND_TARGET;
  if (explicit) {
    const [eventId, orderId] = explicit.split("/");
    await page.goto(`/events/${eventId}/orders/${orderId}`);
    await expect(
      page.getByRole("button", { name: "환불하기" }),
      `E2E_REFUND_TARGET(${explicit}) 상세에 환불 카드가 없다 — 지정값을 확인하라`,
    ).toBeVisible({ timeout: 15_000 });
    return { eventId: eventId!, orderId: orderId! };
  }

  let tries = 0;
  for (const e of await listEvents(page.request)) {
    const res = await page.request.get(`/api/events/${e.id}/orders?limit=20`);
    // ⚠️ 이 라우트는 `PLAYWRIGHT_TEST=1` 로도 레이트리밋이 안 풀린다. 50개 이벤트를 연속으로
    //    긁으면 뒤쪽이 429 로 잘려 후보를 놓친다(실측: idx 36부터 429). 429 면 한 번 쉬고 재시도.
    let body: { data?: Array<{ id: string; status?: string; totalAmount?: number }> } = {};
    if (res.status() === 429) {
      await page.waitForTimeout(1200);
      const retry = await page.request.get(`/api/events/${e.id}/orders?limit=20`);
      if (!retry.ok()) continue;
      body = await retry.json();
    } else if (res.ok()) {
      body = await res.json();
    } else {
      continue;
    }

    for (const o of body.data ?? []) {
      if (o.status !== "completed" || (o.totalAmount ?? 0) <= 0) continue;
      if (++tries > maxTries) return null;
      // ⚠️ 목록에 뜬다고 상세가 열리는 건 아니다. 상세는 go DB + v2 단건 read 를 둘 다 타서
      //    ① go 에 없으면 목록으로 redirect, ② v2 에 없으면 ORDER_NOT_FOUND 로 에러 바운더리.
      //    (로컬은 v2 DB 가 초기화돼 대부분 ②로 떨어진다.) 그래서 **열리는 것**을 골라 쓴다.
      await page.goto(`/events/${e.id}/orders/${o.id}`);
      const shown = await page
        .getByRole("button", { name: "환불하기" })
        .waitFor({ state: "visible", timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      if (shown) return { eventId: e.id, orderId: o.id };
    }
  }
  return null;
}

test.describe("확인창 — 비가역 동작 재클릭 차단 (S1)", () => {
  test.use({ viewport: { width: 1440, height: 1300 } });

  test("이벤트 삭제: 요청 중에는 확인 버튼이 잠기고 문구가 '처리 중...' 으로 바뀐다", async ({
    page,
  }) => {
    await loginAsDemoApi(page.request);
    const eventId = await deletableEventId(page.request);
    test.skip(!eventId, "삭제 가능한 상태(draft/rejected/pending_review)의 이벤트가 없어 건너뜀");

    // 삭제 요청을 2초 지연 + 최종 실패로 만든다. 실제로 지우지 않기 위해서다.
    let deleteCalls = 0;
    await page.route(`**/api/events/${eventId}`, async (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      deleteCalls += 1;
      await new Promise((r) => setTimeout(r, 2000));
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "테스트용 지연 응답" }),
      });
    });

    await page.goto(`/events/${eventId}/settings`);

    // ⚠️ 설정 페이지는 go DB 를 직접 읽는다(영향범위 카운트). 로컬 `.env.local` 의 go DB
    //    접속정보가 어긋나면 에러 바운더리로 떨어져 이 테스트를 돌릴 수 없다.
    //    조용히 건너뛰지 않고 **이유를 남기고** 건너뛴다 — 초록으로 위장하지 않기 위해.
    const errorBoundary = page.getByRole("button", { name: "다시 시도" });
    if (await errorBoundary.isVisible().catch(() => false)) {
      test.skip(true, "설정 페이지가 에러 바운더리로 떨어짐 — 로컬 go DB 접속정보 확인 필요(PG_PORT/PG_USER)");
    }

    // ⚠️ `.first()` 로 뭉개지 않는다 — 매칭이 여러 개면 엉뚱한 버튼을 눌러도 초록이 된다.
    //    유일성을 먼저 단언하고, 그다음 그 하나를 쓴다.
    const triggers = page.getByRole("button", { name: /이벤트 삭제|삭제하기/ });
    await expect(triggers, "삭제 트리거가 유일하지 않다").toHaveCount(1, { timeout: 15_000 });
    const trigger = triggers.first();
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();

    const dialog = await expectDialog(page, "이벤트를 삭제할까요?");

    const confirm = dialog.getByRole("button", { name: "삭제" });
    await expect(confirm).toBeEnabled();
    await confirm.click();

    // 요청이 도는 동안: 확인 버튼 잠김 + 문구 전환
    const pendingBtn = dialog.getByRole("button", { name: "처리 중..." });
    await expect(pendingBtn).toBeVisible();
    await expect(pendingBtn).toBeDisabled();

    // 취소 버튼도 잠긴다(ConfirmDialog 설계 — 진행 중 창을 못 닫는다)
    await expect(dialog.getByRole("button", { name: "취소" })).toBeDisabled();

    // 재클릭해도 요청이 늘지 않는다 — 이 배치의 핵심 단언
    await pendingBtn.click({ force: true }).catch(() => undefined);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
    expect(deleteCalls, "요청 중 재클릭/ESC 로 삭제 요청이 중복 발사됐다").toBe(1);

    await page.waitForTimeout(2500);
    expect(deleteCalls).toBe(1);
  });
});

test.describe("금전 화면 — 실패해도 서버 상태를 다시 읽는다 (S1b)", () => {
  test.use({ viewport: { width: 1440, height: 1300 } });

  test("환불 실패 후 router.refresh() 가 실제로 나간다", async ({ page }) => {
    await loginAsDemoApi(page.request);
    const target = await gotoRefundableOrder(page);
    test.skip(!target, "환불 카드가 뜨는 completed 주문을 찾지 못해 건너뜀");
    const { eventId, orderId } = target!;
    const pageUrl = `/events/${eventId}/orders/${orderId}`;

    await page.route(`**/api/events/${eventId}/orders/${orderId}/refund`, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      await new Promise((r) => setTimeout(r, 1500));
      await route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "테스트용 실패 응답" }),
      });
    });

    const trigger = page.getByRole("button", { name: "환불하기" });
    await expect(trigger).toBeVisible();
    test.skip(!(await trigger.isEnabled()), "이 주문은 환불 불가 상태(canRefund=false)라 건너뜀");

    // ── refresh 관측 방법 ──
    // `router.refresh()` 는 현재 URL 로 `RSC: 1` 헤더가 붙은 재요청을 낸다. 클릭 **이후**의
    // 것만 세기 위해 리스너를 여기서 건다(진입 시 프리페치도 RSC 라 섞이면 무의미해진다).
    let rscRefetches = 0;
    page.on("request", (req) => {
      if (req.headers()["rsc"] === "1" && new URL(req.url()).pathname.endsWith(pageUrl)) {
        rscRefetches += 1;
      }
    });

    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();

    const dialog = await expectDialog(page, "환불을 진행할까요?");
    await dialog.getByRole("button", { name: "환불 진행" }).click();

    // 요청 중 재클릭 차단(S1 와 같은 계약, 금전 경로라 별도로 확인한다)
    const pendingBtn = dialog.getByRole("button", { name: "처리 중..." });
    await expect(pendingBtn).toBeVisible();
    await expect(pendingBtn).toBeDisabled();

    // 실패 문구가 뜬 뒤 — 그래도 서버를 다시 읽어야 한다
    await expect(page.getByText("테스트용 실패 응답")).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() => rscRefetches, {
        message: "환불 실패 경로에서 router.refresh() 가 나가지 않았다 — 옛 화면 기준 재시도 위험",
        timeout: 8000,
      })
      .toBeGreaterThan(0);
  });
});

test.describe("메시지 발송 — 수신자 수 확정 후에 확인창이 열린다 (S1)", () => {
  // 작성 모달이 길어 기본 뷰포트에서는 하단 [발송] 이 화면 밖이다(클릭 타임아웃).
  test.use({ viewport: { width: 1440, height: 1300 } });

  test("dryRun 이 도는 동안 확인창이 열리지 않고 발송 버튼이 잠긴다", async ({ page }) => {
    await loginAsDemoApi(page.request);
    const eventId = await firstEventId(page.request);
    test.skip(!eventId, "데모 계정에 이벤트가 없어 건너뜀");

    let dryRunSeen = 0;
    let realSendSeen = 0;
    await page.route(`**/api/events/${eventId}/messages`, async (route) => {
      const req = route.request();
      if (req.method() !== "POST") return route.fallback();
      const body = JSON.parse(req.postData() ?? "{}") as { dryRun?: boolean };
      if (body.dryRun) {
        dryRunSeen += 1;
        await new Promise((r) => setTimeout(r, 2000)); // 느린 dryRun
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ success: true, data: { recipientCount: 42 } }),
        });
      }
      realSendSeen += 1; // 실발송은 절대 나가면 안 된다
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ success: true, data: {} }),
      });
    });

    await page.goto(`/events/${eventId}/messages`);
    // ⚠️ `isVisible()` 은 대기하지 않는다. 이걸 skip 조건으로 쓰면 로딩이 조금만 늦어도
    //    **조용히 건너뛰고 초록**이 된다(실제로 그렇게 됐다). 기다렸다가 없으면 실패시킨다.
    const compose = page.getByRole("button", { name: "메시지 보내기" }).first();
    await expect(compose).toBeVisible({ timeout: 15_000 });
    await compose.click();

    await page.locator("#message-title").fill("E2E 확인용 제목");
    await page.locator("#message-body").fill("E2E 확인용 본문");

    const send = page.getByRole("button", { name: /^발송$|^예약$/ });
    await send.scrollIntoViewIfNeeded();
    await send.click();

    const CONFIRM_TITLE = "메시지를 발송하시겠습니까?";

    // dryRun 도는 동안: 확인창이 아직 없고, 발송 버튼은 잠겨 있다.
    // ⚠️ 순서 주의 — 확인창 부재를 **먼저** 본다. 확인창이 먼저 열려버리면 Radix 가 배경을
    //    `aria-hidden` 으로 덮어 "수신자 확인 중…" 버튼도 같이 사라진다. 그 상태로 버튼
    //    단언을 앞에 두면 결함의 **간접 증상**에서 죽어 원인이 흐려진다(뮤테이션에서 확인).
    await expectNoDialog(page, CONFIRM_TITLE, "수신자 수가 확정되기 전에 확인창이 열렸다");
    await expect(page.getByRole("button", { name: "수신자 확인 중…" })).toBeDisabled();
    expect(realSendSeen, "수신자 수를 모르는 채 실발송이 나갔다").toBe(0);

    // dryRun 이 끝나면 확인창이 열리고, 수신자 수가 표시된다
    const confirmDialog = await expectDialog(page, CONFIRM_TITLE, { timeout: 6000 });
    await expect(confirmDialog).toContainText("42명");
    expect(dryRunSeen).toBe(1);
    expect(realSendSeen).toBe(0);
  });
});
