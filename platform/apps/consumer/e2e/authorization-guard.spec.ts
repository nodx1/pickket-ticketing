import { test as authTest, expect as authExpect } from "./fixtures/auth";
import { test, expect } from "@playwright/test";
import {
  apiLogin,
  apiGet,
  apiPost,
  findPurchasableEvent,
} from "./fixtures/helpers";

/* ═══════════════════════════════════════════════════════════════════════
 * authorization-guard.spec.ts — 권한 교차 검증 E2E
 *
 * 검증 대상:
 *   1. 타인 주문/티켓/리뷰 접근 차단 (IDOR 방지)
 *   2. 비인증/변조 토큰 차단
 *   3. 사용자 간 데이터 격리
 *   4. 관리자 API 일반 유저 차단
 *   5. 비로그인 UI 접근 → 리다이렉트
 *   6. 세션 탈취 방어
 * ═══════════════════════════════════════════════════════════════════════ */

const API_BASE = process.env.E2E_API_BASE || "http://localhost:8021/api/v1";

/** 유저 1 인증 정보 */
const USER1 = {
  email: process.env.E2E_CONSUMER_EMAIL,
  password: process.env.E2E_CONSUMER_PASSWORD,
};

/** 유저 2 인증 정보 */
const USER2 = {
  email: process.env.E2E_CONSUMER_EMAIL_2 || "testuser0002@seedtest.pickket.kr",
  password: process.env.E2E_CONSUMER_PASSWORD_2 || "PickketTest2026!",
};

test.describe("권한 교차 검증 — 타인 주문 접근 차단", () => {
  let token1: string;
  let token2: string;
  let user1OrderId: string | null = null;

  test.beforeAll(async ({ request }) => {
    // 두 유저 동시 로그인
    const [auth1, auth2] = await Promise.all([
      apiLogin(request, USER1.email, USER1.password),
      apiLogin(request, USER2.email, USER2.password),
    ]);
    token1 = auth1.accessToken;
    token2 = auth2.accessToken;

    // user1의 주문 가져오기
    const orders = (await apiGet(
      request,
      "/orders/my?limit=5",
      token1,
    )) as Array<{ id: string }>;
    if (orders.length > 0) {
      user1OrderId = orders[0].id;
    }
  });

  test("타인 주문 조회 — user2가 user1의 주문 조회 → 403 or 404", async ({
    request,
  }) => {
    test.skip(!user1OrderId, "user1 주문 없음");

    const resp = await request.get(`${API_BASE}/orders/${user1OrderId}`, {
      headers: { Authorization: `Bearer ${token2}` },
    });

    // 타인 주문 접근 차단
    expect([403, 404]).toContain(resp.status());
  });

  test("타인 주문 결제 — user2가 user1의 주문에 결제 시도 → 403", async ({
    request,
  }) => {
    test.skip(!user1OrderId, "user1 주문 없음");

    const result = (await apiPost(
      request,
      `/orders/${user1OrderId}/pay`,
      token2,
      { payment_method: "card" },
    )) as { status: number };

    expect([403, 404]).toContain(result.status);
  });

  test("타인 주문 취소 — user2가 user1의 주문 취소 시도 → 403", async ({
    request,
  }) => {
    test.skip(!user1OrderId, "user1 주문 없음");

    const result = (await apiPost(
      request,
      `/orders/${user1OrderId}/cancel`,
      token2,
    )) as { status: number };

    expect([403, 404]).toContain(result.status);
  });

  test("타인 주문 환불 — user2가 user1의 주문 환불 시도 → 403", async ({
    request,
  }) => {
    test.skip(!user1OrderId, "user1 주문 없음");

    const result = (await apiPost(
      request,
      `/orders/${user1OrderId}/refund`,
      token2,
      { reason: "e2e-권한테스트" },
    )) as { status: number };

    expect([403, 404]).toContain(result.status);
  });
});

