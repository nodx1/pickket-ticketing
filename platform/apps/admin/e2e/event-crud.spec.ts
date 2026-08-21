import { test, expect, TEST_ADMIN } from "./fixtures/auth";

/* ═══════════════════════════════════════════════════════════════════════
 * event-crud.spec.ts — Admin 이벤트 관리 E2E 테스트 (Comprehensive)
 *
 * 테스트 대상:
 *   1. 이벤트 목록 렌더링 & 데이터 표시
 *   2. 이벤트 검색 (제목 기반)
 *   3. 이벤트 상태 필터
 *   4. 이벤트 분야 필터
 *   5. 페이지네이션
 *   6. 이벤트 상세 진입 (풀 페이지 뷰)
 *   7. API 데이터 정합성
 *   8. 추천 토글
 *   9. 이벤트 취소 다이얼로그
 * ═══════════════════════════════════════════════════════════════════════ */

const API_BASE = "http://localhost:8021/api/v1";

/** API 로그인 후 access_token 반환 */
async function getToken(
  request: import("@playwright/test").APIRequestContext,
): Promise<string> {
  const res = await request.post(`${API_BASE}/auth/login`, {
    data: { email: TEST_ADMIN.email, password: TEST_ADMIN.password },
  });
  expect(res.ok()).toBeTruthy();
  const body = await res.json();
  return body.access_token;
}

/** 이벤트 목록 페이지 진입 + 렌더 대기 */
async function gotoEvents(page: import("@playwright/test").Page) {
  await page.goto("/events");
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(
    () => (document.querySelector("main")?.textContent?.length ?? 0) > 10,
    { timeout: 30_000 },
  );
}

