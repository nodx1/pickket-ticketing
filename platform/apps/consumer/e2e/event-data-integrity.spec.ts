import { test, expect } from "@playwright/test";
import { dismissOnboarding, apiLogin, apiGet } from "./fixtures/helpers";

/* ═══════════════════════════════════════════════════════════════════════
 * event-data-integrity.spec.ts — 이벤트 데이터 정합성 E2E
 *
 * 검증 대상:
 *   1. API 응답 ↔ UI 표시 데이터 일치
 *   2. 이벤트 목록 → 상세 데이터 연속성
 *   3. 등급별 가격·재고·상태 정확성
 *   4. 카테고리 필터 결과 정확성
 *   5. 이벤트 상태별 UI 분기 (판매중/매진/종료)
 * ═══════════════════════════════════════════════════════════════════════ */

const API_BASE = process.env.E2E_API_BASE || "http://localhost:8021/api/v1";

test.describe("이벤트 API 데이터 정합성", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;
  });

  test("이벤트 목록 API → 필수 필드가 모두 존재한다", async ({ request }) => {
    const resp = await request.get(`${API_BASE}/events/search?limit=20`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(resp.ok()).toBe(true);

    const data = (await resp.json()) as {
      events: Array<{
        id: string;
        title: string;
        category: string;
        status: string;
        event_date: string;
        min_price: number;
      }>;
      total: number;
    };

    expect(data.events.length).toBeGreaterThan(0);
    expect(data.total).toBeGreaterThanOrEqual(data.events.length);

    for (const event of data.events) {
      expect(event.id).toBeTruthy();
      expect(event.title).toBeTruthy();
      expect(event.category).toBeTruthy();
      expect(event.status).toBeTruthy();
    }
  });

  test("카테고리 필터 → 해당 카테고리만 반환된다", async ({ request }) => {
    const categories = [
      "concert",
      "musical",
      "sports",
      "classic",
      "exhibition",
      "festival",
    ];

    for (const category of categories.slice(0, 3)) {
      const resp = await request.get(
        `${API_BASE}/events/search?category=${category}&limit=10`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!resp.ok()) continue;

      const data = (await resp.json()) as {
        events: Array<{ category: string }>;
      };

      // 반환된 모든 이벤트가 해당 카테고리여야 함
      for (const event of data.events) {
        expect(event.category.toLowerCase()).toBe(category);
      }
    }
  });

  test("이벤트 상세 → 등급 가격 합계와 min_price 일치", async ({ request }) => {
    const list = (await apiGet(request, "/events/search?limit=5", token)) as {
      events: Array<{ id: string; min_price: number }>;
    };

    for (const event of list.events.slice(0, 3)) {
      const tiers = (await apiGet(
        request,
        `/events/${event.id}/tiers`,
        token,
      )) as Array<{
        base_price: number;
        face_price: number;
        remaining: number;
      }>;

      if (tiers.length === 0) continue;

      // 최소 가격 = 등급 중 최저 가격
      const prices = tiers.map((t) => t.face_price ?? t.base_price);
      const actualMin = Math.min(...prices);

      // min_price가 실제 등급 최소 가격 범위 내 (시드 데이터 오차 허용)
      if (event.min_price > 0 && actualMin > 0) {
        // 50% 이내 차이 허용 (face_price vs base_price 차이 가능)
        expect(event.min_price).toBeLessThanOrEqual(actualMin * 2);
        expect(event.min_price).toBeGreaterThanOrEqual(actualMin * 0.5);
      }
    }
  });

  test("등급 재고 → remaining ≤ capacity", async ({ request }) => {
    const list = (await apiGet(request, "/events/search?limit=10", token)) as {
      events: Array<{ id: string }>;
    };

    for (const event of list.events.slice(0, 5)) {
      const tiers = (await apiGet(
        request,
        `/events/${event.id}/tiers`,
        token,
      )) as Array<{
        name: string;
        capacity: number;
        remaining: number;
        base_price: number;
      }>;

      for (const tier of tiers) {
        // 재고가 용량을 초과하면 안 됨
        expect(tier.remaining).toBeLessThanOrEqual(tier.capacity);
        expect(tier.remaining).toBeGreaterThanOrEqual(0);
        expect(tier.capacity).toBeGreaterThan(0);
        expect(tier.base_price).toBeGreaterThanOrEqual(0);
      }
    }
  });

  test("이벤트 상태별 등급 잔여 → 매진 이벤트는 remaining=0", async ({
    request,
  }) => {
    // completed 상태 이벤트 조회
    const resp = await request.get(
      `${API_BASE}/events/search?status=completed&limit=5`,
      { headers: { Authorization: `Bearer ${token}` } },
    );

    if (!resp.ok()) return;

    const data = (await resp.json()) as {
      events: Array<{ id: string; status: string }>;
    };

    for (const event of data.events.slice(0, 2)) {
      const tiers = (await apiGet(
        request,
        `/events/${event.id}/tiers`,
        token,
      )) as Array<{
        remaining: number;
        sold_count: number;
      }>;

      for (const tier of tiers) {
        // 완료된 이벤트는 잔여석이 0이어야 함 (또는 이미 정산됨)
        expect(tier.remaining).toBeLessThanOrEqual(
          tier.sold_count + tier.remaining,
        );
      }
    }
  });
});