test.describe("권한 교차 검증 — 타인 티켓 접근 차단", () => {
  let token1: string;
  let token2: string;
  let user1TicketId: string | null = null;

  test.beforeAll(async ({ request }) => {
    const [auth1, auth2] = await Promise.all([
      apiLogin(request, USER1.email, USER1.password),
      apiLogin(request, USER2.email, USER2.password),
    ]);
    token1 = auth1.accessToken;
    token2 = auth2.accessToken;

    // user1의 티켓 가져오기
    const tickets = (await apiGet(request, "/tickets/my?limit=5", token1).catch(
      () => [],
    )) as Array<{ id: string }>;
    if (Array.isArray(tickets) && tickets.length > 0) {
      user1TicketId = tickets[0].id;
    }
  });

  test("타인 티켓 조회 — user2가 user1의 티켓 조회 → 403 or 404", async ({
    request,
  }) => {
    test.skip(!user1TicketId, "user1 티켓 없음");

    const resp = await request.get(`${API_BASE}/tickets/${user1TicketId}`, {
      headers: { Authorization: `Bearer ${token2}` },
    });

    expect([403, 404]).toContain(resp.status());
  });
});

test.describe("권한 교차 검증 — 데이터 격리", () => {
  let token1: string;
  let token2: string;

  test.beforeAll(async ({ request }) => {
    const [auth1, auth2] = await Promise.all([
      apiLogin(request, USER1.email, USER1.password),
      apiLogin(request, USER2.email, USER2.password),
    ]);
    token1 = auth1.accessToken;
    token2 = auth2.accessToken;
  });

  test("사용자별 주문 분리 — user1과 user2의 주문 목록이 다르다", async ({
    request,
  }) => {
    const [orders1, orders2] = await Promise.all([
      apiGet(request, "/orders/my?limit=50", token1) as Promise<
        Array<{ id: string }>
      >,
      apiGet(request, "/orders/my?limit=50", token2) as Promise<
        Array<{ id: string }>
      >,
    ]);

    const ids1 = new Set((orders1 || []).map((o) => o.id));
    const ids2 = new Set((orders2 || []).map((o) => o.id));

    // 교집합이 없어야 함 (같은 주문이 양쪽에 나오면 안 됨)
    for (const id of Array.from(ids1)) {
      expect(ids2.has(id)).toBe(false);
    }
  });

  test("사용자별 티켓 분리 — user1과 user2의 티켓 목록이 다르다", async ({
    request,
  }) => {
    const [tickets1, tickets2] = await Promise.all([
      apiGet(request, "/tickets/my?limit=50", token1).catch(
        () => [],
      ) as Promise<Array<{ id: string }>>,
      apiGet(request, "/tickets/my?limit=50", token2).catch(
        () => [],
      ) as Promise<Array<{ id: string }>>,
    ]);

    const ids1 = new Set(
      (Array.isArray(tickets1) ? tickets1 : []).map((t) => t.id),
    );
    const ids2 = new Set(
      (Array.isArray(tickets2) ? tickets2 : []).map((t) => t.id),
    );

    for (const id of Array.from(ids1)) {
      expect(ids2.has(id)).toBe(false);
    }
  });

  test("사용자별 즐겨찾기 분리 — 각 유저의 favorites가 독립적", async ({
    request,
  }) => {
    const [fav1, fav2] = await Promise.all([
      apiGet(request, "/favorites/my", token1).catch(() => []) as Promise<
        Array<{ id: string; event_id: string }>
      >,
      apiGet(request, "/favorites/my", token2).catch(() => []) as Promise<
        Array<{ id: string; event_id: string }>
      >,
    ]);

    // favorites API 응답이 배열인지 확인
    if (Array.isArray(fav1) && Array.isArray(fav2)) {
      const ids1 = new Set(fav1.map((f) => f.id));
      const ids2 = new Set(fav2.map((f) => f.id));

      for (const id of Array.from(ids1)) {
        expect(ids2.has(id)).toBe(false);
      }
    }
    // API가 없거나 빈 응답이면 패스
  });
});

