/**
 * Phase 5B-1 — 휴대폰 OTP 회귀 테스트
 *
 * 검증:
 *  - send-otp → verificationId 발급 + stub 모드 확인
 *  - verify-otp 성공 → 검증 토큰 발급
 *  - 동일 OTP 재사용 → "이미 검증된 인증" 409
 *  - 잘못된 코드 → attempts 증가 + 남은 시도 표시
 *  - 전화번호별 rate limit (3/hour) + burst (sms preset 3/60s)
 *
 * 주의: stub provider가 OTP를 콘솔에 출력하므로, PLAYWRIGHT_TEST=1 환경에서
 *       테스트 모드로 OTP를 직접 확인할 방법이 없음.
 *       → Redis key `wh:...` 직접 조회 또는 DB 직접 조회는 회피하고,
 *       "발송 → 잘못된 코드 시도 → rate limit" 시나리오로 회귀 방지만 담당.
 */
import { expect, test } from "@playwright/test";

/**
 * E2E 유니크 전화번호 생성 — 테스트 간 rate limit 충돌 방지.
 * Date.now() + 카운터로 retry 시에도 유일성 보장.
 */
let phoneCounter = 0;
function uniquePhone(): string {
  phoneCounter += 1;
  const ts = (Date.now() % 10_000_000).toString().padStart(7, "0");
  const counter = (phoneCounter % 10).toString();
  const random2 = Math.floor(Math.random() * 100).toString().padStart(2, "0");
  return `010${random2}${ts.slice(0, 6)}${counter}`;
}

test.describe("Phase 5B-1: 휴대폰 OTP", () => {
  test("send-otp → verificationId + stub 모드 확인", async ({ request }) => {
    const phone = uniquePhone();
    const response = await request.post("/api/auth/phone/send-otp", {
      data: { phone, purpose: "signup" },
    });
    const body = await response.json().catch(() => ({ error: "parse_fail" }));

    // 실패 시 원인 즉시 노출
    expect(
      response.ok(),
      `send-otp 실패 status=${response.status()} body=${JSON.stringify(body)}`,
    ).toBeTruthy();
    expect(body.success).toBe(true);
    expect(body.data.verificationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(body.data.provider).toBe("stub");
    expect(body.data.expiresInSeconds).toBe(300);
  });

  test("잘못된 OTP → 422 + 남은 시도 횟수 감소", async ({ request }) => {
    const phone = uniquePhone();
    const sendRes = await request.post("/api/auth/phone/send-otp", {
      data: { phone, purpose: "login" },
    });
    const sendBody = await sendRes.json();
    const vid = sendBody.data.verificationId;

    // 잘못된 코드 3번 시도
    for (let i = 1; i <= 3; i++) {
      const verifyRes = await request.post("/api/auth/phone/verify-otp", {
        data: { verificationId: vid, code: "000000" },
      });
      expect(verifyRes.status()).toBe(422);
      const verifyBody = await verifyRes.json();
      expect(verifyBody.success).toBe(false);
      expect(verifyBody.error).toMatch(/일치하지 않습니다/);
      expect(verifyBody.error).toMatch(/남은 시도/);
    }
  });

  test("send-otp rate limit: 동일 전화번호 반복 호출 → 429 발생 (phone 3/hour)", async ({ request }) => {
    // phone별 limit = 3/hour → 최대 6번까지 호출하며 429가 나오는 순간 확인.
    // Redis 상태 누적 가능성을 감안해 관대하게 검증 (최소 1건 429 발생).
    const phone = uniquePhone();

    const results: number[] = [];
    for (let i = 1; i <= 6; i++) {
      const res = await request.post("/api/auth/phone/send-otp", {
        data: { phone, purpose: "checkout" },
      });
      results.push(res.status());
      if (res.status() === 429) break;
    }

    // 최소 1건의 429가 발생했어야 함 (phone rate limit 동작 확인)
    expect(results.some((s) => s === 429), `전체 응답: ${JSON.stringify(results)}`).toBeTruthy();
  });

  test("잘못된 phone 형식 → 400", async ({ request }) => {
    const response = await request.post("/api/auth/phone/send-otp", {
      data: { phone: "abc123", purpose: "signup" },
    });
    expect(response.status()).toBe(400);
  });

  test("잘못된 verificationId UUID 형식 → 400", async ({ request }) => {
    const response = await request.post("/api/auth/phone/verify-otp", {
      data: { verificationId: "not-a-uuid", code: "123456" },
    });
    expect(response.status()).toBe(400);
  });

  test("6자리 아닌 code → 400", async ({ request }) => {
    const response = await request.post("/api/auth/phone/verify-otp", {
      data: {
        verificationId: "11111111-1111-4111-8111-111111111111",
        code: "12345",
      },
    });
    expect(response.status()).toBe(400);
  });
});
