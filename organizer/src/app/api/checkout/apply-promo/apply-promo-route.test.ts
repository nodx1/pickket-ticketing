import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * W5-COMMERCE — 체크아웃 프로모코드 적용(표시액) 회귀.
 *
 * 여기서 고정하는 것:
 *   1. 할인액을 go 가 재계산하지 않는다 — **v2 검증 응답 값을 그대로** 쓴다.
 *      (go 가 별도 산식으로 계산하면 표시액≠청구액이 되고 주문 생성이 AMOUNT_MISMATCH 로 거절)
 *   2. v2 장애를 "할인 0원"·"유효하지 않은 코드"로 흘리지 않는다 → 503.
 *   3. 코드별 사유(미존재/기간전/만료/한도초과)를 한국어로 갈라 안내한다.
 */

const { validatePromoCode, V2CommerceError, v2ErrorCode } = vi.hoisted(() => {
  class V2CommerceError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly body?: string,
    ) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return {
    validatePromoCode: vi.fn(),
    V2CommerceError,
    v2ErrorCode: (err: unknown): string | null => {
      if (!(err instanceof V2CommerceError) || !err.body) return null;
      try {
        const parsed = JSON.parse(err.body) as { error?: { code?: unknown } };
        return typeof parsed?.error?.code === "string" ? parsed.error.code : null;
      } catch {
        return null;
      }
    },
  };
});

vi.mock("@/lib/v2/commerce-client", () => ({ validatePromoCode, V2CommerceError, v2ErrorCode }));
// 레이트리밋 HOF 는 통과시킨다(레이트리밋 자체는 별도 테스트 소관).
vi.mock("@/lib/auth/withRateLimit", () => ({
  withRateLimit: () => (handler: (req: Request) => Promise<Response>) => handler,
}));

const { POST } = await import("@/app/api/checkout/apply-promo/route");

const EVENT_ID = "11111111-1111-4111-8111-111111111111";

function req(body: unknown): Request {
  return { json: async () => body } as unknown as Request;
}

function v2Err(status: number, code?: string) {
  return new V2CommerceError("v2", status, code ? JSON.stringify({ error: { code } }) : undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("apply-promo — 할인액은 v2 정본", () => {
  it("v2 가 계산한 discount/final 을 그대로 반환한다(go 재계산 금지)", async () => {
    validatePromoCode.mockResolvedValue({
      valid: true,
      promo_id: "v2-code-1",
      code: "SAVE10",
      promo_type: "percentage",
      discount_value: 10,
      gross_amount: 33333,
      // 🔴 go 가 Math.floor 로 다시 계산하면 3333 이 된다 — v2 값(3333.3)과 갈라진다.
      discount_amount: 3333.3,
      final_amount: 29999.7,
    });

    const res = await POST(req({ eventId: EVENT_ID, code: "save10", totalAmount: 33333 }));
    expect(res.status).toBe(200);
    const payload = (await res.json()) as {
      data: { discountAmount: number; finalAmount: number; promoCode: { code: string } };
    };
    expect(payload.data.discountAmount).toBe(3333.3);
    expect(payload.data.finalAmount).toBe(29999.7);
    expect(payload.data.promoCode.code).toBe("SAVE10");
  });

  it("코드는 대문자로 정규화해 v2 에 보낸다", async () => {
    validatePromoCode.mockResolvedValue({
      valid: true,
      promo_id: "p",
      code: "SAVE10",
      promo_type: "fixed",
      discount_value: 1000,
      gross_amount: 5000,
      discount_amount: 1000,
      final_amount: 4000,
    });
    await POST(req({ eventId: EVENT_ID, code: "save10", totalAmount: 5000 }));
    expect(validatePromoCode).toHaveBeenCalledWith(EVENT_ID, {
      code: "SAVE10",
      gross_amount: 5000,
    });
  });
});

describe("apply-promo — fail-closed", () => {
  it("🔴 v2 장애는 503 — 할인 0원이나 '유효하지 않은 코드'로 위장하지 않는다", async () => {
    validatePromoCode.mockRejectedValue(v2Err(500));
    const res = await POST(req({ eventId: EVENT_ID, code: "SAVE10", totalAmount: 5000 }));
    expect(res.status).toBe(503);
  });

  it("사유별 안내 — 미존재 404 / 기간 전 400 / 만료 400 / 한도초과 400", async () => {
    const cases: Array<[number, string, number]> = [
      [404, "PROMO_NOT_FOUND", 404],
      [400, "PROMO_NOT_YET", 400],
      [400, "PROMO_EXPIRED", 400],
      [409, "PROMO_EXHAUSTED", 400],
    ];
    for (const [status, code, expected] of cases) {
      validatePromoCode.mockRejectedValueOnce(v2Err(status, code));
      const res = await POST(req({ eventId: EVENT_ID, code: "SAVE10", totalAmount: 5000 }));
      expect(res.status, code).toBe(expected);
    }
  });

  it("코드 미상 4xx 는 400, 코드 미상 5xx 는 503", async () => {
    validatePromoCode.mockRejectedValueOnce(v2Err(422));
    expect((await POST(req({ eventId: EVENT_ID, code: "X1", totalAmount: 1 }))).status).toBe(400);

    validatePromoCode.mockRejectedValueOnce(v2Err(503));
    expect((await POST(req({ eventId: EVENT_ID, code: "X1", totalAmount: 1 }))).status).toBe(503);
  });

  it("입력 검증 실패는 400 이고 v2 를 호출하지 않는다", async () => {
    const res = await POST(req({ eventId: "not-a-uuid", code: "X", totalAmount: -1 }));
    expect(res.status).toBe(400);
    expect(validatePromoCode).not.toHaveBeenCalled();
  });
});