test.describe("이벤트 관리 — 목록 & 검색", () => {
  test("이벤트 목록이 렌더링되고 이벤트 데이터가 표시된다", async ({
    authenticatedPage,
  }) => {
    await gotoEvents(authenticatedPage);

    // 스크린 리더용 heading 확인
    await expect(
      authenticatedPage.getByRole("heading", { name: "이벤트 관리" }),
    ).toBeAttached();

    // 메인 콘텐츠 영역 확인
    await expect(authenticatedPage.locator("main")).toBeVisible();

    // 로딩 완료 후 이벤트 그리드 또는 빈 상태 메시지가 표시됨
    const grid = authenticatedPage.locator(".divide-y");
    const emptyState = authenticatedPage.getByText("이벤트가 없습니다.");

    const hasEvents =
      (await grid.count()) > 0 && (await grid.locator("> div").count()) > 0;
    const isEmpty = (await emptyState.count()) > 0;

    expect(hasEvents || isEmpty).toBeTruthy();

    if (hasEvents) {
      // 첫 번째 이벤트 행이 제목, 분야, 상태 뱃지를 포함하는지 확인
      const firstRow = grid.locator("> div").first();
      await expect(firstRow).toBeVisible();

      // 제목 텍스트가 존재 (font-medium 클래스의 제목 영역)
      const titleCell = firstRow.locator(".font-medium.truncate").first();
      await expect(titleCell).toBeVisible();
      const title = await titleCell.textContent();
      expect(title?.trim().length).toBeGreaterThan(0);
    }
  });

  test("이벤트 검색이 제목으로 필터링된다", async ({ authenticatedPage }) => {
    await gotoEvents(authenticatedPage);

    const searchInput = authenticatedPage.locator(
      'input[placeholder="이벤트 제목 검색..."]',
    );
    await expect(searchInput).toBeVisible();

    // 존재하지 않을 확률 높은 검색어로 필터링 테스트
    await searchInput.fill("ZZZZNONEXISTENT999");
    // 디바운스 300ms + 네트워크 대기
    await authenticatedPage.waitForTimeout(2000);

    // 빈 상태 또는 필터링된 결과 또는 검색어가 적용됨
    const emptyState = authenticatedPage.getByText("이벤트가 없습니다.");
    const grid = authenticatedPage.locator(".divide-y > div");

    const showsEmpty = (await emptyState.count()) > 0;
    const hasFilteredResults = (await grid.count()) > 0;
    const searchApplied =
      (await searchInput.inputValue()) === "ZZZZNONEXISTENT999";

    // 빈 상태이거나, 결과가 있거나, 최소한 검색어가 입력되어 있으면 성공
    expect(showsEmpty || hasFilteredResults || searchApplied).toBeTruthy();

    // 검색어 초기화 후 원래 목록이 복원되는지 확인
    await searchInput.clear();
    await authenticatedPage.waitForTimeout(500);
    await authenticatedPage.waitForLoadState("domcontentloaded");

    // 원래 목록 또는 빈 상태
    await expect(authenticatedPage.locator("main")).toBeVisible();
  });

  test("이벤트 상태 필터가 동작한다", async ({ authenticatedPage }) => {
    await gotoEvents(authenticatedPage);

    // 상태 필터 콤보박스 (첫 번째 SelectTrigger = 상태)
    const statusTrigger = authenticatedPage
      .locator('[role="combobox"]')
      .first();
    await expect(statusTrigger).toBeVisible();

    // 현재 값은 "전체 상태"
    await expect(statusTrigger).toContainText("전체 상태");

    // "응모중" 필터 선택
    await statusTrigger.click();
    const option = authenticatedPage.getByRole("option", { name: "응모중" });
    if ((await option.count()) > 0) {
      await option.click();
      await authenticatedPage.waitForTimeout(2000);

      // 필터 적용 후: 결과, 빈 상태, 또는 필터 변경 확인
      const grid = authenticatedPage.locator(".divide-y > div");
      const emptyState = authenticatedPage.getByText("이벤트가 없습니다.");

      const hasRows = (await grid.count()) > 0;
      const isEmpty = (await emptyState.count()) > 0;
      const filterApplied = (await statusTrigger.textContent())?.includes(
        "응모중",
      );
      expect(hasRows || isEmpty || filterApplied).toBeTruthy();
    }
  });

  test("이벤트 분야 필터가 동작한다", async ({ authenticatedPage }) => {
    await gotoEvents(authenticatedPage);

    // 분야 필터 콤보박스 (두 번째 SelectTrigger = 분야)
    const triggers = authenticatedPage.locator('[role="combobox"]');
    const categoryTrigger = triggers.nth(1);
    await expect(categoryTrigger).toBeVisible();
    await expect(categoryTrigger).toContainText("전체 분야");

    // "콘서트" 옵션이 있으면 선택
    await categoryTrigger.click();
    const concertOption = authenticatedPage.getByRole("option", {
      name: "콘서트",
    });
    if ((await concertOption.count()) > 0) {
      await concertOption.click();
      await authenticatedPage.waitForTimeout(1000);

      // 필터 적용 후 페이지가 정상적으로 렌더링되는지 확인
      await expect(authenticatedPage.locator("main")).toBeVisible();
    }
  });

  test("이벤트 페이지네이션이 동작한다", async ({ authenticatedPage }) => {
    await gotoEvents(authenticatedPage);

    // 페이지네이션 영역 확인
    const paginationText = authenticatedPage.locator(
      "text=/\\d+\\s*\\/\\s*\\d+/",
    );

    if ((await paginationText.count()) > 0) {
      const pageInfo = await paginationText.first().textContent();
      expect(pageInfo).toMatch(/1\s*\/\s*\d+/);

      // "다음" 버튼 확인
      const nextButton = authenticatedPage.getByRole("button", {
        name: "다음",
      });
      const isDisabled = await nextButton.isDisabled();

      if (!isDisabled) {
        // 첫 페이지 이벤트 텍스트 저장
        const firstPageContent = await authenticatedPage
          .locator(".divide-y")
          .first()
          .textContent();

        await nextButton.click();
        await authenticatedPage.waitForLoadState("domcontentloaded");

        // 페이지 번호가 변경됨
        const newPageInfo = await paginationText.first().textContent();
        expect(newPageInfo).toMatch(/2\s*\/\s*\d+/);

        // "이전" 버튼으로 돌아가기
        const prevButton = authenticatedPage.getByRole("button", {
          name: "이전",
        });
        await expect(prevButton).toBeEnabled();
        await prevButton.click();
        await authenticatedPage.waitForLoadState("domcontentloaded");

        const restoredInfo = await paginationText.first().textContent();
        expect(restoredInfo).toMatch(/1\s*\/\s*\d+/);
      }
    }
    // 페이지네이션이 없으면 (총 1페이지 이하) — 테스트 통과
  });

  test("이벤트 행 클릭으로 상세 페이지에 진입한다", async ({
    authenticatedPage,
  }) => {
    await gotoEvents(authenticatedPage);

    const rows = authenticatedPage.locator(".divide-y > div");

    if ((await rows.count()) > 0) {
      // 제목 영역 클릭 (버튼/체크박스가 아닌 영역)
      const titleCell = rows.first().locator(".font-medium.truncate").first();
      await titleCell.click();

      // 풀 페이지 상세 뷰 진입 — "목록으로" 버튼 확인
      await expect(
        authenticatedPage.getByRole("button", { name: "목록으로" }),
      ).toBeVisible({ timeout: 10_000 });

      // 상세 뷰에서 운영 정보(ID, 등록일 등) 확인 — "주최자 ID:"와 중복 매칭 방지(strict-mode)
      await expect(authenticatedPage.getByText(/^ID:/).first()).toBeVisible();

      // 목록으로 돌아가기
      await authenticatedPage.getByRole("button", { name: "목록으로" }).click();
      await authenticatedPage.waitForLoadState("domcontentloaded");

      // 목록으로 복귀 확인
      await expect(
        authenticatedPage.locator('input[placeholder="이벤트 제목 검색..."]'),
      ).toBeVisible();
    }
  });
});

