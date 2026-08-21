import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 🔴 주문 목록 라우트를 **실제로 실행**한다 (2026-08-10)
 *
 * `payment-attempt-label.test.ts` 는 판정 함수와 **소스 관계**를 본다. 그것으로는
 * *"응답에 v2 원문(last_error)이 **안 나간다**"* 를 소스에 없다로만 증명한다.
 * 원문은 내부 문구라("reconciliation: PG status failed") 주최자 화면에 나가면 안 된다.
 *
 * ⟹ 여기서는 핸들러를 부르고 **응답 본문을 파싱해** 확인한다.
 */
const h = vi.hoisted(() => ({
  listOrders: vi.fn(),
  resolveOwnedV2EventId: vi.fn(),
  class_V2CommerceError: class V2CommerceError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  },
  class_EventAccessError: class EventAccessError extends Error {
    constructor(message: string, readonly reason: string, readonly status: number) {
      super(message);
    }
  },
}));

// 🔴 권한 HOF 는 통과시킨다 — 여기서 보려는 것은 **본문**이다.
vi.mock("@/lib/auth/permissions", () => ({
  // ⚠️ 커링이 아니라 **2인자**다(`withRole(role, handler)`). 커링으로 목하면
  //    GET 이 Response 대신 함수를 돌려주고 `.json is not a function` 이 난다.
  withRole:
    (_role: string, handler: (req: Request, ctx: unknown) => unknown) =>
    (req: Request, _ctx: unknown) =>
      handler(req, {
        session: { accountId: "acct-1", id: "u1", role: "organizer" },
        params: Promise.resolve({ eventId: "ev-1" }),
      }),
}));
vi.mock("@/lib/v2/commerce-client", () => ({
  listOrders: (...a: unknown[]) => h.listOrders(...a),
  V2CommerceError: h.class_V2CommerceError,
}));
vi.mock("@/lib/v2/event-access", () => ({
  resolveOwnedV2EventId: (...a: unknown[]) => h.resolveOwnedV2EventId(...a),
  EventAccessError: h.class_EventAccessError,
}));
vi.mock("@/lib/server/orders", () => ({ createOrder: vi.fn() }));

import { GET } from "@/app/api/events/[eventId]/orders/route";

const V2_EVENT = "aaaaaaaa-0000-0000-0000-000000000001";

function v2Row(over: Record<string, unknown> = {}) {
  return {
    order_id: "o-v2-1",
    external_ref: "GO-ORD-1",
    order_number: "GO-ORD-1",
    buyer_name: "홍길동",
    buyer_email: "b@t.com",
    total_amount: 13500,
    paid_amount: 13500,
    total_refunded: 0,
    status: "expired",
    payment_method: "nicepay",
    ordered_at: "2026-08-10T02:16:00Z",
    ...over,
  };
}

async function call(query = ""): Promise<Response> {
  return (await GET(
    new Request(`https://go.pickket.kr/api/events/ev-1/orders${query}`) as never,
    { params: Promise.resolve({ eventId: "ev-1" }) } as never,
  )) as Response;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveOwnedV2EventId.mockResolvedValue(V2_EVENT);
});

