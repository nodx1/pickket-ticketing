import { beforeEach, describe, expect, it, vi } from "vitest";

// 레벨2 read-flip 회귀: checkout 서버 권위 금액이 v2 tier.base_price 로 산정되는지 검증한다.
//   go products.price 를 읽지 않고 v2 정본만으로 serverTotal 이 계산됨 = 전환으로 금액 불변.

const h = vi.hoisted(() => {
  const cookieStore = {
    get: vi.fn(() => undefined),
    set: vi.fn(),
  };
  class V2CommerceError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  class EventAccessError extends Error {
    constructor(
      message: string,
      readonly reason: "not_found" | "unavailable",
      readonly status: number,
    ) {
      super(message);
    }
  }
  return {
    pool: { query: vi.fn() },
    cookieStore,
    createOrder: vi.fn(),
    getEvent: vi.fn(),
    getTiersByEvent: vi.fn(),
    getAccountFeePlan: vi.fn(),
    prepareNicePayment: vi.fn(),
    validatePromoCode: vi.fn(),
    calculatePlatformFee: vi.fn((..._a: unknown[]) => 0),
    recordConsent: vi.fn(),
    // 무통장 가용성 판정 — 기본은 "가능"(정본 계좌가 코드에 있으므로 실제와 같다).
    // 가드 자체를 검증할 때만 false 로 갈아끼운다.
    isOfflinePaymentAvailable: vi.fn(() => true),
    V2CommerceError,
    EventAccessError,
  };
});

vi.mock("next/headers", () => ({ cookies: async () => h.cookieStore }));
vi.mock("@/lib/db/pool", () => ({ getPool: () => h.pool }));
vi.mock("@/lib/auth/withRateLimit", () => ({
  withRateLimit: () => (handler: (r: Request) => Promise<Response>) => handler,
}));
vi.mock("@/lib/server/orders", () => ({ createOrder: (...a: unknown[]) => h.createOrder(...a) }));
// 🔴 기한 계산(paymentDeadlineISO)은 **실제 구현**을 쓴다 — 목으로 덮으면
//    "무통장 24시간 / 카드 15분" 단언이 목을 검증하는 자기충족이 된다.
vi.mock("@/lib/checkout/offline-payment", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/checkout/offline-payment")>();
  return { ...actual, isOfflinePaymentAvailable: () => h.isOfflinePaymentAvailable() };
});
vi.mock("@/lib/v2/commerce-client", () => ({
  getEvent: (...a: unknown[]) => h.getEvent(...a),
  getTiersByEvent: (...a: unknown[]) => h.getTiersByEvent(...a),
  // 구형 나이스: provider 기본값이 nicepay 라 유료 주문은 prepare 를 탄다.
  prepareNicePayment: (...a: unknown[]) => h.prepareNicePayment(...a),
  validatePromoCode: (...a: unknown[]) => h.validatePromoCode(...a),
  V2CommerceError: h.V2CommerceError,
}));
vi.mock("@/lib/v2/event-access", () => ({ EventAccessError: h.EventAccessError }));
vi.mock("@/lib/fee/calculator", () => ({
  getAccountFeePlan: (...a: unknown[]) => h.getAccountFeePlan(...a),
  calculatePlatformFee: (...a: unknown[]) => h.calculatePlatformFee(...a),
}));
vi.mock("@/lib/notification/compliance", () => ({ recordConsent: (...a: unknown[]) => h.recordConsent(...a) }));
vi.mock("@/lib/notification/consent-wording", () => ({ MARKETING_CONSENT_VERSION: "test-v1" }));

import { POST } from "@/app/api/checkout/initiate/route";

function tier(over: Partial<Record<string, unknown>>) {
  return {
    tier_id: "t", external_ref: "p", name: "티어", capacity: 100, base_price: 0,
    sold_count: 0, fill_rate: 0, sale_mode: null, sale_window: { opens_at: null, closes_at: null },
    ...over,
  };
}

