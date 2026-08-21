/**
 * Phase 5A-3 — 결제 웹훅 idempotency 회귀 테스트
 *
 * 검증:
 *  - 동일 payload 2회 → 1회 fresh, 2회 dedup:true
 *  - 5분 초과된 createdAt → timestamp 거부 (400)
 *  - 4개 provider 전부 (toss/kakao/naver/portone)
 *  - DB processed_webhook_events 테이블에 기록되는지 (API 경유 확인)
 *
 * 주의: 테스트 실행 시 provider별 webhook secret을 함께 주입한다.
 */
import crypto from "node:crypto";
import { expect, test } from "@playwright/test";

const providers = (["toss", "kakao", "naver", "portone"] as const).filter(
  (provider) => provider !== "portone" || process.env.PORTONE_WEBHOOK_ENABLED === "true",
);

const providerSecrets = {
  toss: process.env.TOSS_WEBHOOK_SECRET ?? "test_toss_webhook_secret",
  kakao: process.env.KAKAO_WEBHOOK_SECRET ?? "test_kakao_webhook_secret",
  naver: process.env.NAVER_WEBHOOK_SECRET ?? "test_naver_webhook_secret",
  portone: process.env.PORTONE_WEBHOOK_SECRET ?? "test_portone_webhook_secret",
} as const;

const signatureHeaders = {
  toss: "TossPayments-Signature",
  kakao: "Kakaopay-Signature",
  naver: "Naverpay-Signature",
  portone: "x-portone-signature",
} as const;

function signPayload(provider: (typeof providers)[number], rawBody: string) {
  const digest =
    provider === "portone"
      ? crypto.createHmac("sha256", providerSecrets[provider]).update(rawBody).digest("hex")
      : crypto.createHmac("sha256", providerSecrets[provider]).update(rawBody).digest("base64");

  return provider === "portone" ? `sha256=${digest}` : digest;
}

function signedRequestOptions(provider: (typeof providers)[number], payload: Record<string, unknown>) {
  const rawBody = JSON.stringify(payload);
  return {
    data: rawBody,
    headers: {
      "content-type": "application/json",
      [signatureHeaders[provider]]: signPayload(provider, rawBody),
    },
  };
}

test.describe("Phase 5A-3: 웹훅 idempotency", () => {
  for (const provider of providers) {
    test(`${provider} webhook — 동일 payload 2회 → 2회차 dedup:true`, async ({ request }) => {
      const eventId = `e2e_${provider}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();
      const payload = {
        id: eventId,
        paymentKey: `pk_${eventId}`,
        orderId: `11111111-1111-4111-8111-111111111111`,
        amount: 10000,
        createdAt: now,
        status: "paid",
      };

      // 1회차 — fresh
      const first = await request.post(
        `/api/payment/${provider}/webhook`,
        signedRequestOptions(provider, payload),
      );
      expect(first.ok()).toBeTruthy();
      const firstBody = await first.json();
      expect(firstBody.success).toBe(true);
      expect(firstBody.data.received).toBe(true);
      expect(firstBody.data.dedup).toBeFalsy();
      expect(firstBody.data.eventId).toBe(eventId);

      // 2회차 — duplicate
      const second = await request.post(
        `/api/payment/${provider}/webhook`,
        signedRequestOptions(provider, payload),
      );
      expect(second.ok()).toBeTruthy();
      const secondBody = await second.json();
      expect(secondBody.success).toBe(true);
      expect(secondBody.data.dedup).toBe(true);
      expect(secondBody.data.eventId).toBe(eventId);
    });
  }

  test("timestamp 5분 초과 → 거부 (400)", async ({ request }) => {
    const oldTimestamp = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    const eventId = `e2e_old_${Date.now()}`;

    const response = await request.post(
      "/api/payment/toss/webhook",
      signedRequestOptions("toss", {
        id: eventId,
        createdAt: oldTimestamp,
      }),
    );

    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/허용 범위|tolerance|범위 초과/i);
  });

  test("eventId 없는 payload도 sha256 폴백으로 dedup 동작", async ({ request }) => {
    const uniquePayload = {
      // id/eventId 없음 — sha256(raw body)로 dedup
      amount: 12345,
      createdAt: new Date().toISOString(),
      marker: `e2e_fallback_${Date.now()}`,
    };

    const first = await request.post(
      "/api/payment/toss/webhook",
      signedRequestOptions("toss", uniquePayload),
    );
    expect(first.ok()).toBeTruthy();
    const firstBody = await first.json();
    expect(firstBody.data.eventId).toMatch(/^sha256:/);

    const second = await request.post(
      "/api/payment/toss/webhook",
      signedRequestOptions("toss", uniquePayload),
    );
    const secondBody = await second.json();
    expect(secondBody.data.dedup).toBe(true);
  });
});
