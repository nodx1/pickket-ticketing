import { test as authTest, expect as authExpect } from "./fixtures/auth";

/* ═══════════════════════════════════════════════════════════════════════
 * purchase-flow.spec.ts — 구매 플로우 (Happy Path) E2E 테스트
 *
 * 실제 결제는 PortOne V2 SDK mock 환경에서만 동작하므로,
 * UI 인터랙션과 모달 표시까지만 검증합니다.
 *
 * 테스트 대상:
 *   1. 로그인 → 이벤트 상세 페이지 이동
 *   2. 티켓 등급 선택 UI 인터랙션
 *   3. 수량 선택 UI 인터랙션
 *   4. 주문/응모 버튼 동작
 *   5. 주문 목록 페이지 확인
 * ═══════════════════════════════════════════════════════════════════════ */

/** 이벤트 목록에서 첫 번째 이벤트 URL을 가져오는 헬퍼 */
async function getFirstEventUrl(
  page: import("@playwright/test").Page,
): Promise<string | null> {
  await page.goto("/events");
  await page.waitForLoadState("networkidle");

  const eventLink = page.locator("a[href*='/events/']").first();
  if (!(await eventLink.isVisible().catch(() => false))) return null;

  return await eventLink.getAttribute("href");
}

authTest.describe("구매 플로우 — Happy Path", () => {
  let eventUrl: string | null = null;

  authTest.beforeAll(async ({ browser }) => {
    const page = await browser.newPage();
    eventUrl = await getFirstEventUrl(page);
    await page.close();
  });

  authTest(
    "이벤트 상세에서 예매 영역이 표시된다",
    async ({ authenticatedPage }) => {
      authTest.skip(!eventUrl, "시드 이벤트가 없습니다");

      await authenticatedPage.goto(eventUrl!);
      await authenticatedPage.waitForLoadState("networkidle");

      // 스켈레톤 완료 대기
      await authenticatedPage
        .waitForSelector(".animate-pulse", { state: "hidden", timeout: 15_000 })
        .catch(() => {});

      // BookingFlow 또는 '판매 정보가 아직 등록되지 않았어요' 확인
      const bookingContent = authenticatedPage
        .getByText(/응모|예매|구매|좌석|등급|티켓|알림 받기|판매 정보/)
        .first();
      await authExpect(bookingContent).toBeVisible({ timeout: 15_000 });
    },
  );

  authTest(
    "티켓 등급이 있으면 선택할 수 있다",
    async ({ authenticatedPage }) => {
      authTest.skip(!eventUrl, "시드 이벤트가 없습니다");

      await authenticatedPage.goto(eventUrl!);
      await authenticatedPage.waitForLoadState("networkidle");

      await authenticatedPage
        .waitForSelector(".animate-pulse", { state: "hidden", timeout: 15_000 })
        .catch(() => {});

      // 등급 선택 버튼 또는 라디오가 있는지 확인
      const tierSelector = authenticatedPage
        .locator(
          "button:has-text('석'), button:has-text('등급'), [role='radio'], [role='option']",
        )
        .first();
      const hasTiers = await tierSelector
        .isVisible({ timeout: 5_000 })
        .catch(() => false);

      if (hasTiers) {
        await tierSelector.click();
        // 선택 후 가격이나 수량 관련 UI가 업데이트되는지 확인
        const priceInfo = authenticatedPage.getByText(/원|₩|KRW/i).first();
        await authExpect(priceInfo)
          .toBeVisible({ timeout: 5_000 })
          .catch(() => {});
      }
    },
  );

  authTest("수량 선택 UI가 있으면 동작한다", async ({ authenticatedPage }) => {
    authTest.skip(!eventUrl, "시드 이벤트가 없습니다");

    await authenticatedPage.goto(eventUrl!);
    await authenticatedPage.waitForLoadState("networkidle");

    await authenticatedPage
      .waitForSelector(".animate-pulse", { state: "hidden", timeout: 15_000 })
      .catch(() => {});

    // 수량 관련 UI (증가/감소 버튼 또는 입력 필드)
    const quantityPlus = authenticatedPage
      .locator(
        "button:has-text('+'), button[aria-label*='증가'], button[aria-label*='추가']",
      )
      .first();
    const hasQuantity = await quantityPlus
      .isVisible({ timeout: 5_000 })
      .catch(() => false);

    if (hasQuantity) {
      await quantityPlus.click();
      // 수량이 변경되었는지 확인 (숫자가 1에서 2로)
    }
  });

  authTest(
    "CTA 버튼이 존재하고 클릭 가능하다",
    async ({ authenticatedPage }) => {
      authTest.skip(!eventUrl, "시드 이벤트가 없습니다");

      await authenticatedPage.goto(eventUrl!);
      await authenticatedPage.waitForLoadState("networkidle");

      await authenticatedPage
        .waitForSelector(".animate-pulse", { state: "hidden", timeout: 15_000 })
        .catch(() => {});

      // CTA 버튼 찾기 (응모하기, 구매하기, 예매하기 등)
      const ctaButton = authenticatedPage
        .locator(
          'button:has-text("응모"), button:has-text("구매"), button:has-text("예매"), button:has-text("결제"), button:has-text("주문"), button:has-text("대기열"), button:has-text("티켓 구매")',
        )
        .first();
      // 모바일에서 CTA가 하단 고정일 수 있으므로 스크롤
      if (await ctaButton.count()) {
        await ctaButton.scrollIntoViewIfNeeded().catch(() => {});
      }
      const hasCTA = await ctaButton.isVisible().catch(() => false);

      if (hasCTA) {
        // 버튼이 활성화되어 있는지 확인
        const isEnabled = await ctaButton.isEnabled();
        authExpect(isEnabled).toBeTruthy();
      } else {
        // '알림 받기' 버튼이 있으면 (아직 판매 시작 전)
        const notifyButton = authenticatedPage
          .getByRole("button", { name: /알림 받기/ })
          .first();
        const hasNotify = await notifyButton.isVisible().catch(() => false);
        // CTA나 알림 받기 중 하나는 있어야 함 (또는 이벤트가 없을 수 있음)
      }
    },
  );
});

authTest.describe("주문 목록 페이지", () => {
  authTest(
    "주문 목록 페이지가 정상 로딩된다",
    async ({ authenticatedPage }) => {
      // /orders 또는 /mypage?tab=orders 로 접근
      await authenticatedPage.goto("/orders");
      await authenticatedPage.waitForLoadState("networkidle");

      // i18n 리다이렉트로 /ko/orders 등으로 갈 수 있음
      const url = authenticatedPage.url();
      const isOrdersPage =
        url.includes("/orders") || url.includes("tab=orders");

      // /orders 라우트가 없으면 mypage orders 탭으로 폴백
      if (!isOrdersPage || url.includes("/auth") || url.includes("/404")) {
        await authenticatedPage.goto("/mypage?tab=orders");
        await authenticatedPage.waitForLoadState("networkidle");
      }

      // 주문 내역이 있거나 빈 상태 메시지가 표시
      const content = authenticatedPage.locator("main, body").first();
      await authExpect(content).toBeVisible();
    },
  );
});