const PROD_A = "2f0aeb23-573e-4a02-b2a4-a3df1bb51db6";
const PROD_B = "a17a0af8-859f-4b3c-8e9c-46ec7c0f1888";
const EVT = "cbaccedd-51bf-4242-addb-a325ae603cbb";

function makeRequest(
  items: Array<{ productId: string; quantity: number }>,
  extra: Record<string, unknown> = {},
) {
  return new Request("http://localhost/api/checkout/initiate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      eventId: EVT,
      items,
      buyerName: "홍길동",
      buyerEmail: "buyer@example.com",
      buyerPhone: "01012345678",
      // P1-11: durable idempotency 필수(uuid). 특정 테스트는 extra 로 override/제거.
      idempotencyToken: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
      // 구형 나이스: 유료 주문은 전자금융거래 동의 시각이 필수.
      termsAgreedAt: "2026-07-28T00:00:00.000Z",
      ...extra,
    }),
  });
}

beforeEach(() => {
  h.pool.query.mockReset();
  h.createOrder.mockReset().mockResolvedValue({ id: "ord-1", orderNumber: "ORD-1", totalAmount: 0 });
  h.getEvent.mockReset();
  h.getTiersByEvent.mockReset();
  // T17: 유효 스케줄 없음(null)은 이제 **결제 차단(503)** 이다 — 기본값을 유효 플랜으로 둔다.
  //      (null 경로 자체는 아래 전용 테스트와 fee-propagation.itest.ts 가 덮는다.)
  h.prepareNicePayment.mockReset().mockResolvedValue({
    provider_params: { js_url: "https://pg-web.nicepay.co.kr/v3/common/js/nicepay-pgweb.js", form: { MID: "testpick1m" } },
  });
  h.getAccountFeePlan.mockReset().mockResolvedValue({ feePercentage: 3, feeFixed: 300 });
  h.validatePromoCode.mockReset().mockResolvedValue({ promo_id: "dc-1", discount_amount: 5000 });
  h.cookieStore.get.mockReset().mockReturnValue(undefined);
  h.cookieStore.set.mockReset();

  // W2-ORD: go events 앵커 SELECT 폐기 — account/채널/대기열/event id 전부 v2 이벤트 상세에서.
  h.getEvent.mockResolvedValue({
    event_id: EVT,
    go_account_id: "acc-1",
    sale_channels: ["self"],
    queue_enabled: false,
    title: "테스트",
  });
  // 🔴 회귀: 이 라우트는 go events 를 조회하지 않는다(프로모코드 조회만 go-local).
  h.pool.query.mockImplementation(async (sql: string) => {
    if (String(sql).includes("FROM events")) {
      throw new Error(`go events 조회가 남아 있다: ${String(sql)}`);
    }
    return { rows: [] };
  });
});

