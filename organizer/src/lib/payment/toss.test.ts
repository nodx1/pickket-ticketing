import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getTossPaymentByOrderId, getTossPaymentByPaymentKey, isTossSecretConfigured, TossAmbiguousError, TossLookupError, tossProvider } from "@/lib/payment/toss";

/** fetch 응답 목 — ok/status·json 페이로드 지정. */
function mockFetchOnce(ok: boolean, payload: unknown, status = ok ? 200 : 400) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => payload,
  } as Response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

const ORIG_SECRET = process.env.TOSS_SECRET_KEY;

afterEach(() => {
  if (ORIG_SECRET === undefined) delete process.env.TOSS_SECRET_KEY;
  else process.env.TOSS_SECRET_KEY = ORIG_SECRET;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("toss.ts 서버 provider", () => {
  describe("mock 모드 — 시크릿 미설정", () => {
    beforeEach(() => {
      delete process.env.TOSS_SECRET_KEY;
    });

    it("confirm: 실 PG 호출 없이 success", async () => {
      const fetchFn = mockFetchOnce(true, {});
      const r = await tossProvider.confirm({ paymentKey: "pk", orderId: "ord_x", amount: 1000 });
      expect(r.success).toBe(true);
      expect(r.paymentKey).toBe("pk");
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("cancel: 실 PG 호출 없이 success + 요청 취소금액 반영", async () => {
      const fetchFn = mockFetchOnce(true, {});
      const r = await tossProvider.cancel({ paymentKey: "pk", reason: "환불", amount: 5000 });
      expect(r.success).toBe(true);
      expect(r.cancelAmount).toBe(5000);
      expect(fetchFn).not.toHaveBeenCalled();
    });

    it("isTossSecretConfigured false, getTossPaymentByOrderId null (웹훅 조회 비활성)", async () => {
      const fetchFn = mockFetchOnce(true, {});
      expect(isTossSecretConfigured()).toBe(false);
      expect(await getTossPaymentByOrderId("ord_x")).toBeNull();
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe("mock paymentKey (mock_ prefix) — 시크릿 있어도 우회", () => {
    beforeEach(() => {
      process.env.TOSS_SECRET_KEY = "test_sk_dummy";
    });

    it("confirm: mock_ 키는 실 PG 승인 건너뜀", async () => {
      const fetchFn = mockFetchOnce(true, {});
      const r = await tossProvider.confirm({ paymentKey: "mock_abc", orderId: "ord_x", amount: 1000 });
      expect(r.success).toBe(true);
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe("real 모드 — 시크릿 설정", () => {
    beforeEach(() => {
      process.env.TOSS_SECRET_KEY = "test_sk_dummy";
    });

    it("confirm DONE → success, paymentKey·method·receipt 파싱 + Basic 인증 헤더", async () => {
      const fetchFn = mockFetchOnce(true, {
        status: "DONE",
        paymentKey: "pk_real_1",
        method: "카드",
        approvedAt: "2026-07-12T00:00:00+09:00",
        receipt: { url: "https://receipt.toss/1" },
      });
      const r = await tossProvider.confirm({ paymentKey: "pk_real_1", orderId: "ord_x", amount: 30000 });
      expect(r.success).toBe(true);
      expect(r.pending).toBe(false);
      expect(r.paymentKey).toBe("pk_real_1");
      expect(r.method).toBe("카드");
      expect(r.receipt).toBe("https://receipt.toss/1");

      // 실 토스 confirm 엔드포인트 + Basic 인증 + 본문 검증
      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe("https://api.tosspayments.com/v1/payments/confirm");
      expect((init as RequestInit).method).toBe("POST");
      const auth = (init as RequestInit).headers as Record<string, string>;
      const expected = "Basic " + Buffer.from("test_sk_dummy:").toString("base64");
      expect(auth.Authorization).toBe(expected);
      expect(JSON.parse((init as RequestInit).body as string)).toEqual({
        paymentKey: "pk_real_1",
        orderId: "ord_x",
        amount: 30000,
      });
    });

    it("가상계좌 WAITING_FOR_DEPOSIT → pending=true, success=false", async () => {
      mockFetchOnce(true, { status: "WAITING_FOR_DEPOSIT", paymentKey: "pk_va" });
      const r = await tossProvider.confirm({ paymentKey: "pk_va", orderId: "ord_x", amount: 1000 });
      expect(r.pending).toBe(true);
      expect(r.success).toBe(false);
    });

    it("confirm 실패(!ok) → 토스 message 로 throw", async () => {
      mockFetchOnce(false, { message: "카드사 승인 거절" });
      await expect(
        tossProvider.confirm({ paymentKey: "pk", orderId: "ord_x", amount: 1000 }),
      ).rejects.toThrow("카드사 승인 거절");
    });

    it("confirm 실패 message 없음 → 기본 문구로 throw", async () => {
      mockFetchOnce(false, {});
      await expect(
        tossProvider.confirm({ paymentKey: "pk", orderId: "ord_x", amount: 1000 }),
      ).rejects.toThrow("토스 결제 승인에 실패했습니다");
    });

    it("cancel → cancels 배열 최신 항목의 금액·시각 반영 + Idempotency 헤더", async () => {
      const fetchFn = mockFetchOnce(true, {
        cancels: [{ cancelAmount: 5000, canceledAt: "2026-07-12T01:00:00+09:00" }],
      });
      const r = await tossProvider.cancel({ paymentKey: "pk_c", reason: "고객 환불", amount: 5000 });
      expect(r.success).toBe(true);
      expect(r.cancelAmount).toBe(5000);
      expect(r.cancelledAt).toBe("2026-07-12T01:00:00+09:00");

      const [url, init] = fetchFn.mock.calls[0];
      expect(url).toBe("https://api.tosspayments.com/v1/payments/pk_c/cancel");
      const headers = (init as RequestInit).headers as Record<string, string>;
      expect(headers["Idempotency-Key"]).toBe("cancel:pk_c");
    });

    it("cancel 실패(!ok) → 토스 message 로 throw", async () => {
      mockFetchOnce(false, { message: "이미 취소된 결제입니다" });
      await expect(
        tossProvider.cancel({ paymentKey: "pk", reason: "환불", amount: 1000 }),
      ).rejects.toThrow("이미 취소된 결제입니다");
    });

    it("getTossPaymentByOrderId: orderId 조회 성공 → 페이로드 반환", async () => {
      const fetchFn = mockFetchOnce(true, { paymentKey: "pk", status: "DONE", orderId: "ord_x" });
      const body = await getTossPaymentByOrderId("ord_x");
      expect(body?.status).toBe("DONE");
      const [url] = fetchFn.mock.calls[0];
      expect(url).toBe("https://api.tosspayments.com/v1/payments/orders/ord_x");
    });

    it("getTossPaymentByOrderId: 404 → null (결제 없음 — 정상, 위조 웹훅 차단)", async () => {
      mockFetchOnce(false, { code: "NOT_FOUND_PAYMENT" }, 404);
      expect(await getTossPaymentByOrderId("ord_missing")).toBeNull();
    });

    it("getTossPaymentByOrderId: 401/5xx → TossLookupError (P1-10 fail-closed, null 위장 금지)", async () => {
      mockFetchOnce(false, { code: "SERVER_ERROR" }, 500);
      await expect(getTossPaymentByOrderId("ord_x")).rejects.toBeInstanceOf(TossLookupError);
    });

    it("paymentKey 조회는 orderId가 아니라 provider paymentKey 경로를 사용한다", async () => {
      const fetchFn = mockFetchOnce(true, { paymentKey: "pk/real", status: "DONE", cancels: [] });
      await expect(getTossPaymentByPaymentKey("pk/real")).resolves.toMatchObject({ status: "DONE" });
      expect(fetchFn.mock.calls[0]?.[0]).toBe("https://api.tosspayments.com/v1/payments/pk%2Freal");
    });

    it("취소 transport/5xx 결과는 중복 환불을 막기 위해 ambiguous로 남긴다", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket timeout")));
      await expect(tossProvider.cancel({ paymentKey: "pk_timeout", reason: "sandbox", amount: 1000 }))
        .rejects.toBeInstanceOf(TossAmbiguousError);

      const response = { ok: false, status: 503, json: async () => ({ message: "upstream unavailable" }) } as Response;
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      await expect(tossProvider.cancel({ paymentKey: "pk_5xx", reason: "sandbox", amount: 1000 }))
        .rejects.toBeInstanceOf(TossAmbiguousError);
    });

    it("confirm 재시도 멱등: ALREADY_PROCESSED + 조회 일치(DONE·동일주문·동일금액) → success", async () => {
      // 1차 응답: confirm 실패(이미 승인됨) / 2차 응답: 결제 조회 — DONE 일치
      const fn = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          json: async () => ({ code: "ALREADY_PROCESSED_PAYMENT", message: "이미 처리된 결제" }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            orderId: "ord_x",
            status: "DONE",
            totalAmount: 30000,
            paymentKey: "pk_real_1",
            method: "카드",
            approvedAt: "2026-07-12T00:00:00+09:00",
          }),
        } as Response);
      vi.stubGlobal("fetch", fn);
      const r = await tossProvider.confirm({ paymentKey: "pk_real_1", orderId: "ord_x", amount: 30000 });
      expect(r.success).toBe(true);
      expect(r.paymentKey).toBe("pk_real_1");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("confirm 재시도: ALREADY_PROCESSED 지만 조회 불일치(다른 주문/금액) → throw", async () => {
      const fn = vi
        .fn()
        .mockResolvedValueOnce({
          ok: false,
          json: async () => ({ code: "ALREADY_PROCESSED_PAYMENT", message: "이미 처리된 결제" }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({ orderId: "ord_OTHER", status: "DONE", totalAmount: 30000 }),
        } as Response);
      vi.stubGlobal("fetch", fn);
      await expect(
        tossProvider.confirm({ paymentKey: "pk_real_1", orderId: "ord_x", amount: 30000 }),
      ).rejects.toThrow("이미 처리된 결제");
    });

    it("prepare: no-op — successUrl?orderId 리다이렉트 + paymentKey=orderId", async () => {
      const r = await tossProvider.prepare({
        orderId: "ord_x",
        amount: 1000,
        orderName: "테스트 주문",
        buyerName: "홍길동",
        buyerEmail: "buyer@pickket.kr",
        buyerPhone: "01000000000",
        successUrl: "https://go.pickket.kr/success",
        failUrl: "https://go.pickket.kr/fail",
      });
      expect(r.paymentKey).toBe("ord_x");
      expect(r.redirectUrl).toBe("https://go.pickket.kr/success?orderId=ord_x");
    });
  });
});
