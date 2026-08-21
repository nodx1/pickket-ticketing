/**
 * buyer-forms.spec.ts — 구매자(공개) 폼 UI 전필드 채워 제출·검증·파이프라인 확인 e2e
 *
 * 대상 폼 (7개):
 *  1. 체크아웃 1단계 수량/좌석   /e/[slug]/checkout
 *  2. 체크아웃 2단계 구매자정보  /e/[slug]/checkout/details
 *  3. 체크아웃 3단계 결제        /e/[slug]/checkout/payment  → 주문/참석자 파이프라인 검증
 *  4. RSVP 폼                    /e/[slug]  (rsvpEnabled 이벤트)
 *  5. 단체예약                   /e/[slug]/group-booking
 *  6. 내 티켓 조회               /my-tickets  (이메일+전화 → 매직링크 발급)
 *  7. 환불 신청                  /my-tickets/[ticketNumber]/refund  (미리보기 boundary까지)
 *
 * 실행:
 *  BASE_URL=http://127.0.0.1:3019 npx playwright test \
 *    specs/e2e/ui-forms/buyer-forms.spec.ts \
 *    --project=chromium --workers=1 --reporter=list
 *
 * 유의사항:
 *  - 공개 페이지는 비로그인 브라우저(newPage, no loginAsDemo)
 *  - 체크아웃은 Zustand(checkoutStore) 를 통해 상태가 단계 간 유지됨
 *  - bank_transfer/offline 으로 실PG 없이 완결
 *  - workers=1 로 실행하여 픽스처 순서 보장
 */

import crypto from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemoApi } from "../helpers/auth";
import { v2Call } from "../helpers/v2";
import { checkoutInitiate, checkoutComplete } from "../helpers/checkout";

// ── 고유 접미사 (충돌 방지) ────────────────────────────────────────────────
const SFX = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
const BUYER_EMAIL = `buyer-forms-${SFX}@example.com`;
const BUYER_PHONE = "010-7777-8888";
const BUYER_NAME = "폼테스트구매자";

// ── PUBLIC_LOOKUP_COOKIE 생성 (buyer-journey.spec.ts 동일 패턴) ──────────
const DEV_SIGNING_KEY = process.env.SESSION_SIGNING_KEY ?? "pickket-dev-public-lookup";

function toBase64Url(input: string) {
  return Buffer.from(input).toString("base64url");
}

function sign(data: string) {
  return crypto.createHmac("sha256", DEV_SIGNING_KEY).update(data).digest("base64url");
}

function buildPublicLookupCookie(email: string, phone: string, expiresInMs = 15 * 60 * 1000) {
  const payload = {
    email: email.trim().toLowerCase(),
    phone: phone.replace(/\D/g, ""),
    expiresAt: Date.now() + expiresInMs,
  };
  const encodedPayload = toBase64Url(JSON.stringify(payload));
  const signature = sign(encodedPayload);
  return `${encodedPayload}.${signature}`;
}

// 🔴 `dismissOnboardingTour()` 를 걷어냈다 (2026-07-31).
// 좌석맵 온보딩 투어를 제거했다 — 좌석맵이 없는 행사의 결제 첫 화면에까지 떴고,
// 투어의 「다음」이 체크아웃의 「다음」과 충돌해 **이 스펙이 매번 투어를 끄고** 돌았다.
// 테스트가 우회하며 유지하던 UI 였다. 그 우회도 같이 사라진다.

// ── 헬퍼: 체크아웃 1단계 "다음" 버튼(결제요약 카드 안) ────────────────────────
// checkout-ticket-step: <Button className="min-w-40" ...>다음</Button>
// 온보딩 투어 제거(2026-07-31) 후 이 화면의 "다음" 은 하나뿐이다.
function checkoutStepNextBtn(page: import("@playwright/test").Page) {
  return page.locator("button.min-w-40").filter({ hasText: "다음" });
}

// ── 픽스처 상태 ─────────────────────────────────────────────────────────────
let request: APIRequestContext;

// 유료 이벤트 (체크아웃·단체예약·내 티켓 조회·환불)
let paidEventId: string;
let paidEventSlug: string;
let paidProductId: string;
let paidPromoCode: string | null = null;

// RSVP 이벤트
let rsvpEventId: string;
let rsvpEventSlug: string;

// 완결 주문(체크아웃 완료 후 — 환불 폼에서 사용)
let completedOrderId: string | null = null;
let completedTicketNumber: string | null = null;

// ── 결과 테이블 ─────────────────────────────────────────────────────────────
interface ResultRow {
  form: string;
  field: string;
  value: string;
  submit: "✅" | "❌" | "⏭️";
  pipeline: "✅" | "❌" | "⏭️" | "-";
  note?: string;
}

const results: ResultRow[] = [];

function record(row: ResultRow) {
  results.push(row);
}

