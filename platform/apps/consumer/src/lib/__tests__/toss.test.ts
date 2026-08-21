import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  isTossLive,
  mockRedirectToSuccess,
  renderTossWidget,
} from "@/lib/toss";

describe("toss.ts — 결제위젯 클라이언트", () => {
  describe("isTossLive", () => {
    it("clientKey 미설정(테스트 환경)에서는 false", () => {
      // vitest 환경엔 NEXT_PUBLIC_TOSS_CLIENT_KEY 미주입 → mock 모드.
      expect(isTossLive()).toBe(false);
    });
  });

  describe("mockRedirectToSuccess", () => {
    let assignMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      assignMock = vi.fn();
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { assign: assignMock, origin: "http://localhost" },
      });
    });

    it("successUrl 에 paymentKey(mock_)·orderId·amount 를 붙여 리다이렉트", () => {
      mockRedirectToSuccess("ord_abc_a1", 30000, "https://pickket.kr/ko/payment/success?order=uuid1");
      expect(assignMock).toHaveBeenCalledTimes(1);
      const url = new URL(assignMock.mock.calls[0][0] as string);
      expect(url.searchParams.get("paymentKey")).toBe("mock_ord_abc_a1");
      expect(url.searchParams.get("orderId")).toBe("ord_abc_a1");
      expect(url.searchParams.get("amount")).toBe("30000");
      // 기존 쿼리(order=uuid1)도 보존
      expect(url.searchParams.get("order")).toBe("uuid1");
    });
  });

  describe("renderTossWidget", () => {
    let setAmount: ReturnType<typeof vi.fn>;
    let renderPaymentMethods: ReturnType<typeof vi.fn>;
    let renderAgreement: ReturnType<typeof vi.fn>;
    let requestPayment: ReturnType<typeof vi.fn>;
    let widgetsFactory: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      setAmount = vi.fn().mockResolvedValue(undefined);
      renderPaymentMethods = vi.fn().mockResolvedValue(undefined);
      renderAgreement = vi.fn().mockResolvedValue(undefined);
      requestPayment = vi.fn().mockResolvedValue(undefined);
      widgetsFactory = vi.fn(() => ({
        setAmount,
        renderPaymentMethods,
        renderAgreement,
        requestPayment,
      }));
      // SDK 전역 목킹 — loadTossSdk 는 window.TossPayments 존재 시 즉시 resolve.
      (window as unknown as { TossPayments: unknown }).TossPayments = vi.fn(() => ({
        widgets: widgetsFactory,
      }));
    });

    it("setAmount + renderPaymentMethods(DEFAULT) + renderAgreement(AGREEMENT) 를 호출", async () => {
      await renderTossWidget({
        amount: 30000,
        methodsSelector: "#m",
        agreementSelector: "#a",
      });
      expect(setAmount).toHaveBeenCalledWith({ currency: "KRW", value: 30000 });
      expect(renderPaymentMethods).toHaveBeenCalledWith({ selector: "#m", variantKey: "DEFAULT" });
      expect(renderAgreement).toHaveBeenCalledWith({ selector: "#a", variantKey: "AGREEMENT" });
    });

    it("반환 핸들의 requestPayment 가 orderId/orderName/successUrl/failUrl 을 위젯에 전달", async () => {
      const handle = await renderTossWidget({ amount: 30000, methodsSelector: "#m", agreementSelector: "#a" });
      await handle.requestPayment({
        orderId: "ord_x_a1",
        orderName: "티켓",
        successUrl: "https://x/success",
        failUrl: "https://x/fail",
        customerEmail: "buyer@test.kr",
      });
      expect(requestPayment).toHaveBeenCalledTimes(1);
      const arg = requestPayment.mock.calls[0][0];
      expect(arg.orderId).toBe("ord_x_a1");
      expect(arg.orderName).toBe("티켓");
      expect(arg.successUrl).toBe("https://x/success");
      expect(arg.failUrl).toBe("https://x/fail");
      expect(arg.customerEmail).toBe("buyer@test.kr");
    });

    it("반환 핸들의 setAmount 가 금액을 갱신", async () => {
      const handle = await renderTossWidget({ amount: 30000, methodsSelector: "#m", agreementSelector: "#a" });
      await handle.setAmount(50000);
      expect(setAmount).toHaveBeenLastCalledWith({ currency: "KRW", value: 50000 });
    });
  });
});