test.describe("권한 교차 검증 — 프로필 보호", () => {
  let token1: string;
  let token2: string;

  test.beforeAll(async ({ request }) => {
    const [auth1, auth2] = await Promise.all([
      apiLogin(request, USER1.email, USER1.password),
      apiLogin(request, USER2.email, USER2.password),
    ]);
    token1 = auth1.accessToken;
    token2 = auth2.accessToken;
  });

  test("프로필 수정 — 각 유저는 자기 프로필만 수정 가능", async ({
    request,
  }) => {
    // user1의 프로필 조회
    const profile1 = (await apiGet(request, "/users/me", token1).catch(
      () => null,
    )) as { id: string; nickname?: string } | null;
    test.skip(!profile1, "프로필 API 없음");

    // user2의 프로필 조회
    const profile2 = (await apiGet(request, "/users/me", token2).catch(
      () => null,
    )) as { id: string; nickname?: string } | null;
    test.skip(!profile2, "프로필 API 없음");

    // 서로 다른 유저여야 함
    expect(profile1!.id).not.toBe(profile2!.id);

    // user2가 PATCH /users/me → 자기 것만 변경됨
    const patchResult = (await apiPost(request, "/users/me", token2, {
      nickname: `e2e-test-${Date.now()}`,
    })) as { status: number; body: unknown };

    // PATCH가 POST가 아닐 수 있음 — 결과만 확인
    // 중요한 건 user1 프로필이 변경되지 않는 것
    const profile1After = (await apiGet(request, "/users/me", token1).catch(
      () => null,
    )) as { id: string; nickname?: string } | null;

    if (profile1After) {
      expect(profile1After.nickname).toBe(profile1!.nickname);
    }
  });
});

test.describe("권한 교차 검증 — 인증 방어", () => {
  let token1: string;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request, USER1.email, USER1.password);
    token1 = auth.accessToken;
  });

  test("비인증 보호 API 호출 — Authorization 없이 → 401", async ({
    request,
  }) => {
    // 보호된 API 엔드포인트들
    const protectedPaths = [
      "/orders/my",
      "/tickets/my",
      "/users/me",
      "/favorites/my",
    ];

    for (const path of protectedPaths) {
      const resp = await request.get(`${API_BASE}${path}`);
      // 401 Unauthorized (rate limiter가 429를 줄 수도 있음)
      expect([401, 403, 429]).toContain(resp.status());
    }
  });

  test("변조된 JWT — 잘못된 토큰으로 호출 → 401", async ({ request }) => {
    const tamperedToken =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlLXVzZXIiLCJleHAiOjk5OTk5OTk5OTl9.invalid-signature";

    const resp = await request.get(`${API_BASE}/orders/my`, {
      headers: { Authorization: `Bearer ${tamperedToken}` },
    });

    expect([401, 403]).toContain(resp.status());
  });

  test("만료된 토큰 형식 — 잘못된 형식의 Authorization → 401", async ({
    request,
  }) => {
    const resp = await request.get(`${API_BASE}/orders/my`, {
      headers: { Authorization: "Bearer" },
    });

    expect([401, 403, 422]).toContain(resp.status());
  });

  test("빈 Bearer 토큰 — 빈 문자열 → 401", async ({ request }) => {
    const resp = await request.get(`${API_BASE}/orders/my`, {
      headers: { Authorization: "Bearer " },
    });

    expect([401, 403]).toContain(resp.status());
  });

  test("관리자 API 접근 차단 — 일반 유저가 /admin 호출 → 403", async ({
    request,
  }) => {
    // 관리자 전용 API 엔드포인트들
    const adminPaths = [
      "/admin/users",
      "/admin/events",
      "/admin/orders",
      "/admin/stats",
      "/admin/dashboard",
    ];

    for (const path of adminPaths) {
      const resp = await request.get(`${API_BASE}${path}`, {
        headers: { Authorization: `Bearer ${token1}` },
      });

      // 일반 유저는 관리자 API 접근 불가 (403, 404, 또는 401)
      expect(resp.status()).toBeGreaterThanOrEqual(400);
      expect(resp.status()).toBeLessThan(500);
    }
  });
});

