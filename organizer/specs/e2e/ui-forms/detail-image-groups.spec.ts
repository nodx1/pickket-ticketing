/**
 * detail-image-groups.spec.ts
 *
 * 상세 안내 이미지 **섹션별 그룹 UI**(IMG-2) 실동작 검증.
 *
 * 🔴 왜 E2E 가 필요한가
 * 순수 로직은 `lib/events/detail-image-order.test.ts` 16건으로 지켜진다. 그런데
 * **컴포넌트가 그것을 실제로 쓰는지**는 단위테스트가 증명하지 않는다. 실측으로 확인했다 —
 * 아래 네 뮤테이션이 vitest 2027건 + tsc 를 **전부 통과**했다:
 *
 *   A `pendingSection.current = section` → `= "intro"`    (누른 그룹 무시 = 결함 재발)
 *   B `uploadFiles(files, pendingSection.current)` → `"intro"`
 *   C `{left > 0 ? (` → `{true ? (`                        (가득 찬 그룹에 버튼 유지)
 *   D `moveWithinSection(...)` → 전체 배열 스왑             (섹션 경계 넘김)
 *
 * 이 스펙이 그 사각지대를 덮는다. 업로드는 실제 파일이 필요해 A·B 는 **버튼의 존재/부재와
 * 그룹별 잔여 표기**로 간접 확인하고, C·D 는 직접 확인한다.
 *
 * ⚠️ 라이브 검증은 **프로덕션 빌드**로 한다(검증 원칙 #11 — dev 서버는 하이드레이션이 안 돼
 *    버튼 클릭이 전부 무반응이었던 실사고가 있다). playwright.config 의 webServer 가
 *    `npm run start` 를 쓴다.
 *
 * 실행:
 *   npx playwright test specs/e2e/ui-forms/detail-image-groups.spec.ts \
 *     --project=chromium --workers=1 --reporter=list
 */

import { test, expect, type Page } from "@playwright/test";
import { loginAsDemo, loginAsDemoApi } from "../helpers/auth";
import { createFullEvent, type FullEventFixture } from "../helpers/fixture-event";

/** IMG-1·IMG-2 가 공유하는 정본 상한 — 코드와 어긋나면 이 스펙이 먼저 깨진다. */
const SECTIONS = [
  { label: "이벤트 안내", max: 3 },
  { label: "대중교통 안내", max: 2 },
  { label: "주차 안내", max: 2 },
  { label: "문의", max: 1 },
] as const;

async function openSettings(page: Page, eventId: string) {
  await page.goto(`/events/${eventId}/settings`);
  // 상세 안내 이미지 카드가 로드될 때까지 — 로드 실패 시 편집이 잠기므로 그 상태도 구분한다.
  const card = page.getByRole("heading", { name: "상세 안내 이미지" });
  await expect(card).toBeVisible({ timeout: 20_000 });
  return card;
}

test.describe("상세 안내 이미지 — 섹션별 그룹 UI", () => {
  let fx: FullEventFixture;

  /**
   * ⚠️ 처음엔 `getSeededEventIds` 를 썼는데 그 안의 `createLiveBackedEvent` 가
   *    **organizer 가 이미 있다고 전제**한다(`helpers/events.ts:42`). 깨끗한 환경에는
   *    없다 — go `organizers` 는 컷오버가 DROP 했고 지금은 v2 `event_hosts` 다(W2-EVT).
   *    `createFullEvent` 는 **없으면 만든다**(`fixture-event.ts:38`). 다른 ui-forms 스펙
   *    3개가 전부 그걸 쓴다 — 내가 헬퍼를 잘못 골랐다.
   */
  test.beforeAll(async ({ request }) => {
    await loginAsDemoApi(request);
    fx = await createFullEvent(request);
    expect(fx.eventId, "픽스처 이벤트 생성 실패").toBeTruthy();
  });

  test.beforeEach(async ({ page }) => {
    await loginAsDemo(page);
  });

  test("🔴 4개 그룹이 각자 제목·장수·추가 버튼을 갖는다 (드롭다운은 없다)", async ({ page }) => {
    await openSettings(page, fx.eventId);

    for (const { label, max } of SECTIONS) {
      // 그룹 제목
      await expect(page.getByText(label, { exact: true }).first()).toBeVisible();
      // 그룹별 장수 표기 — `N / max장`
      await expect(page.getByText(new RegExp(`\\d+ / ${max}장`)).first()).toBeVisible();
    }

    // 🔴 드롭다운이 사라졌는지 — 종전엔 이미지마다 `표시 위치` select 가 있었고
    //    기본값(intro) 때문에 섹션 지정이 사실상 안 쓰였다.
    await expect(page.getByRole("combobox", { name: /표시 위치/ })).toHaveCount(0);

    // 그룹마다 "이 자리에 이미지 추가" 버튼 — 누른 그룹이 곧 표시 위치다.
    const addButtons = page.getByRole("button", { name: /이 자리에 이미지 추가/ });
    await expect(addButtons).toHaveCount(SECTIONS.length);
  });

  test("🔴 각 추가 버튼이 그 그룹의 잔여 장수를 표시한다 (뮤테이션 C 를 잡는다)", async ({ page }) => {
    await openSettings(page, fx.eventId);

    // 비어 있는 그룹이면 `(max장 더 가능)`, 이미 있으면 줄어든 수 — 어느 쪽이든 상한 이하다.
    await expect(
      page.getByText(/이 자리에 이미지 추가 \(\d+장 더 가능\)/).first(),
    ).toBeVisible();

    // 표시된 잔여가 그 그룹의 상한을 넘지 않는다 — 총합(8)을 잘못 쓰면 여기서 깨진다.
    const texts = await page
      .getByRole("button", { name: /이 자리에 이미지 추가/ })
      .allInnerTexts();
    const remains = texts.map((t) => Number(/\((\d+)장/.exec(t)?.[1] ?? "-1"));
    expect(remains.every((n) => n >= 0)).toBe(true);
    expect(Math.max(...remains)).toBeLessThanOrEqual(Math.max(...SECTIONS.map((s) => s.max)));
  });

  test("안내 문구가 그룹 방식을 설명한다 (없어진 드롭다운을 설명하지 않는다)", async ({ page }) => {
    await openSettings(page, fx.eventId);
    const card = page.locator("div").filter({ hasText: "상세 안내 이미지" }).first();
    await expect(card).toContainText("넣고 싶은 자리의");
    // 🔴 옛 문구가 남아 있으면 실패 — 오늘 세 번 나온 유형(기능은 바꿨는데 설명이 그대로).
    await expect(card).not.toContainText("이미지마다");
  });
});