describe("🔴 실행 — 이탈과 실패가 응답에서 갈리는가", () => {
  it("🔴 시도 0건 → '결제창에서 나감'", async () => {
    h.listOrders.mockResolvedValue({
      orders: [v2Row({
        payment_attempts: {
          attempt_count: 0, last_status: null, last_error_kind: null,
          last_error: null, last_at: null,
        },
      })],
      total: 1,
    });
    const body = await (await call()).json();
    expect(body.data[0].paymentAttempt).toEqual({
      kind: "abandoned",
      label: "결제창에서 나감",
    });
  });

  it("🔴 failed → '결제 실패 (카드사 거절)' — 이탈과 다른 문구", async () => {
    h.listOrders.mockResolvedValue({
      orders: [v2Row({
        payment_attempts: {
          attempt_count: 1, last_status: "failed", last_error_kind: "pg_declined",
          last_error: "reconciliation: PG status failed", last_at: "2026-08-10T05:16:00Z",
        },
      })],
      total: 1,
    });
    const row = (await (await call()).json()).data[0];
    expect(row.paymentAttempt.kind).toBe("failed");
    expect(row.paymentAttempt.label).toBe("결제 실패 (카드사 거절)");
  });

  it("🔴 **응답 본문 어디에도 v2 원문이 없다**", async () => {
    h.listOrders.mockResolvedValue({
      orders: [v2Row({
        payment_attempts: {
          attempt_count: 1, last_status: "failed", last_error_kind: "pg_declined",
          last_error: "reconciliation: PG status failed", last_at: null,
        },
      })],
      total: 1,
    });
    const raw = await (await call()).text();
    expect(raw, "내부 문구가 주최자 화면으로 샌다").not.toMatch(/reconciliation|PG status/);
    expect(raw).not.toMatch(/last_error/);
  });

  it("succeeded 는 아무 말도 안 한다 (기존 상태가 이미 정확하다)", async () => {
    h.listOrders.mockResolvedValue({
      orders: [v2Row({
        status: "completed",
        payment_attempts: {
          attempt_count: 1, last_status: "succeeded", last_error_kind: null,
          last_error: null, last_at: null,
        },
      })],
      total: 1,
    });
    expect((await (await call()).json()).data[0].paymentAttempt.label).toBeNull();
  });

  it("🔴 구버전 v2(필드 없음)면 아무 말도 안 한다 — 전건이 이탈로 보이면 안 된다", async () => {
    h.listOrders.mockResolvedValue({ orders: [v2Row()], total: 1 });
    const row = (await (await call()).json()).data[0];
    expect(row.paymentAttempt).toEqual({ kind: "unknown", label: null });
  });

  it("🔴 기존 필드가 하나도 안 사라졌다 (가산적 변경)", async () => {
    h.listOrders.mockResolvedValue({ orders: [v2Row()], total: 1 });
    const row = (await (await call()).json()).data[0];
    for (const k of ["id", "orderNumber", "buyerName", "buyerEmail", "totalAmount",
                     "paidAmount", "refundedAmount", "status", "orderedAt"]) {
      expect(row, `기존 필드 ${k} 가 사라졌다`).toHaveProperty(k);
    }
    // 🔴 상세·환불 라우트가 go order id 로 조회한다 — external_ref 여야 한다
    expect(row.id).toBe("GO-ORD-1");
    expect(row.status).toBe("expired");
  });
});

/**
 * 🔴 초대권·수동발권 구분이 **목록 응답까지 오는가** (2026-08-11).
 *
 * 배선이 끊기면 화면 테스트는 전부 초록인 채 목록에서 초대권과 실판매가 한 덩어리로
 * 보인다. 실측: 확정 주문 27건이 결제 시도 0건(초대권·수동발권·0원)이라
 * 목록으로 「몇 장 팔렸나」를 보면 **매출이 부풀어 보인다.**
 *
 * ⚠️ 화면 규칙(무엇을 붙이고 무엇을 안 붙이나)은 `lib/orders/issue-source.test.ts` 가 본다.
 *    여기는 **값이 실려 오는지**만 본다 — 묶으면 매핑을 지워도 규칙 테스트가 통과한다.
 */
describe("🔴 초대권·수동발권 플래그가 목록 응답에 실린다", () => {
  it("🔴 v2 is_invitation 을 그대로 넘긴다", async () => {
    h.listOrders.mockResolvedValue({ orders: [v2Row({ is_invitation: true })], total: 1 });
    const row = (await (await call()).json()).data[0];
    expect(row.isInvitation, "초대권 표식이 목록까지 오지 않는다").toBe(true);
  });

  it("🔴 v2 is_manual_issue 를 그대로 넘긴다", async () => {
    h.listOrders.mockResolvedValue({ orders: [v2Row({ is_manual_issue: true })], total: 1 });
    expect((await (await call()).json()).data[0].isManualIssue).toBe(true);
  });

  it("🔴 v2 가 안 주면 `undefined` 로 둔다 — false 로 접지 않는다", async () => {
    // 「모름」과 「아님」은 다르다. false 로 접으면 화면이 "실판매" 라고 단정한다.
    h.listOrders.mockResolvedValue({ orders: [v2Row({})], total: 1 });
    const row = (await (await call()).json()).data[0];
    expect(row.isInvitation ?? "없음", "undefined 를 false 로 접었다").toBe("없음");
    expect(row.isManualIssue ?? "없음").toBe("없음");
  });

  it("false 는 false 그대로 온다 — 명시적 '아님'", async () => {
    h.listOrders.mockResolvedValue({ orders: [v2Row({ is_invitation: false })], total: 1 });
    expect((await (await call()).json()).data[0].isInvitation).toBe(false);
  });

  it("🔴 주문마다 자기 값 — 첫 행 것을 전부에 쓰면 안 된다", async () => {
    h.listOrders.mockResolvedValue({
      orders: [v2Row({ order_id: "o1", is_invitation: true }), v2Row({ order_id: "o2" })],
      total: 2,
    });
    const rows = (await (await call()).json()).data;
    expect(rows.map((r: { isInvitation?: boolean }) => r.isInvitation ?? null)).toEqual([true, null]);
  });
});

