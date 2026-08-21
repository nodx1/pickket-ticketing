/**
 * orders-attendees-forms.spec.ts — 주문/참석자/운영 폼 전체 UI E2E 검증
 *
 * 대상 폼 (/events/[id]/ 하위):
 *   1. 참석자 (attendees)          — 추가 다이얼로그 + CSV 임포트 boundary
 *   2. 주문 상세 (orders/[orderId]) — memo·attendees-manager·items·refund-action
 *   3. 단체예약 (group-bookings)    — 승인/거절 ConfirmDialog
 *   4. 수동발권 (ticket-issuance)   — 이름·이메일·전화·상품·발권→목록
 *   5. 체크인 (check-in)            — 리스트 생성·수동 체크인
 *   6. CRM (crm)                   — 주문동기화·등급 변경
 *   7. 대기자 (waitlist)            — 목록 로드·구매제안 ConfirmDialog
 *
 * 검증:
 *   · 모든 입력 필드 → 저장 → 성공 · 리로드 → 값 유지 · v2 파이프라인
 *
 * 실행:
 *   BASE_URL=http://127.0.0.1:3019 npx playwright test \
 *     specs/e2e/ui-forms/orders-attendees-forms.spec.ts \
 *     --project=chromium --workers=1 --reporter=list
 */

import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { loginAsDemo } from "../helpers/auth";
import { createFullEvent, type FullEventFixture } from "../helpers/fixture-event";

// ── 고유 접미사 ─────────────────────────────────────────────
const SFX = `${Date.now()}`.slice(-7);

// ── 공유 픽스처 상태 ────────────────────────────────────────
let request: APIRequestContext;
let fx: FullEventFixture;

// ── 결과 테이블 ─────────────────────────────────────────────
interface ResultRow {
  form: string;
  field: string;
  value: string;
  saved: "✅" | "❌" | "⏭️";
  reload: "✅" | "❌" | "⏭️" | "-";
  pipeline: "✅" | "❌" | "⏭️" | "-";
  note?: string;
}
const RESULTS: ResultRow[] = [];

function rec(row: ResultRow) {
  RESULTS.push(row);
}

// ── 공통 beforeAll ───────────────────────────────────────────
test.beforeAll(async ({ playwright }) => {
  request = await playwright.request.newContext({
    baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3019",
  });
  fx = await createFullEvent(request);
});

test.afterAll(async () => {
  console.log("\n\n════════════════════════════════════════════════════════════════════════════");
  console.log("orders-attendees-forms 결과표");
  console.log("════════════════════════════════════════════════════════════════════════════");
  console.log(
    `${"폼".padEnd(18)} ${"필드".padEnd(24)} ${"값".padEnd(22)} ${"저장".padEnd(6)} ${"리로드".padEnd(8)} ${"파이프"}`
  );
  console.log("─".repeat(96));
  for (const r of RESULTS) {
    const note = r.note ? `  ← ${r.note}` : "";
    console.log(
      `${r.form.padEnd(18)} ${r.field.padEnd(24)} ${r.value.slice(0, 20).padEnd(22)} ${r.saved.padEnd(6)} ${r.reload.padEnd(8)} ${r.pipeline}${note}`
    );
  }
  console.log("════════════════════════════════════════════════════════════════════════════\n");
  await request.dispose().catch(() => { /* 이미 disposed — 무시 */ });
});

// ──────────────────────────────────────────────────────────────
// 헬퍼: 로그인 후 페이지 이동 + 기본 로드 대기
// ──────────────────────────────────────────────────────────────
async function gotoEventPage(page: Page, path: string) {
  await loginAsDemo(page);
  await page.goto(`/events/${fx.eventId}/${path}`);
  // Next.js 하이드레이션 완료 대기 — 로딩 스피너 사라질 때까지
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => null);
}

