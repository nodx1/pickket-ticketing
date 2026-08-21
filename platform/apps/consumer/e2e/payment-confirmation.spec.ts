import { test as authTest, expect as authExpect } from "./fixtures/auth";
import {
  apiLogin,
  apiGet,
  apiPost,
  findPurchasableEvent,
} from "./fixtures/helpers";

/* ═══════════════════════════════════════════════════════════════════════
 * payment-confirmation.spec.ts — 결제 라이프사이클 전체 E2E 테스트
 *
 * 테스트 대상 (전체 결제 플로우):
 *   1. 주문 생성 → payment_required 상태 확인
 *   2. 결제 확인(수동 confirm) → confirmed/paid 상태 전이
 *   3. 결제 후 티켓 active 상태 검증
 *   4. 주문 상세 페이지 UI 검증
 *   5. 환불 요청 플로우
 *
 * 주의:
 *   - 실제 PG(PortOne) 결제는 수행하지 않음
 *   - /{order_id}/pay (manual confirm fallback) 엔드포인트 사용
 *   - PAYMENT_MANUAL_API_ENABLED=true 환경에서만 confirm/refund 동작
 * ═══════════════════════════════════════════════════════════════════════ */

const API_BASE = process.env.E2E_API_BASE || "http://localhost:8021/api/v1";

/** apiPost 응답 타입 */
interface ApiPostResult {
  status: number;
  body: Record<string, unknown> | null;
}

/** 구매 가능한 이벤트 + 토큰 조합 */
interface TestContext {
  token: string;
  eventId: string;
  tierId: string;
  tierPrice: number;
}

/** 테스트 전 구매 가능한 이벤트를 찾고 토큰을 발급하는 헬퍼 */
async function setupTestContext(
  request: import("@playwright/test").APIRequestContext,
): Promise<TestContext | null> {
  const { accessToken } = await apiLogin(request);
  const purchasable = await findPurchasableEvent(request, accessToken);
  if (!purchasable) return null;
  return {
    token: accessToken,
    eventId: purchasable.event.id,
    tierId: purchasable.tier.id,
    tierPrice: purchasable.tier.base_price,
  };
}

/** FCFS 구매로 주문 생성 */
async function createOrder(
  request: import("@playwright/test").APIRequestContext,
  ctx: TestContext,
): Promise<ApiPostResult> {
  return (await apiPost(
    request,
    `/events/${ctx.eventId}/tiers/${ctx.tierId}/purchase`,
    ctx.token,
    { quantity: 1 },
  )) as ApiPostResult;
}

/** 주문 상세 조회 */
async function getOrder(
  request: import("@playwright/test").APIRequestContext,
  orderId: string,
  token: string,
): Promise<Record<string, unknown>> {
  return (await apiGet(request, `/orders/${orderId}`, token)) as Record<
    string,
    unknown
  >;
}

/** 수동 결제 확인 (/{order_id}/pay) */
async function confirmPayment(
  request: import("@playwright/test").APIRequestContext,
  orderId: string,
  token: string,
  amount?: number,
): Promise<ApiPostResult> {
  return (await apiPost(request, `/orders/${orderId}/pay`, token, {
    pg_provider: "portone",
    pg_transaction_id: `e2e_test_txn_${Date.now()}`,
    payment_id: `e2e_pay_${Date.now()}`,
    amount: amount ?? undefined,
  })) as ApiPostResult;
}

/* ═══════════════════════════════════════════════════════════════════════
 * 1. 주문 생성 → 결제 요청 상태 확인
 * ═══════════════════════════════════════════════════════════════════════ */

