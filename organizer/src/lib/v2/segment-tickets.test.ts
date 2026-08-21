import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class FakeV2CommerceError extends Error {
    constructor(message: string, readonly status = 500) {
      super(message);
    }
  }
  return { listAttendees: vi.fn(), FakeV2CommerceError };
});
vi.mock("@/lib/v2/commerce-client", () => ({
  listAttendees: (...a: unknown[]) => h.listAttendees(...a),
  V2CommerceError: h.FakeV2CommerceError,
}));

import { fetchTicketIdsByProductRefs, V2SegmentTicketsError } from "@/lib/v2/segment-tickets";

function page(rows: Array<{ ticket_id: string; product_external_ref: string | null }>) {
  return { attendees: rows, total: rows.length, limit: 500, offset: 0 };
}

// ⚠️ 블록 본문 필수 — `() => mock.mockReset()` 는 mock **함수 자체**를 반환하고,
// vitest 는 beforeEach 의 함수 반환값을 teardown 콜백으로 보고 테스트 후 호출한다
// (throw 하도록 세팅된 mock 이면 그 예외가 테스트 실패로 둔갑한다).
beforeEach(() => {
  h.listAttendees.mockReset();
});

describe("fetchTicketIdsByProductRefs — 상품 세그먼트 v2 해석", () => {
  it("요청한 go productId 의 티켓만 고른다 (다른 상품 구매자 오발송 차단)", async () => {
    h.listAttendees.mockResolvedValue(
      page([
        { ticket_id: "t-1", product_external_ref: "p-vip" },
        { ticket_id: "t-2", product_external_ref: "p-general" },
        { ticket_id: "t-3", product_external_ref: "p-vip" },
        { ticket_id: "t-4", product_external_ref: null },
      ]),
    );

    await expect(fetchTicketIdsByProductRefs("evt-v2", ["p-vip"])).resolves.toEqual(["t-1", "t-3"]);
  });

  it("productIds 가 비면 v2 를 호출하지 않고 빈 배열", async () => {
    await expect(fetchTicketIdsByProductRefs("evt-v2", [])).resolves.toEqual([]);
    expect(h.listAttendees).not.toHaveBeenCalled();
  });

  it("페이지가 가득 차면 다음 오프셋을 이어 읽는다", async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({
      ticket_id: `t-${i}`,
      product_external_ref: i === 0 ? "p-vip" : "p-other",
    }));
    h.listAttendees
      .mockResolvedValueOnce(page(full))
      .mockResolvedValueOnce(page([{ ticket_id: "t-last", product_external_ref: "p-vip" }]));

    await expect(fetchTicketIdsByProductRefs("evt-v2", ["p-vip"])).resolves.toEqual(["t-0", "t-last"]);
    expect(h.listAttendees).toHaveBeenCalledTimes(2);
    expect(h.listAttendees).toHaveBeenNthCalledWith(2, "evt-v2", { limit: 500, offset: 500 });
  });

  it("v2 실패는 throw — 빈 목록으로 강등하면 조용한 0명 발송이 된다", async () => {
    h.listAttendees.mockImplementation(() => {
      throw new h.FakeV2CommerceError("boom", 502);
    });

    let caught: unknown;
    try {
      await fetchTicketIdsByProductRefs("evt-v2", ["p-vip"]);
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(V2SegmentTicketsError);
    expect((caught as Error).message).toContain("boom");
  });
});
