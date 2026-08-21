import type { APIRequestContext, Page } from "@playwright/test";
import { expect } from "@playwright/test";

// 비번은 v2 정책(대문자 1자 이상) 준수 — scripts/provision-v2-test-accounts.ts·seed.ts 와 동일값.
export const demoCredentials = {
  email: "demo@pickket.kr",
  password: "Test1234!",
};

/**
 * 주최자 owner 로그인 (시드 계정, 대부분의 기존 테스트에서 사용)
 */
export async function loginAsDemo(page: Page) {
  await page.goto("/login");
  await page.getByLabel("이메일").fill(demoCredentials.email);
  await page.getByLabel("비밀번호").fill(demoCredentials.password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "대시보드", level: 2 })).toBeVisible();
}

/**
 * API 전용 데모 로그인 (browser 없이 세션 쿠키만).
 * workers=4 동시 시작 시 로그인 버스트 경합으로 간헐 실패할 수 있어 짧게 재시도(마스킹 아님 — 경합 완화).
 */
export async function loginAsDemoApi(request: APIRequestContext) {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await request.post("/api/auth/login", { data: demoCredentials });
    if (response.ok()) return;
    lastStatus = response.status();
    await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
  }
  expect(lastStatus, `로그인 3회 실패 (마지막 status ${lastStatus})`).toBe(200);
}

// ───────────────────────── RBAC 테스트용 확장 ─────────────────────────

export type UserRole = "owner" | "admin" | "organizer" | "staff" | "check_in";

export interface TestUserCredentials {
  email: string;
  password: string;
  role: UserRole;
}

/**
 * 시드된 계정 (기본)
 */
export const seededUsers: Record<string, TestUserCredentials> = {
  ownerDemo: { email: "demo@pickket.kr", password: "Test1234!", role: "owner" },
  ownerAdmin: { email: "admin@pickket.kr", password: "Test1234!", role: "owner" },
  adminOrganizer: { email: "organizer@pickket.kr", password: "Test1234!", role: "admin" },
};

/**
 * 임의 이메일/비번으로 API 로그인 + 성공 여부 반환
 */
export async function loginWithCredentials(
  request: APIRequestContext,
  credentials: { email: string; password: string },
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await request.post("/api/auth/login", {
    data: credentials,
  });
  const body = await response.json().catch(() => null);
  return { ok: response.ok(), status: response.status(), body };
}

/**
 * UI 로그인 (역할 무관, 이메일/비번만)
 */
export async function loginViaUI(
  page: Page,
  credentials: { email: string; password: string },
) {
  await page.goto("/login");
  await page.getByLabel("이메일").fill(credentials.email);
  await page.getByLabel("비밀번호").fill(credentials.password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page).toHaveURL(/\/dashboard$/, { timeout: 15_000 });
}

/**
 * 특정 역할로 시드된 계정 로그인 (owner|admin)
 * organizer/staff/check_in은 시드에 없으므로 RBAC 테스트에서 DB 직접 생성 필요.
 */
export async function loginAsRole(
  request: APIRequestContext,
  role: "owner" | "admin",
): Promise<TestUserCredentials> {
  const target = Object.values(seededUsers).find((u) => u.role === role);
  if (!target) {
    throw new Error(`시드된 ${role} 계정 없음. 테스트에서 DB로 생성 필요.`);
  }
  const response = await request.post("/api/auth/login", {
    data: { email: target.email, password: target.password },
  });
  expect(response.ok()).toBeTruthy();
  return target;
}

/**
 * 로그아웃 (API)
 */
export async function logoutApi(request: APIRequestContext) {
  await request.post("/api/auth/logout").catch(() => {
    // 이미 로그아웃 상태면 무시
  });
}
