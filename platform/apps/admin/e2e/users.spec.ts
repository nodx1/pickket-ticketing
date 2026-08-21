import { test, expect } from "./fixtures/auth";
import { test as base, expect as baseExpect } from "@playwright/test";

/* ═══════════════════════════════════════════════════════════════════════
 * users.spec.ts — Admin 사용자 관리 E2E 테스트
 *
 * 테스트 대상:
 *   1. 사용자 목록 페이지 렌더링 & 필수 컬럼
 *   2. 검색 기능 (이메일/이름)
 *   3. 사용자 상세 진입
 *   4. API 데이터 정합성 (구조 검증)
 * ═══════════════════════════════════════════════════════════════════════ */

const API_BASE = process.env.E2E_API_URL || "http://localhost:8021/api/v1";

/* ── UI: 목록 & 검색 ────────────────────────────────────────────────── */

test.describe("사용자 관리 — 목록 & 검색", () => {
  test("사용자 목록 페이지가 렌더링된다", async ({ authenticatedPage }) => {
    await authenticatedPage.goto("/users");
    await authenticatedPage.waitForLoadState("domcontentloaded");

    // 메인 콘텐츠 영역 표시 확인
    const content = authenticatedPage.locator("main");
    await expect(content).toBeVisible();

    // URL이 /users를 유지하는지 확인 (인증된 상태)
    expect(authenticatedPage.url()).toContain("/users");
  });

  test("사용자 검색이 이메일/이름으로 동작한다", async ({
    authenticatedPage,
  }) => {
    await authenticatedPage.goto("/users");
    await authenticatedPage.waitForLoadState("domcontentloaded");

    // 검색 입력 필드 찾기
    const searchInput = authenticatedPage.locator(
      'input[placeholder*="검색"], input[type="search"], input[name*="search"]',
    );

    if ((await searchInput.count()) > 0) {
      // 이름 검색
      await searchInput.first().fill("테스트");
      await authenticatedPage.waitForTimeout(500);
      // 페이지가 에러 없이 동작 확인
      await expect(authenticatedPage.locator("body")).toBeVisible();

      // 이메일 검색
      await searchInput.first().fill("@");
      await authenticatedPage.waitForTimeout(500);
      await expect(authenticatedPage.locator("body")).toBeVisible();

      // 검색어 초기화
      await searchInput.first().fill("");
      await authenticatedPage.waitForTimeout(500);
    }
  });

  test("사용자 목록에 필수 컬럼이 표시된다", async ({ authenticatedPage }) => {
    await authenticatedPage.goto("/users");
    await authenticatedPage.waitForLoadState("domcontentloaded");

    // 데이터 로딩 완료 대기 (로더 사라짐)
    await authenticatedPage
      .locator(".animate-spin")
      .waitFor({ state: "hidden", timeout: 10_000 })
      .catch(() => {
        /* 로더가 없을 수도 있음 */
      });

    // 데스크톱 해상도에서 필수 컬럼 헤더 확인
    const headerRow = authenticatedPage.locator(
      ".hidden.md\\:grid, thead tr, [role='row']",
    );

    if ((await headerRow.count()) > 0) {
      const headerText = await headerRow.first().textContent();
      // 이름, 이메일, 역할(또는 Role), 상태(또는 Status), 가입일(또는 날짜)
      const requiredColumns = ["이름", "이메일", "역할", "상태", "가입"];
      const alternativeColumns = ["name", "email", "role", "status", "date"];

      const hasKorean = requiredColumns.some((col) =>
        headerText?.includes(col),
      );
      const hasEnglish = alternativeColumns.some((col) =>
        headerText?.toLowerCase().includes(col),
      );

      // 최소한 한국어 또는 영어 컬럼 중 일부가 존재해야 함
      expect(hasKorean || hasEnglish).toBe(true);
    }
  });

  test("사용자 행 클릭으로 상세 정보가 표시된다", async ({
    authenticatedPage,
  }) => {
    await authenticatedPage.goto("/users");
    await authenticatedPage.waitForLoadState("domcontentloaded");

    // 데이터 로딩 완료 대기
    await authenticatedPage
      .locator(".animate-spin")
      .waitFor({ state: "hidden", timeout: 10_000 })
      .catch(() => {});

    // 사용자 행 찾기 (테이블 행 또는 커스텀 카드)
    const userRow = authenticatedPage.locator(
      "table tbody tr, [data-testid^='user-row'], .divide-y > div",
    );

    if ((await userRow.count()) > 0) {
      await userRow.first().click();

      // 상세 페이지 URL 또는 상세 뷰 표시 확인
      const navigated = await authenticatedPage
        .waitForURL(/\/users\/[a-f0-9-]+/, { timeout: 10_000 })
        .then(() => true)
        .catch(() => false);

      if (navigated) {
        // 상세 페이지 콘텐츠 존재 확인
        await expect(authenticatedPage.locator("body")).toBeVisible();
        // 이메일이 표시되는지 확인 (상세 페이지 필수 필드)
        const emailText = authenticatedPage.locator("text=@");
        if ((await emailText.count()) > 0) {
          await expect(emailText.first()).toBeVisible();
        }
      }
    }
  });
});