describe("checkout/initiate — 금액 정본 flip(go↔v2 base_price 정합)", () => {
  it("serverTotal 을 v2 tier.base_price 로 산정한다(go products.price 미read)", async () => {
    h.getTiersByEvent.mockResolvedValue(new Map([
      [PROD_A, tier({ external_ref: PROD_A, base_price: 50000 })],
      [PROD_B, tier({ external_ref: PROD_B, base_price: 30000 })],
    ]));

    const res = await POST(makeRequest([
      { productId: PROD_A, quantity: 2 },
      { productId: PROD_B, quantity: 1 },
    ]));

    expect(res.status).toBe(201);
    // go products 테이블 가격 SELECT 가 없어야 한다(정본 = v2). events 앵커 SELECT 만 허용.
    expect(h.pool.query.mock.calls.some(([sql]) => String(sql).includes("FROM products"))).toBe(false);
    // createOrder 에 넘어가는 서버 권위 총액 = 50000*2 + 30000*1 = 130000 (v2 base_price 기반).
    const arg = h.createOrder.mock.calls[0]?.[0] as { totalAmountOverride: number };
    expect(arg.totalAmountOverride).toBe(130000);
  });

  it("요청 상품이 v2 티어로 해석되지 않으면 400(0원 흘려보냄 방지)", async () => {
    h.getTiersByEvent.mockResolvedValue(new Map([
      [PROD_A, tier({ external_ref: PROD_A, base_price: 50000 })],
    ]));
    const res = await POST(makeRequest([
      { productId: PROD_A, quantity: 1 },
      { productId: PROD_B, quantity: 1 }, // 미해석
    ]));
    expect(res.status).toBe(400);
    expect(h.createOrder).not.toHaveBeenCalled();
  });

  /**
   * 🔴 **숨김 티어(초대권)를 공개 구매로 살 수 없다** (2026-08-01 오픈 당일).
   *
   * 문자열 가드(`public-purchasable.test.ts` 의 "관문 배치")만으로는 부족하다 —
   * 페이블 적대검수가 실증한 우회:
   *
   *     if (blocked && blocked.reason === "unknown_tier") {   // 숨김·비활성만 빠져나감
   *
   * 이 한 줄이면 `findNonPurchasable` 호출도, 인덱스 순서도, 미해석 400 테스트도
   * 전부 통과하면서 **구멍이 100% 부활**한다. 그래서 **라우트 동작**으로 고정한다.
   */
  it("🔴 숨김 티어(초대권)는 400 — 대시보드 전용이다", async () => {
    h.getTiersByEvent.mockResolvedValue(new Map([
      [PROD_A, tier({ external_ref: PROD_A, base_price: 0, visibility: "hidden" })],
    ]));
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }]));
    expect(res.status).toBe(400);
    expect(h.createOrder, "숨김 티어로 주문이 만들어지면 안 된다").not.toHaveBeenCalled();
  });

  it("🔴 정상 티어에 숨김 티어를 **섞어** 보내도 전부 거부 — 전형적 수법이다", async () => {
    h.getTiersByEvent.mockResolvedValue(new Map([
      [PROD_A, tier({ external_ref: PROD_A, base_price: 15000, visibility: "public" })],
      [PROD_B, tier({ external_ref: PROD_B, base_price: 0, visibility: "hidden" })],
    ]));
    const res = await POST(makeRequest([
      { productId: PROD_A, quantity: 1 },
      { productId: PROD_B, quantity: 1 },
    ]));
    expect(res.status).toBe(400);
    expect(h.createOrder).not.toHaveBeenCalled();
  });

  it("판매 중단(is_active=false) 티어도 400", async () => {
    h.getTiersByEvent.mockResolvedValue(new Map([
      [PROD_A, tier({ external_ref: PROD_A, base_price: 15000, visibility: "public", is_active: false })],
    ]));
    expect((await POST(makeRequest([{ productId: PROD_A, quantity: 1 }]))).status).toBe(400);
    expect(h.createOrder).not.toHaveBeenCalled();
  });

  /**
   * 🔴 **반대 방향이 더 큰 사고다.** 오픈 당일 정상 판매가 막히면 구멍보다 훨씬 나쁘다.
   *    `visibility` 가 없는 응답(구버전 v2·필드 누락)에서 거절하면 판매가 통째로 멈춘다.
   */
  it("🔴 visibility 가 없으면 **판다** — 여기서 막으면 오픈이 멈춘다", async () => {
    h.getTiersByEvent.mockResolvedValue(new Map([
      [PROD_A, tier({ external_ref: PROD_A, base_price: 15000 })], // visibility 키 자체가 없음
    ]));
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }]));
    expect(res.status, "정상 판매가 막혔다").not.toBe(400);
    expect(h.createOrder).toHaveBeenCalled();
  });

  it("visibility=public 은 당연히 판다", async () => {
    h.getTiersByEvent.mockResolvedValue(new Map([
      [PROD_A, tier({ external_ref: PROD_A, base_price: 15000, visibility: "public" })],
    ]));
    expect((await POST(makeRequest([{ productId: PROD_A, quantity: 1 }]))).status).not.toBe(400);
    expect(h.createOrder).toHaveBeenCalled();
  });

  it("v2 조회 실패(V2CommerceError)면 502 — 조용한 금액 산정 금지", async () => {
    h.getTiersByEvent.mockRejectedValue(new h.V2CommerceError("down", 502));
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }]));
    expect(res.status).toBe(502);
    expect(h.createOrder).not.toHaveBeenCalled();
  });
});

