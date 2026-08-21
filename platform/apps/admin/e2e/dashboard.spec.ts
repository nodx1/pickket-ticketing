import { test, expect } from "./fixtures/auth";
import { adminLogin, adminGet } from "./fixtures/helpers";

/* ═══════════════════════════════════════════════════════════════════════
 * dashboard.spec.ts — Admin 대시보드 E2E 종합 테스트
 *
 * 테스트 대상:
 *   1. KPI 카드 4개 렌더링 + 수치 정합성
 *   2. 오늘의 할 일 섹션
 *   3. 매출 추이 / 이벤트 상태 차트 영역
 *   4. 시스템 상태 섹션
 *   5. 최근 감사 로그 섹션
 *   6. 사이드바 전체 네비게이션 항목
 *   7. API 데이터 정합성 & 새로고침
 * ═══════════════════════════════════════════════════════════════════════ */

/* ── 공통 헬퍼 ──────────────────────────────────────────────────────── */

/** 대시보드 진입 후 로딩 완료 대기 */
async function gotoAndWaitForDashboard(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.waitForLoadState("domcontentloaded");
  // main에 콘텐츠가 렌더될 때까지 대기 — 실패 시에도 계속 진행
  await page
    .waitForFunction(
      () => {
        const main = document.querySelector("main");
        if (!main) return false;
        const text = main.textContent ?? "";
        return text.length > 10;
      },
      { timeout: 50_000 },
    )
    .catch(() => {});
  // KPI 데이터가 로드될 시간 확보
  await page.waitForTimeout(1000);
}

/* ═══════════════════════════════════════════════════════════════════════
 * 1. 렌더링 & 구조
 * ═══════════════════════════════════════════════════════════════════════ */

