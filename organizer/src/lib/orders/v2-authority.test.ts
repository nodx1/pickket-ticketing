/**
 * v2 권위 판정 회귀 — 2026-07-31 감사 반려분.
 *
 * 🔴 이 판정이 만료·자동환불의 유일한 게이트다. 그런데 테스트가 없어서
 *    fail-closed 를 통째로 없애도 그린이었다(감사 뮤테이션 M1 생존).
 *
 * 🔴 그리고 화이트리스트가 v2 enum 을 다 못 덮고 있었다 — `payment_required` 누락으로
 *    "결제 진행 중인 모든 정상 주문" 이 `unknown` 이 되어 5분마다 degraded 경보를
 *    울릴 뻔했다. 대회 중이면 **진짜 유실 신호가 그 소음에 묻힌다**.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getOrderByExternalRef } = vi.hoisted(() => ({ getOrderByExternalRef: vi.fn() }));
vi.mock("@/lib/v2/commerce-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/v2/commerce-client")>(
    "@/lib/v2/commerce-client",
  );
  return { ...actual, getOrderByExternalRef };
});

import { askV2AboutOrder, mayExpire } from "@/lib/orders/v2-authority";
import { V2CommerceError } from "@/lib/v2/commerce-client";

const detail = (status: string) => ({
  order_id: "v2-1", status_v2: status, status,
  paid_amount: 15000, total_amount: 15000, payment_method: "card",
});

beforeEach(() => vi.clearAllMocks());

/**
 * 🔴 v2 `OrderStatus` enum 전량(platform/backend/app/models/order.py).
 * 새 상태가 추가되면 이 표가 먼저 깨져야 한다 — 조용히 unknown 이 되어
 * 경보만 울리는 상태로 배포되면 안 된다.
 */
const V2_ENUM: Array<[string, "paid" | "terminal" | "in_flight"]> = [
  ["pending", "in_flight"],
  ["payment_required", "in_flight"],
  ["authorized", "in_flight"],
  ["deposit_held", "in_flight"],
  ["paid", "paid"],
  ["confirmed", "paid"],
  ["partially_refunded", "paid"],
  ["cancelled", "terminal"],
  ["expired", "terminal"],
  ["refunded", "terminal"],
  ["deposit_refunded", "terminal"],
  ["deposit_forfeited", "terminal"],
];

describe("askV2AboutOrder — v2 enum 전량 분류", () => {
  it.each(V2_ENUM)("%s → %s", async (status, expected) => {
    getOrderByExternalRef.mockResolvedValue(detail(status));
    const v = await askV2AboutOrder("go-1");
    expect(v.kind).toBe(expected);
  });

  it("🔴 enum 어디에도 없는 값은 unknown — 임의로 '끝났다' 로 해석하지 않는다", async () => {
    getOrderByExternalRef.mockResolvedValue(detail("some_future_status"));
    const v = await askV2AboutOrder("go-1");
    expect(v.kind).toBe("unknown");
  });

  it("빈 상태도 unknown", async () => {
    getOrderByExternalRef.mockResolvedValue({ order_id: "v2-1", status_v2: "", status: "" });
    expect((await askV2AboutOrder("go-1")).kind).toBe("unknown");
  });
});

describe("askV2AboutOrder — 조회 실패 구분", () => {
  it("🔴 404 는 absent(정보) — v2 에 없는 go 단독 주문", async () => {
    getOrderByExternalRef.mockRejectedValue(new V2CommerceError("없음", 404, "ORDER_NOT_FOUND"));
    expect((await askV2AboutOrder("go-1")).kind).toBe("absent");
  });

  it("🔴 5xx·타임아웃은 unknown(정보 없음) — 404 와 뭉치면 v2 장애 중 결제건이 만료된다", async () => {
    getOrderByExternalRef.mockRejectedValue(new V2CommerceError("죽음", 503, "UPSTREAM"));
    expect((await askV2AboutOrder("go-1")).kind).toBe("unknown");

    getOrderByExternalRef.mockRejectedValue(new Error("ETIMEDOUT"));
    expect((await askV2AboutOrder("go-1")).kind).toBe("unknown");
  });
});

describe("mayExpire — 만료 허용 판정", () => {
  it("🔴 terminal·absent 만 허용한다", () => {
    expect(mayExpire({ kind: "terminal", v2OrderId: "v2", v2Status: "expired" })).toBe(true);
    expect(mayExpire({ kind: "absent" })).toBe(true);
  });

  it("🔴 paid·in_flight·unknown 은 절대 허용하지 않는다(fail-closed)", () => {
    expect(mayExpire({ kind: "paid", v2OrderId: "v2", v2Status: "confirmed", facts: { amount: 15000, method: "card" } })).toBe(false);
    expect(mayExpire({ kind: "in_flight", v2OrderId: "v2", v2Status: "payment_required" })).toBe(false);
    expect(mayExpire({ kind: "unknown", reason: "timeout" })).toBe(false);
  });
});

describe("askV2AboutOrder — 결제 사실 동반", () => {
  it("🔴 paid 판정은 금액·수단을 함께 돌려준다", async () => {
    // 배포 후 실측 사고: 대사가 이걸 안 넘겨 복구된 주문이 paid_amount=0 ·
    // payment_method=offline 로 남았다(실제 15,000원 카드). 정산·CS 가 그 값을 본다.
    getOrderByExternalRef.mockResolvedValue(detail("confirmed"));
    const v = await askV2AboutOrder("go-1");
    expect(v.kind).toBe("paid");
    if (v.kind !== "paid") return;
    expect(v.facts).toEqual({ amount: 15000, method: "card" });
  });

  it("금액이 0·결측이면 null 로 — 0 을 덮어쓰지 않는다", async () => {
    getOrderByExternalRef.mockResolvedValue({
      order_id: "v2-1", status_v2: "confirmed", status: "confirmed",
      paid_amount: 0, total_amount: 0, payment_method: null,
    });
    const v = await askV2AboutOrder("go-1");
    if (v.kind !== "paid") throw new Error("paid 여야 한다");
    expect(v.facts).toEqual({ amount: null, method: null });
  });
});
