import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * P0 재배선 계약(pending-first): recordPaymentConfirmOutbox 는 **외부 v2 호출을 하지 않는다.**
 * go 트랜잭션에 pending outbox 행만 원자 기록하고, 실제 v2 confirm 은 워커/cron(트랜잭션 밖·커밋 후)
 * 에서만 일어난다 → 역 split-brain(v2=confirmed·go=롤백·outbox 소멸) 이 원천 불가.
 */
const commerceMock = vi.hoisted(() => ({
  confirmOrderPayment: vi.fn(),
  V2CommerceError: class V2CommerceError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  },
}));
vi.mock("@/lib/v2/commerce-client", () => commerceMock);

import { recordPaymentConfirmOutbox } from "@/lib/payment/confirm-v2";

/** go 트랜잭션 client mock: 앵커 SELECT → outbox INSERT(pending) 순으로 query 호출된다. */
function makeClient(v2OrderId: string | null, amount = 30000) {
  const query = vi.fn();
  // 첫 호출: v2_order_id/total_amount 조회
  query.mockResolvedValueOnce({ rows: [{ v2_order_id: v2OrderId, total_amount: amount }] });
  // 둘째 호출: outbox INSERT(pending)
  query.mockResolvedValueOnce({});
  return { query };
}

describe("recordPaymentConfirmOutbox — pending-first 원자 기록 불변식", () => {
  beforeEach(() => vi.clearAllMocks());

  it("외부 v2 호출을 절대 하지 않는다(역 split-brain 원천 불가)", async () => {
    const client = makeClient("v2-0");
    await recordPaymentConfirmOutbox(client as never, "order-0", { amount: 30000 });
    // 재배선의 핵심: 이 함수는 트랜잭션 안에서 confirmOrderPayment 를 호출하지 않는다.
    expect(commerceMock.confirmOrderPayment).not.toHaveBeenCalled();
  });

  it("v2 앵커가 있으면 같은 client 에 status=pending outbox 를 기록하고 pending=true 반환", async () => {
    const client = makeClient("v2-1");

    const result = await recordPaymentConfirmOutbox(client as never, "order-1", { amount: 30000 });

    expect(result).toEqual({ pending: true, v2OrderId: "v2-1" });
    // 2번째 query = outbox INSERT. 같은 client(=go 트랜잭션)에서 실행됨(원자성).
    const insertCall = client.query.mock.calls[1];
    expect(insertCall[0]).toContain("INSERT INTO payment_confirm_outbox");
    expect(insertCall[0]).toContain("'pending'"); // 항상 pending 으로 기록(외부호출 전)
    expect(insertCall[0]).toContain("status NOT IN ('confirmed', 'manual_review', 'superseded')"); // confirmed/manual_review 보존 가드
    // 파라미터: order_id, v2_order_id, amount 만 — status 문자열은 SQL 리터럴.
    expect(insertCall[1]).toEqual(["order-1", "v2-1", 30000]);
  });

  it("amount 미지정 시 orders.total_amount 로 outbox 금액 채움(음수는 0 클램프)", async () => {
    const client = makeClient("v2-amt", 12345);
    const result = await recordPaymentConfirmOutbox(client as never, "order-amt");
    expect(result.pending).toBe(true);
    expect(client.query.mock.calls[1][1]).toEqual(["order-amt", "v2-amt", 12345]);
  });

  it("v2_order_id 없음(레거시/NICE) 이면 outbox 미기록·pending=false", async () => {
    const client = makeClient(null);

    const result = await recordPaymentConfirmOutbox(client as never, "order-3");

    expect(result).toEqual({ pending: false, v2OrderId: null });
    // 앵커 SELECT 한 번만 — outbox INSERT 없음.
    expect(client.query).toHaveBeenCalledTimes(1);
    expect(commerceMock.confirmOrderPayment).not.toHaveBeenCalled();
  });

  it("outbox INSERT 실패는 삼키지 않고 throw(go 트랜잭션 롤백 — completed↔outbox 1:1 강제)", async () => {
    const query = vi.fn();
    query.mockResolvedValueOnce({ rows: [{ v2_order_id: "v2-4", total_amount: 20000 }] });
    query.mockRejectedValueOnce(new Error("outbox insert failed")); // outbox INSERT 실패
    const client = { query };

    await expect(recordPaymentConfirmOutbox(client as never, "order-4", { amount: 20000 })).rejects.toThrow(
      "outbox insert failed",
    );
  });
});
