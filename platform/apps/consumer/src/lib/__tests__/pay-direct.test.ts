/**
 * 과업 WP7 — 주최사 PG 직결(무경유) 결제창.
 * provider=toss_direct 면 서버가 준 **주최사 클라이언트 키**로 토스 표준 결제창을 띄운다(나이스·플랫폼 위젯 아님).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const prepareMock = vi.fn();
vi.mock("@pickket/lib/api", () => ({
  prepareOrderPayment: (...args: unknown[]) => prepareMock(...args),
}));

const startNicePaymentMock = vi.fn();
vi.mock("@/lib/nice", () => ({
  startNicePayment: (...args: unknown[]) => startNicePaymentMock(...args),
}));

const directMock = vi.fn();
vi.mock("@/lib/toss", () => ({
  isTossLive: () => false,
  mockRedirectToSuccess: vi.fn(),
  requestDirectTossPayment: (...args: unknown[]) => directMock(...args),
}));

import { resolveProvider, startPayment } from "@/lib/pay";

describe("주최사 PG 직결 결제창", () => {
  beforeEach(() => {
    prepareMock.mockReset();
    startNicePaymentMock.mockReset();
    directMock.mockReset();
  });

  it("toss_direct 는 나이스로 폴백하지 않는다", () => {
    expect(resolveProvider("toss_direct")).toBe("toss_direct");
  });

  it("주최사 클라이언트 키로 결제창을 띄운다", async () => {
    prepareMock.mockResolvedValue({
      data: { provider: "toss_direct", payment_id: "ord_d_a1", provider_params: { clientKey: "test_ck_organizer01", settlement: "direct" } },
    });
    await startPayment({
      orderId: "uuid-d",
      orderName: "R석 1매",
      amount: 132000,
      successUrl: "https://www.pickket.kr/payment/success",
      failUrl: "https://www.pickket.kr/payment/fail",
      buyer: { email: "a@b.kr", name: "김서연", tel: "010-1234-5678" },
    });
    expect(directMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientKey: "test_ck_organizer01", orderId: "ord_d_a1", amount: 132000, orderName: "R석 1매" }),
    );
    expect(startNicePaymentMock).not.toHaveBeenCalled();
  });

  it("클라이언트 키가 없으면 결제창을 띄우지 않고 알린다", async () => {
    prepareMock.mockResolvedValue({ data: { provider: "toss_direct", payment_id: "ord_d_a2", provider_params: null } });
    await expect(
      startPayment({ orderId: "uuid-e", orderName: "x", amount: 1000, successUrl: "s", failUrl: "f" }),
    ).rejects.toThrow("주최사 결제 정보");
    expect(directMock).not.toHaveBeenCalled();
  });
});