/**
 * W2-ORD 회귀: 이벤트 조회가 go events → v2 로 이관되면서 **실패 모드 분리**가 계약이 됐다.
 * 옛 코드는 미앵커(v2_event_id NULL)를 409 로 냈지만, 이제 앵커 개념 자체가 없다.
 * 남는 구분은 딱 둘이다: 없는 행사(404) vs v2 장애(503).
 * 🔴 v2 장애를 404/400 으로 내면 구매자는 "행사가 사라졌다"·"내 입력이 틀렸다"로 오인하고
 *    클라이언트도 재시도하지 않는다 — 결제 진입이 조용히 막힌다.
 */
describe("checkout/initiate — T17 수수료 fail-closed", () => {
  it("🔴 유효 수수료 스케줄이 없으면(null) 0원으로 흘리지 않고 503 으로 막는다", async () => {
    h.getTiersByEvent.mockResolvedValue(new Map([[PROD_A, tier({ external_ref: PROD_A, base_price: 15000 })]]));
    h.getAccountFeePlan.mockResolvedValue(null);
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }]));
    expect(res.status).toBe(503);
    expect(h.createOrder).not.toHaveBeenCalled();
  });
});

describe("checkout/initiate — W2-ORD 이벤트 조회 fail-closed", () => {
  beforeEach(() => {
    h.getTiersByEvent.mockResolvedValue(new Map([[PROD_A, tier({ external_ref: PROD_A, base_price: 10000 })]]));
  });

  it("v2 404(없는 행사) → 404", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("no event", 404));
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }]));
    expect(res.status).toBe(404);
    expect(h.createOrder).not.toHaveBeenCalled();
  });

  it("v2 5xx(장애) → 503 (404·400 으로 위장 금지)", async () => {
    h.getEvent.mockRejectedValue(new h.V2CommerceError("down", 503));
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }]));
    expect(res.status).toBe(503);
    expect(h.createOrder).not.toHaveBeenCalled();
  });

  it("v2 네이티브 주최자(go_account_id 없음) → 404 (go 결제 대상 아님)", async () => {
    h.getEvent.mockResolvedValue({
      event_id: EVT, go_account_id: null, sale_channels: ["self"], queue_enabled: false, title: "t",
    });
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }]));
    expect(res.status).toBe(404);
    expect(h.createOrder).not.toHaveBeenCalled();
  });

  it("createOrder 가 EventAccessError(unavailable) 를 던지면 503 — 400 위장 금지", async () => {
    h.createOrder.mockRejectedValue(new h.EventAccessError("v2 down", "unavailable", 502));
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }]));
    expect(res.status).toBe(503);
  });

  it("createOrder 가 EventAccessError(not_found) 를 던지면 404", async () => {
    h.createOrder.mockRejectedValue(new h.EventAccessError("없음", "not_found", 404));
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }]));
    expect(res.status).toBe(404);
  });

  it("self 채널이 아니면 403 (v2 sale_channels 정본)", async () => {
    h.getEvent.mockResolvedValue({
      event_id: EVT, go_account_id: "acc-1", sale_channels: ["marketplace"],
      queue_enabled: false, title: "t",
    });
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }]));
    expect(res.status).toBe(403);
  });

  it("수수료는 주문 생성 파라미터로 전달된다(별도 go UPDATE 폐기)", async () => {
    h.getAccountFeePlan.mockResolvedValue({ feePercentage: 3, feeFixed: 300 });
    h.calculatePlatformFee.mockReturnValue(600);
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }]));
    expect(res.status).toBe(201);
    const arg = h.createOrder.mock.calls[0]?.[0] as { platformFee: number };
    expect(arg.platformFee).toBe(600);
    // 옛 `UPDATE orders SET platform_fee` 는 사라졌다(go 앵커 write 1건 제거).
    expect(h.pool.query.mock.calls.some(([sql]) => /UPDATE orders/.test(String(sql)))).toBe(false);
  });
});

