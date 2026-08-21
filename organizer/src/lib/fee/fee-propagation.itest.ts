import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from "vitest";

/**
 * T8-④ — "fee 조회 실패가 호출측까지 전파되는가" 를 **실행**으로 확인한다.
 *
 * 보고서는 "fail-closed: 장애를 삼켜 수수료 0 을 만들지 않는다"를 **요구사항으로만** 적었다.
 * 실제로 호출측이 어떻게 반응하는지는 검증된 적이 없다. 여기서 두 호출측을 모두 태운다.
 *
 *   · POST /api/checkout/initiate  — 결제 진입(구매자 대면)
 *   · POST /api/events             — 행사 개설 시 fee plan write-through
 *
 * v2 는 실 HTTP 스텁이라 commerce-client 의 "5xx 재시도 → V2CommerceError(status)" 계약이
 * 그대로 실행된다.
 */
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));
// 레이트리밋은 T8 의 대상이 아니다(라우트 본문을 그대로 실행시킨다).
vi.mock("@/lib/auth/withRateLimit", () => ({
  withRateLimit: (_opts: unknown) => (handler: unknown) => handler,
}));

import { getPool } from "@/lib/db/pool";
import { getAccountFeePlan, calculatePlatformFee } from "@/lib/fee/calculator";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { startV2Stub, useV2Stub, type V2Stub } from "@/test/itest-harness";

let stub: V2Stub;
let restoreEnv: () => void;

beforeAll(async () => {
  stub = await startV2Stub();
  restoreEnv = useV2Stub(stub);
});
afterAll(async () => {
  restoreEnv();
  await stub.close();
  await getPool().end().catch(() => undefined);
});
beforeEach(() => {
  stub.routes.length = 0;
  stub.calls.length = 0;
});

const FEE_PATH = /^\/api\/v1\/internal\/organizers\/[^/]+\/fee-plan$/;
const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";

describe("T8-④ getAccountFeePlan 자체 계약", () => {
  it("플랜 있음 — v2 값을 그대로 반영한다(15,000 → 750)", async () => {
    stub.routes.push({
      method: "GET", pathPattern: FEE_PATH, status: 200,
      data: { fee_plan: { id: "fp-1", fee_type: "percentage_plus_fixed", fee_percentage: 3, fee_fixed: 300, min_fee: 0, max_fee: null } },
    });
    const plan = await getAccountFeePlan(ACCOUNT_ID);
    expect(plan).not.toBeNull();
    expect(calculatePlatformFee(plan!, 15000)).toBe(750);
  });

  it("플랜 없음 — null (호출측이 기본플랜을 결정한다)", async () => {
    stub.routes.push({ method: "GET", pathPattern: FEE_PATH, status: 200, data: { fee_plan: null } });
    await expect(getAccountFeePlan(ACCOUNT_ID)).resolves.toBeNull();
  });

  it("🔴 v2 장애 — 삼키지 않고 V2CommerceError 를 던진다(수수료 0 강등 금지)", async () => {
    stub.routes.push({ method: "GET", pathPattern: FEE_PATH, status: 503 });
    await expect(getAccountFeePlan(ACCOUNT_ID)).rejects.toBeInstanceOf(V2CommerceError);
  });

  it("🔴 v2 라우트 미배포(404) 도 null 이 아니라 예외 — '플랜 없음'과 구분된다", async () => {
    // 백엔드가 organizer 보다 늦게 배포되면 이 경로가 404 다. 이때 null(=수수료 0)로
    // 흘리면 무료 판매가 된다. 반드시 예외여야 한다.
    stub.routes.push({ method: "GET", pathPattern: FEE_PATH, status: 404 });
    await expect(getAccountFeePlan(ACCOUNT_ID)).rejects.toBeInstanceOf(V2CommerceError);
  });
});

