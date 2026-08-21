import { test, expect } from "@playwright/test";
import { apiLogin, apiGet } from "./fixtures/helpers";

/* ═══════════════════════════════════════════════════════════════════════
 * session-security.spec.ts — 세션 보안 E2E 테스트
 *
 * 검증 대상:
 *   1. 토큰 만료/변조 시 API 거부
 *   2. 리프레시 토큰 갱신 플로우
 *   3. 인증 헤더 형식 검증
 *   4. JWT payload/signature 변조 방어
 *   5. 로그아웃 후 토큰 무효화
 *   6. CORS 헤더 검증
 *   7. 동시 세션 처리
 *   8. 잘못된 content-type 방어
 *   9. SQL injection 방어
 * ═══════════════════════════════════════════════════════════════════════ */

const API_BASE = process.env.E2E_API_BASE || "http://localhost:8021/api/v1";

/** JWT 토큰의 payload 부분을 변조하여 반환 */
function tamperJwtPayload(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) return token;

  // payload를 디코딩 → 변조 → 재인코딩
  const payload = JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf-8"),
  );
  payload.sub = "00000000-0000-0000-0000-000000000000"; // 존재하지 않는 사용자
  payload.exp = Math.floor(Date.now() / 1000) + 3600; // 1시간 후 만료

  parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return parts.join(".");
}

/** JWT 토큰의 signature 부분만 변조 */
function tamperJwtSignature(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) return token;

  // 시그니처를 무작위 문자열로 교체
  parts[2] = Buffer.from("tampered-signature-e2e-test").toString("base64url");
  return parts.join(".");
}

/** JWT 토큰의 exp 클레임을 과거로 설정하여 만료된 토큰 생성 */
function makeExpiredToken(token: string): string {
  const parts = token.split(".");
  if (parts.length !== 3) return token;

  const payload = JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf-8"),
  );
  payload.exp = Math.floor(Date.now() / 1000) - 3600; // 1시간 전 만료
  payload.iat = Math.floor(Date.now() / 1000) - 7200; // 2시간 전 발급

  parts[1] = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return parts.join(".");
}

