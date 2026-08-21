/**
 * RBAC (Role-Based Access Control) 매트릭스 테스트
 *
 * 역할 계층 (src/lib/auth/permissions.ts):
 *   owner(5) > admin(4) > organizer(3) > staff(2) > check_in(1)
 *
 * 시드 계정:
 *   - demo@pickket.kr       (owner)
 *   - admin@pickket.kr      (owner)
 *   - organizer@pickket.kr  (admin)  ← 이름은 organizer지만 role은 admin
 *
 * 커버리지:
 *   - 비인증 → 모든 관리자 API 401
 *   - owner(demo) → 전체 접근 가능
 *   - admin(organizer@) → 대부분 가능, owner 전용(members 관리 등) 구분
 *   - withRole 위계 정상 동작 확인
 *   - organizer/staff/check_in 역할은 초대-가입 플로우가 복잡해서 별도 테스트로 미룸
 */
import { test, expect, type APIRequestContext } from "@playwright/test";
import { seededUsers, loginWithCredentials } from "../helpers/auth";

type EndpointRule = {
  name: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  /** 필요 역할 — withRole()에 명시된 값 */
  requiredRole: "owner" | "admin" | "organizer" | "staff" | "check_in";
};

/**
 * 대표 엔드포인트 매트릭스.
 * 각 행의 requiredRole에 따라 owner/admin이 접근 가능한지 자동 판정.
 */
const ENDPOINTS: EndpointRule[] = [
  // owner 전용
  {
    name: "audit logs",
    method: "GET",
    path: "/api/admin/audit-logs",
    requiredRole: "owner",
  },
  // admin 이상
  { name: "members 목록", method: "GET", path: "/api/account/members", requiredRole: "admin" },
  { name: "정산 목록", method: "GET", path: "/api/account/settlements", requiredRole: "admin" },
  // organizer 이상
  { name: "이벤트 목록", method: "GET", path: "/api/events", requiredRole: "organizer" },
  { name: "organizers", method: "GET", path: "/api/organizers", requiredRole: "organizer" },
  { name: "notifications", method: "GET", path: "/api/notifications", requiredRole: "organizer" },
];

const ROLE_LEVEL: Record<string, number> = {
  owner: 5,
  admin: 4,
  organizer: 3,
  staff: 2,
  check_in: 1,
};

function canAccess(userRole: string, requiredRole: string): boolean {
  return (ROLE_LEVEL[userRole] ?? 0) >= (ROLE_LEVEL[requiredRole] ?? 0);
}

test.describe("RBAC 매트릭스 — 역할별 접근 권한", () => {
  test.describe("0. 비인증", () => {
    let guest: APIRequestContext;
    test.beforeAll(async ({ playwright }) => {
      guest = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
    });
    test.afterAll(async () => {
      await guest.dispose();
    });

    for (const ep of ENDPOINTS) {
      test(`비인증 → ${ep.method} ${ep.path} → 401`, async () => {
        const res = await guest.fetch(ep.path, { method: ep.method });
        expect(res.status()).toBe(401);
      });
    }
  });

  test.describe("1. owner 권한 (demo@pickket.kr)", () => {
    let authed: APIRequestContext;
    test.beforeAll(async ({ playwright }) => {
      authed = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
      const result = await loginWithCredentials(authed, {
        email: seededUsers.ownerDemo.email,
        password: seededUsers.ownerDemo.password,
      });
      expect(result.ok).toBeTruthy();
    });
    test.afterAll(async () => {
      await authed.dispose();
    });

    for (const ep of ENDPOINTS) {
      test(`owner → ${ep.method} ${ep.path} → 접근 가능`, async () => {
        const res = await authed.fetch(ep.path, { method: ep.method });
        // owner는 모든 엔드포인트 접근 가능 (200 또는 data 포함)
        expect([200, 204]).toContain(res.status());
      });
    }
  });

  test.describe("2. admin 권한 (organizer@pickket.kr — role:admin)", () => {
    let authed: APIRequestContext;
    test.beforeAll(async ({ playwright }) => {
      authed = await playwright.request.newContext({ baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011" });
      const result = await loginWithCredentials(authed, {
        email: seededUsers.adminOrganizer.email,
        password: seededUsers.adminOrganizer.password,
      });
      expect(result.ok).toBeTruthy();
    });
    test.afterAll(async () => {
      await authed.dispose();
    });

    for (const ep of ENDPOINTS) {
      const allowed = canAccess("admin", ep.requiredRole);
      test(`admin → ${ep.method} ${ep.path} → ${allowed ? "접근 가능" : "403"}`, async () => {
        const res = await authed.fetch(ep.path, { method: ep.method });
        if (allowed) {
          expect([200, 204]).toContain(res.status());
        } else {
          expect(res.status()).toBe(403);
        }
      });
    }
  });

  test.describe("3. 세션 탈취 방지", () => {
    test("쿠키 조작 → 401", async ({ playwright }) => {
      const ctx = await playwright.request.newContext({
        baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011",
        extraHTTPHeaders: {
          Cookie: "pickket_session=invalid_token_value",
        },
      });
      const res = await ctx.get("/api/events");
      expect(res.status()).toBe(401);
      await ctx.dispose();
    });

    test("만료된 세션 쿠키 → 401", async ({ playwright }) => {
      const ctx = await playwright.request.newContext({
        baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3011",
        extraHTTPHeaders: {
          Cookie: "pickket_session=eyJfbGVnYWN5X2V4cGlyZWRfdG9rZW5fIn0=",
        },
      });
      const res = await ctx.get("/api/account/members");
      expect(res.status()).toBe(401);
      await ctx.dispose();
    });
  });
});