describe("T8-④ 호출측 전파 — POST /api/checkout/initiate", () => {
  const EVENT_ID = "22222222-2222-4222-8222-222222222222";
  const V2_EVENT_ID = "33333333-3333-4333-8333-333333333333";
  const PRODUCT_ID = "44444444-4444-4444-8444-444444444444";

  function seedV2Routes() {
    stub.routes.push({
      method: "GET", pathPattern: /^\/api\/v1\/internal\/events\/[^/?]+(\?.*)?$/, status: 200,
      data: { event_id: V2_EVENT_ID, go_account_id: ACCOUNT_ID, sale_channels: ["self"], queue_enabled: false },
    });
    stub.routes.push({
      method: "GET", pathPattern: /^\/api\/v1\/internal\/events\/[^/]+\/tiers$/, status: 200,
      data: { tiers: [{ id: "t1", external_ref: PRODUCT_ID, base_price: 15000, capacity: 100, sold_count: 0 }] },
    });
  }

  const callCheckout = async () => {
    const { POST } = await import("@/app/api/checkout/initiate/route");
    return (POST as unknown as (r: Request) => Promise<Response>)(
      new Request("https://go.pickket.kr/api/checkout/initiate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          eventId: EVENT_ID,
          items: [{ productId: PRODUCT_ID, quantity: 1 }],
          buyerName: "홍길동",
          buyerEmail: "buyer@pickket.kr",
          buyerPhone: "01012345678",
          idempotencyToken: crypto.randomUUID(),
          // 구형 나이스: 유료 주문은 전자금융거래 동의 시각이 필수(초기 400 차단).
          termsAgreedAt: "2026-07-28T00:00:00.000Z",
        }),
      }),
    );
  };

  it("🔴 T17: 유효 스케줄 없음(fee_plan:null)도 0원으로 흘리지 않고 503 으로 막는다", async () => {
    seedV2Routes();
    // v2 가 200 으로 "플랜 없음" 을 명시 응답하는 경우 — 장애가 아니다.
    stub.routes.push({ method: "GET", pathPattern: FEE_PATH, status: 200, data: { fee_plan: null } });

    const res = await callCheckout();

    // 예전엔 여기서 platformFee=0 으로 주문이 생성됐다(수수료 영구 0 동결).
    expect(res.status).toBe(503);
    expect(stub.calls.filter((c) => /\/orders$/.test(c.path) && c.method === "POST")).toHaveLength(0);
  });

  it("🔴 fee 조회가 v2 장애면 주문을 만들지 않고 503 을 돌려준다", async () => {
    seedV2Routes();
    stub.routes.push({ method: "GET", pathPattern: FEE_PATH, status: 503 });
    // createOrder 는 정의하지 않는다 — 호출되면 스텁이 501 을 주고 아래 단언이 깨진다.

    const res = await callCheckout();

    expect(res.status).toBe(503);
    // 🔴 주문 생성으로 넘어가지 않았는가(수수료 미상태로 주문이 생기면 정산이 틀어진다).
    expect(stub.calls.filter((c) => /\/orders$/.test(c.path) && c.method === "POST")).toHaveLength(0);
  });

  it("fee 라우트 404(백엔드 미배포) — 주문은 안 만들지만 상태코드가 404 로 나간다", async () => {
    seedV2Routes();
    stub.routes.push({ method: "GET", pathPattern: FEE_PATH, status: 404 });

    const res = await callCheckout();

    // ⚠️ 현행 동작을 **고정**해 둔다(의도적 변경만 이 테스트를 깨뜨리도록).
    //    commerce-client 는 4xx 를 "사용자에게 의미 있는 거절"로 보고 그대로 통과시키므로
    //    체크아웃이 404 를 낸다. 그런데 이 404 의 진짜 의미는 "v2 백엔드에 fee-plan
    //    라우트가 아직 없음"(배포 순서 문제)이지 "행사가 없음"이 아니다.
    //    fail-closed 자체는 지켜진다(주문 미생성). 상태코드 의미는 보고서 리스크 항목 참고.
    expect(res.status).toBe(404);
    expect(stub.calls.filter((c) => /\/orders$/.test(c.path) && c.method === "POST")).toHaveLength(0);
  });
});