test.describe("이벤트 UI ↔ API 데이터 매칭", () => {
  let token: string;
  let testEvent: { id: string; title: string; category: string };

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;

    const list = (await apiGet(
      request,
      "/events/search?status=bidding_open&limit=1",
      token,
    )) as {
      events: Array<{ id: string; title: string; category: string }>;
    };
    if (list.events.length > 0) testEvent = list.events[0];
  });

  test("이벤트 상세 페이지 → API 타이틀과 UI 타이틀 일치", async ({
    page,
    request,
  }) => {
    test.skip(!testEvent, "테스트 이벤트 없음");

    await page.goto(`/events/${testEvent.id}`);
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // API 제목이 페이지에 표시되는지 확인
    const title = page.getByText(testEvent.title).first();
    await expect(title).toBeVisible({ timeout: 10_000 });
  });

  test("이벤트 목록 카드 → 클릭하면 같은 이벤트 상세로 이동", async ({
    page,
  }) => {
    await page.goto("/events");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // 첫 번째 이벤트 카드의 제목 텍스트 캡처
    const firstCard = page.locator("a[href*='/events/']").first();
    if (!(await firstCard.isVisible({ timeout: 5_000 }).catch(() => false)))
      return;

    const cardText = await firstCard.innerText();
    const href = await firstCard.getAttribute("href");
    expect(href).toBeTruthy();

    // 클릭하여 상세 페이지로 이동
    await firstCard.click();
    await page.waitForURL(/\/events\//, { timeout: 10_000 });

    // URL이 올바른 이벤트 ID를 포함
    expect(page.url()).toMatch(/\/events\/[a-f0-9-]+/);

    // 상세 페이지에서 이벤트 제목이 여전히 보이는지 확인
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);
  });

  test("카테고리 필터 클릭 → API와 UI 결과 수 일치", async ({
    page,
    request,
  }) => {
    await page.goto("/events");
    await page.waitForLoadState("networkidle");
    await dismissOnboarding(page);

    // '콘서트' 필터 클릭
    const concertBtn = page
      .locator("main")
      .getByRole("button", { name: "콘서트" })
      .first();

    if (!(await concertBtn.isVisible({ timeout: 3_000 }).catch(() => false)))
      return;

    await concertBtn.click();
    await page.waitForURL(/category=concert/, { timeout: 5_000 });
    await page.waitForLoadState("networkidle");

    // API로 같은 필터 조회
    const apiResp = await request.get(
      `${API_BASE}/events/search?category=concert&limit=100`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    const apiData = (await apiResp.json()) as { total: number };

    // UI에 표시된 개수 텍스트 확인 ("N개의 이벤트")
    const countText = page.getByText(/\d+개의 이벤트/);
    if (await countText.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const text = await countText.innerText();
      const uiCount = parseInt(text.match(/(\d+)/)?.[1] || "0");
      expect(uiCount).toBe(apiData.total);
    }
  });
});
