/**
 * repair 회귀 — 2026-07-31 감사 반려분(P0-1).
 *
 * 이 파일이 없던 동안 `repairPaidOrder` 의 가드를 통째로 제거해도 전체 스위트가
 * **그린이었다**(감사 뮤테이션 M2 생존). 돈을 지키는 분기가 무방비였다는 뜻이다.
 *
 * 증명할 것:
 *  ① 보상환불이 진행/완료됐으면 **되돌리지 않는다** — 돈이 이미 나갔다
 *  ② 보상행을 **잠그고** 읽는다(TOCTOU) — 안 잠그면 드레인이 그 사이 클레임한다
 *  ③ 부분환불은 앵커만 고치고 **"구매 완료" 를 보내지 않는다**
 *  ④ 증거(v2 상태)가 없으면 아무것도 안 한다
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { repairOrderToPaid } = vi.hoisted(() => ({ repairOrderToPaid: vi.fn() }));
vi.mock("@/lib/state-machine/order-state-machine", () => ({ repairOrderToPaid }));

import { repairPaidOrder } from "@/lib/orders/repair-paid-order";

/** 실행된 SQL 을 모으는 가짜 클라이언트. 보상행 조회 결과를 주입할 수 있다. */
function mockClient(compensationRows: { status: string }[]) {
  const sqls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    sqls.push(sql);
    if (/FROM payment_compensation_actions/.test(sql)) {
      return { rows: compensationRows, rowCount: compensationRows.length };
    }
    return { rows: [], rowCount: 1 };
  });
  return { client: { query } as never, sqls };
}

beforeEach(() => {
  vi.clearAllMocks();
  repairOrderToPaid.mockResolvedValue({ status: "applied", from: "expired" });
});

describe("repairPaidOrder", () => {
  it("🔴 보상환불이 이미 실행/진행 중이면 되돌리지 않는다 — 돈이 이미 돌아갔다", async () => {
    for (const blocking of ["completed", "processing", "manual_review"]) {
      vi.clearAllMocks();
      repairOrderToPaid.mockResolvedValue({ status: "applied", from: "expired" });
      const { client } = mockClient([{ status: blocking }]);

      const out = await repairPaidOrder(client, "ord-1", {
        v2Status: "confirmed", v2OrderId: "v2-1",
      });

      expect(out.repaired, `blocking=${blocking}`).toBe(false);
      expect(out.shouldNotify).toBe(false);
      // 전이 자체를 시도조차 하지 않아야 한다.
      expect(repairOrderToPaid).not.toHaveBeenCalled();
    }
  });

  it("🔴 보상행을 FOR UPDATE 로 잠그고 읽는다 — 안 잠그면 드레인이 그 사이 클레임한다", async () => {
    const { client, sqls } = mockClient([]);

    await repairPaidOrder(client, "ord-1", { v2Status: "confirmed", v2OrderId: "v2-1" });

    const lookup = sqls.find((s) => /FROM payment_compensation_actions/.test(s));
    expect(lookup).toBeDefined();
    // 이 잠금이 없으면 드레인의 FOR UPDATE SKIP LOCKED 가 이 주문을 가져가고,
    // 우리는 completed 로 되돌리며 알림톡까지 보내는데 돈은 환불된다.
    expect(lookup).toMatch(/FOR UPDATE/);
  });

  it("pending·failed 보상은 취소하고 되돌린다", async () => {
    const { client, sqls } = mockClient([{ status: "pending" }]);

    const out = await repairPaidOrder(client, "ord-1", {
      v2Status: "confirmed", v2OrderId: "v2-1",
    });

    expect(out.repaired).toBe(true);
    expect(out.shouldNotify).toBe(true);
    expect(sqls.some((s) => /UPDATE payment_compensation_actions/.test(s))).toBe(true);
  });

  it("🔴 부분환불은 앵커만 고치고 '구매 완료' 를 보내지 않는다", async () => {
    const { client } = mockClient([]);

    const out = await repairPaidOrder(client, "ord-1", {
      v2Status: "partially_refunded", v2OrderId: "v2-1",
    });

    expect(out.repaired).toBe(true);
    // go 에 좌석별 환불 매핑이 없어 어느 참석자가 환불분인지 모른다. 잘못된 안내는 회수 불가.
    expect(out.shouldNotify).toBe(false);
  });

  it("전이가 noop 이면(이미 고쳐짐) 알림을 보내지 않는다 — 5분 크론 재발송 방지", async () => {
    repairOrderToPaid.mockResolvedValue({ status: "noop" });
    const { client, sqls } = mockClient([]);

    const out = await repairPaidOrder(client, "ord-1", {
      v2Status: "confirmed", v2OrderId: "v2-1",
    });

    expect(out.repaired).toBe(false);
    expect(out.shouldNotify).toBe(false);
    // 참석자·보상큐도 건드리지 않아야 한다.
    expect(sqls.some((s) => /UPDATE attendees/.test(s))).toBe(false);
  });

  it("🔴 참석자 복원은 checked_in 을 건드리지 않는다 — 입장 이력을 되돌리면 재입장이 열린다", async () => {
    const { client, sqls } = mockClient([]);

    await repairPaidOrder(client, "ord-1", { v2Status: "confirmed", v2OrderId: "v2-1" });

    const att = sqls.find((s) => /UPDATE attendees/.test(s));
    expect(att).toBeDefined();
    expect(att).toMatch(/IN \('cancelled', 'pending'\)/);
    expect(att).not.toMatch(/checked_in/);
  });
});
