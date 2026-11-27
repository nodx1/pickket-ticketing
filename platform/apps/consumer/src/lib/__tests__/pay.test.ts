import { describe, it, expect, vi, beforeEach } from "vitest";

const prepareMock = vi.fn();
vi.mock("@pickket/lib/api", () => ({
  prepareOrderPayment: (...args: unknown[]) => prepareMock(...args),
}));

const startNicePaymentMock = vi.fn();
vi.mock("@/lib/nice", () => ({
  startNicePayment: (...args: unknown[]) => startNicePaymentMock(...args),
}));

import { resolveProvider, startPayment } from "@/lib/pay";

const NICE_PARAMS = {
  js_url: "https://pg-web.nicepay.co.kr/v3/common/js/nicepay-pgweb.js",
  form: {
    MID: "nicepay00m",
    Moid: "ord_x_a1",
    Amt: "30000",
    SignData: "SIGN",
    ReturnURL: "https://api.pickket.kr/api/v1/payments/nice/return",
    MallReserved: "https://www.pickket.kr/ko/payment/success?order=uuid-1",
  },
};

function preparedResponse(
  provider: string,
  extra: Record<string, unknown> = {},
  paymentId = "ord_x_a1",
) {
  return { data: { provider, payment_id: paymentId, ...extra } };
}

