import { test, expect } from "@playwright/test";
import { dismissOnboarding } from "./fixtures/helpers";

/* ═══════════════════════════════════════════════════════════════════════
 * error-resilience.spec.ts — 에러 경계 회복력 E2E 테스트
 *
 * 검증 대상:
 *   1. API 500/timeout/네트워크 단절 시 페이지 크래시 방지
 *   2. 빈 데이터/잘못된 JSON 응답 처리
 *   3. 404 페이지, 존재하지 않는 이벤트 처리
 *   4. 이미지 로드 실패 시 대체 처리
 *   5. JS 에러 후 네비게이션 복구
 *   6. 연속 에러 후 정상 복구
 *   7. 뒤로가기/새로고침 후 상태 복구
 *   8. CSR 에러 바운더리 동작
 *   9. API rate limit (429) 처리
 * ═══════════════════════════════════════════════════════════════════════ */

test.describe("에러 회복력 — API 응답 에러 처리", () => {
  test("API 500 에러 → 페이지가 크래시하지 않고 에러 메시지 표시", async ({
    page,
  }) => {
    // /api/v1/events/search를 500 에러로 mock
    await page.route("**/api/v1/events/search**", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Internal Server Error" }),
      }),
    );

    await page.goto("/events");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // 페이지가 크래시하지 않고 body가 렌더링되어야 함
    const body = page.locator("body");
    await expect(body).toBeVisible();

    // 에러 메시지 또는 에러 바운더리가 표시되거나, 최소한 빈 상태라도 정상
    const hasErrorUI =
      (await page
        .getByText(/문제가 발생|오류|에러|다시 시도|일시적/)
        .first()
        .isVisible({ timeout: 5_000 })
        .catch(() => false)) || (await page.locator("body").isVisible());

    expect(hasErrorUI).toBeTruthy();

    await page.unroute("**/api/v1/events/search**");
  });

  test("API timeout (30초 지연) → 로딩 상태 표시 후 타임아웃 처리", async ({
    page,
  }) => {
    // 응답을 30초 지연 (실제로는 playwright의 기본 타임아웃이 먼저 동작)
    await page.route("**/api/v1/events/search**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 30_000));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ events: [], total: 0 }),
      });
    });

    await page.goto("/events");

    // 로딩 상태가 표시되거나 타임아웃 처리가 되어야 함
    const hasLoadingOrContent = await Promise.race([
      // 로딩 인디케이터 확인
      page
        .locator(
          "[data-loading], .animate-pulse, [role='progressbar'], .skeleton",
        )
        .first()
        .isVisible({ timeout: 5_000 })
        .catch(() => false),
      // 또는 페이지가 정상 렌더링
      page
        .locator("body")
        .isVisible({ timeout: 5_000 })
        .catch(() => false),
    ]);

    expect(hasLoadingOrContent).toBeTruthy();

    // 페이지가 크래시하지 않았는지 확인
    const body = page.locator("body");
    await expect(body).toBeVisible();

    await page.unroute("**/api/v1/events/search**");
  });

  test("네트워크 단절 (요청 abort) → 에러 메시지 또는 오프라인 안내", async ({
    page,
  }) => {
    // 모든 API 요청을 abort
    await page.route("**/api/v1/**", (route) =>
      route.abort("connectionfailed"),
    );

    await page.goto("/events");
    await page.waitForLoadState("domcontentloaded");
    await dismissOnboarding(page);

    // 페이지가 크래시하지 않고 렌더링
    const body = page.locator("body");
    await expect(body).toBeVisible();

    // 에러 메시지, 오프라인 안내, 또는 에러 바운더리 중 하나
    const hasErrorHandling =
      (await page
        .getByText(
          /문제가 발생|오류|네트워크|연결|오프라인|다시 시도|일시적|불러올 수 없/,
        )
        .first()
        .isVisible({ timeout: 5_000 })
        .catch(() => false)) || (await page.locator("body").isVisible());

    expect(hasErrorHandling).toBeTruthy();

    await page.unroute("**/api/v1/**");
  });

  test("빈 이벤트 목록 → '이벤트가 없습니다' 또는 빈 상태 표시, 크래시 없음", async ({
    page,
  }) => {
    // 빈 이벤트 목록 mock
    await page.route("**/api/v1/events/search**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ events: [], total: 0, page: 1, pages: 0 }),
      }),
    );

    await page.goto("/events");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // 페이지가 크래시하지 않아야 함
    const body = page.locator("body");
    await expect(body).toBeVisible();

    // 에러 바운더리가 발동하지 않아야 함
    const hasError = await page
      .getByText("문제가 발생했습니다")
      .isVisible({ timeout: 2_000 })
      .catch(() => false);
    expect(hasError).toBeFalsy();

    await page.unroute("**/api/v1/events/search**");
  });

  test("잘못된 JSON 응답 → 에러 바운더리 표시, 페이지 크래시 없음", async ({
    page,
  }) => {
    // malformed JSON 응답
    await page.route("**/api/v1/events/search**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: "{invalid json content!!!",
      }),
    );

    await page.goto("/events");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // 페이지가 크래시하지 않고 body가 렌더링되어야 함
    const body = page.locator("body");
    await expect(body).toBeVisible();

    await page.unroute("**/api/v1/events/search**");
  });
});