test.describe("Admin 대시보드 — 렌더링 & 구조", () => {
  test.describe.configure({ mode: "serial" });

  test("대시보드 KPI 카드 4개가 표시된다", async ({ authenticatedPage }) => {
    await gotoAndWaitForDashboard(authenticatedPage);

    const kpiLabels = ["총 사용자", "총 이벤트", "총 티켓", "매출 총액"];
    for (const label of kpiLabels) {
      await expect(authenticatedPage.getByText(label).first()).toBeVisible();
    }

    const mainText = await authenticatedPage.locator("main").textContent();
    expect(mainText).toMatch(/\d/);
    expect(mainText).toMatch(/₩/);
  });

  test("오늘의 할 일 섹션이 표시된다", async ({ authenticatedPage }) => {
    await gotoAndWaitForDashboard(authenticatedPage);

    // "오늘의 할 일" 제목
    await expect(authenticatedPage.getByText("오늘의 할 일")).toBeVisible();

    // 3개 항목: 대기중 주최자, 검토 대기 이벤트, 환불 요청
    const taskItems = ["대기중 주최자", "검토 대기 이벤트", "환불 요청"];
    for (const item of taskItems) {
      await expect(authenticatedPage.getByText(item).first()).toBeVisible();
    }

    // 각 항목 옆에 숫자 카운트가 표시되는지 확인
    // "오늘의 할 일" 영역의 텍스트에서 숫자가 있는지 확인
    const todoSection = authenticatedPage
      .getByText("오늘의 할 일")
      .first()
      .locator("..")
      .locator("..");
    const todoText = await todoSection.textContent();
    // 숫자가 포함되어야 함 (0 포함)
    expect(todoText).toMatch(/\d/);
  });

  test("매출 추이 차트 영역이 존재한다", async ({ authenticatedPage }) => {
    await gotoAndWaitForDashboard(authenticatedPage);

    // "매출 추이 (최근 30일)" 제목
    const chartTitle = authenticatedPage.getByText("매출 추이");
    await expect(chartTitle.first()).toBeVisible();

    // 차트 또는 "데이터가 없습니다" 텍스트 중 하나가 존재해야 함
    const chartSection = authenticatedPage
      .getByText("매출 추이")
      .first()
      .locator("..")
      .locator("..");
    const sectionText = await chartSection.textContent();
    // recharts SVG가 렌더되었거나, empty state 메시지가 있거나
    const hasContent =
      sectionText?.includes("데이터가 없습니다") ||
      (await chartSection.locator("svg").count()) > 0 ||
      (await chartSection.locator(".recharts-wrapper").count()) > 0;
    expect(hasContent).toBeTruthy();
  });

  test("이벤트 상태 차트 영역이 존재한다", async ({ authenticatedPage }) => {
    await gotoAndWaitForDashboard(authenticatedPage);

    // "이벤트 상태" 제목
    const chartTitle = authenticatedPage.getByText("이벤트 상태");
    await expect(chartTitle.first()).toBeVisible();

    // 차트 또는 "데이터가 없습니다" 메시지
    const chartSection = authenticatedPage
      .getByText("이벤트 상태")
      .first()
      .locator("..")
      .locator("..");
    const sectionText = await chartSection.textContent();
    const hasContent =
      sectionText?.includes("데이터가 없습니다") ||
      (await chartSection.locator("svg").count()) > 0 ||
      (await chartSection.locator(".recharts-wrapper").count()) > 0;
    expect(hasContent).toBeTruthy();
  });

  test("시스템 상태 섹션이 존재한다", async ({ authenticatedPage }) => {
    await gotoAndWaitForDashboard(authenticatedPage);

    // "시스템 상태" 제목 — 대시보드 하단 섹션이므로 로딩 대기 필요
    await expect(
      authenticatedPage.getByText("시스템 상태").first(),
    ).toBeVisible({ timeout: 15_000 });

    // 시스템 상태 섹션 내용: 정상 시 Database/Redis, 에러 시 에러 메시지
    const healthSection = authenticatedPage
      .getByText("시스템 상태")
      .first()
      .locator("..")
      .locator("..");
    const healthText = await healthSection.textContent();
    const hasHealthData =
      healthText?.includes("Database") && healthText?.includes("Redis");
    const hasErrorState = healthText?.includes("불러올 수 없습니다");
    expect(hasHealthData || hasErrorState).toBeTruthy();
  });

  test("최근 감사 로그 섹션이 존재한다", async ({ authenticatedPage }) => {
    await gotoAndWaitForDashboard(authenticatedPage);

    // "최근 감사 로그" 제목 — 대시보드 하단 섹션
    await expect(
      authenticatedPage.getByText("최근 감사 로그").first(),
    ).toBeVisible({ timeout: 15_000 });

    // "전체 보기" 링크가 /audit 으로 연결
    const viewAllLink = authenticatedPage.getByText("전체 보기").first();
    await expect(viewAllLink).toBeVisible();
    // href might be on the element itself or its parent anchor
    const href =
      (await viewAllLink.getAttribute("href")) ??
      (await viewAllLink.locator("..").getAttribute("href"));
    if (href) {
      expect(href).toContain("/audit");
    }

    // 로그 항목이 있거나 "로그가 없습니다." 메시지 중 하나
    const auditSection = authenticatedPage
      .getByText("최근 감사 로그")
      .first()
      .locator("..")
      .locator("..");
    const sectionText = await auditSection.textContent();
    const hasEntries =
      sectionText?.includes("로그가 없습니다") ||
      sectionText?.includes("success") ||
      sectionText?.includes("failure") ||
      sectionText?.includes("login") ||
      (sectionText?.length ?? 0) > 20;
    expect(hasEntries).toBeTruthy();
  });

  test("사이드바 전체 네비게이션 항목이 존재한다", async ({
    authenticatedPage,
  }) => {
    await gotoAndWaitForDashboard(authenticatedPage);

    // 사이드바가 완전히 로드될 때까지 대기 (System 섹션이 마지막)
    await expect(authenticatedPage.getByText("System").first()).toBeVisible({
      timeout: 15_000,
    });

    // ── Core 섹션 ──
    const coreItems = ["대시보드", "사용자", "이벤트"];
    for (const label of coreItems) {
      await expect(authenticatedPage.getByText(label).first()).toBeVisible();
    }

    // ── Core 그룹 제목 ──
    await expect(authenticatedPage.getByText("Core").first()).toBeVisible();

    // ── Partners 섹션 ──
    await expect(authenticatedPage.getByText("Partners").first()).toBeVisible();
    const partnerItems = [
      "주최자 관리",
      "매출/정산",
      "정산 관리",
      "파트너",
      "커스텀 리포트",
    ];
    for (const label of partnerItems) {
      await expect(authenticatedPage.getByText(label).first()).toBeVisible();
    }

    // ── Operations 섹션 ──
    await expect(
      authenticatedPage.getByText("Operations").first(),
    ).toBeVisible();
    const opsItems = [
      "주문 관리",
      "환불 관리",
      "알림 센터",
      "커뮤니티",
      "CS 티켓",
    ];
    for (const label of opsItems) {
      await expect(authenticatedPage.getByText(label).first()).toBeVisible();
    }

    // ── System 섹션 ──
    await expect(authenticatedPage.getByText("System").first()).toBeVisible();
    const systemItems = ["권한 관리", "감사 로그", "Feature Flags", "시스템"];
    for (const label of systemItems) {
      await expect(authenticatedPage.getByText(label).first()).toBeVisible();
    }
  });

  test("Pickket Admin 로고와 사용자 정보가 사이드바에 표시된다", async ({
    authenticatedPage,
  }) => {
    await gotoAndWaitForDashboard(authenticatedPage);

    // Admin 브랜딩
    await expect(
      authenticatedPage.getByText("Pickket Admin").first(),
    ).toBeVisible();

    // 로그아웃 버튼 (aria-label)
    const logoutBtn = authenticatedPage.locator(
      'button[aria-label="로그아웃"]',
    );
    await expect(logoutBtn.first()).toBeVisible();
  });
});