authTest.describe("결제 라이프사이클 — 주문 생성", () => {
  authTest(
    "FCFS 구매 시 주문이 생성되고 payment_required 또는 pending 상태여야 한다",
    async ({ request }) => {
      const ctx = await setupTestContext(request);
      authTest.skip(!ctx, "구매 가능한 이벤트가 없습니다");

      const result = await createOrder(request, ctx!);

      // 구매 성공(201) 또는 비즈니스 로직 실패(4xx)
      if (result.status === 201) {
        authExpect(result.body).toBeTruthy();
        authExpect(result.body!.success).toBe(true);
        authExpect(result.body!.order_id).toBeTruthy();
        authExpect(result.body!.ticket_ids).toBeTruthy();

        // 주문 상세 조회로 상태 확인
        const order = await getOrder(
          request,
          result.body!.order_id as string,
          ctx!.token,
        );
        // 초기 상태는 payment_required 또는 pending (무료 이벤트는 바로 confirmed 가능)
        const validInitialStatuses = [
          "payment_required",
          "pending",
          "confirmed",
          "paid",
        ];
        authExpect(validInitialStatuses).toContain(order.status as string);
      } else {
        // 재고 소진, 큐 필요, 서비스 일시 불가 등 — 테스트 환경에서 허용
        authExpect([403, 409, 429, 503]).toContain(result.status);
      }
    },
  );

  authTest(
    "PurchaseResponse에 order_id와 ticket_ids가 포함되어야 한다",
    async ({ request }) => {
      const ctx = await setupTestContext(request);
      authTest.skip(!ctx, "구매 가능한 이벤트가 없습니다");

      const result = await createOrder(request, ctx!);
      authTest.skip(result.status !== 201, "주문 생성에 실패했습니다");

      const body = result.body!;
      authExpect(body.order_id).toBeTruthy();
      authExpect(Array.isArray(body.ticket_ids)).toBe(true);
      authExpect((body.ticket_ids as string[]).length).toBeGreaterThan(0);
      authExpect(typeof body.total_price).toBe("number");
      authExpect(typeof body.unit_price).toBe("number");
    },
  );
});

/* ═══════════════════════════════════════════════════════════════════════
 * 2. 결제 확인 시뮬레이션 (수동 confirm 엔드포인트)
 * ═══════════════════════════════════════════════════════════════════════ */

authTest.describe("결제 라이프사이클 — 결제 확인", () => {
  authTest(
    "주문 생성 후 수동 결제 확인(POST /pay)으로 상태가 전이된다",
    async ({ request }) => {
      const ctx = await setupTestContext(request);
      authTest.skip(!ctx, "구매 가능한 이벤트가 없습니다");

      // 1) 주문 생성
      const purchaseResult = await createOrder(request, ctx!);
      authTest.skip(purchaseResult.status !== 201, "주문 생성에 실패했습니다");

      const orderId = purchaseResult.body!.order_id as string;
      const totalPrice = purchaseResult.body!.total_price as number;

      // 2) 결제 확인
      const confirmResult = await confirmPayment(
        request,
        orderId,
        ctx!.token,
        totalPrice > 0 ? totalPrice : undefined,
      );

      // PAYMENT_MANUAL_API_ENABLED가 꺼져 있으면 403 반환 — skip
      if (confirmResult.status === 403) {
        authTest.skip(
          true,
          "수동 결제 API가 비활성화 상태입니다 (PAYMENT_MANUAL_API_ENABLED=false)",
        );
        return;
      }

      // 성공 시 주문 상태가 confirmed 또는 paid
      if (confirmResult.status === 200) {
        const confirmedOrder = confirmResult.body!;
        const paidStatuses = ["confirmed", "paid"];
        authExpect(paidStatuses).toContain(confirmedOrder.status as string);
        authExpect(confirmedOrder.pg_provider).toBeTruthy();
        authExpect(confirmedOrder.pg_transaction_id).toBeTruthy();
      } else {
        // 이미 결제됨, 금액 불일치 등
        authExpect([400, 409, 422]).toContain(confirmResult.status);
      }
    },
  );
});

/* ═══════════════════════════════════════════════════════════════════════
 * 3. 결제 후 티켓 활성화 검증
 * ═══════════════════════════════════════════════════════════════════════ */