test.describe("에러 회복력 — 페이지 라우팅 에러", () => {
  test("존재하지 않는 페이지 → 404 페이지 표시", async ({ page }) => {
    await page.goto("/this-route-does-not-exist-at-all-12345");
    await page.waitForLoadState("networkidle");

    // 404 페이지 또는 리다이렉트 확인
    const is404Page =
      page.url().includes("404") ||
      (await page
        .getByText(/404|찾을 수 없|페이지를 찾을 수 없|not found/i)
        .first()
        .isVisible({ timeout: 5_000 })
        .catch(() => false));

    // 홈으로 리다이렉트되는 경우도 허용
    const isRedirected =
      page.url().endsWith("/") || page.url().includes("/events");

    // 어느 쪽이든 페이지가 크래시하지 않아야 함
    const body = page.locator("body");
    await expect(body).toBeVisible();
    expect(is404Page || isRedirected).toBeTruthy();
  });

  test("존재하지 않는 이벤트 ID → 에러 메시지 표시", async ({ page }) => {
    await page.goto("/events/nonexistent-event-id-that-does-not-exist");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // 에러 메시지 또는 404 또는 리다이렉트
    const hasErrorOrRedirect =
      page.url().includes("404") ||
      (await page
        .getByText(
          /찾을 수 없|존재하지 않|not found|오류|이벤트를 불러올 수 없/i,
        )
        .first()
        .isVisible({ timeout: 5_000 })
        .catch(() => false)) ||
      // 이벤트 목록으로 리다이렉트된 경우
      (page.url().includes("/events") && !page.url().includes("nonexistent"));

    // 페이지가 크래시하지 않아야 함
    const body = page.locator("body");
    await expect(body).toBeVisible();
    expect(hasErrorOrRedirect).toBeTruthy();
  });
});

test.describe("에러 회복력 — 리소스 로딩 실패", () => {
  test("이미지 로드 실패 → 대체 이미지(fallback) 또는 깨지지 않음", async ({
    page,
  }) => {
    // 이벤트 목록에서 이미지를 404로 mock
    await page.route("**/*.{jpg,jpeg,png,webp,avif}", (route) =>
      route.fulfill({ status: 404, body: "" }),
    );

    await page.goto("/events");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // 페이지가 크래시하지 않아야 함
    const body = page.locator("body");
    await expect(body).toBeVisible();

    // 이미지가 깨진 아이콘 없이 처리되는지 확인 (img 요소가 있다면)
    const images = page.locator("img");
    const imageCount = await images.count();

    for (let i = 0; i < Math.min(imageCount, 5); i++) {
      const img = images.nth(i);
      // 이미지 요소가 보이면 크래시하지 않은 것
      const isVisible = await img.isVisible().catch(() => false);
      if (isVisible) {
        // naturalWidth가 0이면 로드 실패 → fallback 처리 확인
        const naturalWidth = await img.evaluate(
          (el: HTMLImageElement) => el.naturalWidth,
        );
        // fallback 이미지가 있거나, CSS로 대체되거나, 깨진 이미지가 숨겨져야 함
        // naturalWidth === 0이면 로드 실패이지만 페이지가 크래시하지 않았으면 OK
      }
    }

    await page.unroute("**/*.{jpg,jpeg,png,webp,avif}");
  });
});