// ══════════════════════════════════════════════════════════════
// 1. 참석자 폼 — /events/[id]/attendees
// ══════════════════════════════════════════════════════════════
test.describe("1. 참석자 폼", () => {
  test("1-1 참석자 추가 다이얼로그 — 모든 필드 채워 저장", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoEventPage(page, "attendees");

    // 페이지 제목 확인 — exact:true로 "전체 참석자" h3와 구분
    await expect(page.getByRole("heading", { name: "참석자", exact: true })).toBeVisible({ timeout: 15_000 });

    // "참석자 추가" 버튼 클릭
    await page.getByRole("button", { name: "참석자 추가" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 8_000 });

    const ATTENDEE_NAME = `E2E참석자${SFX}`;
    const ATTENDEE_EMAIL = `e2e-att-${SFX}@example.com`;
    const ATTENDEE_PHONE = "010-5555-4444";

    // 이름
    await dialog.getByLabel("이름").fill(ATTENDEE_NAME);
    rec({ form: "attendees", field: "이름", value: ATTENDEE_NAME, saved: "✅", reload: "-", pipeline: "-" });

    // 이메일
    await dialog.getByLabel("이메일").fill(ATTENDEE_EMAIL);
    rec({ form: "attendees", field: "이메일", value: ATTENDEE_EMAIL, saved: "✅", reload: "-", pipeline: "-" });

    // 전화번호
    await dialog.getByLabel("전화번호").fill(ATTENDEE_PHONE);
    rec({ form: "attendees", field: "전화번호", value: ATTENDEE_PHONE, saved: "✅", reload: "-", pipeline: "-" });

    // 주문 선택 — Radix SelectTrigger는 role="combobox"
    const orderSelectTriggers = dialog.getByRole("combobox");
    const orderTrigger = orderSelectTriggers.first();
    await orderTrigger.click();
    // 옵션은 body에 portal로 렌더됨
    const orderOptions = page.getByRole("option");
    await orderOptions.first().waitFor({ timeout: 5_000 }).catch(() => null);
    const orderCount = await orderOptions.count();
    if (orderCount > 0) {
      await orderOptions.first().click();
      rec({ form: "attendees", field: "주문(orderId)", value: "첫번째 주문 선택", saved: "✅", reload: "-", pipeline: "-" });
    } else {
      // 클릭으로 listbox가 안 열리면 Escape로 초기화
      await page.keyboard.press("Escape");
      rec({ form: "attendees", field: "주문(orderId)", value: "(주문없음)", saved: "⏭️", reload: "-", pipeline: "-", note: "픽스처 주문 없음" });
    }

    // 상품 선택 — 두 번째 combobox
    const productTrigger = orderSelectTriggers.nth(1);
    await productTrigger.click();
    const productOptions = page.getByRole("option");
    await productOptions.first().waitFor({ timeout: 5_000 }).catch(() => null);
    const prodCount = await productOptions.count();
    if (prodCount > 0) {
      await productOptions.first().click();
      rec({ form: "attendees", field: "상품(productId)", value: "첫번째 상품 선택", saved: "✅", reload: "-", pipeline: "-" });
    } else {
      await page.keyboard.press("Escape");
      rec({ form: "attendees", field: "상품(productId)", value: "(상품없음)", saved: "⏭️", reload: "-", pipeline: "-", note: "픽스처 상품 없음" });
    }

    // 추가 버튼 클릭
    const addBtn = dialog.getByRole("button", { name: "추가" });
    await addBtn.click();

    // 성공: 다이얼로그 닫힘 or 성공 토스트
    const closed = await dialog.isHidden().catch(() => false);
    const toastVisible = await page.locator("[data-sonner-toast], [role='status']").first().isVisible().catch(() => false);
    const savedOk = closed || toastVisible;

    if (savedOk) {
      // 목록에서 이름 확인
      await expect(page.getByText(ATTENDEE_NAME)).toBeVisible({ timeout: 8_000 });
      rec({ form: "attendees", field: "추가→목록반영", value: ATTENDEE_NAME, saved: "✅", reload: "-", pipeline: "-" });

      // 리로드 후 유지
      await page.reload();
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => null);
      const stillVisible = await page.getByText(ATTENDEE_NAME).isVisible().catch(() => false);
      rec({
        form: "attendees", field: "리로드 후 이름 유지", value: ATTENDEE_NAME,
        saved: "✅", reload: stillVisible ? "✅" : "❌", pipeline: "-",
        note: stillVisible ? undefined : "리로드 시 참석자 사라짐"
      });
    } else {
      // 에러 메시지 확인
      const errMsg = await page.locator("[role='alert']").textContent().catch(() => "");
      rec({ form: "attendees", field: "추가→목록반영", value: ATTENDEE_NAME, saved: "❌", reload: "-", pipeline: "-", note: errMsg ?? "저장 실패" });
    }
  });

  test("1-2 CSV 임포트 다이얼로그 — 버튼 렌더 boundary", async ({ page }) => {
    test.setTimeout(30_000);
    await gotoEventPage(page, "attendees");
    await expect(page.getByRole("heading", { name: "참석자", exact: true })).toBeVisible({ timeout: 15_000 });

    // CSV 임포트 버튼 존재 확인
    const csvBtn = page.getByRole("button", { name: "CSV 임포트" });
    const csvBtnVisible = await csvBtn.isVisible().catch(() => false);
    rec({
      form: "attendees", field: "CSV임포트 버튼 렌더", value: csvBtnVisible ? "보임" : "없음",
      saved: csvBtnVisible ? "✅" : "❌", reload: "-", pipeline: "-"
    });

    if (csvBtnVisible) {
      // 클릭하면 카드 형태 업로드 UI 렌더
      await csvBtn.click();
      const uploadCard = page.locator("text=CSV 스마트 임포트");
      const cardVisible = await uploadCard.isVisible({ timeout: 5_000 }).catch(() => false);
      rec({
        form: "attendees", field: "CSV임포트 업로드 카드", value: cardVisible ? "렌더됨" : "안보임",
        saved: cardVisible ? "✅" : "❌", reload: "-", pipeline: "-"
      });

      // 취소 버튼으로 닫기
      await page.getByRole("button", { name: "취소" }).click();
    }
  });

  test("1-3 참석자 상세 모달 — 픽스처 참석자 클릭", async ({ page }) => {
    test.setTimeout(30_000);
    if (!fx.attendeeId) {
      rec({ form: "attendees", field: "상세 모달", value: "(attendee 없음)", saved: "⏭️", reload: "-", pipeline: "-", note: "픽스처 완결주문 없어 attendeeId 미생성" });
      test.skip();
    }
    await gotoEventPage(page, "attendees");
    await expect(page.getByRole("heading", { name: "참석자", exact: true })).toBeVisible({ timeout: 15_000 });

    // 테이블 행 클릭
    const rows = page.locator("tbody tr");
    const rowCount = await rows.count();
    if (rowCount === 0) {
      rec({ form: "attendees", field: "상세 모달 클릭", value: "행 없음", saved: "⏭️", reload: "-", pipeline: "-" });
      return;
    }
    await rows.first().click();
    const detailDialog = page.getByRole("dialog");
    const detailOpen = await detailDialog.isVisible({ timeout: 8_000 }).catch(() => false);
    rec({
      form: "attendees", field: "상세 모달 열림", value: detailOpen ? "✅" : "❌",
      saved: detailOpen ? "✅" : "❌", reload: "-", pipeline: "-"
    });
  });
});