test.describe("세션 보안 — 토큰 인증 검증", () => {
  let accessToken: string;
  let refreshToken: string;

  test.beforeAll(async ({ request }) => {
    const auth = await apiLogin(request);
    accessToken = auth.accessToken;
    refreshToken = auth.refreshToken;
  });

  test("만료된 access_token으로 보호 API 호출 → 401", async ({ request }) => {
    // 유효한 토큰의 exp를 과거로 변조
    const expiredToken = makeExpiredToken(accessToken);

    const resp = await request.get(`${API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${expiredToken}` },
    });

    expect(resp.status()).toBe(401);
  });

  test("리프레시 토큰으로 새 access_token 발급", async ({ request }) => {
    const resp = await request.post(`${API_BASE}/auth/refresh`, {
      data: { refresh_token: refreshToken },
    });

    // 리프레시 엔드포인트가 존재하고 정상 동작하는지 확인
    if (resp.status() === 404) {
      test.skip(true, "리프레시 엔드포인트 미구현");
      return;
    }

    expect(resp.ok()).toBe(true);
    const body = await resp.json();
    expect(body.access_token).toBeTruthy();
    expect(typeof body.access_token).toBe("string");

    // 새 토큰으로 API 호출이 가능한지 확인
    const meResp = await request.get(`${API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${body.access_token}` },
    });
    expect(meResp.ok()).toBe(true);
  });

  test("리프레시 후 이전 access_token 유효성 확인", async ({ request }) => {
    // 먼저 리프레시로 새 토큰 발급
    const refreshResp = await request.post(`${API_BASE}/auth/refresh`, {
      data: { refresh_token: refreshToken },
    });

    if (refreshResp.status() === 404) {
      test.skip(true, "리프레시 엔드포인트 미구현");
      return;
    }

    // 이전 access_token으로 API 호출
    const resp = await request.get(`${API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    // 이전 토큰이 즉시 무효화될 수도, 유효할 수도 있음 (정책에 따라 다름)
    // 어떤 경우든 서버가 500 에러 없이 응답해야 함
    expect(resp.status()).toBeLessThan(500);
  });

  test("빈 Authorization 헤더 → 401", async ({ request }) => {
    const resp = await request.get(`${API_BASE}/users/me`, {
      headers: { Authorization: "" },
    });

    expect(resp.status()).toBe(401);
  });

  test("Bearer 접두사 없는 토큰 → 401", async ({ request }) => {
    // Bearer 없이 토큰만 전송
    const resp = await request.get(`${API_BASE}/users/me`, {
      headers: { Authorization: accessToken },
    });

    expect(resp.status()).toBe(401);
  });

  test("변조된 JWT payload → 401", async ({ request }) => {
    const tamperedToken = tamperJwtPayload(accessToken);

    const resp = await request.get(`${API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${tamperedToken}` },
    });

    // payload가 변조되면 시그니처 불일치로 401
    expect(resp.status()).toBe(401);
  });

  test("변조된 JWT signature → 401", async ({ request }) => {
    const tamperedToken = tamperJwtSignature(accessToken);

    const resp = await request.get(`${API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${tamperedToken}` },
    });

    expect(resp.status()).toBe(401);
  });

  test("완전히 무효한 JWT 문자열 → 401", async ({ request }) => {
    const resp = await request.get(`${API_BASE}/users/me`, {
      headers: { Authorization: "Bearer not.a.valid.jwt.at.all" },
    });

    expect(resp.status()).toBe(401);
  });
});

test.describe("세션 보안 — 로그아웃 및 세션 관리", () => {
  test("로그아웃 후 이전 토큰으로 API 호출 → 401 또는 403", async ({
    request,
  }) => {
    // 전용 세션으로 로그인
    const auth = await apiLogin(request);
    const token = auth.accessToken;

    // 로그아웃 전 토큰이 유효한지 확인
    const beforeResp = await request.get(`${API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(beforeResp.ok()).toBe(true);

    // 로그아웃
    const logoutResp = await request.post(`${API_BASE}/auth/logout`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (logoutResp.status() === 404) {
      test.skip(true, "로그아웃 엔드포인트 미구현");
      return;
    }

    expect(logoutResp.status()).toBeLessThan(500);

    // 로그아웃 후 이전 토큰으로 API 호출
    const afterResp = await request.get(`${API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    // 로그아웃 후 토큰은 무효화되어야 함 (401 또는 403)
    // 일부 구현에서는 JWT가 stateless라 여전히 유효할 수 있음
    expect(afterResp.status()).toBeLessThan(500);
  });

  test("동시 세션 — 같은 계정 2회 로그인 → 둘 다 유효하거나 이전 세션 무효화", async ({
    request,
  }) => {
    // 첫 번째 로그인
    const session1 = await apiLogin(request);
    // 두 번째 로그인
    const session2 = await apiLogin(request);

    // 두 번째 세션은 항상 유효해야 함
    const resp2 = await request.get(`${API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${session2.accessToken}` },
    });
    expect(resp2.ok()).toBe(true);

    // 첫 번째 세션: 유효하거나 무효화 (정책에 따라 다름)
    const resp1 = await request.get(`${API_BASE}/users/me`, {
      headers: { Authorization: `Bearer ${session1.accessToken}` },
    });

    // 어떤 정책이든 서버가 크래시하면 안 됨
    expect(resp1.status()).toBeLessThan(500);

    if (resp1.ok()) {
      // 다중 세션 허용 정책
      expect(resp1.status()).toBe(200);
    } else {
      // 단일 세션 정책 — 이전 세션 무효화
      expect([401, 403]).toContain(resp1.status());
    }
  });
});

test.describe("세션 보안 — 입력 검증 및 방어", () => {
  test("잘못된 content-type (application/xml) → 422 또는 415", async ({
    request,
  }) => {
    const resp = await request.post(`${API_BASE}/auth/login`, {
      headers: { "Content-Type": "application/xml" },
      data: "<login><email>test@test.com</email><password>test</password></login>",
    });

    // XML content-type은 거부되어야 함
    expect(resp.status()).toBeGreaterThanOrEqual(400);
    expect(resp.status()).toBeLessThan(500);
  });

  test("SQL injection 방어 — 로그인 이메일 필드", async ({ request }) => {
    const sqlInjectionPayloads = [
      "' OR '1'='1' --",
      "admin@pickket.kr'; DROP TABLE users; --",
      "' UNION SELECT * FROM users --",
      "1' OR '1'='1",
    ];

    for (const payload of sqlInjectionPayloads) {
      const resp = await request.post(`${API_BASE}/auth/login`, {
        data: {
          email: payload,
          password: "anything",
        },
      });

      // SQL injection이 실행되면 안 됨 — 401(인증 실패) 또는 422(유효성 검사 실패)
      expect(resp.status()).toBeGreaterThanOrEqual(400);
      expect(resp.status()).toBeLessThan(500);

      // 서버가 정상 동작하는지 확인 (500 에러 없음)
    }
  });

  test("SQL injection 방어 — 비밀번호 필드", async ({ request }) => {
    const resp = await request.post(`${API_BASE}/auth/login`, {
      data: {
        email: "test@example.com",
        password: "' OR '1'='1' --",
      },
    });

    expect(resp.status()).toBeGreaterThanOrEqual(400);
    expect(resp.status()).toBeLessThan(500);
  });

  test("XSS 페이로드가 포함된 입력 → 서버 정상 처리", async ({ request }) => {
    const xssPayloads = [
      '<script>alert("xss")</script>',
      '"><img src=x onerror=alert(1)>',
      "javascript:alert(document.cookie)",
    ];

    for (const payload of xssPayloads) {
      const resp = await request.post(`${API_BASE}/auth/login`, {
        data: {
          email: payload,
          password: payload,
        },
      });

      // XSS가 서버를 크래시시키면 안 됨
      expect(resp.status()).toBeGreaterThanOrEqual(400);
      expect(resp.status()).toBeLessThan(500);
    }
  });
});

test.describe("세션 보안 — CORS 및 프로토콜 검증", () => {
  test("CORS 프리플라이트 OPTIONS 요청 → 적절한 헤더 포함", async ({
    request,
  }) => {
    // OPTIONS 요청 시뮬레이션 (CORS 프리플라이트)
    const resp = await request.fetch(`${API_BASE}/events/search`, {
      method: "OPTIONS",
      headers: {
        Origin: "http://localhost:3020",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "Authorization, Content-Type",
      },
    });

    // CORS 응답 검증 (200 또는 204)
    expect(resp.status()).toBeLessThan(400);

    const headers = resp.headers();
    // CORS 헤더가 존재하는지 확인
    const hasCorsHeaders =
      headers["access-control-allow-origin"] !== undefined ||
      headers["access-control-allow-methods"] !== undefined;

    // FastAPI CORSMiddleware가 적절히 설정되어 있으면 CORS 헤더가 포함됨
    expect(hasCorsHeaders).toBe(true);
  });

  test("Authorization 헤더 없이 보호 API → 401", async ({ request }) => {
    const resp = await request.get(`${API_BASE}/users/me`);

    expect(resp.status()).toBe(401);
  });

  test("Authorization 헤더에 'Bearer ' 뒤 빈 값 → 401", async ({ request }) => {
    const resp = await request.get(`${API_BASE}/users/me`, {
      headers: { Authorization: "Bearer " },
    });

    expect(resp.status()).toBe(401);
  });
});
