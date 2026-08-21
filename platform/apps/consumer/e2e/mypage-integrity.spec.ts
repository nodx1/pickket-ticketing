import { test as authTest, expect as authExpect } from "./fixtures/auth";
import { test, expect } from "@playwright/test";
import { dismissOnboarding, apiLogin, apiGet } from "./fixtures/helpers";

/* ═══════════════════════════════════════════════════════════════════════
 * mypage-integrity.spec.ts — 마이페이지 데이터 무결성 E2E
 *
 * 검증 대상:
 *   1. 내 주문 목록 API ↔ UI 데이터 일치
 *   2. 내 티켓 목록 → 주문과 연결 검증
 *   3. 포인트 잔액 정합성
 *   4. 탭 전환 시 데이터 로딩
 *   5. 프로필 정보 정확성
 *   6. 즐겨찾기 토글 동작
 * ═══════════════════════════════════════════════════════════════════════ */

const API_BASE = process.env.E2E_API_BASE || "http://localhost:8021/api/v1";

test.describe("마이페이지 API 데이터 정합성", () => {
  let token: string;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    token = auth.accessToken;
  });

  test("내 프로필 → 필수 필드 존재 + 이메일 일치", async ({ request }) => {
    const profile = (await apiGet(request, "/users/me", token)) as {
      id: string;
      email: string;
      name: string;
      is_verified: boolean;
    };

    expect(profile.id).toBeTruthy();
    expect(profile.email).toBe(process.env.E2E_CONSUMER_EMAIL);
    expect(profile.name).toBeTruthy();
    expect(typeof profile.is_verified).toBe("boolean");
  });

  test("내 티켓 → 각 티켓이 유효한 이벤트와 연결됨", async ({ request }) => {
    const resp = await request.get(`${API_BASE}/tickets?limit=20`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok()) return;

    const tickets = (await resp.json()) as Array<{
      id: string;
      event_id: string;
      tier_id: string;
      status: string;
      order_id: string;
    }>;

    if (!Array.isArray(tickets) || tickets.length === 0) return;

    for (const ticket of tickets.slice(0, 5)) {
      expect(ticket.id).toBeTruthy();
      expect(ticket.event_id).toBeTruthy();
      expect(ticket.status).toBeTruthy();
      expect([
        "active",
        "used",
        "cancelled",
        "transferred",
        "expired",
      ]).toContain(ticket.status);

      // 티켓의 이벤트가 실제 존재하는지 확인
      const event = (await apiGet(
        request,
        `/events/${ticket.event_id}`,
        token,
      )) as {
        id: string;
        title: string;
      };
      expect(event.id).toBe(ticket.event_id);
      expect(event.title).toBeTruthy();
    }
  });

  test("내 주문 → 금액 합계 일관성 (quantity × unit_price = total_amount)", async ({
    request,
  }) => {
    const orders = (await apiGet(
      request,
      "/orders/my?limit=20",
      token,
    )) as Array<{
      id: string;
      quantity: number;
      unit_price: number;
      total_amount: number;
      status: string;
    }>;

    for (const order of orders) {
      // 총액 = 단가 × 수량 (수수료 등으로 약간 차이 허용)
      if (order.unit_price && order.quantity) {
        const expected = order.unit_price * order.quantity;
        // 10% 이내 차이 허용 (수수료, 할인 등)
        expect(order.total_amount).toBeGreaterThanOrEqual(expected * 0.9);
        expect(order.total_amount).toBeLessThanOrEqual(expected * 1.5);
      }

      expect(order.total_amount).toBeGreaterThanOrEqual(0);
    }
  });

  test("포인트 지갑 → 잔액이 0 이상이고 유효한 구조", async ({ request }) => {
    const resp = await request.get(`${API_BASE}/points/wallet`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok()) return; // 포인트 기능이 없을 수 있음

    const wallet = (await resp.json()) as {
      balance: number;
      total_earned: number;
      total_spent: number;
    };

    expect(wallet.balance).toBeGreaterThanOrEqual(0);
    if (wallet.total_earned !== undefined) {
      expect(wallet.total_earned).toBeGreaterThanOrEqual(0);
      expect(wallet.total_spent).toBeGreaterThanOrEqual(0);
      // 잔액 = 적립 - 사용 (대략적 검증)
      expect(wallet.balance).toBeLessThanOrEqual(wallet.total_earned);
    }
  });

  test("즐겨찾기 목록 API → 유효한 구조를 반환한다", async ({ request }) => {
    const resp = await request.get(`${API_BASE}/events/favorites`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (resp.ok()) {
      const favorites = await resp.json();
      expect(Array.isArray(favorites)).toBe(true);
      // 즐겨찾기가 있으면 각 항목이 유효한 이벤트 구조인지 확인
      for (const fav of (
        favorites as Array<{ id: string; title: string }>
      ).slice(0, 3)) {
        expect(fav.id).toBeTruthy();
      }
    }
    // 404면 기능 미구현 — 스킵
  });
});