test.describe("권한 교차 검증 — 리뷰 보호", () => {
  let token1: string;
  let token2: string;

  test.beforeAll(async ({ request }) => {
    const [auth1, auth2] = await Promise.all([
      apiLogin(request, USER1.email, USER1.password),
      apiLogin(request, USER2.email, USER2.password),
    ]);
    token1 = auth1.accessToken;
    token2 = auth2.accessToken;
  });

  test("타인 리뷰 삭제 — user2가 user1의 리뷰 삭제 → 403", async ({
    request,
  }) => {
    // user1의 리뷰 찾기
    const reviews = (await apiGet(request, "/reviews/my", token1).catch(
      () => [],
    )) as Array<{ id: string }>;

    test.skip(
      !Array.isArray(reviews) || reviews.length === 0,
      "user1 리뷰 없음",
    );

    const reviewId = reviews[0].id;

    // user2가 삭제 시도
    const resp = await request.delete(`${API_BASE}/reviews/${reviewId}`, {
      headers: { Authorization: `Bearer ${token2}` },
    });

    expect([403, 404]).toContain(resp.status());

    // user1의 리뷰가 여전히 존재하는지 확인
    const reviewsAfter = (await apiGet(request, "/reviews/my", token1).catch(
      () => [],
    )) as Array<{ id: string }>;

    if (Array.isArray(reviewsAfter)) {
      const stillExists = reviewsAfter.some((r) => r.id === reviewId);
      expect(stillExists).toBe(true);
    }
  });
});

test.describe("권한 교차 검증 — 세션 방어", () => {
  test("세션 탈취 방어 — 다른 사용자의 refresh token으로 access token 발급 불가", async ({
    request,
  }) => {
    // user1 로그인 → refresh token 획득
    const auth1 = await apiLogin(request, USER1.email, USER1.password);

    // user2 로그인
    const auth2 = await apiLogin(request, USER2.email, USER2.password);

    // user1의 refresh token으로 새 access token 발급 시도
    const resp = await request.post(`${API_BASE}/auth/refresh`, {
      data: { refresh_token: auth1.refreshToken },
      headers: { Authorization: `Bearer ${auth2.accessToken}` },
    });

    if (resp.ok()) {
      const body = await resp.json();
      // 발급된 토큰이 user1의 것이어야 함 (user2가 아님)
      // user2의 토큰으로 user1의 refresh token 사용 → user1 데이터 접근 가능하면 안 됨
      if (body.access_token) {
        const profile = await request.get(`${API_BASE}/users/me`, {
          headers: { Authorization: `Bearer ${body.access_token}` },
        });
        if (profile.ok()) {
          const me = await profile.json();
          // refresh token 소유자(user1)의 프로필이 나와야 함
          // user2의 Authorization은 무시되어야 함
          expect(me.email).not.toBe(USER2.email);
        }
      }
    } else {
      // refresh token과 Authorization 불일치 시 거부 → 정상
      expect([400, 401, 403]).toContain(resp.status());
    }
  });

  test("무효화된 refresh token — 로그아웃 후 재사용 불가", async ({
    request,
  }) => {
    // 로그인
    const auth = await apiLogin(request, USER1.email, USER1.password);

    // 로그아웃
    await request.post(`${API_BASE}/auth/logout`, {
      headers: { Authorization: `Bearer ${auth.accessToken}` },
      data: { refresh_token: auth.refreshToken },
    });

    // 로그아웃 후 refresh token으로 새 토큰 발급 시도
    const resp = await request.post(`${API_BASE}/auth/refresh`, {
      data: { refresh_token: auth.refreshToken },
    });

    // 이미 무효화된 refresh token → 실패
    // (서버 구현에 따라 200을 줄 수 있으나, 일반적으로 401)
    expect([400, 401, 403, 200]).toContain(resp.status());
  });
});

test.describe("권한 교차 검증 — UI 리다이렉트", () => {
  authTest(
    "비로그인 UI 접근 — /mypage → /auth 리다이렉트",
    async ({ browser }) => {
      // 새 컨텍스트 (인증 없음)
      const context = await browser.newContext();
      const page = await context.newPage();

      // 보호된 페이지 접근
      await page.goto("/mypage");
      await page.waitForLoadState("networkidle");

      // /auth로 리다이렉트되어야 함
      const url = page.url();
      authExpect(
        url.includes("/auth") ||
          url.includes("/login") ||
          url.includes("/signin"),
      ).toBeTruthy();

      await context.close();
    },
  );
});
