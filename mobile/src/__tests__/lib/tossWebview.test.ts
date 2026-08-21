import {
  matchesScheme,
  isExternalAppScheme,
  isAllowedPgHost,
  parsePaymentCallback,
} from "@/lib/tossWebview";

const SUCCESS = "pickket://payment/success";
const FAIL = "pickket://payment/fail";
const ALLOWED = [
  "api.pickket.kr",
  "pickket.kr",
  "pay.toss.im",
  "www.tosspayments.com",
  "api.tosspayments.com",
];

describe("tossWebview 헬퍼", () => {
  describe("matchesScheme", () => {
    it("정확 일치 / ? / # 형태 매칭", () => {
      expect(matchesScheme(SUCCESS, SUCCESS)).toBe(true);
      expect(matchesScheme(`${SUCCESS}?pg_transaction_id=x`, SUCCESS)).toBe(true);
      expect(matchesScheme(`${SUCCESS}#frag`, SUCCESS)).toBe(true);
      expect(matchesScheme("https://x", SUCCESS)).toBe(false);
    });
  });

  describe("isExternalAppScheme", () => {
    it("http(s) 는 false, 앱 스킴은 true", () => {
      expect(isExternalAppScheme("https://pay.toss.im/x")).toBe(false);
      expect(isExternalAppScheme("http://x")).toBe(false);
      expect(isExternalAppScheme("supertoss://pay")).toBe(true);
      expect(isExternalAppScheme("ispmobile://auth")).toBe(true);
      expect(isExternalAppScheme("intent://scan#Intent;end")).toBe(true);
      expect(isExternalAppScheme("kb-acp://card")).toBe(true);
    });
  });

  describe("isAllowedPgHost", () => {
    it("허용 호스트/서브도메인 true, 그 외 false", () => {
      expect(isAllowedPgHost("https://pay.toss.im/redirect", ALLOWED)).toBe(true);
      expect(isAllowedPgHost("https://api.tosspayments.com/v1", ALLOWED)).toBe(true);
      // 서브도메인 매칭
      expect(isAllowedPgHost("https://sub.pickket.kr/x", ALLOWED)).toBe(true);
      // 미허용
      expect(isAllowedPgHost("https://evil.com/x", ALLOWED)).toBe(false);
      // 접미사만 같은 위장 도메인은 차단(endsWith "." + host)
      expect(isAllowedPgHost("https://notpickket.kr/x", ALLOWED)).toBe(false);
    });
    it("잘못된 URL 은 false", () => {
      expect(isAllowedPgHost("not a url", ALLOWED)).toBe(false);
    });
  });

  describe("parsePaymentCallback", () => {
    it("success → pg_transaction_id·pg_provider·payment_id 파싱", () => {
      const cb = parsePaymentCallback(
        `${SUCCESS}?pg_transaction_id=pk_1&pg_provider=toss&payment_id=ord_x_a1`,
        SUCCESS,
        FAIL,
      );
      expect(cb.kind).toBe("success");
      expect(cb.pgTransactionId).toBe("pk_1");
      expect(cb.pgProvider).toBe("toss");
      expect(cb.paymentId).toBe("ord_x_a1");
    });

    it("success 에 pg_provider 없으면 기본 toss", () => {
      const cb = parsePaymentCallback(`${SUCCESS}?pg_transaction_id=pk_1`, SUCCESS, FAIL);
      expect(cb.pgProvider).toBe("toss");
      expect(cb.paymentId).toBeUndefined();
    });

    it("fail → reason 파싱", () => {
      const cb = parsePaymentCallback(`${FAIL}?reason=사용자취소`, SUCCESS, FAIL);
      expect(cb.kind).toBe("fail");
      expect(cb.reason).toBe("사용자취소");
    });

    it("무관 URL → none", () => {
      const cb = parsePaymentCallback("https://pay.toss.im/x", SUCCESS, FAIL);
      expect(cb.kind).toBe("none");
    });
  });
});