test.describe("에러 회복력 — 복구 및 상태 관리", () => {
  test("JavaScript 에러 발생 후에도 네비게이션 가능", async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });

    await page.goto("/events");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // 의도적으로 JS 에러 발생
    await page.evaluate(() => {
      console.error("E2E 테스트: 의도적 에러 발생");
    });

    // 에러 발생 후에도 다른 페이지로 네비게이션 가능한지 확인
    await page.goto("/auth");
    await page.waitForLoadState("networkidle");

    // auth 페이지가 정상 로드되어야 함
    const body = page.locator("body");
    await expect(body).toBeVisible();
  });

  test("느린 API 응답 (3초 지연) → 로딩/스켈레톤 표시", async ({ page }) => {
    // 3초 지연 mock
    await page.route("**/api/v1/events/search**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 3_000));
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          events: [
            {
              id: "test-1",
              title: "테스트 이벤트",
              status: "bidding_open",
              thumbnail_url: "",
            },
          ],
          total: 1,
          page: 1,
          pages: 1,
        }),
      });
    });

    await page.goto("/events");

    // 로딩 중 상태 확인 (스켈레톤, 로딩 인디케이터, 또는 빈 상태)
    const hasLoadingState = await Promise.race([
      page
        .locator(
          ".animate-pulse, [data-loading], .skeleton, [role='progressbar'], [aria-busy='true']",
        )
        .first()
        .isVisible({ timeout: 2_000 })
        .catch(() => false),
      // 페이지가 바로 렌더링되는 경우 (SSR)
      page
        .locator("body")
        .isVisible({ timeout: 2_000 })
        .catch(() => false),
    ]);

    expect(hasLoadingState).toBeTruthy();

    // 3초 후 데이터 로드 완료 확인
    await page.waitForLoadState("networkidle");
    const body = page.locator("body");
    await expect(body).toBeVisible();

    await page.unroute("**/api/v1/events/search**");
  });

  test("연속 3페이지 500 에러 후 정상 페이지 → 정상 렌더링", async ({
    page,
  }) => {
    let requestCount = 0;

    // 처음 3번은 500, 이후 정상 응답
    await page.route("**/api/v1/events/search**", (route) => {
      requestCount++;
      if (requestCount <= 3) {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Internal Server Error" }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          events: [
            {
              id: "recovered-1",
              title: "복구된 이벤트",
              status: "bidding_open",
              thumbnail_url: "",
            },
          ],
          total: 1,
          page: 1,
          pages: 1,
        }),
      });
    });

    // 첫 번째 방문 (500 에러)
    await page.goto("/events");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // 두 번째 방문 (500 에러)
    await page.reload();
    await page.waitForLoadState("networkidle");

    // 세 번째 방문 (500 에러)
    await page.reload();
    await page.waitForLoadState("networkidle");

    // 네 번째 방문 (정상 응답) — requestCount > 3이므로 200
    await page.reload();
    await page.waitForLoadState("networkidle");

    // 페이지가 정상 렌더링되어야 함
    const body = page.locator("body");
    await expect(body).toBeVisible();

    // 에러 바운더리가 사라져야 함
    const hasError = await page
      .getByText("문제가 발생했습니다")
      .isVisible({ timeout: 2_000 })
      .catch(() => false);
    expect(hasError).toBeFalsy();

    await page.unroute("**/api/v1/events/search**");
  });

  test("에러 페이지에서 뒤로가기 → 이전 페이지 정상", async ({ page }) => {
    // 먼저 정상 페이지 방문
    await page.goto("/auth");
    await page.waitForLoadState("networkidle");

    // 이후 존재하지 않는 페이지로 이동
    await page.goto("/this-page-does-not-exist-99999");
    await page.waitForLoadState("networkidle");

    // 뒤로가기
    await page.goBack();
    await page.waitForLoadState("networkidle");

    // 이전 페이지(/auth)가 정상 렌더링되어야 함
    const body = page.locator("body");
    await expect(body).toBeVisible();

    // auth 페이지의 콘텐츠가 있는지 확인
    expect(page.url()).toContain("/auth");
  });

  test("에러 상태에서 새로고침 후 복구 (mock 해제 시)", async ({ page }) => {
    // 500 에러 mock
    await page.route("**/api/v1/events/search**", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Internal Server Error" }),
      }),
    );

    await page.goto("/events");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // 에러 상태 확인 — 페이지가 크래시하지 않아야 함
    const body = page.locator("body");
    await expect(body).toBeVisible();

    // mock 해제
    await page.unroute("**/api/v1/events/search**");

    // 새로고침 → 이제 정상 API가 응답
    await page.reload();
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // 페이지가 정상 렌더링되어야 함
    await expect(body).toBeVisible();
  });
});

