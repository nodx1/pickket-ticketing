import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

/**
 * W5-COMMERCE — 프로모코드 라우트 v2 단일화 회귀.
 *
 * 이전 구조는 go `promo_codes` 앵커 + v2 write-through 이중 원장이었고, 이 파일은
 * "go 만 바꾸고 v2 를 방치하면 소비자에게는 여전히 코드가 먹는다"(split-brain)를 막는
 * 회귀였다. 이제 정본이 v2 하나뿐이라 split-brain 자체가 불가능하다.
 *
 * 여기서 새로 고정하는 것:
 *   1. 소유 경계 — 타 계정 이벤트는 404, v2 장애는 503(404 로 뭉개면 "이벤트가 사라졌다"는 거짓말).
 *   2. 목록 조회 실패는 **빈 배열이 아니라 503** (프로모코드 없음으로 보이면 중복 생성·과할인).
 *   3. DELETE 는 v2 404 를 "이미 없음 → 성공"으로 흡수하지 않는다.
 *   4. PATCH 는 보낸 키만 전달(부분 수정), 할인 유형/값은 짝으로만 변경 허용.
 */

const stubSession = { id: "u-1", accountId: "acct-1", role: "organizer" };
vi.mock("@/lib/auth/permissions", () => ({
  withRole:
    (
      _role: string,
      handler: (
        req: NextRequest,
        ctx: { session: typeof stubSession; params: { eventId: string; promoId: string } },
      ) => Promise<Response>,
    ) =>
    (req: NextRequest) =>
      handler(req, { session: stubSession, params: { eventId: "event-1", promoId: "promo-1" } }),
}));

const { listPromoCodes, createPromoCode, patchPromoCode, deletePromoCode, V2CommerceError } =
  vi.hoisted(() => {
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
      listPromoCodes: vi.fn(),
      createPromoCode: vi.fn(),
      patchPromoCode: vi.fn(),
      deletePromoCode: vi.fn(),
      V2CommerceError,
    };
  });

vi.mock("@/lib/v2/commerce-client", () => ({
  listPromoCodes,
  createPromoCode,
  patchPromoCode,
  deletePromoCode,
  V2CommerceError,
}));

const { resolveOwnedV2EventId, EventAccessError, eventAccessStatus } = vi.hoisted(() => {
  class EventAccessError extends Error {
    constructor(
      message: string,
      readonly reason: "not_found" | "unavailable",
      readonly status: number,
    ) {
      super(message);
      this.name = "EventAccessError";
    }
  }
  return {
    resolveOwnedV2EventId: vi.fn(),
    EventAccessError,
    eventAccessStatus: (err: { reason: string }) => (err.reason === "not_found" ? 404 : 503),
  };
});
vi.mock("@/lib/v2/event-access", () => ({
  resolveOwnedV2EventId,
  EventAccessError,
  eventAccessStatus,
}));

import { PATCH, DELETE } from "@/app/api/events/[eventId]/promo-codes/[promoId]/route";
import { GET as LIST, POST as CREATE } from "@/app/api/events/[eventId]/promo-codes/route";

const ctx = { params: Promise.resolve({ eventId: "event-1", promoId: "promo-1" }) };

const V2_PROMO = {
  promo_id: "v2-code-1",
  code: "SAVE10",
  promo_type: "percentage" as const,
  discount_value: 10,
  usage_limit: 100,
  used_count: 7,
  starts_at: null,
  ends_at: null,
  is_active: true,
  description: null,
  min_order_amount: null,
  max_discount_amount: null,
  created_at: "2026-07-01T00:00:00Z",
};

