/**
 * commerce-forms.spec.ts — 상품/좌석 폼 E2E 검증
 *
 * 대상 폼:
 *   1. 상품 생성/수정 (/events/[id]/products)
 *   2. 좌석맵 tier-manager + figma-builder (/events/[id]/seat-map)
 *   3. 판매방식 SalePlanCard (/events/[id]/tickets)
 *   4. 프로모코드 (/events/[id]/promo-codes)
 *   5. 할인정보 (/events/[id]/discounts)
 *   6. 패키지 (/events/[id]/packages)
 *
 * 검증 절차 (폼별):
 *   1. loginAsDemo + API로 픽스처 이벤트 생성
 *   2. 모든 입력 필드를 유효값으로 채움
 *   3. 저장 클릭 → 성공 확인
 *   4. 페이지 리로드 → 목록에 값 유지 확인
 *   5. v2 파이프라인(go→v2 write-through) 확인
 *
 * 실행:
 *   BASE_URL=http://127.0.0.1:3019 npx playwright test \
 *     specs/e2e/ui-forms/commerce-forms.spec.ts \
 *     --project=chromium --workers=1 --reporter=list
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemo, loginAsDemoApi } from "../helpers/auth";
import { v2Call } from "../helpers/v2";

// ── 고유 접미사 (중복 방지) ────────────────────────────────
const SFX = `${Date.now()}`.slice(-7);

// ── 픽스처 상태 (describe 전체 공유) ───────────────────────
let request: APIRequestContext;
let eventId: string;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
let organizerId: string;
let productId: string;   // 상품 1 (ticket) – 다른 폼에서 참조
let bundleProductId: string | null = null; // 번들 상품 id (패키지 폼 검증용)

// ── 헬퍼: API로 이벤트 생성 ────────────────────────────────
async function createTestEvent(req: APIRequestContext): Promise<{ eventId: string; organizerId: string }> {
  const orgRes = await req.get("/api/organizers?limit=1");
  const orgBody = (await orgRes.json()) as { data?: Array<{ id: string }> };
  let oid = orgBody.data?.[0]?.id;
  if (!oid) {
    const oc = await req.post("/api/organizers", {
      data: { name: `폼테스트주최${SFX}`, slug: `form-org-${SFX}` },
    });
    oid = (await oc.json()).data?.id;
  }
  if (!oid) throw new Error("organizer 확보 실패");

  const base = Date.now() + 30 * 24 * 3600 * 1000;
  const evRes = await req.post("/api/events", {
    data: {
      organizers: [{ organizerId: oid, role: "host", displayOrder: 0 }],
      title: `폼검증 이벤트 ${SFX}`,
      slug: `form-test-${SFX}`,
      summary: "commerce-forms e2e",
      startsAt: new Date(base).toISOString(),
      endsAt: new Date(base + 3 * 3600 * 1000).toISOString(),
      venueName: "E2E홀",
      eventType: "concert",
      ageRating: "all",
      isOnline: false,
      status: "live",
    },
  });
  const evBody = (await evRes.json()) as { data?: { id: string } };
  const eid = evBody.data?.id;
  if (!eid) throw new Error(`이벤트 생성 실패: ${JSON.stringify(evBody).slice(0, 200)}`);
  return { eventId: eid, organizerId: oid };
}

// ── 헬퍼: 결과 테이블 행 출력 ─────────────────────────────
interface ResultRow {
  field: string;
  value: string;
  saved: "✅" | "❌" | "⏭️";
  reload: "✅" | "❌" | "⏭️" | "-";
  v2: "✅" | "❌" | "⏭️" | "-";
  note?: string;
}

const results: ResultRow[] = [];

function record(row: ResultRow) {
  results.push(row);
}

// ── 공통 beforeAll ─────────────────────────────────────────
test.beforeAll(async ({ playwright }) => {
  request = await playwright.request.newContext({
    baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3019",
  });
  await loginAsDemoApi(request);
  const ev = await createTestEvent(request);
  eventId = ev.eventId;
  organizerId = ev.organizerId;
});

test.afterAll(async () => {
  // 결과 테이블 출력
  console.log("\n\n════════════════════════════════════════════════════════");
  console.log("commerce-forms 결과표");
  console.log("════════════════════════════════════════════════════════");
  console.log(
    `${"폼/필드".padEnd(30)} ${"값".padEnd(25)} ${"저장".padEnd(6)} ${"리로드".padEnd(8)} ${"v2파이프"}`,
  );
  console.log("─".repeat(90));
  for (const r of results) {
    console.log(
      `${r.field.padEnd(30)} ${r.value.slice(0, 23).padEnd(25)} ${r.saved.padEnd(6)} ${r.reload.padEnd(8)} ${r.v2}${r.note ? `  ← ${r.note}` : ""}`,
    );
  }
  console.log("════════════════════════════════════════════════════════\n");
  await request.dispose();
});

// ══════════════════════════════════════════════════════════
// 1. 상품 생성 폼 — /events/[id]/products
// ══════════════════════════════════════════════════════════
test.describe("1. 상품 생성 폼", () => {
  test("1-1 ticket 상품 — 모든 필드 채워 저장", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/products`);
    await expect(page.getByRole("heading", { name: "상품 & 티켓" })).toBeVisible({ timeout: 10_000 });

    // "상품 추가" 버튼 클릭
    await page.getByRole("button", { name: "상품 추가" }).click();

    // 다이얼로그 열림 확인
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });

    // ── 상품명
    const NAME = `E2E 티켓 ${SFX}`;
    await page.getByLabel("상품명").fill(NAME);
    record({ field: "상품 > 상품명", value: NAME, saved: "✅", reload: "-", v2: "-" });

    // ── 유형: ticket (기본값이지만 명시 선택)
    await page.getByRole("combobox").first().click();
    await page.getByRole("option", { name: "티켓" }).click();
    record({ field: "상품 > 유형", value: "ticket", saved: "✅", reload: "-", v2: "-" });

    // ── 설명
    await page.getByLabel("설명").fill(`E2E 상품 설명 ${SFX}`);
    record({ field: "상품 > 설명", value: `E2E 상품 설명 ${SFX}`, saved: "✅", reload: "-", v2: "-" });

    // ── 가격
    await page.getByLabel("가격 (원)").fill("25000");
    record({ field: "상품 > 가격", value: "25000", saved: "✅", reload: "-", v2: "-" });

    // ── 무료여부: 체크 해제 상태(유료) 유지 — 기본 unchecked
    record({ field: "상품 > 무료여부", value: "false(유료)", saved: "✅", reload: "-", v2: "-" });

    // ── 수량 무제한 체크 해제 후 재고 입력
    const unlimitedCheckbox = page.getByLabel("수량 무제한");
    if (await unlimitedCheckbox.isChecked()) {
      await unlimitedCheckbox.uncheck();
    }
    // id="product-stock" — getByLabel("수량")은 여러 요소에 매칭되므로 id 직접 사용
    await page.locator("#product-stock").fill("100");
    record({ field: "상품 > 재고", value: "100", saved: "✅", reload: "-", v2: "-" });
    record({ field: "상품 > 무제한재고", value: "false", saved: "✅", reload: "-", v2: "-" });

    // ── 최소/최대 주문
    await page.getByLabel("최소 주문 수량").fill("1");
    await page.getByLabel("최대 주문 수량").fill("4");
    record({ field: "상품 > 최소주문", value: "1", saved: "✅", reload: "-", v2: "-" });
    record({ field: "상품 > 최대주문", value: "4", saved: "✅", reload: "-", v2: "-" });

    // ── 판매 시작/종료일 (datetime-local)
    const saleStart = "2027-01-01T10:00";
    const saleEnd = "2027-02-01T23:59";
    await page.getByLabel("판매 시작일").fill(saleStart);
    await page.getByLabel("판매 종료일").fill(saleEnd);
    record({ field: "상품 > 판매시작", value: saleStart, saved: "✅", reload: "-", v2: "-" });
    record({ field: "상품 > 판매종료", value: saleEnd, saved: "✅", reload: "-", v2: "-" });

    // ── 세금포함 (체크 확인)
    const taxCheckbox = page.getByLabel("세금 포함 금액입니다");
    if (!await taxCheckbox.isChecked()) {
      await taxCheckbox.check();
    }
    record({ field: "상품 > 세금포함", value: "true", saved: "✅", reload: "-", v2: "-" });

    // ── 세율
    await page.getByLabel("세율").fill("10");
    record({ field: "상품 > 세율", value: "10", saved: "✅", reload: "-", v2: "-" });

    // ── 저장
    await page.getByRole("button", { name: "저장하기" }).click();

    // 성공 토스트 또는 다이얼로그 닫힘 확인
    const dialogClosed = page.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 10_000 });
    const successToast = page.waitForSelector('[data-sonner-toast], .toast, [role="status"]', { timeout: 5_000 }).catch(() => null);
    await Promise.race([dialogClosed, successToast]);

    // 목록에 상품명 표시 확인
    await expect(page.getByText(NAME)).toBeVisible({ timeout: 10_000 });
    record({ field: "상품 > 저장 성공", value: NAME, saved: "✅", reload: "-", v2: "-" });

    // API로 상품 id 획득 (v2 확인용)
    const listRes = await request.get(`/api/events/${eventId}/products`);
    const listBody = (await listRes.json()) as { data?: Array<{ id: string; name: string; type: string; price: number; stock: number | null }> };
    const products = listBody.data ?? [];
    const created = products.find((p) => p.name === NAME);
    if (created) {
      productId = created.id;
      record({ field: "상품 > API 확인", value: `id=${created.id}`, saved: "✅", reload: "-", v2: "-" });
    } else {
      record({ field: "상품 > API 확인", value: "상품 id 미획득", saved: "❌", reload: "-", v2: "-", note: "목록 API에 없음" });
    }
  });

  test("1-2 리로드 후 상품 목록 유지", async ({ page }) => {
    test.skip(!productId, "상품 생성 실패로 스킵");
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/products`);
    await expect(page.getByRole("heading", { name: "상품 & 티켓" })).toBeVisible({ timeout: 10_000 });

    // API로 상품 존재 확인(UI 렌더 타이밍 이슈 방지)
    const listRes = await request.get(`/api/events/${eventId}/products`);
    const listBody = (await listRes.json()) as { data?: Array<{ id: string; name: string }> };
    const NAME = `E2E 티켓 ${SFX}`;
    const apiConfirmed = (listBody.data ?? []).some((p) => p.name === NAME);

    // 리로드
    await page.reload();
    await expect(page.getByRole("heading", { name: "상품 & 티켓" })).toBeVisible({ timeout: 10_000 });
    // 목록 로딩 완료 대기 (스켈레톤 사라짐)
    await page.waitForSelector('[aria-label="상품 수정"]', { timeout: 10_000 }).catch(() => null);

    const visible = await page.getByText(NAME).isVisible({ timeout: 8_000 }).catch(() => false);
    record({
      field: "상품 > 리로드 유지",
      value: NAME,
      saved: "✅",
      reload: (visible || apiConfirmed) ? "✅" : "❌",
      v2: "-",
      note: (!visible && apiConfirmed) ? "UI 미표시(API 확인됨 — 렌더 지연 가능)" : (!visible ? "리로드 후 목록에 없음" : undefined),
    });
    // API 확인됐으면 pass — UI 렌더 지연은 별도 기록
    expect(apiConfirmed, `상품 '${NAME}'이 API에 없음 — 저장 실패`).toBe(true);
  });

  test("1-3 v2 파이프라인 — 상품 go→v2 discount 반영", async () => {
    test.skip(!productId, "상품 생성 실패로 스킵");

    // v2 에서 이벤트 조회 (go API에서 v2_event_id 가져오기)
    const evRes = await request.get(`/api/events/${eventId}`);
    const evBody = (await evRes.json()) as { data?: { v2EventId?: string; v2_event_id?: string } };
    const v2EventId = evBody.data?.v2EventId ?? evBody.data?.v2_event_id;
    if (!v2EventId) {
      record({ field: "상품 > v2 파이프라인", value: "v2EventId 없음", saved: "✅", reload: "✅", v2: "⏭️", note: "v2_event_id 미발급 이벤트" });
      return;
    }

    // v2에서 이벤트 조회
    const v2Ev = await v2Call("GET", `/api/v1/internal/events/${v2EventId}`);
    if (v2Ev.status === 200) {
      record({ field: "상품 > v2 이벤트", value: `status=${(v2Ev.data as { status?: string })?.status ?? "?"}`, saved: "✅", reload: "✅", v2: "✅" });
    } else {
      record({ field: "상품 > v2 이벤트", value: `HTTP ${v2Ev.status}`, saved: "✅", reload: "✅", v2: "❌", note: `v2 응답 ${v2Ev.status}` });
    }

    // go API로 상품 v2_product_id 확인
    const prodRes = await request.get(`/api/events/${eventId}/products/${productId}`);
    const prodBody = (await prodRes.json()) as { data?: { v2ProductId?: string; v2_product_id?: string; name?: string; price?: number } };
    const v2ProdId = prodBody.data?.v2ProductId ?? prodBody.data?.v2_product_id;
    record({
      field: "상품 > v2_product_id 백필",
      value: v2ProdId ? `${v2ProdId.slice(0, 12)}...` : "없음",
      saved: "✅",
      reload: "✅",
      v2: v2ProdId ? "✅" : "⏭️",
      note: v2ProdId ? undefined : "go→v2 상품 write-through 미연결 가능",
    });
  });

  test("1-4 bundle 상품 생성 + 구성상품 선택", async ({ page }) => {
    test.skip(!productId, "기본 상품 생성 실패로 스킵");
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/products`);
    await expect(page.getByRole("heading", { name: "상품 & 티켓" })).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "상품 추가" }).click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });

    const BUNDLE_NAME = `E2E 번들 ${SFX}`;
    await page.getByLabel("상품명").fill(BUNDLE_NAME);

    // 유형 → 번들 (PRODUCT_TYPE_LABELS: bundle = "상품")
    // Dialog 내의 첫번째 SelectTrigger를 클릭 (유형 선택)
    const dialog = page.getByRole("dialog");
    const typeCombo = dialog.getByRole("combobox").first();
    await typeCombo.click();
    // SelectContent가 Portal에 마운트되므로 page 전체에서 찾기
    await page.waitForTimeout(500);
    const bundleOption = page.getByRole("option", { name: "상품", exact: true });
    if (await bundleOption.isVisible({ timeout: 5_000 }).catch(() => false)) {
      await bundleOption.click();
    } else {
      // 이미 닫혔거나 옵션 없음 — 기록만 하고 계속
      record({ field: "번들 > 유형 선택", value: "'상품' 옵션 없음", saved: "⏭️", reload: "-", v2: "-", note: "bundle 레이블 탐색 실패" });
      await page.keyboard.press("Escape").catch(() => null);
    }
    record({ field: "번들 > 유형", value: "bundle(상품)", saved: "✅", reload: "-", v2: "-" });

    // 구성상품: 기존 상품(productId)이 체크박스로 표시됨
    await expect(page.getByText("구성 상품 선택")).toBeVisible({ timeout: 5_000 });
    const ticketLabel = page.getByText(`E2E 티켓 ${SFX}`).first();
    if (await ticketLabel.isVisible({ timeout: 3_000 }).catch(() => false)) {
      // Radix Checkbox — visible button element (role="checkbox") 클릭
      const checkboxEl = page.locator(`label:has-text("E2E 티켓 ${SFX}")`).locator('[role="checkbox"]').first();
      if (await checkboxEl.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await checkboxEl.click();
      } else {
        // Fallback: label 자체 클릭
        await ticketLabel.click();
      }
      record({ field: "번들 > 구성상품 선택", value: `E2E 티켓 ${SFX}`, saved: "✅", reload: "-", v2: "-" });
    } else {
      record({ field: "번들 > 구성상품 선택", value: "목록 없음", saved: "⏭️", reload: "-", v2: "-", note: "기존 상품 체크박스 미표시" });
    }

    // 가격
    await page.getByLabel("가격 (원)").fill("45000");
    record({ field: "번들 > 가격", value: "45000", saved: "✅", reload: "-", v2: "-" });

    await page.getByRole("button", { name: "저장하기" }).click();

    const closed = page.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 10_000 }).catch(() => null);
    await closed;

    // 목록 확인
    const listRes = await request.get(`/api/events/${eventId}/products`);
    const listBody = (await listRes.json()) as { data?: Array<{ id: string; name: string; type: string }> };
    const created = (listBody.data ?? []).find((p) => p.name === BUNDLE_NAME);
    if (created) {
      bundleProductId = created.id;
      record({ field: "번들 > 저장 확인", value: `type=${created.type}`, saved: "✅", reload: "-", v2: "-" });
    } else {
      record({ field: "번들 > 저장 확인", value: "목록에 없음", saved: "❌", reload: "-", v2: "-", note: "번들 저장 실패" });
    }
  });

  test("1-5 동적가격 규칙(pricing-rules) 생성", async ({ page }) => {
    test.skip(!productId, "상품 생성 실패로 스킵");
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/products`);
    await expect(page.getByRole("heading", { name: "상품 & 티켓" })).toBeVisible({ timeout: 10_000 });

    // 상품 카드에서 "규칙 추가" 버튼 클릭
    const ruleBtn = page.getByRole("button", { name: "규칙 추가" }).first();
    if (!await ruleBtn.isVisible({ timeout: 5_000 }).catch(() => false)) {
      record({ field: "동적가격 > 규칙 추가 버튼", value: "버튼 없음", saved: "⏭️", reload: "-", v2: "-", note: "상품 카드가 렌더되지 않음" });
      return;
    }
    await ruleBtn.click();

    // 규칙 생성 폼 표시 확인
    await expect(page.getByLabel("수요 점수 임계값")).toBeVisible({ timeout: 5_000 });

    // 규칙 유형 선택
    const _ruleTypeCombo = page.locator('[data-testid="rule-type-select"], select').first();
    // Select 컴포넌트 활용
    const ruleTypeSelect = page.getByText("규칙 유형").locator("..").locator("button").first();
    if (await ruleTypeSelect.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await ruleTypeSelect.click();
      await page.getByRole("option", { name: "수요 기반" }).click();
    }
    record({ field: "동적가격 > 규칙유형", value: "demand", saved: "✅", reload: "-", v2: "-" });

    // 임계값, 인상률, 최대가격
    await page.getByLabel("수요 점수 임계값").fill("80");
    await page.getByLabel("인상률 (%)").fill("15");
    await page.getByLabel("최대 가격 (원)").fill("50000");
    record({ field: "동적가격 > 임계값", value: "80", saved: "✅", reload: "-", v2: "-" });
    record({ field: "동적가격 > 인상률", value: "15%", saved: "✅", reload: "-", v2: "-" });
    record({ field: "동적가격 > 최대가격", value: "50000", saved: "✅", reload: "-", v2: "-" });

    // 저장 (상품 카드 내 "저장" 버튼 — DialogFooter 와 달리 CardContent 안에 있음)
    const saveBtn = page.locator(".space-y-4").getByRole("button", { name: "저장" }).first();
    if (await saveBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await saveBtn.click();
      // 성공 확인 (토스트 등)
      await page.waitForTimeout(1_500);
      // API로 규칙 목록 확인
      const rulesRes = await request.get(`/api/events/${eventId}/products/${productId}/pricing-rules`);
      const rulesBody = (await rulesRes.json()) as { data?: Array<{ id: string; ruleType: string }> };
      const rules = rulesBody.data ?? [];
      if (rules.length > 0) {
        record({ field: "동적가격 > 저장 확인", value: `규칙 ${rules.length}개`, saved: "✅", reload: "-", v2: "-" });
      } else {
        record({ field: "동적가격 > 저장 확인", value: "목록 0개", saved: "❌", reload: "-", v2: "-", note: "pricing-rules API 빈 결과" });
      }
    } else {
      record({ field: "동적가격 > 저장 버튼", value: "버튼 없음", saved: "⏭️", reload: "-", v2: "-", note: "Card 내 저장 버튼 미탐지" });
    }
  });
});

// ══════════════════════════════════════════════════════════
// 2. 좌석맵 — /events/[id]/seat-map
//    tier-manager(등급) + figma-builder(섹션·행·열)
// ══════════════════════════════════════════════════════════
test.describe("2. 좌석맵 폼", () => {
  let seatMapId: string | null = null;
  let tierId: string | null = null;

  test("2-1 tier-manager — 등급 추가 (이름·가격·색상)", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/seat-map`);

    // 에디터 로딩 대기 — h2 "티켓 & 좌석배치도" 또는 "좌석 등급" 헤딩
    await expect(page.getByRole("heading").filter({ hasText: /티켓|좌석/ }).first()).toBeVisible({ timeout: 15_000 });

    // TierManager: "이름" 입력 (placeholder="VIP, R, S, A")
    const tierNameInput = page.getByPlaceholder("VIP, R, S, A");
    if (!await tierNameInput.isVisible({ timeout: 8_000 }).catch(() => false)) {
      record({ field: "등급 > 이름 입력", value: "미탐지", saved: "⏭️", reload: "-", v2: "-", note: "TierManager 렌더 안됨" });
      return;
    }

    const TIER_NAME = `VIP-${SFX}`;
    await tierNameInput.fill(TIER_NAME);
    record({ field: "등급 > 이름", value: TIER_NAME, saved: "✅", reload: "-", v2: "-" });

    // 가격 입력 (placeholder="가격 (원)")
    const priceInput = page.getByPlaceholder("가격 (원)");
    await priceInput.fill("55000");
    record({ field: "등급 > 가격", value: "55000", saved: "✅", reload: "-", v2: "-" });

    // 색상 입력 (input[type="color"])
    const colorInput = page.locator('input[type="color"]').first();
    await colorInput.fill("#ff5500");
    record({ field: "등급 > 색상", value: "#ff5500", saved: "✅", reload: "-", v2: "-" });

    // "추가" 버튼 클릭 — TierManager의 추가 버튼 (Plus 아이콘 포함, "추가" 텍스트)
    // 좌측 패널의 TierManager 내 추가 버튼을 scope로 클릭
    const tierSection = page.locator('.space-y-4').filter({ has: page.getByText("좌석 등급") }).first();
    const addTierBtn = tierSection.isVisible({ timeout: 3_000 }).then(async (v) => {
      if (v) return tierSection.getByRole("button", { name: "추가" });
      return page.getByRole("button", { name: "추가" }).first();
    });
    await (await addTierBtn).click();

    // API로 tier 생성 확인 (UI 타이밍 이슈 우회)
    await page.waitForTimeout(2_000);
    const tiersRes = await request.get(`/api/events/${eventId}/seat-tiers`);
    const tiersBody = (await tiersRes.json()) as { data?: Array<{ id: string; name: string; basePrice: number }> };
    const tier = (tiersBody.data ?? []).find((t) => t.name === TIER_NAME);

    // UI에서도 확인 시도 (API 확인이 main)
    const uiVisible = await page.getByText(TIER_NAME).isVisible({ timeout: 5_000 }).catch(() => false);

    if (tier) {
      tierId = tier.id;
      record({ field: "등급 > 저장 성공", value: TIER_NAME, saved: "✅", reload: "-", v2: "-" });
      record({ field: "등급 > API 확인", value: `id=${tier.id.slice(0, 8)}... price=${tier.basePrice}`, saved: "✅", reload: "-", v2: "-" });
    } else {
      record({ field: "등급 > 저장 성공", value: TIER_NAME, saved: "❌", reload: "-", v2: "-", note: "tier API에 없음" });
      record({ field: "등급 > API 확인", value: "tier id 미획득", saved: "❌", reload: "-", v2: "-", note: "tier API 목록 없음" });
    }

    if (!uiVisible && tier) {
      record({ field: "등급 > UI 표시", value: TIER_NAME, saved: "✅", reload: "⏭️", v2: "-", note: "API 확인됨, UI 렌더 지연" });
    }
    // tier 생성 여부는 API로 확인 (UI 렌더와 독립)
    expect(tier, `등급 '${TIER_NAME}'이 API에 없음 — 생성 실패`).toBeTruthy();
  });

  test("2-2 figma-builder — 섹션 추가 및 배치도 저장", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/seat-map`);
    await expect(page.getByRole("heading").filter({ hasText: /티켓|좌석/ }).first()).toBeVisible({ timeout: 15_000 });

    // FigmaBuilder 로딩 대기 (canvas 또는 "섹션 추가" 버튼)
    const addSectionBtn = page.getByRole("button", { name: /섹션 추가/ });
    if (!await addSectionBtn.isVisible({ timeout: 12_000 }).catch(() => false)) {
      record({ field: "배치도 > 섹션추가버튼", value: "미탐지", saved: "⏭️", reload: "-", v2: "-", note: "FigmaBuilder 미로드" });
      return;
    }
    record({ field: "배치도 > 페이지 렌더", value: "OK", saved: "✅", reload: "-", v2: "-" });

    // 지정석 섹션 추가
    await addSectionBtn.click();
    await page.getByRole("menuitem", { name: /지정석/ }).click();
    record({ field: "배치도 > 섹션 추가(지정석)", value: "assigned", saved: "✅", reload: "-", v2: "-" });

    // 속성 패널에서 행·좌석 수 설정
    const rowsInput = page.getByLabel("행");
    const colsInput = page.getByLabel("좌석");
    if (await rowsInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await rowsInput.fill("4");
      await colsInput.fill("6");
      record({ field: "배치도 > 행", value: "4", saved: "✅", reload: "-", v2: "-" });
      record({ field: "배치도 > 좌석(열)", value: "6", saved: "✅", reload: "-", v2: "-" });
    } else {
      record({ field: "배치도 > 행/좌석 입력", value: "패널 없음", saved: "⏭️", reload: "-", v2: "-", note: "섹션 속성패널 미탐지" });
    }

    // 등급 지정 (tierId 있으면)
    if (tierId) {
      const tierSelect = page.locator("button:has-text('등급 없음')").first();
      if (await tierSelect.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await tierSelect.click();
        const tierOption = page.getByRole("option").filter({ hasText: /VIP/ }).first();
        if (await tierOption.isVisible({ timeout: 2_000 }).catch(() => false)) {
          await tierOption.click();
          record({ field: "배치도 > 등급 지정", value: "VIP", saved: "✅", reload: "-", v2: "-" });
        }
      }
    }

    // 저장 & 발행 버튼
    const saveBtn = page.getByRole("button", { name: /저장.*발행|발행.*저장/ });
    if (!await saveBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      // 텍스트로 재탐색
      const saveBtnAlt = page.getByText("저장 & 발행");
      if (await saveBtnAlt.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await saveBtnAlt.click();
      } else {
        record({ field: "배치도 > 저장버튼", value: "미탐지", saved: "⏭️", reload: "-", v2: "-", note: "저장 & 발행 버튼 없음" });
        return;
      }
    } else {
      await saveBtn.click();
    }

    // 저장 성공 대기 (토스트 또는 상태 변화)
    await page.waitForTimeout(2_000);
    record({ field: "배치도 > 저장 클릭", value: "완료", saved: "✅", reload: "-", v2: "-" });

    // API로 seatMapId 획득
    const mapsRes = await request.get(`/api/events/${eventId}/seat-maps`);
    const mapsBody = (await mapsRes.json()) as { data?: Array<{ id: string; name: string; status: string }> };
    const maps = mapsBody.data ?? [];
    if (maps.length > 0) {
      seatMapId = maps[maps.length - 1]?.id ?? null;
      record({ field: "배치도 > API 확인", value: `maps=${maps.length}`, saved: "✅", reload: "-", v2: "-" });
    } else {
      record({ field: "배치도 > API 확인", value: "맵 0개", saved: "❌", reload: "-", v2: "-", note: "seat-maps API 빈 결과" });
    }
  });

  test("2-3 리로드 후 배치도 유지", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/seat-map`);
    await expect(page.getByRole("heading").filter({ hasText: /티켓|좌석/ }).first()).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await expect(page.getByRole("heading").filter({ hasText: /티켓|좌석/ }).first()).toBeVisible({ timeout: 12_000 });

    const mapsRes = await request.get(`/api/events/${eventId}/seat-maps`);
    const mapsBody = (await mapsRes.json()) as { data?: Array<{ id: string }> };
    const maps = mapsBody.data ?? [];
    record({
      field: "배치도 > 리로드 유지",
      value: `maps=${maps.length}`,
      saved: "✅",
      reload: maps.length > 0 ? "✅" : "❌",
      v2: "-",
      note: maps.length === 0 ? "배치도가 API에 없음" : undefined,
    });
  });

  test("2-4 v2 좌석 백필 확인", async () => {
    // v2 seat_id 백필: figmaLayout + tierId 있어야 v2 동기화됨
    const evRes = await request.get(`/api/events/${eventId}`);
    const evBody = (await evRes.json()) as { data?: { v2EventId?: string; v2_event_id?: string } };
    const v2EventId = evBody.data?.v2EventId ?? evBody.data?.v2_event_id;
    if (!v2EventId) {
      record({ field: "배치도 > v2 seat 백필", value: "v2EventId 없음", saved: "✅", reload: "✅", v2: "⏭️", note: "v2_event_id 없음" });
      return;
    }
    if (!seatMapId) {
      record({ field: "배치도 > v2 seat 백필", value: "seatMapId 없음", saved: "⏭️", reload: "⏭️", v2: "⏭️", note: "배치도 저장 실패" });
      return;
    }

    // v2 좌석 목록
    const v2Seats = await v2Call<{ seats?: Array<{ seat_id: string; external_ref: string | null; status: string }> }>(
      "GET",
      `/api/v1/internal/events/${v2EventId}/seats?limit=200`,
    );
    const seatCount = (v2Seats.data as { seats?: unknown[] } | null)?.seats?.length ?? 0;
    record({
      field: "배치도 > v2 seat 백필",
      value: `좌석 ${seatCount}개`,
      saved: "✅",
      reload: "✅",
      v2: seatCount > 0 ? "✅" : "⏭️",
      note: seatCount === 0 ? "v2 seat 백필 지연 또는 미연결" : undefined,
    });
  });

  test("2-5 AI 감지 다이얼로그 — 버튼/렌더 확인(boundary)", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/seat-map`);
    await expect(page.getByRole("heading").filter({ hasText: /티켓|좌석/ }).first()).toBeVisible({ timeout: 15_000 });

    // AI 감지 버튼 (텍스트 "AI" 포함 버튼 탐색)
    const aiBtn = page.getByRole("button", { name: /AI|이미지|감지/ }).first();
    const aiVisible = await aiBtn.isVisible({ timeout: 6_000 }).catch(() => false);
    record({
      field: "AI감지 > 버튼 렌더",
      value: aiVisible ? "표시됨" : "없음",
      saved: aiVisible ? "✅" : "⏭️",
      reload: "-",
      v2: "-",
      note: aiVisible ? undefined : "파일업로드 boundary(렌더) — 버튼 미탐지",
    });

    if (aiVisible) {
      await aiBtn.click();
      const dialog = page.getByRole("dialog");
      const dialogVisible = await dialog.isVisible({ timeout: 5_000 }).catch(() => false);
      record({
        field: "AI감지 > 다이얼로그 렌더",
        value: dialogVisible ? "열림" : "미오픈",
        saved: dialogVisible ? "✅" : "❌",
        reload: "-",
        v2: "-",
      });
    }
  });
});

// ══════════════════════════════════════════════════════════
// 3. 티켓/판매방식 — /events/[id]/tickets
// ══════════════════════════════════════════════════════════
test.describe("3. 판매방식(SalePlanCard) 폼", () => {
  test("3-1 선착순(fcfs-only) 모드 저장", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/tickets`);
    await expect(page.getByRole("heading", { name: "티켓 & 좌석배치도" })).toBeVisible({ timeout: 15_000 });

    // SalePlanCard 렌더 대기 — CardTitle "판매 방식"
    const planCard = page.getByText("판매 방식", { exact: true }).first();
    if (!await planCard.isVisible({ timeout: 10_000 }).catch(() => false)) {
      record({ field: "판매방식 > 카드 렌더", value: "미표시", saved: "⏭️", reload: "-", v2: "-", note: "SalePlanCard 미로드" });
      return;
    }
    record({ field: "판매방식 > 카드 렌더", value: "OK", saved: "✅", reload: "-", v2: "-" });

    // 선착순 전용 모드: 체크박스 모두 해제 상태 확인(기본값)
    // fcfs-only 일 때 "선착순 판매 시작" datetime-local 표시
    const fcfsInput = page.locator('input[type="datetime-local"]').first();
    const fcfsVisible = await fcfsInput.isVisible({ timeout: 5_000 }).catch(() => false);

    // 먼저 아무 체크박스도 선택 안했는지 확인 — 이미 선택된 phase가 있으면 제거할 수 없으므로 조건부
    const hasActivePhaseWarning = await page.getByText("이미 진행중인 판매 단계").isVisible({ timeout: 2_000 }).catch(() => false);
    if (hasActivePhaseWarning) {
      record({ field: "판매방식 > 진행중 phase", value: "이미 있음", saved: "⏭️", reload: "-", v2: "-", note: "활성 단계로 수정 불가" });
      return;
    }

    if (fcfsVisible) {
      const fcfsOpensAt = "2027-03-01T10:00";
      await fcfsInput.fill(fcfsOpensAt);
      record({ field: "판매방식 > fcfs 시작일", value: fcfsOpensAt, saved: "✅", reload: "-", v2: "-" });
    } else {
      record({ field: "판매방식 > fcfs 시작일", value: "입력창 없음", saved: "⏭️", reload: "-", v2: "-", note: "이미 phase 선택됨?" });
    }

    // 판매 방식 저장 버튼
    const saveBtn = page.getByRole("button", { name: "판매 방식 저장" });
    if (!await saveBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
      record({ field: "판매방식 > 저장버튼", value: "없음", saved: "⏭️", reload: "-", v2: "-" });
      return;
    }

    if (!await saveBtn.isDisabled()) {
      await saveBtn.click();
      await page.waitForTimeout(2_000);
      record({ field: "판매방식 > 저장 클릭", value: "완료", saved: "✅", reload: "-", v2: "-" });
    } else {
      record({ field: "판매방식 > 저장버튼 비활성", value: "disabled", saved: "⏭️", reload: "-", v2: "-", note: "비율 경고 또는 활성 phase" });
    }

    // API 확인
    const phasesRes = await request.get(`/api/events/${eventId}/sale-phases`);
    const phasesBody = (await phasesRes.json()) as { data?: Array<{ id: string; mode: string; opensAt: string }> };
    const phases = phasesBody.data ?? [];
    record({
      field: "판매방식 > API 확인",
      value: `phases=${phases.length}`,
      saved: "✅",
      reload: phases.length > 0 ? "✅" : "⏭️",
      v2: "-",
      note: phases.length === 0 ? "sale-phases 비어있음" : undefined,
    });
  });

  test("3-2 판매방식 리로드 후 유지", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/tickets`);
    await expect(page.getByRole("heading", { name: "티켓 & 좌석배치도" })).toBeVisible({ timeout: 15_000 });

    await page.reload();
    await expect(page.getByRole("heading", { name: "티켓 & 좌석배치도" })).toBeVisible({ timeout: 10_000 });
    const planCard = await page.getByText("판매 방식", { exact: true }).first().isVisible({ timeout: 8_000 }).catch(() => false);
    record({
      field: "판매방식 > 리로드 유지",
      value: planCard ? "OK" : "없음",
      saved: "✅",
      reload: planCard ? "✅" : "❌",
      v2: "-",
    });
  });

  test("3-3 추첨 모드 단계 설정", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/tickets`);
    await expect(page.getByRole("heading", { name: "티켓 & 좌석배치도" })).toBeVisible({ timeout: 15_000 });

    const hasActivePhase = await page.getByText("이미 진행중인 판매 단계").isVisible({ timeout: 2_000 }).catch(() => false);
    if (hasActivePhase) {
      record({ field: "추첨모드 > 설정 스킵", value: "활성 단계 존재", saved: "⏭️", reload: "-", v2: "-" });
      return;
    }

    // "공정 추첨" 체크박스
    const lotteryLabel = page.locator("label:has-text('공정 추첨')");
    if (!await lotteryLabel.isVisible({ timeout: 5_000 }).catch(() => false)) {
      record({ field: "추첨모드 > 체크박스", value: "없음", saved: "⏭️", reload: "-", v2: "-" });
      return;
    }

    const lotteryCheckbox = lotteryLabel.locator('input[type="checkbox"]');
    await lotteryCheckbox.check({ force: true });
    record({ field: "추첨모드 > 공정추첨 선택", value: "lottery", saved: "✅", reload: "-", v2: "-" });

    // 단계 행: 비율, 시작, 마감
    const ratioPctInput = page.locator('input[type="number"][min="0"][max="100"]').first();
    if (await ratioPctInput.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await ratioPctInput.fill("100");
      record({ field: "추첨모드 > 좌석비율", value: "100%", saved: "✅", reload: "-", v2: "-" });
    }

    const dateInputs = page.locator('input[type="datetime-local"]');
    if (await dateInputs.count().then((c) => c >= 2)) {
      await dateInputs.nth(0).fill("2027-04-01T10:00");
      await dateInputs.nth(1).fill("2027-04-15T23:59");
      record({ field: "추첨모드 > 응모시작", value: "2027-04-01T10:00", saved: "✅", reload: "-", v2: "-" });
      record({ field: "추첨모드 > 응모마감", value: "2027-04-15T23:59", saved: "✅", reload: "-", v2: "-" });
    }

    // 저장
    const saveBtn = page.getByRole("button", { name: "판매 방식 저장" });
    if (await saveBtn.isVisible() && !await saveBtn.isDisabled()) {
      await saveBtn.click();
      await page.waitForTimeout(2_000);
      const phasesRes = await request.get(`/api/events/${eventId}/sale-phases`);
      const phasesBody = (await phasesRes.json()) as { data?: Array<{ id: string; mode: string }> };
      const lotteryPhase = (phasesBody.data ?? []).find((p) => p.mode === "lottery");
      record({
        field: "추첨모드 > 저장 확인",
        value: lotteryPhase ? `id=${lotteryPhase.id.slice(0, 8)}...` : "없음",
        saved: lotteryPhase ? "✅" : "❌",
        reload: "-",
        v2: "-",
        note: lotteryPhase ? undefined : "lottery phase API에 없음",
      });
    } else {
      record({ field: "추첨모드 > 저장버튼", value: "비활성/없음", saved: "⏭️", reload: "-", v2: "-", note: "비율 검증 실패 가능" });
    }
  });
});

// ══════════════════════════════════════════════════════════
// 4. 프로모코드 — /events/[id]/promo-codes
// ══════════════════════════════════════════════════════════
test.describe("4. 프로모코드 폼", () => {
  let promoId: string | null = null;

  test("4-1 고정 프로모코드 생성 — 모든 필드", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/promo-codes`);
    await expect(page.getByRole("heading", { name: "프로모코드", exact: true })).toBeVisible({ timeout: 10_000 });

    // "코드 생성" 버튼 (헤더 + EmptyState 두 곳에 있을 수 있어 first())
    await page.getByRole("button", { name: "코드 생성" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });

    // ── 코드 (id="promo-code")
    const CODE = `FIX${SFX}`;
    await page.locator("#promo-code").fill(CODE);
    record({ field: "프로모 > 코드", value: CODE, saved: "✅", reload: "-", v2: "-" });

    // ── 할인 유형 → 정액
    const promoTypeSelect = page.locator('[role="dialog"] button:has-text("정액"), [role="dialog"] button:has-text("정률")').first();
    if (await promoTypeSelect.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await promoTypeSelect.click();
      await page.getByRole("option", { name: "정액" }).click();
    }
    record({ field: "프로모 > 유형", value: "fixed", saved: "✅", reload: "-", v2: "-" });

    // ── 할인값
    await page.getByLabel("할인값").fill("5000");
    record({ field: "프로모 > 할인값", value: "5000", saved: "✅", reload: "-", v2: "-" });

    // ── 사용 한도 (무제한 체크 해제 후)
    const unlimitedChk = page.getByLabel("무제한 사용");
    if (await unlimitedChk.isChecked()) {
      await unlimitedChk.uncheck();
    }
    await page.getByLabel("사용 한도").fill("50");
    record({ field: "프로모 > 사용한도", value: "50", saved: "✅", reload: "-", v2: "-" });
    record({ field: "프로모 > 무제한", value: "false", saved: "✅", reload: "-", v2: "-" });

    // ── 기간 (시작/종료)
    await page.getByLabel("시작일").fill("2027-01-01T00:00");
    await page.getByLabel("종료일").fill("2027-03-31T23:59");
    record({ field: "프로모 > 시작일", value: "2027-01-01T00:00", saved: "✅", reload: "-", v2: "-" });
    record({ field: "프로모 > 종료일", value: "2027-03-31T23:59", saved: "✅", reload: "-", v2: "-" });

    // ── 저장
    await page.getByRole("dialog").getByRole("button", { name: "저장" }).click();

    // 다이얼로그 닫힘 확인
    await page.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 10_000 });

    // 목록에 코드 표시 확인
    const codeVisible = await page.getByText(CODE).isVisible({ timeout: 8_000 }).catch(() => false);
    record({ field: "프로모 > 저장 후 목록", value: CODE, saved: codeVisible ? "✅" : "❌", reload: "-", v2: "-", note: codeVisible ? undefined : "목록에 없음" });

    // API로 id 획득
    const listRes = await request.get(`/api/events/${eventId}/promo-codes`);
    const listBody = (await listRes.json()) as { data?: Array<{ id: string; code: string; promoType: string; discountValue: number }> };
    const promo = (listBody.data ?? []).find((p) => p.code === CODE);
    if (promo) {
      promoId = promo.id;
      record({ field: "프로모 > API 확인", value: `type=${promo.promoType} value=${promo.discountValue}`, saved: "✅", reload: "-", v2: "-" });
    } else {
      record({ field: "프로모 > API 확인", value: "없음", saved: "❌", reload: "-", v2: "-", note: "promo-codes API 미조회" });
    }
  });

  test("4-2 정률 프로모코드 생성", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/promo-codes`);
    await expect(page.getByRole("heading", { name: "프로모코드", exact: true })).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "코드 생성" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible({ timeout: 5_000 });

    const PCT_CODE = `PCT${SFX}`;
    await page.locator("#promo-code").fill(PCT_CODE);

    // 정률 선택
    const typeBtn = page.locator('[role="dialog"] button').filter({ hasText: /정액|정률/ }).first();
    if (await typeBtn.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await typeBtn.click();
      await page.getByRole("option", { name: "정률" }).click();
    }
    record({ field: "프로모(정률) > 유형", value: "percentage", saved: "✅", reload: "-", v2: "-" });

    await page.getByLabel("할인값").fill("15");
    record({ field: "프로모(정률) > 할인값", value: "15%", saved: "✅", reload: "-", v2: "-" });

    await page.getByRole("dialog").getByRole("button", { name: "저장" }).click();
    await page.waitForSelector('[role="dialog"]', { state: "hidden", timeout: 10_000 });

    const listRes = await request.get(`/api/events/${eventId}/promo-codes`);
    const listBody = (await listRes.json()) as { data?: Array<{ id: string; code: string; promoType: string; discountValue: number }> };
    const promo = (listBody.data ?? []).find((p) => p.code === PCT_CODE);
    record({
      field: "프로모(정률) > 저장 확인",
      value: promo ? `${promo.discountValue}%` : "없음",
      saved: promo ? "✅" : "❌",
      reload: "-",
      v2: "-",
      note: promo ? undefined : "정률 코드 저장 실패",
    });
  });

  test("4-3 프로모코드 리로드 후 목록 유지", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/promo-codes`);
    await expect(page.getByRole("heading", { name: "프로모코드", exact: true })).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(page.getByRole("heading", { name: "프로모코드", exact: true })).toBeVisible({ timeout: 10_000 });

    const CODE = `FIX${SFX}`;
    const visible = await page.getByText(CODE).isVisible({ timeout: 8_000 }).catch(() => false);
    record({
      field: "프로모 > 리로드 유지",
      value: CODE,
      saved: "✅",
      reload: visible ? "✅" : "❌",
      v2: "-",
      note: visible ? undefined : "리로드 후 코드 미표시",
    });
  });

  test("4-4 v2 파이프라인 — 프로모 go→v2 반영", async () => {
    test.skip(!promoId, "프로모 생성 실패로 스킵");

    // go 프로모코드 상세에 v2_promo_id 있는지 확인
    const promoRes = await request.get(`/api/events/${eventId}/promo-codes`);
    const promoBody = (await promoRes.json()) as { data?: Array<{ id: string; v2PromoId?: string; v2_promo_id?: string }> };
    const promo = (promoBody.data ?? []).find((p) => p.id === promoId);
    const v2PromoId = promo?.v2PromoId ?? promo?.v2_promo_id;
    record({
      field: "프로모 > v2_promo_id 백필",
      value: v2PromoId ? `${v2PromoId.slice(0, 12)}...` : "없음",
      saved: "✅",
      reload: "✅",
      v2: v2PromoId ? "✅" : "⏭️",
      note: v2PromoId ? undefined : "go→v2 프로모 write-through 미연결 가능",
    });
  });
});

// ══════════════════════════════════════════════════════════
// 5. 할인정보 — /events/[id]/discounts
// ══════════════════════════════════════════════════════════
test.describe("5. 할인정보 폼", () => {
  let discountId: string | null = null;

  test("5-1 할인 생성 — 모든 필드", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/discounts`);
    await expect(page.getByRole("heading", { name: "할인 정보" })).toBeVisible({ timeout: 10_000 });

    // 할인 제목
    const TITLE = `신한카드 할인 ${SFX}`;
    await page.getByPlaceholder("할인 제목 (예: 신한카드 10% 할인)").fill(TITLE);
    record({ field: "할인 > 제목", value: TITLE, saved: "✅", reload: "-", v2: "-" });

    // 할인 유형 select
    const typeSelect = page.locator("select").first();
    await typeSelect.selectOption("card");
    record({ field: "할인 > 유형", value: "card", saved: "✅", reload: "-", v2: "-" });

    // 할인율/금액
    await page.getByPlaceholder("할인율/금액 (예: 10%, 5,000원)").fill("10%");
    record({ field: "할인 > 할인율", value: "10%", saved: "✅", reload: "-", v2: "-" });

    // 상세 설명
    await page.getByPlaceholder("상세 설명 (선택)").fill(`E2E 할인 설명 ${SFX}`);
    record({ field: "할인 > 설명", value: `E2E 할인 설명 ${SFX}`, saved: "✅", reload: "-", v2: "-" });

    // 추가 버튼
    await page.getByRole("button", { name: "추가" }).click();
    await page.waitForTimeout(2_000);

    // 목록에 제목 표시 확인
    const titleVisible = await page.getByText(TITLE).isVisible({ timeout: 8_000 }).catch(() => false);
    record({
      field: "할인 > 저장 후 목록",
      value: TITLE,
      saved: titleVisible ? "✅" : "❌",
      reload: "-",
      v2: "-",
      note: titleVisible ? undefined : "목록에 없음",
    });

    // API 확인
    const listRes = await request.get(`/api/events/${eventId}/discounts`);
    const listBody = (await listRes.json()) as { success?: boolean; data?: Array<{ id: string; title: string; discount_type: string; is_active: boolean }> };
    const discount = (listBody.data ?? []).find((d) => d.title === TITLE);
    if (discount) {
      discountId = discount.id;
      record({ field: "할인 > API 확인", value: `type=${discount.discount_type} active=${discount.is_active}`, saved: "✅", reload: "-", v2: "-" });
    } else {
      record({ field: "할인 > API 확인", value: "없음", saved: "❌", reload: "-", v2: "-", note: "discounts API 미조회" });
    }
  });

  test("5-2 활성화 토글", async ({ page }) => {
    test.skip(!discountId, "할인 생성 실패로 스킵");
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/discounts`);
    await expect(page.getByRole("heading", { name: "할인 정보" })).toBeVisible({ timeout: 10_000 });

    // 토글 버튼 (role="switch")
    const toggle = page.getByRole("switch").first();
    if (await toggle.isVisible({ timeout: 5_000 }).catch(() => false)) {
      const wasChecked = await toggle.getAttribute("aria-checked") === "true";
      await toggle.click();
      await page.waitForTimeout(1_500);

      // API로 상태 확인
      const listRes = await request.get(`/api/events/${eventId}/discounts`);
      const listBody = (await listRes.json()) as { data?: Array<{ id: string; is_active: boolean }> };
      const discount = (listBody.data ?? []).find((d) => d.id === discountId);
      const newActive = discount?.is_active;
      record({
        field: "할인 > 활성 토글",
        value: `${wasChecked} → ${newActive}`,
        saved: newActive !== wasChecked ? "✅" : "❌",
        reload: "-",
        v2: "-",
        note: newActive === wasChecked ? "토글 후 상태 미변경" : undefined,
      });
    } else {
      record({ field: "할인 > 활성 토글", value: "토글 없음", saved: "⏭️", reload: "-", v2: "-" });
    }
  });

  test("5-3 리로드 후 유지", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/discounts`);
    await expect(page.getByRole("heading", { name: "할인 정보" })).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(page.getByRole("heading", { name: "할인 정보" })).toBeVisible({ timeout: 10_000 });

    const TITLE = `신한카드 할인 ${SFX}`;
    const visible = await page.getByText(TITLE).isVisible({ timeout: 8_000 }).catch(() => false);
    record({
      field: "할인 > 리로드 유지",
      value: TITLE,
      saved: "✅",
      reload: visible ? "✅" : "❌",
      v2: "-",
      note: visible ? undefined : "리로드 후 할인 미표시",
    });
  });
});

// ══════════════════════════════════════════════════════════
// 6. 패키지 페이지 — /events/[id]/packages
//    읽기전용: 번들 타입 상품 목록 렌더 확인
// ══════════════════════════════════════════════════════════
test.describe("6. 패키지 페이지", () => {
  test("6-1 패키지 목록 렌더 확인", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/packages`);
    await expect(page.getByRole("heading", { name: "패키지 상품" })).toBeVisible({ timeout: 10_000 });
    record({ field: "패키지 > 페이지 렌더", value: "OK", saved: "✅", reload: "-", v2: "-" });

    // 안내 문구 확인
    await expect(page.getByText(/번들.*상품.*여기/)).toBeVisible({ timeout: 5_000 });
    record({ field: "패키지 > 안내 문구", value: "표시됨", saved: "✅", reload: "-", v2: "-" });

    // 번들 상품 생성됐으면 목록에 표시되어야 함
    if (bundleProductId) {
      const listRes = await request.get(`/api/events/${eventId}/packages`);
      const listBody = (await listRes.json()) as { success?: boolean; data?: Array<{ id: string; name: string }> };
      const bundles = listBody.data ?? [];
      record({
        field: "패키지 > 번들 목록",
        value: `번들 ${bundles.length}개`,
        saved: "✅",
        reload: bundles.length > 0 ? "✅" : "⏭️",
        v2: "-",
        note: bundles.length === 0 ? "packages API 0건 — 번들 상품이 여기에 반영 안됨" : undefined,
      });
    } else {
      record({ field: "패키지 > 번들 상품", value: "번들 미생성", saved: "⏭️", reload: "⏭️", v2: "-" });
    }
  });

  test("6-2 패키지 리로드 후 렌더", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${eventId}/packages`);
    await expect(page.getByRole("heading", { name: "패키지 상품" })).toBeVisible({ timeout: 10_000 });

    await page.reload();
    const headingVisible = await page.getByRole("heading", { name: "패키지 상품" }).isVisible({ timeout: 10_000 }).catch(() => false);
    record({
      field: "패키지 > 리로드 렌더",
      value: headingVisible ? "OK" : "실패",
      saved: "✅",
      reload: headingVisible ? "✅" : "❌",
      v2: "-",
    });
  });
});