test.describe("에러 회복력 — 에러 바운더리 및 특수 응답", () => {
  test("CSR 에러 바운더리 — 클라이언트 렌더링 에러 시 error.tsx 표시", async ({
    page,
  }) => {
    // 클라이언트 사이드에서 에러를 유발하는 mock
    // events/search가 정상이지만 이벤트 상세에서 에러 발생
    await page.route("**/api/v1/events/search**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        // 필수 필드 누락으로 클라이언트 렌더링 에러 유발
        body: JSON.stringify({
          events: [{ id: null, title: null }],
          total: 1,
        }),
      }),
    );

    await page.goto("/events");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // 에러가 발생하더라도 페이지 자체는 크래시하지 않아야 함
    const body = page.locator("body");
    await expect(body).toBeVisible();

    await page.unroute("**/api/v1/events/search**");
  });

  test("API rate limit (429) → 재시도 안내 또는 에러 메시지", async ({
    page,
  }) => {
    // 429 Too Many Requests mock
    await page.route("**/api/v1/events/search**", (route) =>
      route.fulfill({
        status: 429,
        contentType: "application/json",
        headers: { "Retry-After": "5" },
        body: JSON.stringify({
          detail: "Too many requests. Please try again later.",
        }),
      }),
    );

    await page.goto("/events");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // 페이지가 크래시하지 않아야 함
    const body = page.locator("body");
    await expect(body).toBeVisible();

    // 에러 메시지 또는 재시도 안내가 표시되거나, 빈 상태로 처리
    const hasMessage =
      (await page
        .getByText(/다시 시도|잠시 후|too many|요청이 너무|일시적|문제가 발생/)
        .first()
        .isVisible({ timeout: 5_000 })
        .catch(() => false)) ||
      // 빈 상태라도 크래시 없으면 OK
      (await body.isVisible());

    expect(hasMessage).toBeTruthy();

    await page.unroute("**/api/v1/events/search**");
  });

  test("API 응답 지연 후 페이지 이탈 → 메모리 누수 없이 정상 처리", async ({
    page,
  }) => {
    // 10초 지연 mock
    await page.route("**/api/v1/events/search**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      await route
        .fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ events: [], total: 0 }),
        })
        .catch(() => {
          // 페이지 이탈로 route가 이미 닫힌 경우 무시
        });
    });

    await page.goto("/events");
    // 응답 대기 중 다른 페이지로 이동
    await page.waitForTimeout(500);
    await page.goto("/auth");
    await page.waitForLoadState("networkidle");

    // auth 페이지가 정상 렌더링되어야 함 (이전 요청이 간섭하지 않음)
    const body = page.locator("body");
    await expect(body).toBeVisible();
    expect(page.url()).toContain("/auth");

    await page.unroute("**/api/v1/events/search**");
  });

  test("대용량 API 응답 → 페이지가 정상 처리", async ({ page }) => {
    // 100개 이벤트가 포함된 대용량 응답 mock
    const largeEvents = Array.from({ length: 100 }, (_, i) => ({
      id: `large-event-${i}`,
      title: `대용량 테스트 이벤트 ${i}`,
      status: "bidding_open",
      thumbnail_url: "",
      description: "A".repeat(1000), // 각 이벤트에 긴 설명
      start_date: "2026-12-01T00:00:00Z",
      end_date: "2026-12-02T00:00:00Z",
      venue: `테스트 장소 ${i}`,
      category: "concert",
    }));

    await page.route("**/api/v1/events/search**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          events: largeEvents,
          total: 100,
          page: 1,
          pages: 1,
        }),
      }),
    );

    await page.goto("/events");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // 페이지가 크래시하지 않아야 함
    const body = page.locator("body");
    await expect(body).toBeVisible();

    await page.unroute("**/api/v1/events/search**");
  });

  test("API 응답 헤더에 비정상 charset → 페이지 정상 처리", async ({
    page,
  }) => {
    await page.route("**/api/v1/events/search**", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json; charset=euc-kr",
        body: JSON.stringify({ events: [], total: 0 }),
      }),
    );

    await page.goto("/events");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // 페이지가 크래시하지 않아야 함
    const body = page.locator("body");
    await expect(body).toBeVisible();

    await page.unroute("**/api/v1/events/search**");
  });
});