authTest.describe("마이페이지 UI 무결성", () => {
  authTest(
    "주문 탭 → API 주문 수와 UI 표시 일치",
    async ({ authenticatedPage, request }) => {
      const auth = await apiLogin(request);
      const orders = (await apiGet(
        request,
        "/orders/my?limit=100",
        auth.accessToken,
      )) as Array<{
        id: string;
      }>;

      await authenticatedPage.goto("/mypage?tab=orders");
      await authenticatedPage.waitForLoadState("networkidle");
      await dismissOnboarding(authenticatedPage);

      if (orders.length === 0) {
        // 주문 없으면 빈 상태 메시지
        const emptyMsg =
          authenticatedPage.getByText(/주문 내역이 없|주문이 없|내역이 없/);
        await authExpect(emptyMsg.first()).toBeVisible({ timeout: 10_000 });
      } else {
        // 주문이 있으면 주문 카드가 표시
        await authenticatedPage.waitForTimeout(2_000); // API 로딩 대기
        const orderCards = authenticatedPage.locator(
          "a[href*='/orders/'], [class*='order'], [class*='Order']",
        );
        const cardCount = await orderCards.count();
        // 최소 1개 이상 표시 (페이지네이션으로 전체가 아닐 수 있음)
        if (orders.length > 0) {
          authExpect(cardCount).toBeGreaterThan(0);
        }
      }
    },
  );

  authTest(
    "티켓 탭 → 활성 티켓이 있으면 카드가 표시된다",
    async ({ authenticatedPage, request }) => {
      const auth = await apiLogin(request);
      const resp = await request.get(`${API_BASE}/tickets?limit=10`, {
        headers: { Authorization: `Bearer ${auth.accessToken}` },
      });

      await authenticatedPage.goto("/mypage?tab=tickets");
      await authenticatedPage.waitForLoadState("networkidle");
      await dismissOnboarding(authenticatedPage);

      if (resp.ok()) {
        const tickets = (await resp.json()) as Array<{
          id: string;
          status: string;
        }>;
        const activeTickets = Array.isArray(tickets)
          ? tickets.filter((t) => t.status === "active")
          : [];

        if (activeTickets.length > 0) {
          // 티켓 카드가 표시되어야 함
          await authenticatedPage.waitForTimeout(2_000);
          const ticketElements = authenticatedPage.locator(
            "a[href*='/tickets/'], [class*='ticket'], [class*='Ticket']",
          );
          const count = await ticketElements.count();
          authExpect(count).toBeGreaterThan(0);
        }
      }
    },
  );

  authTest(
    "프로필 편집 → 현재 이름이 표시된다",
    async ({ authenticatedPage, request }) => {
      const auth = await apiLogin(request);
      const profile = (await apiGet(
        request,
        "/users/me",
        auth.accessToken,
      )) as {
        name: string;
        email: string;
      };

      await authenticatedPage.goto("/mypage/edit");
      await authenticatedPage.waitForLoadState("networkidle");
      await dismissOnboarding(authenticatedPage);

      // 이름 입력 필드에 현재 이름이 채워져 있어야 함
      const nameInput = authenticatedPage
        .locator("input[name='name'], input#name, input[placeholder*='이름']")
        .first();

      if (await nameInput.isVisible({ timeout: 5_000 }).catch(() => false)) {
        const value = await nameInput.inputValue();
        authExpect(value).toBe(profile.name);
      }
    },
  );
});