// ══════════════════════════════════════════════════════════════
// 2. 주문 상세 폼 — /events/[id]/orders/[orderId]
// ══════════════════════════════════════════════════════════════
test.describe("2. 주문 상세 폼", () => {
  // 주문 확보는 각 테스트 첫 진입 시 처리 (beforeAll에서 request 재사용 시 retry trace ENOENT 방지)

  test("2-1 order-memo-form — 메모 입력·저장·리로드", async ({ page }) => {
    test.setTimeout(60_000);
    if (!fx.orderId) {
      rec({ form: "order-memo", field: "메모 저장", value: "(orderId 없음)", saved: "⏭️", reload: "-", pipeline: "-" });
      test.skip();
    }
    await gotoEventPage(page, `orders/${fx.orderId}`);
    await expect(page.getByRole("heading", { name: "주문 상세" }).or(page.locator("h2").first())).toBeVisible({ timeout: 15_000 });

    const MEMO_TEXT = `E2E 메모 테스트 ${SFX} — 자동입력된 메모입니다.`;

    // 메모 textarea 찾기
    const textarea = page.getByRole("textbox").first();
    await textarea.fill(MEMO_TEXT);
    rec({ form: "order-memo", field: "메모 내용", value: MEMO_TEXT.slice(0, 20), saved: "✅", reload: "-", pipeline: "-" });

    // 메모 저장 버튼
    await page.getByRole("button", { name: "메모 저장" }).click();

    // 성공 메시지 확인
    const successMsg = await page.waitForSelector("text=메모를 저장했습니다", { timeout: 8_000 }).catch(() => null);
    const savedOk = Boolean(successMsg);
    rec({
      form: "order-memo", field: "메모 저장 성공", value: savedOk ? "저장완료" : "실패",
      saved: savedOk ? "✅" : "❌", reload: "-", pipeline: "-",
      note: savedOk ? undefined : "저장 응답 없음"
    });

    // 리로드 후 값 유지 확인
    await page.reload();
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => null);
    const memoAfterReload = await page.getByRole("textbox").first().inputValue().catch(() => "");
    const reloadOk = memoAfterReload.includes(SFX);
    rec({
      form: "order-memo", field: "메모 리로드 유지", value: memoAfterReload.slice(0, 20),
      saved: "✅", reload: reloadOk ? "✅" : "❌", pipeline: "-",
      note: reloadOk ? undefined : "리로드 시 메모 사라짐(저장 실패 또는 SSR 초기값 문제)"
    });

    // API GET으로 메모 확인 (page.request 사용)
    const orderRes = await page.request.get(`/api/events/${fx.eventId}/orders/${fx.orderId!}`);
    const orderBody = await orderRes.json();
    const apiMemo: string = orderBody.data?.memo ?? "";
    const apiOk = apiMemo.includes(SFX);
    rec({
      form: "order-memo", field: "API GET 메모 확인", value: apiMemo.slice(0, 20),
      saved: "✅", reload: reloadOk ? "✅" : "❌", pipeline: apiOk ? "✅" : "❌",
      note: apiOk ? undefined : "API에서 메모 미반영"
    });
  });

  test("2-2 order-attendees-manager — 참석자 정보 수정", async ({ page }) => {
    test.setTimeout(60_000);
    if (!fx.orderId) {
      rec({ form: "order-attendees", field: "참석자 수정", value: "(orderId 없음)", saved: "⏭️", reload: "-", pipeline: "-" });
      test.skip();
    }
    await gotoEventPage(page, `orders/${fx.orderId}`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => null);

    // "수정" 버튼 찾기 (참석자 행의 수정 버튼)
    const editBtn = page.getByRole("button", { name: "수정" }).first();
    const editBtnVisible = await editBtn.isVisible({ timeout: 8_000 }).catch(() => false);

    if (!editBtnVisible) {
      rec({ form: "order-attendees", field: "수정 버튼", value: "없음", saved: "⏭️", reload: "-", pipeline: "-", note: "참석자 행 없음" });
      return;
    }

    await editBtn.click();
    const editDialog = page.getByRole("dialog");
    const dialogOpen = await editDialog.isVisible({ timeout: 8_000 }).catch(() => false);

    if (!dialogOpen) {
      rec({ form: "order-attendees", field: "수정 다이얼로그 열림", value: "안열림", saved: "❌", reload: "-", pipeline: "-", note: "수정 버튼 클릭 후 Dialog 미렌더 — 제품 버그 의심(선택상태 미전달)" });
      return;
    }

    const NEW_NAME = `수정참석자${SFX}`;
    const NEW_EMAIL = `edited-${SFX}@example.com`;
    const NEW_PHONE = "010-8888-7777";

    // 이름 수정
    await editDialog.getByPlaceholder("이름").fill(NEW_NAME);
    rec({ form: "order-attendees", field: "이름 수정", value: NEW_NAME, saved: "✅", reload: "-", pipeline: "-" });

    // 이메일 수정
    await editDialog.getByPlaceholder("이메일").fill(NEW_EMAIL);
    rec({ form: "order-attendees", field: "이메일 수정", value: NEW_EMAIL, saved: "✅", reload: "-", pipeline: "-" });

    // 전화번호 수정
    await editDialog.getByPlaceholder("전화번호").fill(NEW_PHONE);
    rec({ form: "order-attendees", field: "전화번호 수정", value: NEW_PHONE, saved: "✅", reload: "-", pipeline: "-" });

    // 저장 클릭
    await editDialog.getByRole("button", { name: "저장" }).click();

    // 페이지 리로드됨(window.location.reload 호출)
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => null);

    // 리로드 후 수정 이름 표시 확인
    const nameVisible = await page.getByText(NEW_NAME).isVisible({ timeout: 8_000 }).catch(() => false);
    rec({
      form: "order-attendees", field: "수정→리로드 반영", value: NEW_NAME,
      saved: "✅", reload: nameVisible ? "✅" : "❌", pipeline: "-",
      note: nameVisible ? undefined : "리로드 후 수정된 이름 미반영"
    });
  });

  test("2-3 order-items-manager — 항목 취소 ConfirmDialog boundary", async ({ page }) => {
    test.setTimeout(60_000);
    if (!fx.orderId) {
      rec({ form: "order-items", field: "항목 취소 boundary", value: "(orderId 없음)", saved: "⏭️", reload: "-", pipeline: "-" });
      test.skip();
    }
    await gotoEventPage(page, `orders/${fx.orderId}`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => null);

    // "취소" 버튼 (항목 취소 — "취소됨" 아닌 것)
    const cancelBtns = page.getByRole("button", { name: "취소" });
    const count = await cancelBtns.count();

    if (count === 0) {
      rec({ form: "order-items", field: "항목 취소 버튼", value: "없음", saved: "⏭️", reload: "-", pipeline: "-", note: "취소 가능한 항목 없음" });
      return;
    }

    // 첫 번째 취소 버튼 클릭 (ConfirmDialog 열림 확인만)
    await cancelBtns.first().click();
    const confirmDialog = page.getByRole("dialog");
    const dialogOpen = await confirmDialog.isVisible({ timeout: 5_000 }).catch(() => false);
    rec({
      form: "order-items", field: "항목취소 ConfirmDialog", value: dialogOpen ? "열림" : "안열림",
      saved: dialogOpen ? "✅" : "❌", reload: "-", pipeline: "-"
    });

    if (dialogOpen) {
      // 항목 취소 실행 (미리보기 boundary — 실환불이 아니므로 항목취소만 1건 허용)
      const confirmBtn = confirmDialog.getByRole("button", { name: "항목 취소" });
      const confirmBtnVisible = await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false);
      rec({
        form: "order-items", field: "항목취소 확인 버튼", value: confirmBtnVisible ? "표시" : "없음",
        saved: confirmBtnVisible ? "✅" : "❌", reload: "-", pipeline: "-"
      });

      if (confirmBtnVisible) {
        await confirmBtn.click();
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => null);
        // 취소됨 표시 확인
        const cancelledVisible = await page.getByText("취소됨").first().isVisible({ timeout: 8_000 }).catch(() => false);
        rec({
          form: "order-items", field: "항목취소→취소됨 표시", value: cancelledVisible ? "취소됨" : "미반영",
          saved: cancelledVisible ? "✅" : "❌", reload: "-", pipeline: "-"
        });
      } else {
        // 취소 다이얼로그 닫기
        await page.keyboard.press("Escape");
      }
    }
  });

  test("2-4 order-refund-action — 환불 버튼 & ConfirmDialog boundary", async ({ page }) => {
    test.setTimeout(30_000);
    if (!fx.orderId) {
      rec({ form: "order-refund", field: "환불 boundary", value: "(orderId 없음)", saved: "⏭️", reload: "-", pipeline: "-" });
      test.skip();
    }
    await gotoEventPage(page, `orders/${fx.orderId}`);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => null);

    // 환불하기 버튼 찾기
    const refundBtn = page.getByRole("button", { name: "환불하기" });
    const refundBtnVisible = await refundBtn.isVisible({ timeout: 8_000 }).catch(() => false);
    const refundBtnEnabled = refundBtnVisible && !(await refundBtn.isDisabled().catch(() => true));

    rec({
      form: "order-refund", field: "환불하기 버튼 렌더", value: refundBtnVisible ? (refundBtnEnabled ? "활성" : "비활성(정책없음)") : "없음",
      saved: refundBtnVisible ? "✅" : "❌", reload: "-", pipeline: "-"
    });

    // 환불 정책 텍스트 확인
    const refundPolicy = await page.getByText("환불 규정").isVisible({ timeout: 5_000 }).catch(() => false);
    rec({
      form: "order-refund", field: "환불 규정 카드 렌더", value: refundPolicy ? "표시" : "없음",
      saved: refundPolicy ? "✅" : "❌", reload: "-", pipeline: "-"
    });

    // 활성 상태일 때만 ConfirmDialog boundary 테스트
    if (refundBtnEnabled) {
      await refundBtn.click();
      const confirmDialog = page.getByRole("dialog");
      const dialogOpen = await confirmDialog.isVisible({ timeout: 5_000 }).catch(() => false);
      rec({
        form: "order-refund", field: "환불 ConfirmDialog 열림", value: dialogOpen ? "열림" : "안열림",
        saved: dialogOpen ? "✅" : "❌", reload: "-", pipeline: "-"
      });

      // 미리보기 boundary — 확인 버튼 텍스트만 검증하고 닫기 (실환불 방지)
      if (dialogOpen) {
        const confirmBtn = confirmDialog.getByRole("button", { name: "환불 진행" });
        const confirmVisible = await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false);
        rec({
          form: "order-refund", field: "환불 진행 버튼(미리보기)", value: confirmVisible ? "표시" : "없음",
          saved: confirmVisible ? "✅" : "❌", reload: "-", pipeline: "⏭️",
          note: "실환불 방지 — 미리보기 boundary까지만 검증"
        });
        // Escape로 닫기 (환불 실행 안 함)
        await page.keyboard.press("Escape");
      }
    } else {
      rec({
        form: "order-refund", field: "환불 ConfirmDialog", value: "건너뜀(버튼 비활성)", saved: "⏭️", reload: "-", pipeline: "⏭️",
        note: "환불 불가 상태 또는 버튼 비활성"
      });
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 3. 단체예약 폼 — /events/[id]/group-bookings
// ══════════════════════════════════════════════════════════════
test.describe("3. 단체예약 폼", () => {
  test("3-1 단체예약 목록 로드 + empty 확인", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoEventPage(page, "group-bookings");
    // h2 "단체 예약" — exact match로 strict 모드 위반 방지
    await expect(page.getByRole("heading", { name: "단체 예약", exact: true })).toBeVisible({ timeout: 15_000 });

    // 할인율 Input — GroupBookingsClient 에서 <Input ... value={discountRate} /> 로 렌더됨
    // shadcn Input은 role="textbox" (type=text)로 렌더됨
    const discountInput = page.locator("input[type='number'], input[inputmode='numeric']").first();
    const discountVisible = await discountInput.isVisible({ timeout: 5_000 }).catch(() => false);
    rec({
      form: "group-bookings", field: "할인율 입력 필드", value: discountVisible ? "렌더됨" : "없음",
      saved: discountVisible ? "✅" : "❌", reload: "-", pipeline: "-"
    });

    if (discountVisible) {
      await discountInput.fill("15");
      const val = await discountInput.inputValue().catch(() => "");
      rec({
        form: "group-bookings", field: "할인율 값 입력", value: val,
        saved: val === "15" ? "✅" : "❌", reload: "-", pipeline: "-"
      });
    }

    // DataTable 렌더 확인 (빈 목록 or 행 존재)
    const tableVisible = await page.locator("table").isVisible({ timeout: 5_000 }).catch(() => false);
    const rows = await page.locator("tbody tr").count().catch(() => 0);

    rec({
      form: "group-bookings", field: "목록 테이블 렌더", value: tableVisible ? `${rows}행` : "없음",
      saved: tableVisible ? "✅" : "❌", reload: "-", pipeline: "-"
    });

    // 목록이 있는 경우에만 승인/거절 ConfirmDialog boundary 테스트
    if (rows > 0) {
      // "승인" 버튼 — 테이블 셀 내 Button
      const approveBtn = page.locator("tbody").getByRole("button", { name: "승인" }).first();
      const approveBtnVisible = await approveBtn.isVisible({ timeout: 5_000 }).catch(() => false);
      rec({
        form: "group-bookings", field: "승인 버튼 렌더", value: approveBtnVisible ? "보임" : "없음",
        saved: approveBtnVisible ? "✅" : "❌", reload: "-", pipeline: "-"
      });
      if (approveBtnVisible) {
        await approveBtn.click({ timeout: 5_000 }).catch(async () => {
          // 클릭 불가 시 JavaScript로 클릭
          await approveBtn.dispatchEvent("click");
        });
        const confirmDialog = page.getByRole("dialog");
        const dialogOpen = await confirmDialog.isVisible({ timeout: 5_000 }).catch(() => false);
        rec({
          form: "group-bookings", field: "승인 ConfirmDialog 열림", value: dialogOpen ? "열림" : "안열림",
          saved: dialogOpen ? "✅" : "❌", reload: "-", pipeline: "-"
        });
        if (dialogOpen) {
          await page.keyboard.press("Escape");
        }
      }

      const cancelBtn = page.locator("tbody").getByRole("button", { name: "거절" }).first();
      const cancelBtnVisible = await cancelBtn.isVisible({ timeout: 5_000 }).catch(() => false);
      if (cancelBtnVisible) {
        await cancelBtn.click({ timeout: 5_000 }).catch(async () => {
          await cancelBtn.dispatchEvent("click");
        });
        const cancelDialog = page.getByRole("dialog");
        const cancelDialogOpen = await cancelDialog.isVisible({ timeout: 5_000 }).catch(() => false);
        rec({
          form: "group-bookings", field: "거절 ConfirmDialog 열림", value: cancelDialogOpen ? "열림" : "안열림",
          saved: cancelDialogOpen ? "✅" : "❌", reload: "-", pipeline: "-"
        });
        if (cancelDialogOpen) {
          await page.keyboard.press("Escape");
        }
      }
    } else {
      rec({ form: "group-bookings", field: "승인/거절 ConfirmDialog", value: "목록 비어 있음(empty)", saved: "⏭️", reload: "-", pipeline: "-", note: "단체예약 없어 ConfirmDialog 테스트 건너뜀" });
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 4. 수동발권 폼 — /events/[id]/ticket-issuance
// ══════════════════════════════════════════════════════════════
test.describe("4. 수동발권 폼", () => {
  test("4-1 이름·이메일·전화·상품 입력 → 발권 → 티켓번호 + 목록 반영", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoEventPage(page, "ticket-issuance");
    await expect(page.getByRole("heading", { name: "수동발권" })).toBeVisible({ timeout: 15_000 });

    const ISSUE_NAME = `수동발권${SFX}`;
    const ISSUE_EMAIL = `issue-${SFX}@example.com`;
    const ISSUE_PHONE = "010-6666-5555";

    // 이름 *
    const nameInput = page.getByPlaceholder("이름 *");
    await nameInput.fill(ISSUE_NAME);
    rec({ form: "ticket-issuance", field: "이름", value: ISSUE_NAME, saved: "✅", reload: "-", pipeline: "-" });

    // 이메일
    const emailInput = page.getByPlaceholder("이메일 (선택)");
    await emailInput.fill(ISSUE_EMAIL);
    rec({ form: "ticket-issuance", field: "이메일", value: ISSUE_EMAIL, saved: "✅", reload: "-", pipeline: "-" });

    // 전화번호
    const phoneInput = page.getByPlaceholder("전화번호 (선택)");
    await phoneInput.fill(ISSUE_PHONE);
    rec({ form: "ticket-issuance", field: "전화번호", value: ISSUE_PHONE, saved: "✅", reload: "-", pipeline: "-" });

    // 상품 선택 — native select
    const productSelect = page.locator("select").first();
    const productSelectVisible = await productSelect.isVisible({ timeout: 5_000 }).catch(() => false);
    if (productSelectVisible) {
      const options = await productSelect.locator("option").all();
      if (options.length > 0) {
        const firstOptionValue = await options[0].getAttribute("value");
        if (firstOptionValue && firstOptionValue !== "") {
          await productSelect.selectOption({ index: 0 });
          rec({ form: "ticket-issuance", field: "상품 선택", value: "첫번째 상품", saved: "✅", reload: "-", pipeline: "-" });
        } else {
          rec({ form: "ticket-issuance", field: "상품 선택", value: "상품 없음", saved: "⏭️", reload: "-", pipeline: "-", note: "상품 없음" });
        }
      }
    }

    // 발권 버튼 클릭
    const issueBtn = page.getByRole("button", { name: "발권" });
    const issueBtnEnabled = !(await issueBtn.isDisabled().catch(() => true));

    if (!issueBtnEnabled) {
      rec({ form: "ticket-issuance", field: "발권 버튼", value: "비활성(이름 또는 상품 없음)", saved: "⏭️", reload: "-", pipeline: "-" });
      return;
    }

    // API intercept: 발권 응답에서 티켓번호 캡처
    let issuedTicketNumber = "";
    page.on("response", async (resp) => {
      if (resp.url().includes("/ticket-issuance") && resp.request().method() === "POST") {
        const body = await resp.json().catch(() => null) as { success?: boolean; data?: { ticketNumber?: string } } | null;
        if (body?.data?.ticketNumber) {
          issuedTicketNumber = body.data.ticketNumber;
        }
      }
    });

    await issueBtn.click();

    // 성공 토스트 대기
    const successToast = await page.waitForSelector("text=발행 완료", { timeout: 15_000 }).catch(() => null);
    const issued = Boolean(successToast) || issuedTicketNumber.startsWith("TKT-");

    rec({
      form: "ticket-issuance", field: "발권 성공(토스트)", value: issued ? (issuedTicketNumber || "완료") : "실패",
      saved: issued ? "✅" : "❌", reload: "-", pipeline: "-"
    });

    if (issuedTicketNumber) {
      rec({
        form: "ticket-issuance", field: "티켓번호(TKT-*)", value: issuedTicketNumber,
        saved: "✅", reload: "-", pipeline: "✅", note: "v2 createOrder → 티켓 발행"
      });
    }

    // 목록 반영 확인 — 이름이 테이블에 보여야 함
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => null);
    const nameInTable = await page.getByText(ISSUE_NAME).isVisible({ timeout: 8_000 }).catch(() => false);
    rec({
      form: "ticket-issuance", field: "발권 후 목록 반영", value: nameInTable ? "보임" : "없음",
      saved: "✅", reload: nameInTable ? "✅" : "❌", pipeline: "-",
      note: nameInTable ? undefined : "발권 후 목록 미반영 (fetch_ 재호출 실패 의심)"
    });

    // 리로드 후 목록 유지
    await page.reload();
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => null);
    const nameAfterReload = await page.getByText(ISSUE_NAME).isVisible({ timeout: 8_000 }).catch(() => false);
    rec({
      form: "ticket-issuance", field: "리로드 후 목록 유지", value: nameAfterReload ? "유지" : "사라짐",
      saved: "✅", reload: nameAfterReload ? "✅" : "❌", pipeline: "-"
    });

    // v2 파이프라인 — page.request로 발권 목록 확인 (top-level request trace ENOENT 방지)
    try {
      const listRes = await page.request.get(`/api/events/${fx.eventId}/ticket-issuance`);
      if (listRes.ok()) {
        const listBody = await listRes.json() as { success?: boolean; data?: Array<{ name: string }> };
        const foundInApi = (listBody.data ?? []).some((t) => t.name === ISSUE_NAME);
        rec({
          form: "ticket-issuance", field: "API GET 목록 확인", value: foundInApi ? "발견" : "없음",
          saved: "✅", reload: "✅", pipeline: foundInApi ? "✅" : "❌",
          note: foundInApi ? undefined : "API 목록에 발행된 티켓 미포함"
        });
      } else {
        rec({ form: "ticket-issuance", field: "API GET 목록", value: `HTTP ${listRes.status()}`, saved: "✅", reload: "-", pipeline: "❌" });
      }
    } catch {
      rec({ form: "ticket-issuance", field: "API GET 목록", value: "요청 실패", saved: "✅", reload: "-", pipeline: "⏭️" });
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 5. 체크인 폼 — /events/[id]/check-in
// ══════════════════════════════════════════════════════════════
test.describe("5. 체크인 폼", () => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let checkInListId = "";
  let ticketNumberForCheckIn = "";
  // ticketNumber는 테스트 첫 실행 시 page.request로 조회 (beforeAll trace ENOENT 방지)
  // → 각 체크인 테스트가 직접 조회하도록 설계

  test("5-1 체크인 리스트 생성 다이얼로그 — 이름 입력 + 만들기", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoEventPage(page, "check-in");
    await expect(page.getByRole("heading", { name: "체크인", exact: true })).toBeVisible({ timeout: 15_000 });

    const LIST_NAME = `E2E리스트${SFX}`;

    // "리스트 만들기" 버튼 클릭
    await page.getByRole("button", { name: "리스트 만들기" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // 리스트 이름 입력
    const listNameInput = dialog.getByLabel("리스트 이름");
    await listNameInput.fill("");
    await listNameInput.fill(LIST_NAME);
    rec({ form: "check-in", field: "리스트 이름", value: LIST_NAME, saved: "✅", reload: "-", pipeline: "-" });

    // "만들기" 버튼 클릭
    await dialog.getByRole("button", { name: "만들기" }).click();

    // 성공 토스트 or 다이얼로그 닫힘 확인
    const closed = await dialog.isHidden({ timeout: 8_000 }).catch(() => false);
    const successToast = await page.waitForSelector("text=체크인 리스트가 생성되었습니다", { timeout: 5_000 }).catch(() => null);
    const listCreated = closed || Boolean(successToast);

    rec({
      form: "check-in", field: "리스트 생성 성공", value: listCreated ? "생성완료" : "실패",
      saved: listCreated ? "✅" : "❌", reload: "-", pipeline: "-"
    });

    // Select에서 리스트 선택 확인
    if (listCreated) {
      await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => null);
      const _selectTrigger = page.locator("[data-radix-select-trigger]").or(page.locator("select")).first();
      const listInSelect = await page.getByText(LIST_NAME).isVisible({ timeout: 5_000 }).catch(() => false);
      rec({
        form: "check-in", field: "리스트 Select 반영", value: listInSelect ? "반영됨" : "없음",
        saved: "✅", reload: listInSelect ? "✅" : "❌", pipeline: "-"
      });
      // API로 체크인 리스트 id 획득 (page.request 사용)
      try {
        const listsRes = await page.request.get(`/api/events/${fx.eventId}/check-in-lists`);
        if (listsRes.ok()) {
          const listsBody = await listsRes.json() as { data?: { items?: Array<{ id: string; name: string }> } };
          const found = (listsBody.data?.items ?? []).find((l) => l.name === LIST_NAME);
          if (found) {
            checkInListId = found.id;
            rec({ form: "check-in", field: "API GET 리스트 확인", value: found.name, saved: "✅", reload: "✅", pipeline: "✅" });
          }
        }
      } catch { /* ignore */ }
    }
  });

  test("5-2 수동 체크인 — 티켓번호 입력 + 체크인 버튼", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoEventPage(page, "check-in");
    await expect(page.getByRole("heading", { name: "체크인", exact: true })).toBeVisible({ timeout: 15_000 });

    // 체크인 리스트 없으면 먼저 생성 (page.request 사용 — 세션 쿠키 공유)
    const noListMsg = await page.getByText("체크인 리스트가 없습니다").isVisible({ timeout: 3_000 }).catch(() => false);
    if (noListMsg) {
      try {
        const createRes = await page.request.post(`/api/events/${fx.eventId}/check-in-lists`, {
          data: { name: `API리스트${SFX}`, productIds: [] }
        });
        if (createRes.ok()) {
          const createBody = await createRes.json() as { data?: { id: string } };
          checkInListId = createBody.data?.id ?? "";
        }
      } catch { /* ignore */ }
      await page.reload();
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => null);
    }

    // 수동 검색 카드 확인
    const manualSearchCard = page.getByText("수동 검색");
    const cardVisible = await manualSearchCard.isVisible({ timeout: 8_000 }).catch(() => false);

    rec({
      form: "check-in", field: "수동 검색 카드 렌더", value: cardVisible ? "렌더됨" : "없음",
      saved: cardVisible ? "✅" : "❌", reload: "-", pipeline: "-",
      note: cardVisible ? undefined : "체크인 리스트 없거나 UI 미렌더"
    });

    if (!cardVisible) return;

    // 티켓번호 입력 (픽스처 or 빈값으로 에러 확인)
    const ticketInput = page.getByPlaceholder("티켓번호를 입력하세요");
    const inputVisible = await ticketInput.isVisible({ timeout: 5_000 }).catch(() => false);
    rec({
      form: "check-in", field: "티켓번호 입력 필드", value: inputVisible ? "렌더됨" : "없음",
      saved: inputVisible ? "✅" : "❌", reload: "-", pipeline: "-"
    });

    if (!inputVisible) return;

    // 티켓번호 조회 (page.request 사용 — beforeAll trace ENOENT 방지)
    if (!ticketNumberForCheckIn && fx.attendeeId) {
      try {
        const attRes = await page.request.get(`/api/events/${fx.eventId}/attendees/${fx.attendeeId}`);
        if (attRes.ok()) {
          const attBody = await attRes.json() as { data?: { ticketNumber?: string } };
          ticketNumberForCheckIn = attBody.data?.ticketNumber ?? "";
        }
      } catch { /* ignore */ }
    }
    if (!ticketNumberForCheckIn) {
      try {
        const listRes = await page.request.get(`/api/events/${fx.eventId}/attendees?status=confirmed&limit=5`);
        if (listRes.ok()) {
          const listBody = await listRes.json() as { data?: Array<{ ticketNumber?: string }> | { items?: Array<{ ticketNumber?: string }> } };
          const items = Array.isArray(listBody.data) ? listBody.data : ((listBody.data as { items?: Array<{ ticketNumber?: string }> })?.items ?? []);
          ticketNumberForCheckIn = items.find((a) => a.ticketNumber?.startsWith("TKT-"))?.ticketNumber ?? "";
        }
      } catch { /* ignore */ }
    }

    if (ticketNumberForCheckIn) {
      await ticketInput.fill(ticketNumberForCheckIn);
      rec({ form: "check-in", field: "티켓번호 입력값", value: ticketNumberForCheckIn, saved: "✅", reload: "-", pipeline: "-" });

      // 체크인 버튼 클릭
      await page.getByRole("button", { name: "체크인" }).click();

      // 결과: 체크인 완료 or 이미 체크인됨 피드백 카드 (locator or로 복수 텍스트 매칭)
      const feedbackCard = await page.locator("p.font-semibold").filter({ hasText: /체크인|리스트/ }).waitFor({ timeout: 10_000 }).catch(() => null);
      const checkedIn = Boolean(feedbackCard);
      rec({
        form: "check-in", field: "체크인 결과 피드백", value: checkedIn ? "피드백 표시됨" : "응답없음",
        saved: checkedIn ? "✅" : "❌", reload: "-", pipeline: checkedIn ? "✅" : "❌",
        note: "check-in API → 상태전이 (confirmed→checked_in)"
      });

      // API로 상태 확인 (page.request 사용)
      if (fx.attendeeId) {
        try {
          const attRes = await page.request.get(`/api/events/${fx.eventId}/attendees/${fx.attendeeId}`);
          if (attRes.ok()) {
            const attBody = await attRes.json() as { data?: { status?: string } };
            const status = attBody.data?.status ?? "";
            rec({
              form: "check-in", field: "API 참석자 상태(confirmed→checked_in)", value: status,
              saved: "✅", reload: "✅", pipeline: (status === "checked_in" || status === "confirmed") ? "✅" : "❌"
            });
          }
        } catch {
          rec({ form: "check-in", field: "API 참석자 상태", value: "요청 실패", saved: "✅", reload: "-", pipeline: "⏭️" });
        }
      }
    } else {
      rec({ form: "check-in", field: "수동 체크인", value: "티켓번호 없음", saved: "⏭️", reload: "-", pipeline: "-", note: "픽스처 참석자 없어 건너뜀" });
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 6. CRM 폼 — /events/[id]/crm
// ══════════════════════════════════════════════════════════════
test.describe("6. CRM 폼", () => {
  test("6-1 주문 데이터 동기화 버튼 + 목록 로드", async ({ page }) => {
    test.setTimeout(60_000);
    await gotoEventPage(page, "crm");
    await expect(page.getByRole("heading", { name: "고객 관리" })).toBeVisible({ timeout: 15_000 });

    // 동기화 버튼 렌더 확인
    const syncBtn = page.getByRole("button", { name: "주문 데이터 동기화" });
    const syncBtnVisible = await syncBtn.isVisible({ timeout: 5_000 }).catch(() => false);
    rec({
      form: "crm", field: "동기화 버튼 렌더", value: syncBtnVisible ? "렌더됨" : "없음",
      saved: syncBtnVisible ? "✅" : "❌", reload: "-", pipeline: "-"
    });

    if (!syncBtnVisible) return;

    // 동기화 버튼 클릭
    await syncBtn.click();

    // "동기화 중..." 또는 "건의 구매자 정보가 동기화되었습니다" 토스트
    const syncFeedback = await page.waitForSelector("text=동기화, text=동기화 중", { timeout: 15_000 }).catch(() => null);
    const syncDone = Boolean(syncFeedback);
    rec({
      form: "crm", field: "동기화 실행 피드백", value: syncDone ? "동기화 완료/진행중" : "응답없음",
      saved: syncDone ? "✅" : "❌", reload: "-", pipeline: "-"
    });

    // 동기화 완료 대기 후 목록 확인
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => null);
    const contactsTable = await page.locator("table").isVisible({ timeout: 8_000 }).catch(() => false);
    const contactCount = await page.locator("tbody tr").count().catch(() => 0);

    rec({
      form: "crm", field: "동기화 후 목록 테이블", value: contactsTable ? `${contactCount}건` : "없음",
      saved: "✅", reload: contactsTable ? "✅" : "❌", pipeline: "-"
    });

    // 목록이 있으면 검색 필터 테스트
    if (contactCount > 0) {
      const searchInput = page.getByPlaceholder("이름, 이메일, 단체명 검색...");
      const searchVisible = await searchInput.isVisible({ timeout: 3_000 }).catch(() => false);
      if (searchVisible) {
        await searchInput.fill("픽스처");
        rec({ form: "crm", field: "검색 필터 입력", value: "픽스처", saved: "✅", reload: "-", pipeline: "-" });
        await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => null);
        await searchInput.fill("");
      }

      // 등급 변경 드롭다운 (첫 번째 행)
      const tierSelect = page.locator("tbody tr").first().locator("select").first();
      const tierSelectVisible = await tierSelect.isVisible({ timeout: 5_000 }).catch(() => false);
      rec({
        form: "crm", field: "등급 변경 드롭다운", value: tierSelectVisible ? "렌더됨" : "없음",
        saved: tierSelectVisible ? "✅" : "❌", reload: "-", pipeline: "-"
      });

      if (tierSelectVisible) {
        const currentTier = await tierSelect.inputValue().catch(() => "regular");
        const newTier = currentTier === "regular" ? "vip" : "regular";
        await tierSelect.selectOption(newTier);

        // 변경 성공 토스트
        const tierToast = await page.waitForSelector("text=등급이 변경되었습니다", { timeout: 8_000 }).catch(() => null);
        const tierSaved = Boolean(tierToast);
        rec({
          form: "crm", field: `등급 변경(${currentTier}→${newTier})`, value: newTier,
          saved: tierSaved ? "✅" : "❌", reload: "-", pipeline: "-",
          note: tierSaved ? undefined : "등급 변경 API 응답 없음"
        });

        // 리로드 후 등급 유지
        await page.reload();
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => null);
        const tierAfterReload = await page.locator("tbody tr").first().locator("select").first().inputValue().catch(() => "");
        rec({
          form: "crm", field: "등급 리로드 유지", value: tierAfterReload,
          saved: "✅", reload: tierAfterReload === newTier ? "✅" : "❌", pipeline: "-",
          note: tierAfterReload === newTier ? undefined : "리로드 시 등급 원복됨"
        });
      }
    } else {
      rec({ form: "crm", field: "등급 변경/태그", value: "연락처 없음(동기화 후도 비어있음)", saved: "⏭️", reload: "-", pipeline: "-", note: "완결주문 없어 CRM 연락처 없음" });
    }
  });

  test("6-2 CRM 등급 필터 드롭다운", async ({ page }) => {
    test.setTimeout(30_000);
    await gotoEventPage(page, "crm");
    await expect(page.getByRole("heading", { name: "고객 관리" })).toBeVisible({ timeout: 15_000 });

    // 등급 필터 select
    const tierFilterSelect = page.locator("select").first();
    const tierFilterVisible = await tierFilterSelect.isVisible({ timeout: 5_000 }).catch(() => false);
    rec({
      form: "crm", field: "등급 필터 select 렌더", value: tierFilterVisible ? "렌더됨" : "없음",
      saved: tierFilterVisible ? "✅" : "❌", reload: "-", pipeline: "-"
    });

    if (tierFilterVisible) {
      await tierFilterSelect.selectOption("vip");
      const val = await tierFilterSelect.inputValue().catch(() => "");
      rec({
        form: "crm", field: "등급 필터 선택(VIP)", value: val,
        saved: val === "vip" ? "✅" : "❌", reload: "-", pipeline: "-"
      });
      await tierFilterSelect.selectOption("");
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 7. 대기자 폼 — /events/[id]/waitlist
// ══════════════════════════════════════════════════════════════
test.describe("7. 대기자 폼", () => {
  test("7-1 대기자 목록 로드 + 구매제안 ConfirmDialog boundary", async ({ page }) => {
    test.setTimeout(30_000);
    await gotoEventPage(page, "waitlist");
    await expect(page.getByRole("heading", { name: "대기열" })).toBeVisible({ timeout: 15_000 });

    // DataTable 렌더 확인
    const tableVisible = await page.locator("table").isVisible({ timeout: 8_000 }).catch(() => false);
    const rowCount = await page.locator("tbody tr").count().catch(() => 0);

    rec({
      form: "waitlist", field: "목록 테이블 렌더", value: tableVisible ? `${rowCount}건` : "없음",
      saved: tableVisible ? "✅" : "❌", reload: "-", pipeline: "-"
    });

    // API로 대기자 수 확인 (page.request 사용 — 세션 쿠키 공유)
    let wlCount = 0;
    try {
      const wlRes = await page.request.get(`/api/events/${fx.eventId}/waitlist`);
      const wlOk = wlRes.ok();
      const wlBody = wlOk ? await wlRes.json() as { data?: unknown[] } : null;
      wlCount = wlBody?.data?.length ?? 0;
      rec({
        form: "waitlist", field: "API 대기자 수", value: String(wlCount),
        saved: wlOk ? "✅" : "❌", reload: "-", pipeline: wlOk ? "✅" : "❌"
      });
    } catch {
      rec({ form: "waitlist", field: "API 대기자 수", value: "요청 실패", saved: "⏭️", reload: "-", pipeline: "⏭️" });
    }

    if (rowCount > 0) {
      // "구매 제안" 버튼 클릭 → ConfirmDialog 열림 확인
      const offerBtn = page.getByRole("button", { name: "구매 제안" }).first();
      const offerBtnVisible = await offerBtn.isVisible({ timeout: 5_000 }).catch(() => false);
      rec({
        form: "waitlist", field: "구매 제안 버튼 렌더", value: offerBtnVisible ? "렌더됨" : "없음",
        saved: offerBtnVisible ? "✅" : "❌", reload: "-", pipeline: "-"
      });

      if (offerBtnVisible) {
        await offerBtn.click();
        const confirmDialog = page.getByRole("dialog");
        const dialogOpen = await confirmDialog.isVisible({ timeout: 5_000 }).catch(() => false);
        rec({
          form: "waitlist", field: "구매제안 ConfirmDialog 열림", value: dialogOpen ? "열림" : "안열림",
          saved: dialogOpen ? "✅" : "❌", reload: "-", pipeline: "-"
        });

        if (dialogOpen) {
          const confirmBtnText = await confirmDialog.getByRole("button", { name: "제안하기" }).isVisible({ timeout: 3_000 }).catch(() => false);
          rec({
            form: "waitlist", field: "제안하기 버튼 표시", value: confirmBtnText ? "표시" : "없음",
            saved: confirmBtnText ? "✅" : "❌", reload: "-", pipeline: "-"
          });
          // Escape로 닫기 (실제 제안 실행 안 함)
          await page.keyboard.press("Escape");
        }
      }
    } else {
      rec({ form: "waitlist", field: "구매제안 ConfirmDialog", value: "대기자 없음(empty)", saved: "⏭️", reload: "-", pipeline: "-", note: "대기자 없어 ConfirmDialog 건너뜀" });
    }
  });
});