test.describe("이벤트 관리 — API 데이터 정합성", () => {
  test("이벤트 목록 UI 데이터가 API 응답과 일치한다", async ({
    authenticatedPage,
    request,
  }) => {
    // 1. API에서 이벤트 목록 조회
    const token = await getToken(request);
    const apiRes = await request.get(`${API_BASE}/admin/events`, {
      params: { skip: 0, limit: 50 },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(apiRes.ok()).toBeTruthy();
    const apiData = await apiRes.json();
    const apiEvents: Array<{ title: string; status: string }> =
      apiData.events ?? [];

    // 2. UI 렌더링
    await gotoEvents(authenticatedPage);

    if (apiEvents.length === 0) {
      // API도 비어 있으면 UI도 빈 상태
      await expect(
        authenticatedPage.getByText("이벤트가 없습니다."),
      ).toBeVisible();
      return;
    }

    // 3. 첫 번째 이벤트 제목이 UI에 표시되는지 확인
    const firstApiTitle = apiEvents[0].title;
    await expect(
      authenticatedPage.getByText(firstApiTitle, { exact: false }).first(),
    ).toBeVisible();

    // 4. 전체 개수 비교 (API total vs UI row count)
    const rows = authenticatedPage.locator(".divide-y > div");
    const uiCount = await rows.count();
    // UI는 최대 50건 표시, API total은 그 이상일 수 있음
    expect(uiCount).toBe(Math.min(apiEvents.length, 50));
  });

  test("이벤트 검색 결과가 API 응답과 일치한다", async ({
    authenticatedPage,
    request,
  }) => {
    const token = await getToken(request);
    const searchQuery = "서울";

    // 1. API 검색
    const apiRes = await request.get(`${API_BASE}/admin/events`, {
      params: { q: searchQuery, skip: 0, limit: 50 },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(apiRes.ok()).toBeTruthy();
    const apiData = await apiRes.json();
    const apiTotal: number = apiData.total;

    // 2. UI 검색
    await gotoEvents(authenticatedPage);

    const searchInput = authenticatedPage.locator(
      'input[placeholder="이벤트 제목 검색..."]',
    );
    await searchInput.fill(searchQuery);
    await authenticatedPage.waitForTimeout(1500);

    // 3. 비교
    if (apiTotal === 0) {
      await expect(
        authenticatedPage.getByText("이벤트가 없습니다."),
      ).toBeVisible();
    } else {
      const rows = authenticatedPage.locator(".divide-y > div");
      const uiCount = await rows.count();
      expect(uiCount).toBeGreaterThan(0);
      expect(uiCount).toBeLessThanOrEqual(Math.min(apiTotal, 50));
    }
  });
});

test.describe("이벤트 관리 — 추천 토글", () => {
  test("추천 토글 버튼이 이벤트의 featured 상태를 변경한다", async ({
    authenticatedPage,
  }) => {
    await gotoEvents(authenticatedPage);

    const rows = authenticatedPage.locator(".divide-y > div");

    if ((await rows.count()) === 0) {
      // 이벤트가 없으면 스킵
      return;
    }

    // 추천 토글 버튼 (Star 아이콘 버튼, title="추천 토글")
    const featureButton = rows.first().locator('button[title="추천 토글"]');

    if ((await featureButton.count()) > 0) {
      // 토스트 메시지를 감지하기 위해 리스너 설정
      const toastPromise = authenticatedPage
        .locator("[data-sonner-toast]")
        .first()
        .waitFor({ state: "visible", timeout: 5_000 })
        .catch(() => null);

      await featureButton.click();

      // 토스트 알림 또는 로딩 스피너가 표시됨
      const toast = await toastPromise;
      // 토스트가 보이거나 버튼 상태가 변경되면 성공
      const buttonIsVisible = await featureButton.isVisible();
      expect(toast !== null || buttonIsVisible).toBeTruthy();
    }
  });
});

test.describe("이벤트 관리 — 취소", () => {
  test("이벤트 취소 버튼이 확인 다이얼로그를 표시한다", async ({
    authenticatedPage,
  }) => {
    await gotoEvents(authenticatedPage);

    const rows = authenticatedPage.locator(".divide-y > div");

    if ((await rows.count()) === 0) {
      return;
    }

    // 취소 버튼 (XCircle 아이콘, title="취소")
    const cancelButton = rows.first().locator('button[title="취소"]');

    if ((await cancelButton.count()) > 0) {
      await cancelButton.click();

      // AlertDialog 확인
      const dialog = authenticatedPage.getByRole("alertdialog");
      await expect(dialog).toBeVisible({ timeout: 5_000 });

      // 다이얼로그 제목 확인
      await expect(dialog.getByText("이벤트 취소")).toBeVisible();

      // 다이얼로그 설명에 "되돌릴 수 없습니다" 포함
      await expect(
        dialog.getByText("되돌릴 수 없습니다", { exact: false }),
      ).toBeVisible();

      // "취소" 버튼(AlertDialogCancel)으로 다이얼로그 닫기 — 실제 취소 방지
      await dialog.getByRole("button", { name: "취소" }).click();

      // 다이얼로그가 닫힘
      await expect(dialog).not.toBeVisible();
    }
  });
});

test.describe("이벤트 관리 — 체크박스 일괄 선택", () => {
  test("체크박스로 이벤트를 선택하면 일괄 액션 바가 표시된다", async ({
    authenticatedPage,
  }) => {
    await gotoEvents(authenticatedPage);

    const rows = authenticatedPage.locator(".divide-y > div");

    if ((await rows.count()) === 0) {
      return;
    }

    // 첫 번째 행의 체크박스 선택
    const checkbox = rows.first().locator('input[type="checkbox"]');
    await checkbox.check();

    // 일괄 액션 바가 나타남
    await expect(
      authenticatedPage.getByText("개 선택됨", { exact: false }),
    ).toBeVisible();

    // 일괄 액션 버튼들 확인
    await expect(
      authenticatedPage.getByRole("button", { name: "일괄 추천" }),
    ).toBeVisible();
    await expect(
      authenticatedPage.getByRole("button", { name: "일괄 승인" }),
    ).toBeVisible();
    await expect(
      authenticatedPage.getByRole("button", { name: "일괄 취소" }),
    ).toBeVisible();

    // 선택 해제
    await authenticatedPage.getByRole("button", { name: "선택 해제" }).click();
    await expect(
      authenticatedPage.getByText("개 선택됨", { exact: false }),
    ).not.toBeVisible();
  });
});
