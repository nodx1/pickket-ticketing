import { describe, it, expect, beforeEach } from "vitest";
import {
  persistGuestViewToken,
  readGuestViewToken,
  clearGuestViewToken,
} from "@/hooks/useGuestBooking";

describe("useGuestBooking — view_token sessionStorage 헬퍼", () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it("persist 후 read 로 토큰을 되찾는다", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    persistGuestViewToken("order-1", "tok_abc", future);
    expect(readGuestViewToken("order-1")).toBe("tok_abc");
  });

  it("만료된 토큰은 read 시 null 반환 + 삭제한다", () => {
    const past = new Date(Date.now() - 1000).toISOString();
    persistGuestViewToken("order-2", "tok_expired", past);
    expect(readGuestViewToken("order-2")).toBeNull();
    // 만료 시 자동 삭제 확인(재조회도 null).
    expect(readGuestViewToken("order-2")).toBeNull();
  });

  it("orderId 스코프로 격리된다", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    persistGuestViewToken("order-a", "tok_a", future);
    persistGuestViewToken("order-b", "tok_b", future);
    expect(readGuestViewToken("order-a")).toBe("tok_a");
    expect(readGuestViewToken("order-b")).toBe("tok_b");
  });

  it("clear 후에는 null 반환한다", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    persistGuestViewToken("order-3", "tok_x", future);
    clearGuestViewToken("order-3");
    expect(readGuestViewToken("order-3")).toBeNull();
  });

  it("존재하지 않는 주문은 null 반환한다", () => {
    expect(readGuestViewToken("nope")).toBeNull();
  });

  it("localStorage 는 사용하지 않는다(sessionStorage 전용)", () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    persistGuestViewToken("order-4", "tok_s", future);
    expect(localStorage.getItem("pickket_guest_view_token_order-4")).toBeNull();
  });
});