function req(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

const VALID_CREATE = {
  code: "SAVE10",
  promoType: "percentage",
  discountValue: 10,
  usageLimit: 100,
};

beforeEach(() => {
  vi.clearAllMocks();
  resolveOwnedV2EventId.mockResolvedValue("v2-ev-1");
  listPromoCodes.mockResolvedValue({ promo_codes: [V2_PROMO], total: 1 });
  createPromoCode.mockResolvedValue(V2_PROMO);
  patchPromoCode.mockResolvedValue(V2_PROMO);
  deletePromoCode.mockResolvedValue({ promo_id: "v2-code-1", deleted: true });
});

describe("promo-codes GET — 목록은 v2 정본(사용량 포함)", () => {
  it("v2 행을 주최자 화면 계약으로 매핑하고 usedCount 를 정본 그대로 노출한다", async () => {
    const res = await LIST(req({}), ctx);
    expect(res.status).toBe(200);
    const payload = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(payload.data[0]).toMatchObject({
      id: "v2-code-1",
      code: "SAVE10",
      promoType: "percentage",
      discountValue: 10,
      usedCount: 7,
      isActive: true,
    });
  });

  it("🔴 v2 장애를 빈 목록으로 위장하지 않는다 — 503", async () => {
    listPromoCodes.mockRejectedValue(new V2CommerceError("down", 500));
    const res = await LIST(req({}), ctx);
    expect(res.status).toBe(503);
  });

  it("타 계정 이벤트는 404", async () => {
    resolveOwnedV2EventId.mockResolvedValue(null);
    const res = await LIST(req({}), ctx);
    expect(res.status).toBe(404);
    expect(listPromoCodes).not.toHaveBeenCalled();
  });
});

describe("promo-codes POST — 생성", () => {
  it("정상 생성 시 v2 canonical code_id 를 돌려준다", async () => {
    const res = await CREATE(req(VALID_CREATE), ctx);
    expect(res.status).toBe(201);
    const payload = (await res.json()) as { data: { id: string } };
    expect(payload.data.id).toBe("v2-code-1");
  });

  it("중복 코드는 409", async () => {
    createPromoCode.mockRejectedValue(new V2CommerceError("conflict", 409));
    const res = await CREATE(req(VALID_CREATE), ctx);
    expect(res.status).toBe(409);
  });

  it("정률 1~100 범위 밖은 400 이고 v2 를 호출하지 않는다", async () => {
    const res = await CREATE(req({ ...VALID_CREATE, discountValue: 120 }), ctx);
    expect(res.status).toBe(400);
    expect(createPromoCode).not.toHaveBeenCalled();
  });

  it("타 계정 이벤트면 404 이고 생성하지 않는다", async () => {
    resolveOwnedV2EventId.mockResolvedValue(null);
    const res = await CREATE(req(VALID_CREATE), ctx);
    expect(res.status).toBe(404);
    expect(createPromoCode).not.toHaveBeenCalled();
  });

  it("v2 장애면 503(500 아님) 이고 성공으로 흡수하지 않는다", async () => {
    resolveOwnedV2EventId.mockRejectedValue(
      new EventAccessError("커머스 서버에 연결할 수 없습니다", "unavailable", 502),
    );
    const res = await CREATE(req(VALID_CREATE), ctx);
    expect(res.status).toBe(503);
    expect(createPromoCode).not.toHaveBeenCalled();
  });

  it("생성 요청은 코드 값에 결속된 멱등키를 쓴다(더블클릭이 중복 코드를 만들지 않게)", async () => {
    await CREATE(req(VALID_CREATE), ctx);
    expect(createPromoCode).toHaveBeenCalledWith(
      "v2-ev-1",
      expect.objectContaining({ code: "SAVE10" }),
      expect.objectContaining({ idempotencyKey: "promo-create:v2-ev-1:SAVE10" }),
    );
  });
});

describe("promo-codes PATCH — 부분 수정", () => {
  it("isActive 만 보내면 그 키만 v2 로 전달된다(나머지 보존)", async () => {
    const res = await PATCH(req({ isActive: false }), ctx);
    expect(res.status).toBe(200);
    expect(patchPromoCode).toHaveBeenCalledWith("v2-ev-1", "promo-1", { is_active: false });
  });

  it("🔴 할인 유형만 바꾸면 400 — '5000원'이 '5000%'가 되는 것을 막는다", async () => {
    const res = await PATCH(req({ promoType: "percentage" }), ctx);
    expect(res.status).toBe(400);
    expect(patchPromoCode).not.toHaveBeenCalled();
  });

  it("유형+값을 함께 보내면 통과한다", async () => {
    const res = await PATCH(req({ promoType: "fixed", discountValue: 3000 }), ctx);
    expect(res.status).toBe(200);
    expect(patchPromoCode).toHaveBeenCalledWith("v2-ev-1", "promo-1", {
      promo_type: "fixed",
      discount_value: 3000,
    });
  });

  it("usageLimit:null(무제한 복귀)은 키를 실어 보낸다 — undefined 와 구분", async () => {
    await PATCH(req({ usageLimit: null }), ctx);
    expect(patchPromoCode).toHaveBeenCalledWith("v2-ev-1", "promo-1", { usage_limit: null });
  });

  it("v2 미존재는 404, v2 장애는 503", async () => {
    patchPromoCode.mockRejectedValueOnce(new V2CommerceError("gone", 404));
    expect((await PATCH(req({ isActive: false }), ctx)).status).toBe(404);

    patchPromoCode.mockRejectedValueOnce(new V2CommerceError("down", 502));
    expect((await PATCH(req({ isActive: false }), ctx)).status).toBe(503);
  });
});

describe("promo-codes DELETE", () => {
  it("정상 삭제는 200", async () => {
    const res = await DELETE(req({}), ctx);
    expect(res.status).toBe(200);
    expect(deletePromoCode).toHaveBeenCalledWith("v2-ev-1", "promo-1");
  });

  it("🔴 v2 404 를 '이미 없음 → 성공'으로 흡수하지 않는다", async () => {
    deletePromoCode.mockRejectedValue(new V2CommerceError("gone", 404));
    const res = await DELETE(req({}), ctx);
    expect(res.status).toBe(404);
  });

  it("🔴 v2 장애를 삭제 성공으로 흡수하지 않는다 — 503", async () => {
    deletePromoCode.mockRejectedValue(new V2CommerceError("down", 500));
    const res = await DELETE(req({}), ctx);
    expect(res.status).toBe(503);
  });

  it("타 계정 이벤트는 404 이고 v2 삭제를 호출하지 않는다", async () => {
    resolveOwnedV2EventId.mockResolvedValue(null);
    const res = await DELETE(req({}), ctx);
    expect(res.status).toBe(404);
    expect(deletePromoCode).not.toHaveBeenCalled();
  });
});