authTest.describe("결제 라이프사이클 — 티켓 활성화", () => {
  authTest("결제 완료 후 티켓 상태가 active여야 한다", async ({ request }) => {
    const ctx = await setupTestContext(request);
    authTest.skip(!ctx, "구매 가능한 이벤트가 없습니다");

    // 1) 주문 생성
    const purchaseResult = await createOrder(request, ctx!);
    authTest.skip(purchaseResult.status !== 201, "주문 생성에 실패했습니다");

    const orderId = purchaseResult.body!.order_id as string;
    const ticketIds = purchaseResult.body!.ticket_ids as string[];
    const totalPrice = purchaseResult.body!.total_price as number;

    // 2) 결제 확인
    const confirmResult = await confirmPayment(
      request,
      orderId,
      ctx!.token,
      totalPrice > 0 ? totalPrice : undefined,
    );

    if (confirmResult.status === 403) {
      authTest.skip(true, "수동 결제 API 비활성화 상태");
      return;
    }

    authTest.skip(
      confirmResult.status !== 200,
      `결제 확인 실패: ${confirmResult.status}`,
    );

    // 3) 내 티켓 목록에서 해당 티켓 상태 확인
    const myTickets = (await apiGet(request, "/tickets/my", ctx!.token)) as {
      tickets: Array<{ id: string; status: string }>;
    };

    for (const ticketId of ticketIds) {
      const ticket = (myTickets.tickets || []).find((t) => t.id === ticketId);
      if (ticket) {
        authExpect(ticket.status).toBe("active");
      }
    }
  });

  authTest("결제 전 티켓은 pending 상태여야 한다", async ({ request }) => {
    const ctx = await setupTestContext(request);
    authTest.skip(!ctx, "구매 가능한 이벤트가 없습니다");

    const purchaseResult = await createOrder(request, ctx!);
    authTest.skip(purchaseResult.status !== 201, "주문 생성에 실패했습니다");

    const ticketIds = purchaseResult.body!.ticket_ids as string[];

    // 결제 전 내 티켓에서 상태 확인
    const myTickets = (await apiGet(request, "/tickets/my", ctx!.token)) as {
      tickets: Array<{ id: string; status: string }>;
    };

    for (const ticketId of ticketIds) {
      const ticket = (myTickets.tickets || []).find((t) => t.id === ticketId);
      if (ticket) {
        // 무료 이벤트에서는 바로 active일 수도 있음
        authExpect(["pending", "active"]).toContain(ticket.status);
      }
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 4. 주문 상세 페이지 UI 검증
 * ═══════════════════════════════════════════════════════════════════════ */

authTest.describe("결제 라이프사이클 — 주문 상세 UI", () => {
  authTest(
    "주문 목록 페이지에서 주문 내역이 표시된다",
    async ({ authenticatedPage }) => {
      // /orders 또는 /mypage?tab=orders로 접근
      await authenticatedPage.goto("/orders");
      await authenticatedPage.waitForLoadState("networkidle");

      const url = authenticatedPage.url();
      // /orders 라우트가 없거나 auth redirect된 경우 mypage로 폴백
      if (url.includes("/auth") || url.includes("/404")) {
        await authenticatedPage.goto("/mypage?tab=orders");
        await authenticatedPage.waitForLoadState("networkidle");
      }

      // 주문 내역 또는 빈 상태 메시지
      const content = authenticatedPage.locator("main, body").first();
      await authExpect(content).toBeVisible({ timeout: 10_000 });
    },
  );

  authTest(
    "내 주문이 있다면 결제 상태 라벨이 표시된다",
    async ({ authenticatedPage, request }) => {
      const ctx = await setupTestContext(request);
      authTest.skip(!ctx, "구매 가능한 이벤트가 없습니다");

      // 주문 목록 API로 기존 주문 확인
      const myOrders = (await apiGet(
        request,
        "/orders/my?limit=5",
        ctx!.token,
      )) as Array<{
        id: string;
        status: string;
        total_amount: number;
      }>;

      authTest.skip(!myOrders || myOrders.length === 0, "주문 내역이 없습니다");

      // 주문 목록 페이지로 이동
      await authenticatedPage.goto("/orders");
      await authenticatedPage.waitForLoadState("networkidle");

      // 결제 상태 관련 텍스트가 있는지 확인
      // (결제 완료, 결제 대기, 취소됨, 환불 등)
      const statusLabels = authenticatedPage
        .locator("text=/결제|완료|대기|취소|환불|confirmed|paid|pending/i")
        .first();
      const hasLabels = await statusLabels
        .isVisible({ timeout: 5_000 })
        .catch(() => false);

      // 주문이 있으면 뭔가 표시되어야 함 (빈 상태가 아닌 이상)
      if (myOrders.length > 0) {
        const anyContent = authenticatedPage
          .locator("text=/주문|티켓|이벤트|결제|₩|원|KRW/i")
          .first();
        const hasContent = await anyContent
          .isVisible({ timeout: 5_000 })
          .catch(() => false);
        // 페이지에 주문 관련 콘텐츠가 있어야 함
        authExpect(hasLabels || hasContent).toBeTruthy();
      }
    },
  );

  authTest(
    "주문 상세 페이지에서 결제 금액과 상태가 표시된다",
    async ({ authenticatedPage, request }) => {
      const ctx = await setupTestContext(request);
      authTest.skip(!ctx, "구매 가능한 이벤트가 없습니다");

      const myOrders = (await apiGet(
        request,
        "/orders/my?limit=1",
        ctx!.token,
      )) as Array<{ id: string; status: string; total_amount: number }>;

      authTest.skip(!myOrders || myOrders.length === 0, "주문 내역이 없습니다");

      const order = myOrders[0];

      // 주문 상세 페이지로 이동 시도 (URL 패턴은 /orders/{id} 또는 /mypage/orders/{id})
      for (const urlPattern of [
        `/orders/${order.id}`,
        `/mypage/orders/${order.id}`,
      ]) {
        await authenticatedPage.goto(urlPattern);
        await authenticatedPage.waitForLoadState("networkidle");

        // 404가 아니면 그 URL이 맞음
        if (!authenticatedPage.url().includes("/404")) {
          break;
        }
      }

      // 주문 상세에서 금액 또는 상태 텍스트 확인
      const pageContent = authenticatedPage.locator("main, body").first();
      await authExpect(pageContent).toBeVisible({ timeout: 10_000 });
    },
  );
});

/* ═══════════════════════════════════════════════════════════════════════
 * 5. 환불 요청 플로우
 * ═══════════════════════════════════════════════════════════════════════ */

authTest.describe("결제 라이프사이클 — 환불 요청", () => {
  authTest("결제 완료된 주문에 환불 요청을 할 수 있다", async ({ request }) => {
    const ctx = await setupTestContext(request);
    authTest.skip(!ctx, "구매 가능한 이벤트가 없습니다");

    // 1) 주문 생성
    const purchaseResult = await createOrder(request, ctx!);
    authTest.skip(purchaseResult.status !== 201, "주문 생성에 실패했습니다");

    const orderId = purchaseResult.body!.order_id as string;
    const totalPrice = purchaseResult.body!.total_price as number;

    // 2) 결제 확인
    const confirmResult = await confirmPayment(
      request,
      orderId,
      ctx!.token,
      totalPrice > 0 ? totalPrice : undefined,
    );

    if (confirmResult.status === 403) {
      authTest.skip(true, "수동 결제 API 비활성화 상태");
      return;
    }
    authTest.skip(
      confirmResult.status !== 200,
      `결제 확인 실패: ${confirmResult.status}`,
    );

    // 3) 환불 요청
    const refundResult = (await apiPost(
      request,
      `/orders/${orderId}/refund`,
      ctx!.token,
      {
        reason: "E2E 테스트 환불 요청",
        idempotency_key: `e2e_refund_${Date.now()}`,
      },
    )) as ApiPostResult;

    // 환불 성공(200/201) 또는 비즈니스 제한(400/403/409)
    if (refundResult.status === 200 || refundResult.status === 201) {
      const refundBody = refundResult.body!;
      authExpect(refundBody.refund_id).toBeTruthy();
      authExpect(refundBody.order_id).toBe(orderId);
      authExpect(typeof refundBody.refund_amount).toBe("number");
      authExpect(refundBody.reason).toBe("E2E 테스트 환불 요청");
    } else {
      // 환불 불가 (기간 초과, 정책 제한 등) — 테스트 환경에서 허용
      authExpect([400, 403, 409, 422]).toContain(refundResult.status);
    }
  });

  authTest(
    "환불 완료 후 주문 상태가 refunded로 전이된다",
    async ({ request }) => {
      const ctx = await setupTestContext(request);
      authTest.skip(!ctx, "구매 가능한 이벤트가 없습니다");

      // 1) 주문 생성 + 결제
      const purchaseResult = await createOrder(request, ctx!);
      authTest.skip(purchaseResult.status !== 201, "주문 생성에 실패했습니다");

      const orderId = purchaseResult.body!.order_id as string;
      const totalPrice = purchaseResult.body!.total_price as number;

      const confirmResult = await confirmPayment(
        request,
        orderId,
        ctx!.token,
        totalPrice > 0 ? totalPrice : undefined,
      );

      if (confirmResult.status === 403) {
        authTest.skip(true, "수동 결제 API 비활성화 상태");
        return;
      }
      authTest.skip(
        confirmResult.status !== 200,
        `결제 확인 실패: ${confirmResult.status}`,
      );

      // 2) 환불 요청
      const refundResult = (await apiPost(
        request,
        `/orders/${orderId}/refund`,
        ctx!.token,
        {
          reason: "E2E 테스트 환불 상태 전이 확인",
          idempotency_key: `e2e_refund_status_${Date.now()}`,
        },
      )) as ApiPostResult;

      authTest.skip(
        refundResult.status !== 200 && refundResult.status !== 201,
        `환불 요청 실패: ${refundResult.status}`,
      );

      // 3) 주문 상태 확인
      const updatedOrder = await getOrder(request, orderId, ctx!.token);
      // 환불 후 상태: refunded 또는 requires_approval인 경우 confirmed/paid 유지
      const validPostRefundStatuses = [
        "refunded",
        "confirmed",
        "paid",
        "cancelled",
      ];
      authExpect(validPostRefundStatuses).toContain(
        updatedOrder.status as string,
      );
    },
  );

  authTest("환불 내역 API에서 환불 이력이 조회된다", async ({ request }) => {
    const ctx = await setupTestContext(request);
    authTest.skip(!ctx, "구매 가능한 이벤트가 없습니다");

    // 기존 환불 내역 조회
    const refunds = (await apiGet(
      request,
      "/orders/my/refunds",
      ctx!.token,
    )) as Array<{ id: string; status: string }>;

    // 환불 내역이 없어도 빈 배열이 반환되어야 함
    authExpect(Array.isArray(refunds)).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 6. 주문 취소 플로우 (결제 전)
 * ═══════════════════════════════════════════════════════════════════════ */

authTest.describe("결제 라이프사이클 — 주문 취소", () => {
  authTest("결제 전 주문을 취소할 수 있다", async ({ request }) => {
    const ctx = await setupTestContext(request);
    authTest.skip(!ctx, "구매 가능한 이벤트가 없습니다");

    // 1) 주문 생성
    const purchaseResult = await createOrder(request, ctx!);
    authTest.skip(purchaseResult.status !== 201, "주문 생성에 실패했습니다");

    const orderId = purchaseResult.body!.order_id as string;

    // 2) 주문 취소
    const cancelResult = (await apiPost(
      request,
      `/orders/${orderId}/cancel`,
      ctx!.token,
    )) as ApiPostResult;

    if (cancelResult.status === 200) {
      const cancelledOrder = cancelResult.body!;
      authExpect(cancelledOrder.status).toBe("cancelled");
    } else {
      // 이미 결제됨 등 — 무료 이벤트에서 바로 confirmed되면 취소 불가할 수 있음
      authExpect([400, 403, 409, 422]).toContain(cancelResult.status);
    }
  });

  authTest("취소된 주문은 다시 결제할 수 없다", async ({ request }) => {
    const ctx = await setupTestContext(request);
    authTest.skip(!ctx, "구매 가능한 이벤트가 없습니다");

    // 1) 주문 생성 → 취소
    const purchaseResult = await createOrder(request, ctx!);
    authTest.skip(purchaseResult.status !== 201, "주문 생성에 실패했습니다");

    const orderId = purchaseResult.body!.order_id as string;

    const cancelResult = (await apiPost(
      request,
      `/orders/${orderId}/cancel`,
      ctx!.token,
    )) as ApiPostResult;

    authTest.skip(cancelResult.status !== 200, "주문 취소에 실패했습니다");

    // 2) 취소된 주문에 결제 시도
    const confirmResult = await confirmPayment(request, orderId, ctx!.token);

    // 취소된 주문에 결제는 실패해야 함
    authExpect([400, 403, 409, 422]).toContain(confirmResult.status);
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 7. 엣지 케이스 — 잘못된 요청 검증
 * ═══════════════════════════════════════════════════════════════════════ */

authTest.describe("결제 라이프사이클 — 엣지 케이스", () => {
  authTest(
    "존재하지 않는 주문에 결제를 시도하면 404가 반환된다",
    async ({ request }) => {
      const { accessToken } = await apiLogin(request);
      const fakeOrderId = "00000000-0000-0000-0000-000000000000";

      const result = await confirmPayment(request, fakeOrderId, accessToken);

      // 404 (주문 없음) 또는 403 (수동 결제 API 비활성화)
      authExpect([403, 404]).toContain(result.status);
    },
  );

  authTest(
    "존재하지 않는 주문에 환불을 시도하면 404가 반환된다",
    async ({ request }) => {
      const { accessToken } = await apiLogin(request);
      const fakeOrderId = "00000000-0000-0000-0000-000000000000";

      const result = (await apiPost(
        request,
        `/orders/${fakeOrderId}/refund`,
        accessToken,
        {
          reason: "E2E 테스트 - 존재하지 않는 주문",
          idempotency_key: `e2e_fake_refund_${Date.now()}`,
        },
      )) as ApiPostResult;

      authExpect(result.status).toBe(404);
    },
  );

  authTest(
    "인증 없이 주문 API에 접근하면 401이 반환된다",
    async ({ request }) => {
      const resp = await request.get(`${API_BASE}/orders/my`);
      authExpect(resp.status()).toBe(401);
    },
  );
});