/**
 * 🔴 발권 경로 필터 — **서버가 자른다** (2026-08-11, v2 73f11c9b).
 *
 * 클라이언트에서 자르면 페이지네이션과 총계가 어긋나 발주처가 잘못 센다.
 * 실측 기준: 전체 84 = issued 51 + sale 33.
 *
 * ⚠️ 응답은 **v2 가 적용한 값**을 에코한다. 우리가 보낸 값이 아니다 — 그래야 화면이
 *    「필터가 안 먹었다」를 알아챈다.
 */
describe("🔴 issueSource 필터", () => {
  it("🔴 아는 값만 v2 로 넘긴다", async () => {
    h.listOrders.mockResolvedValue({ orders: [], total: 0, issue_source: "sale" });
    await call("?issueSource=sale");
    expect(h.listOrders.mock.calls[0][1]).toMatchObject({ issueSource: "sale" });
  });

  it("🔴 모르는 값은 안 넘긴다 — 오타를 넘기면 v2 가 무시하고 조용히 전체가 나온다", async () => {
    h.listOrders.mockResolvedValue({ orders: [], total: 0, issue_source: null });
    await call("?issueSource=SALE");
    expect(h.listOrders.mock.calls[0][1].issueSource, "오타가 그대로 나갔다").toBeUndefined();
  });

  it("미지정이면 안 넘긴다", async () => {
    h.listOrders.mockResolvedValue({ orders: [], total: 0, issue_source: null });
    await call();
    expect(h.listOrders.mock.calls[0][1].issueSource).toBeUndefined();
  });

  it("🔴 v2 가 적용한 값을 그대로 에코한다 — 우리가 보낸 값이 아니다", async () => {
    // v2 가 무시한 상황: 우리는 sale 을 보냈는데 v2 는 null 을 돌려준다.
    h.listOrders.mockResolvedValue({ orders: [], total: 0, issue_source: null });
    const body = await (await call("?issueSource=sale")).json();
    expect(body.meta.issueSource, "우리가 보낸 값을 그대로 올리면 미적용을 못 알아챈다").toBeNull();
  });

  it("🔴 구버전 v2(에코 키 없음)도 null 로 내려간다", async () => {
    h.listOrders.mockResolvedValue({ orders: [], total: 0 });
    const body = await (await call("?issueSource=issued")).json();
    expect(body.meta.issueSource).toBeNull();
  });

  it("적용되면 그 값이 온다", async () => {
    h.listOrders.mockResolvedValue({ orders: [], total: 0, issue_source: "issued" });
    const body = await (await call("?issueSource=issued")).json();
    expect(body.meta.issueSource).toBe("issued");
  });

  it("🔴 총계는 v2 가 준 값을 그대로 쓴다 — 우리가 세지 않는다", async () => {
    // 잘린 목록 33건 + 총계 33. 클라이언트가 자르면 여기서 총계가 84로 남는다.
    h.listOrders.mockResolvedValue({
      orders: [v2Row({ order_id: "o1" })], total: 33, issue_source: "sale",
    });
    const body = await (await call("?issueSource=sale")).json();
    expect(body.meta.total).toBe(33);
  });
});