describe("checkout/initiate — P1 durable idempotency 토큰 전달(재시도 dedup 시드)", () => {
  beforeEach(() => {
    h.getTiersByEvent.mockResolvedValue(new Map([[PROD_A, tier({ external_ref: PROD_A, base_price: 10000 })]]));
  });

  it("body.idempotencyToken 을 createOrder 로 그대로 전달한다(호출자 durable key)", async () => {
    const token = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }], { idempotencyToken: token }));
    expect(res.status).toBe(201);
    const arg = h.createOrder.mock.calls[0]?.[0] as { idempotencyToken?: string };
    expect(arg.idempotencyToken).toBe(token);
  });

  it("토큰 미전송(구버전 클라)이면 400 — durable idempotency 필수(랜덤 폴백 제거, 중복발권 차단)", async () => {
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }], { idempotencyToken: undefined }));
    expect(res.status).toBe(400);
    expect(h.createOrder).not.toHaveBeenCalled();
  });

  it("uuid 형식이 아닌 토큰은 400(스키마 거부) — 오염 시드 차단", async () => {
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }], { idempotencyToken: "not-a-uuid" }));
    expect(res.status).toBe(400);
    expect(h.createOrder).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 T14 카드사 자동할인 — 서버 가드.
 *
 * 감사에서 이 경로의 프론트/라우트 테스트가 **0건**이었고, 그래서 무통장입금 조합·
 * 미설정 카드사 주장이 전부 통과했다. 손실이 나는 조합만 골라 고정한다.
 */
describe("checkout/initiate — 카드사 자동할인(T14) 가드", () => {
  const CARD_EVENT = {
    event_id: EVT,
    go_account_id: "acc-1",
    sale_channels: ["self"],
    queue_enabled: false,
    title: "테스트",
    card_discounts: { BC: { rate: 10, discount_code: "BC-AUTO-XYZ" } },
  };

  beforeEach(() => {
    h.getEvent.mockResolvedValue(CARD_EVENT);
    h.getTiersByEvent.mockResolvedValue(new Map([
      [PROD_A, tier({ external_ref: PROD_A, base_price: 50000 })],
    ]));
  });

  it("BC 선택 시 **서버가** 이벤트 설정의 할인코드를 붙인다(클라 코드 주장 불가)", async () => {
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }], { cardDiscount: "BC" }));
    expect(res.status).toBe(201);
    // 클라는 "BC" 만 보냈는데 v2 검증에는 이벤트 설정의 코드가 나가야 한다.
    expect(h.validatePromoCode).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "BC-AUTO-XYZ" }),
    );
  });

  it.each(["VBANK", "BANK", "CELLPHONE"])(
    "🔴 %s 결제수단과 함께 오면 400 — 카드 없이 할인받는 순손실",
    async (payMethod) => {
      const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }], {
        cardDiscount: "BC", payMethod,
      }));
      expect(res.status).toBe(400);
      expect(h.createOrder).not.toHaveBeenCalled();
    },
  );

  it.each(["EASYPAY", "CARDANDEASYPAY"])(
    "🔴 %s 도 400 — 간편결제는 SelectCardCode 로 카드사를 제한할 수 없어 승인 후 취소된다",
    async (payMethod) => {
      const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }], {
        cardDiscount: "BC", payMethod,
      }));
      expect(res.status).toBe(400);
      expect(h.createOrder).not.toHaveBeenCalled();
    },
  );

  it("CARD 는 통과한다(과잉차단 아님)", async () => {
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }], {
      cardDiscount: "BC", payMethod: "card",
    }));
    expect(res.status).toBe(201);
  });

  it("🔴 이 행사에 설정되지 않은 카드사를 주장하면 400 — 조용히 무시하면 정가 결제된다", async () => {
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }], { cardDiscount: "SAMSUNG" }));
    expect(res.status).toBe(400);
    // 🔴 사유까지 고정한다 — 가드를 지우면 미설정 cfg 를 그대로 읽어 **다른 이유로** 400/500 이
    //    나므로 status 만 보면 뮤테이션이 살아남는다(실측으로 확인).
    expect(await res.json()).toMatchObject({ error: "선택하신 카드사 할인을 사용할 수 없습니다" });
    expect(h.validatePromoCode).not.toHaveBeenCalled();
  });

  it("프로모코드와 동시 사용은 400 — v2 는 주문당 할인코드 1개만 적용한다", async () => {
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }], {
      cardDiscount: "BC", promoCode: "WELCOME",
    }));
    expect(res.status).toBe(400);
  });

  it("카드사 할인을 안 고르면 기존 경로 그대로(현행 동작 불변)", async () => {
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }]));
    expect(res.status).toBe(201);
    expect(h.validatePromoCode).not.toHaveBeenCalled();
  });
});