describe("pay.ts — 결제 개시 공통 헬퍼", () => {
  describe("resolveProvider", () => {
    it("'nicepay' → nicepay", () => {
      expect(resolveProvider("nicepay")).toBe("nicepay");
    });
    // 2026-07-28 결정(f32db91f): 기본 PG 는 나이스. 토스는 명시('toss')일 때만(기존 주문 라우팅용).
    //    이 테스트가 옛 기본값(toss)을 기대한 채 남아 있었다.
    it("'toss' 는 toss, 미지정/미상 → nicepay 폴백", () => {
      expect(resolveProvider("toss")).toBe("toss");
      expect(resolveProvider(null)).toBe("nicepay");
      expect(resolveProvider(undefined)).toBe("nicepay");
      expect(resolveProvider("unknown_pg")).toBe("nicepay");
    });
  });

  describe("startPayment", () => {
    let assignMock: ReturnType<typeof vi.fn>;
    beforeEach(() => {
      prepareMock.mockReset();
      startNicePaymentMock.mockReset();
      assignMock = vi.fn();
      Object.defineProperty(window, "location", {
        configurable: true,
        value: { assign: assignMock, origin: "http://localhost" },
      });
    });

    it("provider=nicepay → provider_params 를 startNicePayment 에 그대로 전달", async () => {
      prepareMock.mockResolvedValue(
        preparedResponse("nicepay", { provider_params: NICE_PARAMS }),
      );
      await startPayment({
        orderId: "uuid-1",
        orderName: "티켓",
        amount: 30000,
        successUrl: "http://localhost/ko/payment/success?order=uuid-1",
        failUrl: "http://localhost/ko/payment/fail?order=uuid-1",
      });
      // payMethod 미지정 → prepare 2번째 인자 undefined(기존 계약 무변).
      expect(prepareMock).toHaveBeenCalledWith("uuid-1", undefined);
      expect(startNicePaymentMock).toHaveBeenCalledTimes(1);
      // 서버가 준 provider_params 를 무변형 전달(SignData/ReturnURL 등) + onCancel 옵션(미지정=undefined).
      expect(startNicePaymentMock).toHaveBeenCalledWith(NICE_PARAMS, {
        onCancel: undefined,
      });
      // 나이스는 토스 mock 리다이렉트 경로를 타지 않는다
      expect(assignMock).not.toHaveBeenCalled();
    });

    it("provider=nicepay + 서버 모의 모드 → 결제창 없이 모의 승인 경로(성공 화면 → 서버 confirm)", async () => {
      prepareMock.mockResolvedValue(
        preparedResponse("nicepay", { provider_params: { ...NICE_PARAMS, mode: "mock" } }),
      );
      await startPayment({
        orderId: "uuid-1",
        orderName: "티켓",
        amount: 1000,
        successUrl: "http://localhost/ko/payment/success?order=uuid-1",
        failUrl: "http://localhost/ko/payment/fail?order=uuid-1",
      });
      expect(startNicePaymentMock).not.toHaveBeenCalled();
      expect(assignMock).toHaveBeenCalledTimes(1);
      const url = new URL(assignMock.mock.calls[0][0] as string);
      expect(url.pathname).toBe("/ko/payment/success");
      expect(url.searchParams.get("order")).toBe("uuid-1");
      expect(url.searchParams.get("paymentKey")).toBe("mock_ord_x_a1");
      expect(url.searchParams.get("orderId")).toBe("ord_x_a1");
      expect(url.searchParams.get("amount")).toBe("1000");
    });

    it("provider=nicepay + 서버 실결제 모드(live) → 실제 나이스 결제창", async () => {
      prepareMock.mockResolvedValue(
        preparedResponse("nicepay", { provider_params: { ...NICE_PARAMS, mode: "live" } }),
      );
      await startPayment({
        orderId: "uuid-1",
        orderName: "티켓",
        amount: 30000,
        successUrl: "http://localhost/ko/payment/success?order=uuid-1",
        failUrl: "http://localhost/ko/payment/fail?order=uuid-1",
      });
      expect(startNicePaymentMock).toHaveBeenCalledTimes(1);
      expect(assignMock).not.toHaveBeenCalled();
    });

    it("provider=nicepay 인데 provider_params 누락 → 명확한 에러(조용한 실패 금지)", async () => {
      prepareMock.mockResolvedValue(preparedResponse("nicepay"));
      const onNiceError = vi.fn();
      await expect(
        startPayment({
          orderId: "uuid-1",
          orderName: "티켓",
          amount: 30000,
          successUrl: "http://localhost/ko/payment/success?order=uuid-1",
          failUrl: "http://localhost/ko/payment/fail?order=uuid-1",
          onNiceError,
        }),
      ).rejects.toThrow();
      expect(startNicePaymentMock).not.toHaveBeenCalled();
    });

    it("provider=nicepay + startNicePayment 오류 → onNiceError 통지 후 re-throw", async () => {
      prepareMock.mockResolvedValue(
        preparedResponse("nicepay", { provider_params: NICE_PARAMS }),
      );
      startNicePaymentMock.mockRejectedValue(new Error("SDK 로드 실패"));
      const onNiceError = vi.fn();
      await expect(
        startPayment({
          orderId: "uuid-1",
          orderName: "티켓",
          amount: 30000,
          successUrl: "http://localhost/ko/payment/success?order=uuid-1",
          failUrl: "http://localhost/ko/payment/fail?order=uuid-1",
          onNiceError,
        }),
      ).rejects.toThrow("SDK 로드 실패");
      expect(onNiceError).toHaveBeenCalledWith("SDK 로드 실패");
    });

    it("provider=nicepay → onNiceCancel 을 startNicePayment 의 onCancel 로 배선(팝업 닫힘 탈출)", async () => {
      prepareMock.mockResolvedValue(
        preparedResponse("nicepay", { provider_params: NICE_PARAMS }),
      );
      const onNiceCancel = vi.fn();
      await startPayment({
        orderId: "uuid-1",
        orderName: "티켓",
        amount: 30000,
        successUrl: "http://localhost/ko/payment/success?order=uuid-1",
        failUrl: "http://localhost/ko/payment/fail?order=uuid-1",
        onNiceCancel,
      });
      // startNicePayment(providerParams, { onCancel }) 형태로 호출됐는지.
      expect(startNicePaymentMock).toHaveBeenCalledWith(NICE_PARAMS, {
        onCancel: onNiceCancel,
      });
    });

    it("provider=toss → toss mock redirect(paymentKey=mock_·amount)", async () => {
      prepareMock.mockResolvedValue(preparedResponse("toss"));
      await startPayment({
        orderId: "uuid-2",
        orderName: "티켓",
        amount: 45000,
        successUrl: "http://localhost/ko/payment/success?order=uuid-2",
        failUrl: "http://localhost/ko/payment/fail?order=uuid-2",
      });
      const url = new URL(assignMock.mock.calls[0][0] as string);
      expect(url.searchParams.get("paymentKey")).toBe("mock_ord_x_a1");
      expect(url.searchParams.get("amount")).toBe("45000");
      // 나이스 경로 미개입
      expect(startNicePaymentMock).not.toHaveBeenCalled();
    });

    it("payMethod 지정 → prepare 요청에 pay_method 전달(나이스 결제수단 선택)", async () => {
      prepareMock.mockResolvedValue(
        preparedResponse("nicepay", { provider_params: NICE_PARAMS }),
      );
      await startPayment({
        orderId: "uuid-1",
        orderName: "티켓",
        amount: 30000,
        successUrl: "http://localhost/ko/payment/success?order=uuid-1",
        failUrl: "http://localhost/ko/payment/fail?order=uuid-1",
        payMethod: "VBANK",
      });
      expect(prepareMock).toHaveBeenCalledWith("uuid-1", {
        pay_method: "VBANK",
      });
    });

    it("payMethod 지정 + provider=toss → pay_method 전달돼도 토스 mock 무영향(서버가 무시)", async () => {
      prepareMock.mockResolvedValue(preparedResponse("toss"));
      await startPayment({
        orderId: "uuid-2",
        orderName: "티켓",
        amount: 45000,
        successUrl: "http://localhost/ko/payment/success?order=uuid-2",
        failUrl: "http://localhost/ko/payment/fail?order=uuid-2",
        payMethod: "CARD",
      });
      expect(prepareMock).toHaveBeenCalledWith("uuid-2", { pay_method: "CARD" });
      // 토스 mock 리다이렉트는 그대로 동작(나이스 미개입).
      const url = new URL(assignMock.mock.calls[0][0] as string);
      expect(url.searchParams.get("paymentKey")).toBe("mock_ord_x_a1");
      expect(startNicePaymentMock).not.toHaveBeenCalled();
    });

    it("prepare 주입(게스트) → payMethod 는 startPayment 기본 prepare 를 우회(주입 prepare 가 소유)", async () => {
      const injectedPrepare = vi.fn().mockResolvedValue(
        preparedResponse("nicepay", { provider_params: NICE_PARAMS }),
      );
      await startPayment({
        orderId: "uuid-9",
        orderName: "티켓",
        amount: 1000,
        successUrl: "http://localhost/ko/payment/success?order=uuid-9",
        failUrl: "http://localhost/ko/payment/fail?order=uuid-9",
        payMethod: "BANK",
        prepare: injectedPrepare,
      });
      // 기본 prepareOrderPayment 는 호출되지 않고, 주입 prepare 만 호출된다.
      expect(prepareMock).not.toHaveBeenCalled();
      expect(injectedPrepare).toHaveBeenCalledWith("uuid-9");
    });

    it("provider 미지정 → 나이스로 가되 결제창 값이 없으면 조용히 넘기지 않고 실패(모의 성공 금지)", async () => {
      prepareMock.mockResolvedValue({ data: { payment_id: "ord_z_a1" } });
      await expect(
        startPayment({
          orderId: "uuid-3",
          orderName: "티켓",
          amount: 1000,
          successUrl: "http://localhost/ko/payment/success?order=uuid-3",
          failUrl: "http://localhost/ko/payment/fail?order=uuid-3",
        }),
      ).rejects.toThrow();
      expect(assignMock).not.toHaveBeenCalled();
      expect(startNicePaymentMock).not.toHaveBeenCalled();
    });
  });
});