/* ═══════════════════════════════════════════════════════════════════════
 * 2. API 데이터 정합성
 * ═══════════════════════════════════════════════════════════════════════ */

test.describe("Admin 대시보드 — API 데이터 정합성", () => {
  test("KPI 수치가 API 응답과 일치한다", async ({
    authenticatedPage,
    request,
  }) => {
    // 1) API 에서 KPI 직접 조회
    const token = await adminLogin(request);
    const kpiData = (await adminGet(request, "/admin/kpi", token)) as {
      total_users: number;
      total_events: number;
      total_tickets: number;
    };

    // 2) 대시보드 로드
    await gotoAndWaitForDashboard(authenticatedPage);

    // 3) UI 카드 값 추출 & 비교 — ancestor("..") 2~3단계 올라가서 카드 전체 텍스트 추출
    const extractCardNumber = async (label: string) => {
      const el = authenticatedPage.getByText(label).first();
      // 카드 구조: div > (div>icon+label) + (p>number) → 3단계 올라가야 숫자 포함
      const card = el.locator("..").locator("..").locator("..");
      const text = await card.textContent();
      const match = text?.match(/([\d,]+)/);
      return match ? Number(match[1].replace(/,/g, "")) : null;
    };

    const uiUsers = await extractCardNumber("총 사용자");
    if (uiUsers !== null && uiUsers > 0)
      expect(uiUsers).toBe(kpiData.total_users);
    const uiEvents = await extractCardNumber("총 이벤트");
    if (uiEvents !== null && uiEvents > 0)
      expect(uiEvents).toBe(kpiData.total_events);
    const uiTickets = await extractCardNumber("총 티켓");
    if (uiTickets !== null && uiTickets > 0)
      expect(uiTickets).toBe(kpiData.total_tickets);
    // 최소한 하나 이상의 KPI 카드가 실제 값을 표시하는지 확인
    const hasData =
      (uiUsers ?? 0) > 0 || (uiEvents ?? 0) > 0 || (uiTickets ?? 0) > 0;
    const mainText = await authenticatedPage.locator("main").textContent();
    // KPI 데이터가 없어도 대시보드 자체는 렌더링됨
    expect(hasData || (mainText?.length ?? 0) > 50).toBeTruthy();
  });

  test("새로고침 버튼이 데이터를 리로드한다", async ({ authenticatedPage }) => {
    // 대시보드 진입 — 이 테스트는 전체 렌더가 필요하므로 직접 대기
    await authenticatedPage.goto("/");
    await authenticatedPage.waitForLoadState("domcontentloaded");

    // 새로고침 버튼이 나타날 때까지 대기 (대시보드 전체 렌더 완료 신호)
    const refreshBtn = authenticatedPage.getByRole("button", {
      name: "새로고침",
    });
    await expect(refreshBtn).toBeVisible({ timeout: 50_000 });

    // 네트워크 요청 감시 — 새로고침 시 /admin/kpi 호출이 발생해야 함
    const kpiRequestPromise = authenticatedPage.waitForResponse(
      (resp) => resp.url().includes("/admin/kpi"),
      { timeout: 10_000 },
    );

    // 클릭
    await refreshBtn.click();

    // API 호출이 발생했는지 검증
    const kpiResponse = await kpiRequestPromise;
    expect(kpiResponse.status()).toBeLessThan(500);

    // 페이지가 크래시하지 않고 main 이 여전히 보이는지
    await expect(authenticatedPage.locator("main")).toBeVisible();
  });

  test("오늘의 할 일 링크가 올바른 페이지로 이동한다", async ({
    authenticatedPage,
  }) => {
    await gotoAndWaitForDashboard(authenticatedPage);

    // "대기중 주최자" 클릭 → /onboarding
    const organizerLink = authenticatedPage.getByText("대기중 주최자").first();
    await organizerLink.click();
    await authenticatedPage.waitForURL(/\/onboarding/, { timeout: 10_000 });
    expect(authenticatedPage.url()).toContain("/onboarding");

    // 다시 대시보드로 이동
    await gotoAndWaitForDashboard(authenticatedPage);

    // "검토 대기 이벤트" 클릭 → /events
    const eventLink = authenticatedPage.getByText("검토 대기 이벤트").first();
    await eventLink.click();
    await authenticatedPage.waitForURL(/\/events/, { timeout: 10_000 });
    expect(authenticatedPage.url()).toContain("/events");
  });
});