/**
 * 🔴 무통장입금 주문은 PG prepare 를 타지 않아야 한다.
 *
 * prepare 는 v2 `orders.payment_id` 를 세팅한다. 무통장 주문에도 돌리면 주최자
 * 입금확정 게이트(has_pg_payment 로 카드 이탈 주문을 가르는 장치)가 **정상 무통장
 * 주문을 막는다**. 옆세션 bb2ec2d2 를 검수하다 실행으로 확인한 회귀다.
 */
describe("checkout/initiate — 무통장입금(offlinePayment)", () => {
  beforeEach(() => {
    // 🔴 무통장은 **입금 계좌 안내가 있어야만** 받는다(2026-07-30). 아래 테스트들은
    //    "계좌가 설정된" 환경을 전제하므로 명시적으로 채운다. 안 채우면 503 이 정답이다
    //    (그 경우는 별도 테스트로 단언한다).
    h.isOfflinePaymentAvailable.mockReturnValue(true);
    process.env.NEXT_PUBLIC_BANK_NAME = "국민은행";
    process.env.NEXT_PUBLIC_BANK_ACCOUNT = "123-45-6789";
    process.env.NEXT_PUBLIC_BANK_HOLDER = "주식회사 노드엑스";
    h.getTiersByEvent.mockResolvedValue(new Map([
      [PROD_A, tier({ external_ref: PROD_A, base_price: 50000 })],
    ]));
    // 기본 mock 은 totalAmount:0 이라 prepare 자체가 스킵된다 — 유료주문으로 되돌린다.
    h.createOrder.mockResolvedValue({
      id: "ord-1", orderNumber: "ORD-1", totalAmount: 50000,
      v2OrderId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("🔴 offlinePayment=true 면 prepare 를 타지 않는다(payment_id 미세팅 = 입금확정 가능)", async () => {
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }], { offlinePayment: true }));
    expect(res.status).toBe(201);
    expect(h.prepareNicePayment).not.toHaveBeenCalled();
  });

  it("카드 결제(기본)는 prepare 를 탄다 — 과잉 스킵 아님", async () => {
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }]));
    expect(res.status).toBe(201);
    expect(h.prepareNicePayment).toHaveBeenCalled();
  });

  it("🔴 무통장 + 카드사 할인은 400 — 카드 없이 할인받는 순손실", async () => {
    h.getEvent.mockResolvedValue({
      event_id: EVT, go_account_id: "acc-1", sale_channels: ["self"],
      queue_enabled: false, title: "테스트",
      card_discounts: { BC: { rate: 10, discount_code: "BC-AUTO-XYZ" } },
    });
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }], {
      offlinePayment: true, cardDiscount: "BC",
    }));
    expect(res.status).toBe(400);
    expect(h.createOrder).not.toHaveBeenCalled();
  });

  /**
   * 🔴 결제수단별 기한 (2026-07-30 실사고)
   *
   * 종전엔 핸들러 앞에서 **무조건 15분**을 계산했다. 화면은 "3일 이내" 라고 안내했고,
   * 만료 스윕은 payment_method 를 보지 않아 **무통장 주문이 15분에 만료**됐다
   * (prod `517ed296`: 10:49 생성 → 11:04 기한).
   * 은행 이체가 15분에 끝나지 않으므로, 주문은 사라지고 돈은 나중에 들어온다.
   */
  it("🔴 무통장 주문의 결제기한은 24시간 뒤다", async () => {
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }], { offlinePayment: true }));
    expect(res.status).toBe(201);
    const arg = h.createOrder.mock.calls[0]?.[0] as { expiresAt: string };
    const hours = (new Date(arg.expiresAt).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.5);
    expect(hours).toBeLessThan(24.5);
  });

  it("카드 주문의 결제기한은 15분 뒤다 — 종전 동작을 바꾸지 않는다", async () => {
    // ⚠️ 카드까지 24시간으로 늘리면 미결제 주문이 재고를 하루 묶는다. 분기를 단언한다.
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }]));
    expect(res.status).toBe(201);
    const arg = h.createOrder.mock.calls[0]?.[0] as { expiresAt: string };
    const minutes = (new Date(arg.expiresAt).getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThan(16);
  });

  /**
   * 🔴 계좌 안내가 없으면 무통장을 받지 않는다 (fail-closed).
   *
   * prod 는 `NEXT_PUBLIC_BANK_*` 가 **빈 문자열**이라 화면에 은행명·계좌번호·예금주가
   * 전부 빈칸으로 나갔다(실측). `?? "국민은행"` 폴백은 빈 문자열을 막지 못한다.
   * 화면에서 선택지를 숨기지만, **서버가 마지막 관문**이다 — 직접 호출을 막는다.
   */
  it("🔴 계좌 안내를 못 만드는 상태면 무통장 주문을 503 으로 거부한다", async () => {
    // ⚠️ env 를 비우는 방식으로는 더 이상 재현되지 않는다 — 정본 계좌(DEFAULT_BANK_INFO)가
    //    코드에 있어 env 가 비어도 이용 가능하다(그게 이 수정의 목적이다).
    //    그래도 가드는 살려둔다: 정본을 지우거나 잘못 바꾼 배포에서 **무통장을 팔지 않기** 위해서다.
    //    ⟹ 가용성 판정만 갈아끼워 가드 자체를 검증한다.
    h.isOfflinePaymentAvailable.mockReturnValue(false);
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }], { offlinePayment: true }));
    expect(res.status).toBe(503);
    expect(h.createOrder).not.toHaveBeenCalled();
  });

  it("계좌 안내가 없어도 카드 주문은 정상 진행된다 — 과잉 차단 아님", async () => {
    h.isOfflinePaymentAvailable.mockReturnValue(false);
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }]));
    expect(res.status).toBe(201);
  });

  it("env 가 비어 있어도 무통장은 이용 가능하다 — 정본 계좌가 코드에 있다", async () => {
    // prod 가 정확히 이 상태였다(env 빈 문자열). 종전엔 화면에 빈칸이 나갔다.
    process.env.NEXT_PUBLIC_BANK_NAME = "";
    process.env.NEXT_PUBLIC_BANK_ACCOUNT = "";
    process.env.NEXT_PUBLIC_BANK_HOLDER = "";
    const res = await POST(makeRequest([{ productId: PROD_A, quantity: 1 }], { offlinePayment: true }));
    expect(res.status).toBe(201);
  });
});