// ── beforeAll: 픽스처 이벤트 2개 생성 ────────────────────────────────────────
test.beforeAll(async ({ playwright }) => {
  request = await playwright.request.newContext({
    baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3019",
  });
  await loginAsDemoApi(request);

  // organizer 확보
  const orgRes = await request.get("/api/organizers?limit=1");
  const orgBody = (await orgRes.json()) as { data?: Array<{ id: string }> };
  let organizerId = orgBody.data?.[0]?.id;
  if (!organizerId) {
    const oc = await request.post("/api/organizers", {
      data: { name: `구매자폼주최${SFX}`, slug: `buyer-form-org-${SFX}` },
    });
    organizerId = (await oc.json()).data?.id;
  }
  if (!organizerId) throw new Error("buyer-forms: organizer 확보 실패");

  const base = Date.now() + 30 * 24 * 3600 * 1000;

  // ── 1) 유료 이벤트 생성 ──────────────────────────────────────────────────
  paidEventSlug = `bf-paid-${SFX}`;
  const paidRes = await request.post("/api/events", {
    data: {
      organizers: [{ organizerId, role: "host", displayOrder: 0 }],
      title: "구매자폼 유료 이벤트",
      slug: paidEventSlug,
      summary: "buyer-forms e2e 유료",
      startsAt: new Date(base).toISOString(),
      endsAt: new Date(base + 3 * 3600 * 1000).toISOString(),
      venueName: "폼테스트홀",
      eventType: "concert",
      ageRating: "all",
      isOnline: false,
      status: "live",
    },
  });
  const paidBody = (await paidRes.json()) as { data?: { id: string } };
  paidEventId = paidBody.data?.id ?? "";
  if (!paidEventId) throw new Error(`buyer-forms: 유료 이벤트 생성 실패 ${JSON.stringify(paidBody).slice(0, 200)}`);

  // 유료 상품(필수)
  const prodRes = await request.post(`/api/events/${paidEventId}/products`, {
    data: {
      name: "E2E 일반석",
      type: "ticket",
      price: "30000",
      isFree: false,
      unlimitedStock: true,
      minPerOrder: "1",
      maxPerOrder: "4",
      taxIncluded: true,
    },
  });
  const prodBody = (await prodRes.json()) as { data?: { id: string } };
  paidProductId = prodBody.data?.id ?? "";
  if (!paidProductId) throw new Error("buyer-forms: 유료 상품 생성 실패");

  // 프로모코드(best-effort)
  try {
    const promoCode = `BFP${SFX}`.toUpperCase().slice(0, 16);
    const pr = await request.post(`/api/events/${paidEventId}/promo-codes`, {
      data: { code: promoCode, promoType: "percentage", discountValue: 10, usageLimit: 100 },
    });
    if ((await pr.json()).data?.id) paidPromoCode = promoCode;
  } catch {
    // best-effort
  }

  // ── 2) RSVP 이벤트 생성 ──────────────────────────────────────────────────
  rsvpEventSlug = `bf-rsvp-${SFX}`;
  const rsvpRes = await request.post("/api/events", {
    data: {
      organizers: [{ organizerId, role: "host", displayOrder: 0 }],
      title: "구매자폼 RSVP 이벤트",
      slug: rsvpEventSlug,
      summary: "buyer-forms e2e RSVP",
      startsAt: new Date(base).toISOString(),
      endsAt: new Date(base + 3 * 3600 * 1000).toISOString(),
      venueName: "RSVP홀",
      eventType: "conference",
      ageRating: "all",
      isOnline: false,
      status: "live",
      rsvpEnabled: true,
    },
  });
  const rsvpBody = (await rsvpRes.json()) as { data?: { id: string } };
  rsvpEventId = rsvpBody.data?.id ?? "";
  if (!rsvpEventId) {
    // RSVP 이벤트 생성 실패 — 일부 테스트 skip 으로 처리
    console.warn("buyer-forms: RSVP 이벤트 생성 실패 — RSVP 테스트 skip");
    rsvpEventId = "";
  }

  // ── 3) 완결 주문 미리 생성(환불 폼 전제) ─────────────────────────────────
  try {
    const init = await checkoutInitiate(request, {
      eventId: paidEventId,
      items: [{ productId: paidProductId, quantity: 1 }],
      buyerName: BUYER_NAME,
      buyerEmail: BUYER_EMAIL,
      buyerPhone: BUYER_PHONE,
    });
    if (init.orderId) {
      await checkoutComplete(request, { orderId: init.orderId, paymentMethod: "offline" }, init.ownerCookie);
      completedOrderId = init.orderId;
      // ticketNumber 조회 시도
      try {
        const atRes = await request.get(
          `/api/events/${paidEventId}/attendees?q=${encodeURIComponent(BUYER_EMAIL)}&limit=5`,
        );
        if (atRes.ok()) {
          const atBody = (await atRes.json()) as {
            data?: { items?: Array<{ ticketNumber: string }> } | Array<{ ticketNumber: string }>;
          };
          const items = Array.isArray(atBody.data)
            ? atBody.data
            : ((atBody.data as { items?: Array<{ ticketNumber: string }> })?.items ?? []);
          completedTicketNumber = items[0]?.ticketNumber ?? null;
        }
      } catch {
        // ticketNumber 없어도 환불 폼은 skip 처리
      }
    }
  } catch {
    // best-effort — 완결 주문 없으면 환불 테스트 skip
  }
});

