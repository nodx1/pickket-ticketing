import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// 레벨2 컷오버 T2-REST — 영수증 발행 원장의 go tax_invoices → v2 이관 회귀.
//
// 검증 대상:
//  ① go DB 에 tax_invoices INSERT 가 **더 이상 발생하지 않는다**(테이블 폐기 전제).
//  ② 원장 기록은 v2 recordTaxInvoice 로 가고, 키는 **v2_order_id**(canonical)다.
//  ③ 현금영수증 식별번호 **원문이 v2 로 새지 않는다** — 꼬리 4자리만 전달(개인정보).
//  ④ 멱등: v2 가 created=false(중복 발행)를 주면 201 이 아니라 200 으로 응답한다.
//  ⑤ receipt_type 이 명시 컬럼으로 구분된다(옛 business_number='-' 하드코딩 폐기).

const stubSession = { id: "u-1", accountId: "acct-1", role: "organizer" };

vi.mock("@/lib/auth/permissions", () => ({
  withRole:
    (
      _role: string,
      handler: (
        req: NextRequest,
        ctx: { session: typeof stubSession; params: { eventId: string; orderId: string } },
      ) => Promise<Response>,
    ) =>
    (req: NextRequest) =>
      handler(req, {
        session: stubSession,
        params: { eventId: "event-1", orderId: "go-order-1" },
      }),
}));

const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock("@/lib/db/pool", () => ({ getPool }));

const { getOrder, recordTaxInvoice, V2CommerceError } = vi.hoisted(() => {
  class V2CommerceError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return { getOrder: vi.fn(), recordTaxInvoice: vi.fn(), V2CommerceError };
});
vi.mock("@/lib/v2/commerce-client", () => ({ getOrder, recordTaxInvoice, V2CommerceError }));

vi.mock("@/lib/tax/invoice", () => ({
  issueTaxInvoice: vi.fn(async () => ({ success: true, provider: "popbill" })),
}));
vi.mock("@/lib/tax/cashReceipt", () => ({
  issueCashReceipt: vi.fn(async () => ({ success: true, provider: "popbill" })),
}));

import { POST } from "@/app/api/events/[eventId]/orders/[orderId]/receipt/route";

const V2_ORDER_ID = "11111111-2222-3333-4444-555555555555";

/** go pool 은 이제 v2_order_id 앵커 조회 1건만 수행해야 한다. */
function buildPool(sqls: string[]) {
  const query = vi.fn(async (sql: string) => {
    sqls.push(sql);
    return { rows: [{ v2_order_id: V2_ORDER_ID }], rowCount: 1 };
  });
  return { query };
}

function req(body: unknown): NextRequest {
  return { json: async () => body } as unknown as NextRequest;
}

/** withRole 목이 무시하는 인자지만, 실제 export 시그니처(2-arity)를 맞추기 위해 전달한다. */
const ctx = {
  params: Promise.resolve({ eventId: "event-1", orderId: "go-order-1" }),
} as unknown as Parameters<typeof POST>[1];

beforeEach(() => {
  getPool.mockReset();
  getOrder.mockReset();
  recordTaxInvoice.mockReset();
  getOrder.mockResolvedValue({ total_amount: 110_000 });
  recordTaxInvoice.mockResolvedValue({ invoice: { id: "inv-1" }, created: true });
});

describe("영수증 발행 — 원장 v2 이관 (T2-REST)", () => {
  it("세금계산서: go tax_invoices INSERT 없이 v2 원장에 기록한다", async () => {
    const sqls: string[] = [];
    getPool.mockReturnValue(buildPool(sqls));

    const res = await POST(
      req({ type: "tax_invoice", businessNumber: "123-45-67890", companyName: "노드엑스" }),
      ctx,
    );

    expect(res.status).toBe(201);
    // ① go 원장 INSERT 소멸
    expect(sqls.some((s) => /INSERT INTO tax_invoices/i.test(s))).toBe(false);
    // ② v2 로, canonical order id 키로 기록
    expect(recordTaxInvoice).toHaveBeenCalledTimes(1);
    const [orderId, accountId, payload] = recordTaxInvoice.mock.calls[0]!;
    expect(orderId).toBe(V2_ORDER_ID);
    expect(accountId).toBe("acct-1");
    // ⑤ 종류가 명시 컬럼으로 구분된다
    expect(payload.receipt_type).toBe("tax_invoice");
    expect(payload.business_number).toBe("123-45-67890");
    // 공급가 기준 세액(1/11)이 원장에 보존된다 — go 원본은 계산만 하고 버렸다.
    expect(payload.tax_amount).toBe(10_000);
    expect(payload.amount).toBe(110_000);
  });

  it("현금영수증: 식별번호 원문을 v2 로 보내지 않고 꼬리 4자리만 남긴다", async () => {
    const sqls: string[] = [];
    getPool.mockReturnValue(buildPool(sqls));

    const res = await POST(req({ type: "cash_receipt", identityNumber: "01012345678" }), ctx);

    expect(res.status).toBe(201);
    const payload = recordTaxInvoice.mock.calls[0]![2];
    expect(payload.receipt_type).toBe("cash_receipt");
    expect(payload.identity_tail).toBe("5678");
    // ③ 원문 유출 차단 — 직렬화된 페이로드 어디에도 전체 식별번호가 없어야 한다.
    expect(JSON.stringify(payload)).not.toContain("01012345678");
    expect(sqls.some((s) => /INSERT INTO tax_invoices/i.test(s))).toBe(false);
  });

  it("멱등: v2 가 created=false(이미 발행)를 주면 201 이 아니라 200 을 반환한다", async () => {
    getPool.mockReturnValue(buildPool([]));
    recordTaxInvoice.mockResolvedValue({ invoice: { id: "inv-1" }, created: false });

    const res = await POST(
      req({ type: "tax_invoice", businessNumber: "123-45-67890", companyName: "노드엑스" }),
      ctx,
    );

    expect(res.status).toBe(200);
  });

  it("v2_order_id 앵커가 없으면 발행하지 않고 409 로 막는다", async () => {
    getPool.mockReturnValue({
      query: vi.fn(async () => ({ rows: [{ v2_order_id: null }], rowCount: 1 })),
    });

    const res = await POST(
      req({ type: "tax_invoice", businessNumber: "123-45-67890", companyName: "노드엑스" }),
      ctx,
    );

    expect(res.status).toBe(409);
    expect(recordTaxInvoice).not.toHaveBeenCalled();
  });
});