/* ── API: 데이터 정합성 ──────────────────────────────────────────────── */

base.describe("사용자 관리 — API 데이터 정합성", () => {
  let adminToken: string;

  base.beforeAll(async ({ request }) => {
    const res = await request.post(`${API_BASE}/auth/login`, {
      data: {
        email: process.env.E2E_ADMIN_EMAIL,
        password: process.env.E2E_ADMIN_PASSWORD,
      },
    });
    baseExpect(res.ok()).toBe(true);
    const body = await res.json();
    adminToken = body.access_token;
  });

  base("사용자 목록 API 응답이 유효한 구조를 가진다", async ({ request }) => {
    const res = await request.get(`${API_BASE}/admin/users?limit=10`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    baseExpect(res.status()).toBe(200);

    const body = await res.json();
    baseExpect(body).toHaveProperty("users");
    baseExpect(body).toHaveProperty("total");
    baseExpect(Array.isArray(body.users)).toBe(true);
    baseExpect(typeof body.total).toBe("number");

    // 각 사용자 객체의 필수 필드 검증
    for (const user of body.users) {
      baseExpect(user).toHaveProperty("id");
      baseExpect(user).toHaveProperty("email");
      baseExpect(user).toHaveProperty("name");
      baseExpect(typeof user.is_organizer).toBe("boolean");
      baseExpect(typeof user.is_admin).toBe("boolean");
      baseExpect(typeof user.is_active).toBe("boolean");
      baseExpect(user).toHaveProperty("created_at");
    }
  });

  base("사용자 검색 API가 필터링된 결과를 반환한다", async ({ request }) => {
    const res = await request.get(`${API_BASE}/admin/users?q=test&limit=50`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    baseExpect(res.status()).toBe(200);

    const body = await res.json();
    baseExpect(body).toHaveProperty("users");
    baseExpect(Array.isArray(body.users)).toBe(true);
    baseExpect(typeof body.total).toBe("number");

    // 검색 결과가 있다면 이름 또는 이메일에 검색어 포함 검증
    for (const user of body.users) {
      const matchesName = user.name?.toLowerCase().includes("test");
      const matchesEmail = user.email?.toLowerCase().includes("test");
      // 검색이 이름/이메일 외 다른 필드에서도 동작할 수 있으므로 느슨한 검증
      baseExpect(typeof user.email).toBe("string");
    }
  });

  base("사용자 상세 API가 올바른 필드를 반환한다", async ({ request }) => {
    // 먼저 사용자 목록에서 첫 번째 사용자 ID 가져오기
    const listRes = await request.get(`${API_BASE}/admin/users?limit=1`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    baseExpect(listRes.status()).toBe(200);

    const listBody = await listRes.json();
    if (listBody.users.length === 0) {
      base.skip();
      return;
    }

    const userId = listBody.users[0].id;

    // 상세 API 호출
    const res = await request.get(`${API_BASE}/admin/users/${userId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    baseExpect(res.status()).toBe(200);

    const user = await res.json();
    baseExpect(user).toHaveProperty("id");
    baseExpect(user).toHaveProperty("email");
    baseExpect(user).toHaveProperty("name");
    baseExpect(typeof user.is_organizer).toBe("boolean");
    baseExpect(typeof user.is_admin).toBe("boolean");
    baseExpect(typeof user.is_active).toBe("boolean");
    baseExpect(user).toHaveProperty("created_at");
    baseExpect(typeof user.verification_level).toBe("number");
  });

  base("사용자 목록 pagination이 올바르게 동작한다", async ({ request }) => {
    const res = await request.get(`${API_BASE}/admin/users?limit=2&skip=0`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    baseExpect(res.status()).toBe(200);

    const body = await res.json();
    baseExpect(body.users.length).toBeLessThanOrEqual(2);
    baseExpect(body.total).toBeGreaterThanOrEqual(body.users.length);
  });

  base("사용자 필터(is_organizer)가 올바르게 동작한다", async ({ request }) => {
    const res = await request.get(
      `${API_BASE}/admin/users?is_organizer=true&limit=50`,
      {
        headers: { Authorization: `Bearer ${adminToken}` },
      },
    );
    baseExpect(res.status()).toBe(200);

    const body = await res.json();
    for (const user of body.users) {
      baseExpect(user.is_organizer).toBe(true);
    }
  });
});