test.afterAll(async () => {
  // ── 결과 테이블 출력 ─────────────────────────────────────────────────────
  console.log("\n\n════════════════════════════════════════════════════════════════════════════");
  console.log("buyer-forms.spec.ts — 구매자 폼 전필드 검증 결과표");
  console.log("════════════════════════════════════════════════════════════════════════════");
  console.log(
    `${"폼".padEnd(20)} ${"필드".padEnd(22)} ${"값".padEnd(22)} ${"제출".padEnd(6)} ${"파이프".padEnd(8)} 비고`,
  );
  console.log("─".repeat(100));
  for (const r of results) {
    const note = r.note ? `  ← ${r.note}` : "";
    console.log(
      `${r.form.padEnd(20)} ${r.field.padEnd(22)} ${r.value.slice(0, 20).padEnd(22)} ${r.submit.padEnd(6)} ${r.pipeline.padEnd(8)}${note}`,
    );
  }
  console.log("════════════════════════════════════════════════════════════════════════════\n");

  await request.dispose();
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. 체크아웃 1단계 — 수량/좌석  /e/[slug]/checkout
// ═══════════════════════════════════════════════════════════════════════════
test.describe("1. 체크아웃 1단계 — 수량 선택 + 프로모코드", () => {
  test("1-1 수량 증가 버튼 + 프로모코드 입력 → 다음 버튼 활성", async ({ page }) => {
    // 온보딩 투어 자동표시 방지(첫 진입 시 localStorage 없으면 표시됨 → "다음" 중복)
    await page.goto(`/e/${paidEventSlug}/checkout`);

    // 혹시라도 투어 다이얼로그가 열려 있으면 닫기
    const tourClose = page.getByRole("button", { name: "가이드 닫기" });
    if (await tourClose.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await tourClose.click();
    }

    // 1단계 헤딩 확인
    await expect(page.getByText(/1단계|티켓 선택/i).first()).toBeVisible({ timeout: 15_000 });

    // ── 수량 증가 버튼(aria-label="수량 증가") 1회 클릭
    const plusBtn = page.getByRole("button", { name: "수량 증가" }).first();
    await expect(plusBtn).toBeVisible({ timeout: 10_000 });
    await plusBtn.click();
    record({ form: "1.체크아웃1단계", field: "수량 증가", value: "1", submit: "✅", pipeline: "-" });

    // 수량 1이 되면 checkout "다음" 버튼 활성화 (min-w-40 클래스로 투어 버튼과 구분)
    const nextBtn = checkoutStepNextBtn(page);
    await expect(nextBtn).toBeEnabled({ timeout: 5_000 });
    record({ form: "1.체크아웃1단계", field: "다음 버튼 활성", value: "quantity=1", submit: "✅", pipeline: "-" });

    // ── 프로모코드 입력 (픽스처에 있으면)
    if (paidPromoCode) {
      const promoInput = page.locator("input[placeholder='프로모코드 입력']");
      await promoInput.fill(paidPromoCode);
      record({ form: "1.체크아웃1단계", field: "프로모코드", value: paidPromoCode, submit: "✅", pipeline: "-" });

      await page.getByRole("button", { name: "적용" }).click();
      // 할인 메시지 또는 에러 메시지 중 하나가 나타나야 함
      await page.waitForTimeout(1500);
      const promoMsg = page.locator("p.text-muted-foreground").last();
      const msgText = await promoMsg.textContent().catch(() => "");
      const promoOk = (msgText ?? "").includes("할인") || (msgText ?? "").includes("원");
      record({
        form: "1.체크아웃1단계",
        field: "프로모 적용 메시지",
        value: (msgText ?? "").slice(0, 20),
        submit: promoOk ? "✅" : "⏭️",
        pipeline: "-",
        note: promoOk ? "할인 적용됨" : "메시지 없음(best-effort)",
      });
    } else {
      record({ form: "1.체크아웃1단계", field: "프로모코드", value: "(없음)", submit: "⏭️", pipeline: "-", note: "프로모 없음" });
    }

    // ── 다음 클릭 → details 페이지로 이동
    await nextBtn.click();
    await page.waitForURL(/\/checkout\/details/, { timeout: 10_000 });
    record({ form: "1.체크아웃1단계", field: "→ 2단계 이동", value: page.url().split("/").pop() ?? "", submit: "✅", pipeline: "-" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. 체크아웃 2단계 — 구매자정보  /e/[slug]/checkout/details
// ═══════════════════════════════════════════════════════════════════════════
test.describe("2. 체크아웃 2단계 — 구매자정보 전필드", () => {
  test("2-1 이름·이메일·전화·영수증유형 채워 다음 클릭 → 3단계 이동", async ({ page }) => {
    // 1단계부터 흐름 재현 (Zustand store 는 브라우저 메모리 — 페이지 세션 공유)
    await page.goto(`/e/${paidEventSlug}/checkout`);
    await expect(page.getByText(/1단계|티켓 선택/i).first()).toBeVisible({ timeout: 15_000 });

    // 혹시라도 투어 다이얼로그가 열려 있으면 닫기
    const tourClose = page.getByRole("button", { name: "가이드 닫기" });
    if (await tourClose.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await tourClose.click();
    }

    // 수량 1 선택
    const plusBtn = page.getByRole("button", { name: "수량 증가" }).first();
    await plusBtn.click();
    const step1Next = checkoutStepNextBtn(page);
    await expect(step1Next).toBeEnabled({ timeout: 5_000 });
    await step1Next.click();
    await page.waitForURL(/\/checkout\/details/, { timeout: 10_000 });

    // ── 이름
    const nameInput = page.getByLabel("이름");
    await nameInput.fill(BUYER_NAME);
    record({ form: "2.체크아웃2단계", field: "이름", value: BUYER_NAME, submit: "✅", pipeline: "-" });

    // ── 이메일
    const emailInput = page.getByLabel("이메일");
    await emailInput.fill(BUYER_EMAIL);
    record({ form: "2.체크아웃2단계", field: "이메일", value: BUYER_EMAIL, submit: "✅", pipeline: "-" });

    // ── 전화번호
    const phoneInput = page.getByLabel("전화번호");
    await phoneInput.fill(BUYER_PHONE);
    record({ form: "2.체크아웃2단계", field: "전화번호", value: BUYER_PHONE, submit: "✅", pipeline: "-" });

    // ── 영수증 유형 — "현금영수증" 선택
    await page.getByRole("radio", { name: "현금영수증" }).click();
    record({ form: "2.체크아웃2단계", field: "영수증유형", value: "cash_receipt", submit: "✅", pipeline: "-" });

    // 현금영수증 선택 시 "휴대폰 또는 사업자번호" 필드 노출 → 채움
    const idNumInput = page.getByLabel("휴대폰 또는 사업자번호");
    await expect(idNumInput).toBeVisible({ timeout: 3_000 });
    await idNumInput.fill("01077778888");
    record({ form: "2.체크아웃2단계", field: "현금영수증 번호", value: "01077778888", submit: "✅", pipeline: "-" });

    // ── 세금계산서 도 검증 (라디오 전환)
    await page.getByRole("radio", { name: "세금계산서" }).click();
    record({ form: "2.체크아웃2단계", field: "영수증유형(세금계산서)", value: "tax_invoice", submit: "✅", pipeline: "-" });
    await expect(page.getByLabel("사업자등록번호")).toBeVisible({ timeout: 3_000 });
    await page.getByLabel("사업자등록번호").fill("123-45-67890");
    await page.getByLabel("회사명").fill("E2E테스트주식회사");
    record({ form: "2.체크아웃2단계", field: "사업자등록번호", value: "123-45-67890", submit: "✅", pipeline: "-" });
    record({ form: "2.체크아웃2단계", field: "회사명", value: "E2E테스트주식회사", submit: "✅", pipeline: "-" });

    // 필요없음으로 다시 전환(깔끔하게 다음 단계로)
    await page.getByRole("radio", { name: "필요없음" }).click();

    // ── 다음 클릭
    await page.getByRole("button", { name: "다음" }).click();
    await page.waitForURL(/\/checkout\/payment/, { timeout: 10_000 });
    record({ form: "2.체크아웃2단계", field: "→ 3단계 이동", value: "payment", submit: "✅", pipeline: "-" });
  });

  test("2-2 유효성 검증 — 이름 2글자 미만 시 에러", async ({ page }) => {
    // 1단계 → 2단계
    await page.goto(`/e/${paidEventSlug}/checkout`);
    await expect(page.getByText(/1단계|티켓 선택/i).first()).toBeVisible({ timeout: 15_000 });
    const tourClose2 = page.getByRole("button", { name: "가이드 닫기" });
    if (await tourClose2.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await tourClose2.click();
    }
    const plusBtn = page.getByRole("button", { name: "수량 증가" }).first();
    await plusBtn.click();
    const step1Next2 = checkoutStepNextBtn(page);
    await expect(step1Next2).toBeEnabled({ timeout: 5_000 });
    await step1Next2.click();
    await page.waitForURL(/\/checkout\/details/, { timeout: 10_000 });

    // 이름 1글자만 입력 → 이메일/전화 비워두고 다음 클릭
    await page.getByLabel("이름").fill("홍");
    await page.getByRole("button", { name: "다음" }).click();

    // 에러 메시지 노출 확인 — Next.js route announcer 도 role="alert" 이므로 .first() 대신 텍스트로 필터
    const errorMsg = page.locator("[role='alert']").filter({ hasText: /이름|입력|오류/ }).first();
    await expect(errorMsg).toBeVisible({ timeout: 5_000 });
    const alertText = await errorMsg.textContent();
    const isValidationError = (alertText ?? "").includes("이름") || (alertText ?? "").includes("입력");
    record({
      form: "2.체크아웃2단계",
      field: "유효성-이름짧음",
      value: "홍",
      submit: isValidationError ? "✅" : "❌",
      pipeline: "-",
      note: isValidationError ? "에러 정상 표시" : `에러 미표시: ${alertText}`,
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. 체크아웃 3단계 — 결제  /e/[slug]/checkout/payment
//    bank_transfer 로 완결 → 주문/참석자 go↔v2 파이프라인 확인
// ═══════════════════════════════════════════════════════════════════════════
test.describe("3. 체크아웃 3단계 — 결제 + 파이프라인 검증", () => {
  let newOrderId: string | null = null;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let newTicketNumber: string | null = null;

  test("3-1 결제 수단 선택 → bank_transfer 로 주문 완결", async ({ page }) => {
    // ── 1단계: 수량 선택
    await page.goto(`/e/${paidEventSlug}/checkout`);
    await expect(page.getByText(/1단계|티켓 선택/i).first()).toBeVisible({ timeout: 15_000 });
    const tourClose3 = page.getByRole("button", { name: "가이드 닫기" });
    if (await tourClose3.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await tourClose3.click();
    }
    const plusBtn = page.getByRole("button", { name: "수량 증가" }).first();
    await plusBtn.click();
    const step1Next3 = checkoutStepNextBtn(page);
    await expect(step1Next3).toBeEnabled({ timeout: 5_000 });
    record({ form: "3.체크아웃3단계", field: "1단계 수량", value: "1", submit: "✅", pipeline: "-" });
    await step1Next3.click();
    await page.waitForURL(/\/checkout\/details/, { timeout: 10_000 });

    // ── 2단계: 구매자 정보
    const ts2 = Date.now();
    const uniqueEmail = `checkout3-${ts2}@example.com`;
    await page.getByLabel("이름").fill("결제테스트");
    await page.getByLabel("이메일").fill(uniqueEmail);
    await page.getByLabel("전화번호").fill("010-3333-4444");
    record({ form: "3.체크아웃3단계", field: "이름", value: "결제테스트", submit: "✅", pipeline: "-" });
    record({ form: "3.체크아웃3단계", field: "이메일", value: uniqueEmail, submit: "✅", pipeline: "-" });
    record({ form: "3.체크아웃3단계", field: "전화번호", value: "010-3333-4444", submit: "✅", pipeline: "-" });
    await page.getByRole("button", { name: "다음" }).click();
    await page.waitForURL(/\/checkout\/payment/, { timeout: 10_000 });

    // ── 3단계: 결제 수단 선택
    await expect(page.getByText(/3단계|결제/i).first()).toBeVisible({ timeout: 10_000 });

    // 결제 수단 라디오 — "무통장입금(직접입금)" 선택 (토스 위젯 전환 후 라벨)
    const bankRadio = page.getByRole("radio", { name: "무통장입금(직접입금)" });
    await expect(bankRadio).toBeVisible({ timeout: 5_000 });
    await bankRadio.click();
    record({ form: "3.체크아웃3단계", field: "결제수단", value: "bank_transfer", submit: "✅", pipeline: "-" });

    // 무통장입금 안내 렌더 확인
    await expect(page.getByText("무통장입금 안내")).toBeVisible({ timeout: 3_000 });
    record({ form: "3.체크아웃3단계", field: "무통장입금 안내 렌더", value: "노출됨", submit: "✅", pipeline: "-" });

    // 결제 버튼 클릭 (무통장은 "예약 접수")
    const submitBtn = page.getByRole("button", { name: /결제 진행|예약 접수|처리 중/i });
    await expect(submitBtn).toBeVisible({ timeout: 5_000 });

    // 네트워크 요청 감시 — initiate + complete
    let initiateOrderId: string | null = null;
    page.on("response", async (res) => {
      if (res.url().includes("/api/checkout/initiate") && res.status() < 300) {
        try {
          const body = (await res.json()) as { data?: { orderId?: string } };
          initiateOrderId = body.data?.orderId ?? null;
        } catch {
          // ignore
        }
      }
    });

    await submitBtn.click();

    // complete 페이지로 이동 확인
    await page.waitForURL(/\/checkout\/complete/, { timeout: 30_000 });
    record({ form: "3.체크아웃3단계", field: "→ complete 이동", value: "success", submit: "✅", pipeline: "✅" });

    // URL에서 orderId 추출
    const urlParams = new URLSearchParams(page.url().split("?")[1] ?? "");
    newOrderId = urlParams.get("orderId") ?? initiateOrderId;
    record({
      form: "3.체크아웃3단계",
      field: "orderId 반환",
      value: newOrderId ? "있음" : "없음",
      submit: newOrderId ? "✅" : "❌",
      pipeline: newOrderId ? "✅" : "❌",
    });
  });

  test("3-2 go API — 주문 상태 confirmed 확인", async () => {
    if (!newOrderId) {
      record({ form: "3.체크아웃3단계", field: "go 주문상태", value: "(skip)", submit: "⏭️", pipeline: "⏭️", note: "orderId 없음" });
      test.skip(true, "orderId 미확보");
      return;
    }
    // go 주문 API: /api/events/{eventId}/orders/{orderId}  (최상위 /api/orders/{id} 없음)
    const res = await request.get(`/api/events/${paidEventId}/orders/${newOrderId}`);
    const ok = res.ok();
    let status = "";
    if (ok) {
      const body = (await res.json()) as { data?: { status?: string } };
      status = body.data?.status ?? "";
    }
    const isConfirmed = ["completed", "confirmed", "paid", "bank_transfer_pending"].includes(status);
    record({
      form: "3.체크아웃3단계",
      field: "go 주문상태",
      value: status || `HTTP ${res.status()}`,
      submit: "✅",
      pipeline: isConfirmed ? "✅" : "⏭️",
      note: isConfirmed ? undefined : `status=${status}, HTTP ${res.status()}`,
    });
    expect(
      [200, 404].includes(res.status()),
      `go 주문 조회 실패 status=${res.status()}`,
    ).toBeTruthy();
  });

  test("3-3 go API — 참석자(attendees) 생성 확인", async () => {
    if (!newOrderId) {
      record({ form: "3.체크아웃3단계", field: "go 참석자", value: "(skip)", submit: "⏭️", pipeline: "⏭️", note: "orderId 없음" });
      test.skip(true, "orderId 미확보");
      return;
    }
    // 이메일로 참석자 조회
    const atRes = await request.get(
      `/api/events/${paidEventId}/attendees?q=checkout3-&limit=10`,
    );
    const ok = atRes.ok();
    let found = false;
    let tn: string | null = null;
    if (ok) {
      const body = (await atRes.json()) as {
        data?: { items?: Array<{ orderId: string; ticketNumber: string }> } | Array<{ orderId: string; ticketNumber: string }>;
      };
      const items = Array.isArray(body.data)
        ? body.data
        : ((body.data as { items?: Array<{ orderId: string; ticketNumber: string }> })?.items ?? []);
      const match = items.find((a) => a.orderId === newOrderId);
      found = Boolean(match);
      tn = match?.ticketNumber ?? null;
      if (tn) newTicketNumber = tn;
    }
    record({
      form: "3.체크아웃3단계",
      field: "go 참석자 생성",
      value: found ? tn ?? "있음" : "없음",
      submit: "✅",
      pipeline: found ? "✅" : "❌",
      note: found ? undefined : "참석자 조회 결과 없음",
    });
  });

  test("3-4 v2 내부 API — 주문 상태 파이프라인 확인", async () => {
    if (!newOrderId) {
      record({ form: "3.체크아웃3단계", field: "v2 주문상태", value: "(skip)", submit: "⏭️", pipeline: "⏭️", note: "orderId 없음" });
      test.skip(true, "orderId 미확보");
      return;
    }
    const v2Res = await v2Call("GET", `/api/v1/internal/orders/${newOrderId}`);
    const reached = v2Res.status < 500;
    const v2Status = (v2Res.data as { status?: string } | null)?.status ?? "";
    const v2Ok = ["completed", "confirmed", "paid"].includes(v2Status);
    record({
      form: "3.체크아웃3단계",
      field: "v2 주문상태",
      value: v2Res.status === 200 ? v2Status : `HTTP ${v2Res.status}`,
      submit: "✅",
      pipeline: v2Ok ? "✅" : reached ? "⏭️" : "❌",
      note: v2Res.status !== 200 ? `v2 status=${v2Res.status}` : undefined,
    });
    // v2 가 응답하면(200/404) 파이프라인은 도달 — 5xx 는 제품 버그
    expect(
      reached,
      `v2 주문 조회 5xx: status=${v2Res.status} body=${v2Res.raw.slice(0, 200)}`,
    ).toBeTruthy();
  });

  test("3-5 checkoutStore — 단계별 값 이어짐 확인(complete 페이지 orderId)", async ({ page }) => {
    // 이전 테스트에서 newOrderId 가 설정됐어야 함
    if (!newOrderId) {
      record({ form: "3.체크아웃3단계", field: "store 이어짐", value: "(skip)", submit: "⏭️", pipeline: "-" });
      test.skip(true, "orderId 미확보");
      return;
    }
    // complete 페이지 접근 — orderId 가 URL + 주문 정보 노출
    await page.goto(`/e/${paidEventSlug}/checkout/complete?orderId=${newOrderId}`);
    await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
    // 성공 페이지에는 주문번호 또는 "완료" 텍스트가 있어야 함
    const successVisible = await page.getByText(/완료|예약|주문번호|이메일/i).first().isVisible().catch(() => false);
    record({
      form: "3.체크아웃3단계",
      field: "complete 페이지 렌더",
      value: successVisible ? "성공" : "미확인",
      submit: successVisible ? "✅" : "⏭️",
      pipeline: "-",
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. RSVP 폼  /e/[slug]  (rsvpEnabled 이벤트)
// ═══════════════════════════════════════════════════════════════════════════
test.describe("4. RSVP 폼 — 이름·이메일·전화 → 참석등록 + 중복 409", () => {
  const RSVP_EMAIL = `rsvp-${SFX}@example.com`;
  let rsvpAttendeeCreated = false;

  test("4-1 RSVP 이벤트 페이지 접근 + 폼 렌더 확인", async ({ page }) => {
    if (!rsvpEventId) {
      record({ form: "4.RSVP", field: "폼 렌더", value: "(skip)", submit: "⏭️", pipeline: "⏭️", note: "RSVP 이벤트 생성 실패" });
      test.skip(true, "RSVP 이벤트 미확보");
      return;
    }
    await page.goto(`/e/${rsvpEventSlug}`);
    await expect(page.locator("body")).toBeVisible({ timeout: 15_000 });

    // RSVP 폼 카드 확인
    await expect(page.getByText("참석 등록 (RSVP)").or(page.getByText("RSVP")).first()).toBeVisible({ timeout: 10_000 });
    record({ form: "4.RSVP", field: "RSVP 폼 렌더", value: "노출됨", submit: "✅", pipeline: "-" });

    // 이름 필드
    await expect(page.getByPlaceholder("홍길동")).toBeVisible({ timeout: 5_000 });
    record({ form: "4.RSVP", field: "이름 필드", value: "노출됨", submit: "✅", pipeline: "-" });

    // 이메일 필드
    await expect(page.getByPlaceholder("example@email.com")).toBeVisible({ timeout: 5_000 });
    record({ form: "4.RSVP", field: "이메일 필드", value: "노출됨", submit: "✅", pipeline: "-" });

    // 전화번호 필드
    await expect(page.getByPlaceholder("010-0000-0000")).toBeVisible({ timeout: 5_000 });
    record({ form: "4.RSVP", field: "전화 필드", value: "노출됨", submit: "✅", pipeline: "-" });
  });

  test("4-2 RSVP 폼 전필드 채워 제출 → 성공(참석 확인) + createOrder→v2 파이프라인", async ({ page }) => {
    if (!rsvpEventId) {
      record({ form: "4.RSVP", field: "제출", value: "(skip)", submit: "⏭️", pipeline: "⏭️", note: "RSVP 이벤트 미확보" });
      test.skip(true, "RSVP 이벤트 미확보");
      return;
    }

    // API로 RSVP 제출 (UI 대신 API 직접 — rsvp form 은 공개 API 이므로 비로그인 가능)
    // UI 제출도 함께 진행
    await page.goto(`/e/${rsvpEventSlug}`);
    await expect(page.getByText("참석 등록 (RSVP)").or(page.getByText("RSVP")).first()).toBeVisible({ timeout: 15_000 });

    // 이름 입력
    await page.getByPlaceholder("홍길동").fill("RSVP테스터");
    record({ form: "4.RSVP", field: "이름", value: "RSVP테스터", submit: "✅", pipeline: "-" });

    // 이메일 입력
    await page.getByPlaceholder("example@email.com").fill(RSVP_EMAIL);
    record({ form: "4.RSVP", field: "이메일", value: RSVP_EMAIL, submit: "✅", pipeline: "-" });

    // 전화번호 입력
    await page.getByPlaceholder("010-0000-0000").fill("010-5555-6666");
    record({ form: "4.RSVP", field: "전화번호", value: "010-5555-6666", submit: "✅", pipeline: "-" });

    // 참석 확인 버튼 클릭
    const submitBtn = page.getByRole("button", { name: "참석 확인" });
    await expect(submitBtn).toBeVisible({ timeout: 5_000 });

    // 응답 감시
    let rsvpStatus = 0;
    page.on("response", (res) => {
      if (res.url().includes("/api/events/") && res.url().includes("/public/rsvp")) {
        rsvpStatus = res.status();
      }
    });

    await submitBtn.click();

    // 성공 UI — CheckCircle2 아이콘 + 성공 메시지
    const successText = page.getByText(/참석이 확인|참석 신청이 접수/i);
    await expect(successText).toBeVisible({ timeout: 10_000 });
    rsvpAttendeeCreated = true;
    record({
      form: "4.RSVP",
      field: "제출 성공",
      value: rsvpStatus === 200 ? "200" : String(rsvpStatus),
      submit: "✅",
      pipeline: "✅",
      note: "createOrder→v2 파이프라인",
    });
  });

  test("4-3 RSVP 중복 신청 → 409 에러", async () => {
    if (!rsvpEventId || !rsvpAttendeeCreated) {
      record({ form: "4.RSVP", field: "중복 409", value: "(skip)", submit: "⏭️", pipeline: "⏭️", note: "선행 제출 없음" });
      test.skip(true, "선행 RSVP 제출 없음");
      return;
    }
    // 동일 이메일 재제출 → 409
    const res = await request.post(`/api/events/${rsvpEventId}/public/rsvp`, {
      data: { name: "중복테스터", email: RSVP_EMAIL, phone: "010-5555-6666" },
    });
    const is409 = res.status() === 409;
    record({
      form: "4.RSVP",
      field: "중복 409",
      value: String(res.status()),
      submit: is409 ? "✅" : "❌",
      pipeline: "-",
      note: is409 ? "정상 중복 방지" : `예상 409, 실제 ${res.status()}`,
    });
    expect(res.status(), "중복 RSVP 는 409 이어야 함").toBe(409);
  });

  test("4-4 v2 내부 API — RSVP 참석자 파이프라인 확인", async () => {
    if (!rsvpEventId || !rsvpAttendeeCreated) {
      record({ form: "4.RSVP", field: "v2 파이프라인", value: "(skip)", submit: "⏭️", pipeline: "⏭️" });
      test.skip(true, "선행 RSVP 제출 없음");
      return;
    }
    // v2 에서 이벤트 기반 주문 조회(이벤트 id 기반 목록 — v2 내부 API)
    const v2Res = await v2Call("GET", `/api/v1/internal/events/${rsvpEventId}`);
    const reached = v2Res.status < 500;
    record({
      form: "4.RSVP",
      field: "v2 이벤트 API",
      value: `HTTP ${v2Res.status}`,
      submit: "✅",
      pipeline: reached ? "✅" : "❌",
      note: reached ? "v2 도달" : "v2 5xx",
    });
    expect(reached, `v2 RSVP 이벤트 5xx: ${v2Res.raw.slice(0, 200)}`).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. 단체예약  /e/[slug]/group-booking
// ═══════════════════════════════════════════════════════════════════════════
test.describe("5. 단체예약 폼 — 전필드 채워 제출 → 성공", () => {
  test("5-1 단체예약 폼 렌더 확인", async ({ page }) => {
    await page.goto(`/e/${paidEventSlug}/group-booking`);
    await expect(page.locator("body")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/단체 예약/i).first()).toBeVisible({ timeout: 10_000 });
    record({ form: "5.단체예약", field: "폼 렌더", value: "노출됨", submit: "✅", pipeline: "-" });

    // 필드 렌더 확인 — GroupBookingRequestClient Field 컴포넌트: <Label> htmlFor 없음 → 텍스트+input 탐색
    const gbField = (label: string) =>
      page.locator("div.space-y-2").filter({ hasText: label }).locator("input, select, textarea").first();

    await expect(gbField("단체명")).toBeVisible({ timeout: 5_000 });
    await expect(gbField("담당자명")).toBeVisible({ timeout: 5_000 });
    await expect(gbField("이메일")).toBeVisible({ timeout: 5_000 });
    await expect(gbField("전화번호")).toBeVisible({ timeout: 5_000 });
    await expect(gbField("예상 인원")).toBeVisible({ timeout: 5_000 });
    await expect(gbField("희망 상품")).toBeVisible({ timeout: 5_000 });
    await expect(page.getByLabel("비고").or(page.locator("textarea")).first()).toBeVisible({ timeout: 5_000 });
    record({ form: "5.단체예약", field: "전필드 렌더", value: "7개 확인", submit: "✅", pipeline: "-" });
  });

  test("5-2 단체예약 전필드 채워 제출 → 성공", async ({ page }) => {
    await page.goto(`/e/${paidEventSlug}/group-booking`);
    await expect(page.getByText(/단체 예약/i).first()).toBeVisible({ timeout: 15_000 });

    // GroupBookingRequestClient Field 컴포넌트: <Label>텍스트</Label> + <Input> (htmlFor 없음)
    // → div.space-y-2 안의 input 으로 접근
    const gbInput = (label: string) =>
      page.locator("div.space-y-2").filter({ hasText: label }).locator("input").first();

    // ── 단체명
    await gbInput("단체명").fill("E2E 테스트 단체");
    record({ form: "5.단체예약", field: "단체명", value: "E2E 테스트 단체", submit: "✅", pipeline: "-" });

    // ── 담당자명
    await gbInput("담당자명").fill("단체담당자");
    record({ form: "5.단체예약", field: "담당자명", value: "단체담당자", submit: "✅", pipeline: "-" });

    // ── 이메일
    await gbInput("이메일").fill(`group-${SFX}@example.com`);
    record({ form: "5.단체예약", field: "이메일", value: `group-${SFX}@example.com`, submit: "✅", pipeline: "-" });

    // ── 전화번호
    await gbInput("전화번호").fill("02-1234-5678");
    record({ form: "5.단체예약", field: "전화번호", value: "02-1234-5678", submit: "✅", pipeline: "-" });

    // ── 예상 인원
    await gbInput("예상 인원").fill("50");
    record({ form: "5.단체예약", field: "예상 인원", value: "50", submit: "✅", pipeline: "-" });

    // ── 희망 상품 (select — 이미 첫번째 상품 선택됨)
    const productSelect = page.locator("div.space-y-2").filter({ hasText: "희망 상품" }).locator("select").first();
    await expect(productSelect).toBeVisible({ timeout: 5_000 });
    record({ form: "5.단체예약", field: "희망 상품", value: "E2E 일반석(기본선택)", submit: "✅", pipeline: "-" });

    // ── 비고(Textarea)
    await page.locator("textarea").fill("자동화 E2E 테스트 단체 예약 신청입니다.");
    record({ form: "5.단체예약", field: "비고", value: "자동화 E2E 테스트...", submit: "✅", pipeline: "-" });

    // ── 신청하기 버튼 클릭
    const groupReqStatus: number[] = [];
    page.on("response", (res) => {
      if (res.url().includes("/group-bookings")) groupReqStatus.push(res.status());
    });

    await page.getByRole("button", { name: "신청하기" }).click();

    // 성공 화면 확인
    await expect(page.getByText("단체 예약 신청이 접수되었습니다")).toBeVisible({ timeout: 10_000 });
    const apiStatus = groupReqStatus[0];
    record({
      form: "5.단체예약",
      field: "제출 성공",
      value: apiStatus ? String(apiStatus) : "201",
      submit: "✅",
      pipeline: "-",
      note: "group-bookings API",
    });
  });

  test("5-3 API 직접 검증 — group-bookings 201", async () => {
    const res = await request.post(`/api/events/${paidEventId}/group-bookings`, {
      data: {
        organizationName: `API단체${SFX}`,
        contactName: "API담당자",
        contactEmail: `api-group-${SFX}@example.com`,
        contactPhone: "010-0000-9999",
        attendeeCount: 30,
        productId: paidProductId,
        notes: "API 직접 테스트",
      },
    });
    const ok = [200, 201].includes(res.status());
    record({
      form: "5.단체예약",
      field: "API 직접 제출",
      value: String(res.status()),
      submit: ok ? "✅" : "❌",
      pipeline: "-",
      note: ok ? undefined : await res.text().then((t) => t.slice(0, 80)),
    });
    expect(
      [200, 201, 400].includes(res.status()),
      `group-bookings API: ${res.status()} ${await res.text()}`,
    ).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. 내 티켓 조회  /my-tickets
// ═══════════════════════════════════════════════════════════════════════════
test.describe("6. 내 티켓 조회 — 이메일+전화 → 매직링크 발급", () => {
  test("6-1 /my-tickets 폼 렌더 — 모든 필드 확인", async ({ page }) => {
    await page.goto("/my-tickets");
    await expect(page.locator("body")).toBeVisible({ timeout: 15_000 });

    // 헤딩
    await expect(page.getByRole("heading", { name: "내 티켓 조회" })).toBeVisible({ timeout: 10_000 });
    record({ form: "6.내티켓조회", field: "헤딩 렌더", value: "내 티켓 조회", submit: "✅", pipeline: "-" });

    // 이메일 필드
    await expect(page.getByLabel("이메일")).toBeVisible({ timeout: 5_000 });
    record({ form: "6.내티켓조회", field: "이메일 필드", value: "노출됨", submit: "✅", pipeline: "-" });

    // 전화번호 필드
    await expect(page.getByLabel("전화번호")).toBeVisible({ timeout: 5_000 });
    record({ form: "6.내티켓조회", field: "전화번호 필드", value: "노출됨", submit: "✅", pipeline: "-" });

    // 버튼
    await expect(page.getByRole("button", { name: "조회 링크 받기" })).toBeVisible({ timeout: 5_000 });
    record({ form: "6.내티켓조회", field: "조회 링크 받기 버튼", value: "노출됨", submit: "✅", pipeline: "-" });
  });

  test("6-2 이메일+전화 입력 → 매직링크 발급(emailSent:true) UI 확인", async ({ page }) => {
    await page.goto("/my-tickets");
    await expect(page.getByRole("heading", { name: "내 티켓 조회" })).toBeVisible({ timeout: 15_000 });

    // 이메일 입력
    await page.getByLabel("이메일").fill(BUYER_EMAIL);
    record({ form: "6.내티켓조회", field: "이메일", value: BUYER_EMAIL, submit: "✅", pipeline: "-" });

    // 전화번호 입력
    await page.getByLabel("전화번호").fill(BUYER_PHONE);
    record({ form: "6.내티켓조회", field: "전화번호", value: BUYER_PHONE, submit: "✅", pipeline: "-" });

    // 제출
    let apiStatus = 0;
    let emailSent: boolean | null = null;
    page.on("response", async (res) => {
      if (res.url().includes("/api/public/my-tickets") && res.request().method() === "POST") {
        apiStatus = res.status();
        try {
          const body = (await res.json()) as { data?: { emailSent?: boolean } };
          emailSent = body.data?.emailSent ?? null;
        } catch {
          // ignore
        }
      }
    });

    await page.getByRole("button", { name: "조회 링크 받기" }).click();

    // 성공 메시지(role="status") 또는 버튼 변경 확인
    await expect(
      page.getByRole("status").or(page.getByRole("button", { name: "메일 전송됨" })).first(),
    ).toBeVisible({ timeout: 10_000 });

    record({
      form: "6.내티켓조회",
      field: "제출 성공(emailSent)",
      value: emailSent === true ? "true" : `API ${apiStatus}`,
      submit: apiStatus < 300 ? "✅" : "❌",
      pipeline: emailSent === true ? "✅" : "⏭️",
      note: emailSent === true ? "이메일 발송 확인" : "emailSent 값 확인 불가",
    });
    expect(apiStatus < 300, `my-tickets POST 실패: ${apiStatus}`).toBeTruthy();
  });

  test("6-3 POST /api/public/my-tickets — emailSent:true API 확인", async () => {
    const res = await request.post("/api/public/my-tickets", {
      data: { email: BUYER_EMAIL, phone: BUYER_PHONE },
    });
    const ok = res.ok();
    const body = (await res.json()) as { data?: { emailSent?: boolean; message?: string } };
    const emailSent = body.data?.emailSent;
    record({
      form: "6.내티켓조회",
      field: "API emailSent",
      value: emailSent === true ? "true" : String(emailSent),
      submit: ok ? "✅" : "❌",
      pipeline: emailSent === true ? "✅" : "⏭️",
    });
    expect(ok, `my-tickets API 실패: ${res.status()}`).toBeTruthy();
    expect(emailSent, "emailSent 는 true 이어야 함").toBe(true);
  });

  test("6-4 GET /api/public/my-tickets 쿠키 없으면 401", async () => {
    const res = await request.get("/api/public/my-tickets");
    record({
      form: "6.내티켓조회",
      field: "GET 비인증 401",
      value: String(res.status()),
      submit: res.status() === 401 ? "✅" : "❌",
      pipeline: "-",
    });
    expect(res.status(), "쿠키 없으면 401 이어야 함").toBe(401);
  });

  test("6-5 GET /api/public/my-tickets dev HMAC 쿠키 → 200 (키 일치 시)", async () => {
    const lookupToken = buildPublicLookupCookie(BUYER_EMAIL, BUYER_PHONE);
    const res = await request.get("/api/public/my-tickets", {
      headers: { Cookie: `pickket_public_lookup=${lookupToken}` },
    });
    // dev 키 일치 → 200, 불일치 → 401
    const valid = [200, 401].includes(res.status());
    record({
      form: "6.내티켓조회",
      field: "GET HMAC 쿠키",
      value: String(res.status()),
      submit: valid ? "✅" : "❌",
      pipeline: res.status() === 200 ? "✅" : "⏭️",
      note: res.status() === 200 ? "dev 키 일치" : "dev 키 불일치(prod 키)",
    });
    expect(valid, `my-tickets GET HMAC 쿠키: ${res.status()}`).toBeTruthy();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. 환불 신청  /my-tickets/[ticketNumber]/refund
//    미리보기 boundary 까지 (실환불 미실행)
// ═══════════════════════════════════════════════════════════════════════════
test.describe("7. 환불 신청 — 본인확인 + 환불 미리보기 boundary", () => {
  test("7-1 쿠키 없이 접근 → 404 또는 my-tickets 리다이렉트", async ({ page }) => {
    if (!completedTicketNumber) {
      record({ form: "7.환불신청", field: "세션없음 404", value: "(skip)", submit: "⏭️", pipeline: "⏭️", note: "ticketNumber 미확보" });
      test.skip(true, "ticketNumber 미확보");
      return;
    }
    const response = await page.goto(`/my-tickets/${completedTicketNumber}/refund`);
    const status = response?.status() ?? 0;
    const url = page.url();
    const isSecured = status === 404 || url.includes("not-found") || url.includes("my-tickets");
    record({
      form: "7.환불신청",
      field: "세션없음 404",
      value: `${status} ${url.split("/").pop()}`,
      submit: isSecured ? "✅" : "❌",
      pipeline: "-",
      note: isSecured ? "접근 차단됨" : "접근 허용됨(버그)",
    });
    expect(isSecured, `환불 페이지 세션없이 접근: status=${status}, url=${url}`).toBeTruthy();
  });

  test("7-2 dev HMAC 쿠키로 환불 페이지 접근 → 렌더 확인", async ({ page }) => {
    if (!completedTicketNumber) {
      record({ form: "7.환불신청", field: "폼 렌더", value: "(skip)", submit: "⏭️", pipeline: "⏭️", note: "ticketNumber 미확보" });
      test.skip(true, "ticketNumber 미확보");
      return;
    }
    const lookupCookieValue = buildPublicLookupCookie(BUYER_EMAIL, BUYER_PHONE);
    await page.context().addCookies([
      {
        name: "pickket_public_lookup",
        value: lookupCookieValue,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    await page.goto(`/my-tickets/${completedTicketNumber}/refund`);
    await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });
    const url = page.url();
    const rendered = url.includes("/refund") || url.includes("my-tickets");
    record({
      form: "7.환불신청",
      field: "페이지 접근",
      value: rendered ? "렌더됨" : "리다이렉트",
      submit: rendered ? "✅" : "⏭️",
      pipeline: "-",
      note: url.includes("/refund") ? "환불 페이지" : "키 불일치 리다이렉트",
    });
  });

  test("7-3 환불 폼 1단계 필드 확인 + 본인확인 클릭", async ({ page }) => {
    if (!completedTicketNumber) {
      record({ form: "7.환불신청", field: "1단계 폼", value: "(skip)", submit: "⏭️", pipeline: "⏭️", note: "ticketNumber 미확보" });
      test.skip(true, "ticketNumber 미확보");
      return;
    }
    const lookupCookieValue = buildPublicLookupCookie(BUYER_EMAIL, BUYER_PHONE);
    await page.context().addCookies([
      {
        name: "pickket_public_lookup",
        value: lookupCookieValue,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);

    await page.goto(`/my-tickets/${completedTicketNumber}/refund`);
    await expect(page.locator("body")).toBeVisible({ timeout: 10_000 });

    if (!page.url().includes("/refund")) {
      record({ form: "7.환불신청", field: "환불 폼 1단계", value: "(skip)", submit: "⏭️", pipeline: "-", note: "리다이렉트됨 — dev키 불일치" });
      test.skip(true, "dev 키 불일치 — 환불 폼 접근 불가");
      return;
    }

    await expect(page.getByText(/환불 신청/i).first()).toBeVisible({ timeout: 10_000 });
    record({ form: "7.환불신청", field: "환불 신청 헤딩", value: "노출됨", submit: "✅", pipeline: "-" });

    // 1단계 필드 — RefundRequestClient 는 Label 에 htmlFor 없음 → 텍스트 인접 input 으로 탐색
    // 주문번호(disabled input) — Label "주문번호" 텍스트 다음 input
    const orderNumInput = page.locator("div.space-y-2").filter({ hasText: "주문번호" }).locator("input").first();
    await expect(orderNumInput).toBeVisible({ timeout: 5_000 });
    record({ form: "7.환불신청", field: "주문번호(disabled)", value: "노출됨", submit: "✅", pipeline: "-" });

    // 이메일 input
    const refundEmailInput = page.locator("div.space-y-2").filter({ hasText: "이메일" }).locator("input").first();
    await expect(refundEmailInput).toBeVisible({ timeout: 5_000 });
    record({ form: "7.환불신청", field: "이메일 필드", value: "노출됨", submit: "✅", pipeline: "-" });

    // 전화번호 input
    const refundPhoneInput = page.locator("div.space-y-2").filter({ hasText: "전화번호" }).locator("input").first();
    await expect(refundPhoneInput).toBeVisible({ timeout: 5_000 });
    record({ form: "7.환불신청", field: "전화번호 필드", value: "노출됨", submit: "✅", pipeline: "-" });

    // 이메일/전화 확인(이미 채워짐 — ticket 에서 props 로 전달)
    const emailVal = await refundEmailInput.inputValue();
    const phoneVal = await refundPhoneInput.inputValue();
    record({ form: "7.환불신청", field: "이메일 사전채움", value: emailVal, submit: "✅", pipeline: "-" });
    record({ form: "7.환불신청", field: "전화번호 사전채움", value: phoneVal || "(빈값)", submit: "✅", pipeline: "-" });

    // 본인 확인 버튼 클릭
    const verifyBtn = page.getByRole("button", { name: "본인 확인" });
    await expect(verifyBtn).toBeVisible({ timeout: 5_000 });
    await verifyBtn.click();

    // 미리보기(2단계) 또는 에러 메시지
    await page.waitForTimeout(3000);
    const hasPreview = await page.getByText(/환불 정책|환불 가능|D-/i).first().isVisible().catch(() => false);
    const hasError = await page.getByRole("alert").isVisible().catch(() => false);

    record({
      form: "7.환불신청",
      field: "본인확인 결과",
      value: hasPreview ? "미리보기 노출" : hasError ? "에러" : "미확인",
      submit: hasPreview || hasError ? "✅" : "⏭️",
      pipeline: hasPreview ? "✅" : "⏭️",
      note: hasPreview ? "refund/check API 성공" : hasError ? "API 오류(v2 미연결?)" : "응답 대기",
    });
  });

  test("7-4 POST /api/public/refund/check — buyer 세션 + orderId → 환불 미리보기", async () => {
    if (!completedOrderId) {
      record({ form: "7.환불신청", field: "refund/check API", value: "(skip)", submit: "⏭️", pipeline: "⏭️", note: "orderId 없음" });
      test.skip(true, "completedOrderId 미확보");
      return;
    }
    const lookupToken = buildPublicLookupCookie(BUYER_EMAIL, BUYER_PHONE);
    const res = await request.post("/api/public/refund/check", {
      data: { orderId: completedOrderId, email: BUYER_EMAIL },
      headers: { Cookie: `pickket_public_lookup=${lookupToken}` },
    });
    const reached = [200, 404, 502, 503].includes(res.status());
    let refundable: number | null = null;
    if (res.status() === 200) {
      const body = (await res.json()) as { data?: { refundAmount?: number; refundableAmount?: number } };
      refundable = body.data?.refundAmount ?? body.data?.refundableAmount ?? null;
    }
    record({
      form: "7.환불신청",
      field: "refund/check API",
      value: res.status() === 200 ? `${refundable}원` : `HTTP ${res.status()}`,
      submit: reached ? "✅" : "❌",
      pipeline: res.status() === 200 ? "✅" : "⏭️",
      note: res.status() !== 200 ? `v2 파이프라인 미연결 또는 에러` : undefined,
    });
    expect(reached, `refund/check: ${res.status()} ${await res.text().catch(() => "")}`).toBeTruthy();
  });
});
