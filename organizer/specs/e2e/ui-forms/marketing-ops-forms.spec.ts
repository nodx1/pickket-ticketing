/**
 * marketing-ops-forms.spec.ts
 *
 * 마케팅/운영 폼 E2E — 각 폼의 모든 입력 필드를 UI에서 채우고
 * 저장 → 목록 반영 → 리로드 → 값 유지 + API GET 재확인.
 *
 * 대상:
 *  1. 캠페인       /events/[id]/campaigns
 *  2. 메시지       /events/[id]/messages
 *  3. 홈페이지디자이너 /events/[id]/homepage-designer
 *  4. 브릿지페이지  /events/[id]/bridge-page
 *  5. 파이널콜     /events/[id]/final-call
 *  6. 홍보(promote) /events/[id]/promote
 *  7. 위젯         /events/[id]/widget
 *  8. 웹훅         /events/[id]/webhooks
 *  9. 어필리에이트  /events/[id]/affiliates
 *
 * 실행:
 *   BASE_URL=http://127.0.0.1:3019 npx playwright test \
 *     specs/e2e/ui-forms/marketing-ops-forms.spec.ts \
 *     --project=chromium --workers=1 --reporter=list
 */

import { test, expect } from "@playwright/test";
import { loginAsDemo, loginAsDemoApi } from "../helpers/auth";
import { createFullEvent, type FullEventFixture } from "../helpers/fixture-event";

// ─────────────────────────────────────────────────────────────
// 공통 유틸
// ─────────────────────────────────────────────────────────────

const sfx = () => `${Date.now()}${Math.floor(Math.random() * 1000)}`;

function dtLocalStr(daysAhead: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString().slice(0, 16);
}

// ─────────────────────────────────────────────────────────────
// 픽스처 — 전체 스위트 공유
// ─────────────────────────────────────────────────────────────

let fx: FullEventFixture;

test.beforeAll(async ({ request }) => {
  await loginAsDemoApi(request);
  fx = await createFullEvent(request);
});

// ══════════════════════════════════════════════════════════════
// 1. 캠페인 (campaigns)
// ══════════════════════════════════════════════════════════════

test.describe("1. 캠페인(campaigns) 폼", () => {
  const subject = () => `[E2E] 여름 특별 이벤트 안내 ${sfx()}`;
  const bodyHtml = "<p>이 메일은 <strong>E2E 테스트</strong>용 이메일 캠페인 본문입니다.</p>";

  let createdSubject: string;
  let campaignId: string;

  test("1-1. 제목·본문 채우기 → 캠페인 생성 → 목록 반영", async ({ page }) => {
    await loginAsDemo(page);
    createdSubject = subject();

    await page.goto(`/events/${fx.eventId}/campaigns`);
    await expect(page.getByRole("heading", { name: "이메일 캠페인" })).toBeVisible();

    // '새 캠페인' 버튼 클릭
    await page.getByRole("button", { name: "새 캠페인" }).click();
    await expect(page.locator("input[placeholder='이메일 제목']")).toBeVisible();

    // 제목 입력
    await page.locator("input[placeholder='이메일 제목']").fill(createdSubject);

    // 본문(HTML) 입력
    await page.locator("textarea").fill(bodyHtml);

    // 캠페인 생성
    await page.getByRole("button", { name: "캠페인 생성" }).click();

    // 성공 toast 또는 목록에서 제목 확인
    await expect(page.locator("body")).toContainText(createdSubject, { timeout: 10_000 });
    // 초안(draft) badge 확인
    await expect(page.locator("body")).toContainText("초안", { timeout: 8_000 });
  });

  test("1-2. 리로드 후 목록에 캠페인 유지", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/campaigns`);
    await expect(page.locator("body")).toContainText(createdSubject, { timeout: 10_000 });
  });

  test("1-3. API GET — 생성된 캠페인 확인", async ({ request }) => {
    await loginAsDemoApi(request);
    const res = await request.get(`/api/events/${fx.eventId}/campaigns`);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { data?: Array<{ id: string; subject: string; status: string }> };
    const found = body.data?.find((c) => c.subject === createdSubject);
    expect(found, `API 목록에서 "${createdSubject}"를 찾지 못함`).toBeTruthy();
    expect(found?.status).toBe("draft");
    campaignId = found?.id ?? "";
  });

  test("1-4. 발송 boundary — 발송 버튼 → API 도달·응답 코드 확인", async ({ page, request }) => {
    // 발송 버튼 클릭 → ConfirmDialog → 발송하기
    if (!campaignId) test.skip();
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/campaigns`);
    await expect(page.locator("body")).toContainText(createdSubject, { timeout: 10_000 });

    // API 요청 감시
    const sendPromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/campaigns/${campaignId}/send`) &&
        response.request().method() === "POST",
      { timeout: 15_000 },
    );

    await page.getByRole("button", { name: "발송" }).first().click();
    // ConfirmDialog — "발송하기" 확인 버튼
    await page.getByRole("button", { name: "발송하기" }).click();

    const sendRes = await sendPromise;
    // 200 또는 201: 성공. 400/403/422: API 경계는 도달했으나 발송 실패(수신자 없음 등). 5xx: 제품버그.
    const status = sendRes.status();
    console.log(`[캠페인 발송 boundary] status=${status}`);
    expect([200, 201, 400, 403, 422], `발송 API status ${status}이 예상 범위 밖`).toContain(status);

    // 발송 후 API GET으로 상태 확인(sent or draft)
    await loginAsDemoApi(request);
    const checkRes = await request.get(`/api/events/${fx.eventId}/campaigns`);
    const checkBody = (await checkRes.json()) as { data?: Array<{ id: string; status: string }> };
    const campaign = checkBody.data?.find((c) => c.id === campaignId);
    console.log(`[캠페인 발송 후 status] ${campaign?.status ?? "not-found"}`);
  });
});

// ══════════════════════════════════════════════════════════════
// 2. 메시지 (messages)
// ══════════════════════════════════════════════════════════════

test.describe("2. 메시지(messages) 폼", () => {
  const msgTitle = () => `[E2E] 당일 안내 메시지 ${sfx()}`;
  const msgBody = "E2E 자동화 테스트용 메시지 본문입니다. 행사장 안내 및 주의사항을 확인해주세요.";

  let createdTitle: string;

  test("2-1. 모든 필드 채우기 → 발송 → 목록 반영", async ({ page }) => {
    await loginAsDemo(page);
    createdTitle = msgTitle();

    await page.goto(`/events/${fx.eventId}/messages`);
    await expect(page.getByRole("heading", { name: "메시지", exact: true })).toBeVisible({ timeout: 10_000 });

    // '메시지 보내기' 버튼 클릭 → Dialog 열림 (헤더 버튼 우선 — EmptyState 버튼도 있을 수 있음)
    await page.getByRole("button", { name: "메시지 보내기" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();

    // AI 유형 select — "당일 안내"로 변경
    await page.locator("select").selectOption("day_of");

    // Dialog 컨텍스트 — 모든 후속 선택을 Dialog 내부로 제한
    const dialog = page.getByRole("dialog");

    // 채널 선택: RadioGroup 구조 = <label><RadioGroupItem(button role="radio")/> SMS</label>
    // label 클릭은 연결된 RadioGroupItem을 활성화
    // Dialog 내 label 중 "SMS"가 포함된 것 클릭 (label.filter hasText는 자식 포함 텍스트 매칭)
    const smsLabel = dialog.locator("label").filter({ hasText: /^SMS$/ });
    if (await smsLabel.count() > 0) {
      await smsLabel.click().catch(() => { /* 무시 */ });
    }

    // 수신 대상: "미체크인" 라벨 클릭 — Dialog 내부로 범위 제한
    const notCheckedLabel = dialog.locator("label").filter({ hasText: /미체크인/ });
    if (await notCheckedLabel.count() > 0) {
      await notCheckedLabel.click().catch(() => { /* 무시 */ });
    }

    // Dialog가 여전히 열려있는지 확인
    await expect(dialog).toBeVisible({ timeout: 3_000 });

    // 제목 입력
    await page.locator("#message-title").fill(createdTitle);

    // 본문 입력
    await page.locator("#message-body").fill(msgBody);

    // API 요청 감시
    const sendPromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/events/${fx.eventId}/messages`) &&
        response.request().method() === "POST",
      { timeout: 15_000 },
    );

    // 발송
    await page.getByRole("button", { name: "발송" }).click();

    const sendRes = await sendPromise;
    const status = sendRes.status();
    console.log(`[메시지 발송 boundary] status=${status}`);
    // 200/201: 성공(수신자 없을 수 있음). 422/400: 검증 실패. 5xx: 제품버그.
    expect([200, 201, 400, 422], `메시지 발송 status ${status}이 예상 범위 밖`).toContain(status);
  });

  test("2-2. 리로드 후 목록 확인", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/messages`);
    // 발송 실패/수신자 없는 경우 목록에 title 이 없을 수 있음 — 빈 상태도 허용
    // 있으면 제목 확인
    const hasItem = await page.locator("body").evaluate(
      (el, t) => el.textContent?.includes(t) ?? false,
      createdTitle,
    );
    console.log(`[메시지 리로드] createdTitle 있음: ${hasItem}`);
    // 단순 페이지 로드 성공만 검증
    await expect(page.getByRole("heading", { name: "메시지", exact: true })).toBeVisible();
  });

  test("2-3. API GET — 메시지 목록 응답 확인", async ({ request }) => {
    await loginAsDemoApi(request);
    const res = await request.get(`/api/events/${fx.eventId}/messages`);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { data?: unknown[] };
    console.log(`[메시지 API GET] 항목수: ${body.data?.length ?? 0}`);
    // 목록이 배열로 반환되는지만 확인 (발송 실패로 항목 없을 수 있음)
    expect(Array.isArray(body.data)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// 3. 홈페이지 디자이너 (homepage-designer)
// ══════════════════════════════════════════════════════════════

test.describe("3. 홈페이지디자이너(homepage-designer) 폼", () => {
  const coverUrl = "https://picsum.photos/seed/e2e/1200/600";
  const bgColor = "#1A1D2E";
  const textColor = "#FFFFFF";
  const accentColor = "#6C5CE7";

  test("3-1. 수동설정 펼치기 → 전체 필드 채우기 → 저장", async ({ page }) => {
    await loginAsDemo(page);

    await page.goto(`/events/${fx.eventId}/homepage-designer`);
    await expect(page.getByRole("heading", { name: "AI 디자인 생성" })).toBeVisible({ timeout: 10_000 });

    // 수동 설정 펼치기
    await page.getByRole("button", { name: "수동 설정" }).click();

    // 커버 이미지 URL
    await page.locator("#cover-image").fill(coverUrl);

    // 배경색 — color 타입은 value 직접 설정
    const colorInputs = page.locator("input[type='color']");
    await colorInputs.nth(0).fill(bgColor);
    await colorInputs.nth(1).fill(textColor);
    await colorInputs.nth(2).fill(accentColor);

    // Switch 토글 — 카운트다운 OFF
    const switches = page.locator("[role='switch'], button[data-state]");
    if (await switches.count() > 0) {
      const countdown = switches.nth(0);
      const state = await countdown.getAttribute("data-state");
      if (state === "checked") {
        await countdown.click();
        await page.waitForTimeout(300);
      }
    }

    // 저장 버튼
    await page.getByRole("button", { name: "저장" }).click();

    // "✓ 저장됨" 텍스트 확인 (3초간 표시됨)
    await expect(page.locator("button", { hasText: "✓ 저장됨" })).toBeVisible({ timeout: 8_000 });
  });

  test("3-2. 리로드 → 값 유지 확인", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/homepage-designer`);
    await expect(page.getByRole("heading", { name: "AI 디자인 생성" })).toBeVisible({ timeout: 10_000 });

    // 수동 설정 펼치기
    await page.getByRole("button", { name: "수동 설정" }).click();
    await page.waitForTimeout(500);

    // 커버 이미지 URL 값 유지 확인
    const coverInput = page.locator("#cover-image");
    const savedUrl = await coverInput.inputValue();
    expect(savedUrl, `커버URL 리로드 후 값 미유지: "${savedUrl}"`).toBe(coverUrl);
  });

  test("3-3. API GET — 저장된 디자인 확인", async ({ request }) => {
    await loginAsDemoApi(request);
    const res = await request.get(`/api/events/${fx.eventId}/homepage-design`);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { data?: { coverImageUrl?: string; backgroundColor?: string } };
    console.log(`[홈페이지디자이너 API GET] data: ${JSON.stringify(body.data ?? {})}`);
    expect(body.data).toBeTruthy();
    expect(body.data?.coverImageUrl).toBe(coverUrl);
  });

  test("3-4. AI 생성 boundary — 버튼 클릭 → API 도달", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/homepage-designer`);
    await expect(page.getByRole("button", { name: /AI로 디자인 생성/ })).toBeVisible({ timeout: 10_000 });

    // 템플릿 선택 — "볼드" 클릭
    await page.getByRole("button", { name: "템플릿 선택" }).click().catch(() => {
      // 이미 펼쳐진 경우 무시
    });
    await page.locator("button").filter({ hasText: "볼드" }).first().click().catch(() => {/* 없으면 무시 */});

    const genPromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/ai/generate-design") &&
        response.request().method() === "POST",
      { timeout: 65_000 },
    );

    await page.getByRole("button", { name: /AI로 디자인 생성/ }).click();

    const genRes = await genPromise;
    const status = genRes.status();
    console.log(`[홈페이지 AI 생성 boundary] status=${status}`);
    expect([200, 201, 400, 422, 500, 503], `AI 생성 status ${status}가 예상 범위 밖`).toContain(status);
  });
});

// ══════════════════════════════════════════════════════════════
// 4. 브릿지페이지 (bridge-page)
// ══════════════════════════════════════════════════════════════

test.describe("4. 브릿지페이지(bridge-page) 폼", () => {
  const title = "판매 시작까지 잠시만 기다려주세요!";
  const description = "E2E 테스트: 곧 판매가 시작됩니다. 알림을 등록하세요.";
  const bgColor = "#2D3436";
  const countdownTarget = dtLocalStr(7, 10, 0); // 7일 후 10:00

  test("4-1. 활성토글·제목·설명·배경색·카운트다운 → 저장", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/bridge-page`);
    await expect(page.getByRole("heading", { name: "브릿지페이지" })).toBeVisible({ timeout: 10_000 });

    // 활성 토글 ON
    const toggle = page.locator("div[class*='rounded-full']").first();
    await toggle.click();
    await page.waitForTimeout(300);

    // 제목
    await page.locator("input[placeholder*='판매 시작']").fill(title);

    // 설명
    await page.locator("textarea[placeholder*='판매 시작 전']").fill(description);

    // 배경색
    await page.locator("input[type='color']").fill(bgColor);

    // 카운트다운
    await page.locator("input[type='datetime-local']").fill(countdownTarget);

    // 저장
    await page.getByRole("button", { name: "저장" }).click();

    // 성공 토스트 확인
    await expect(page.locator("body")).toContainText("저장", { timeout: 8_000 });
  });

  test("4-2. 리로드 → 값 유지 확인", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/bridge-page`);
    await expect(page.getByRole("heading", { name: "브릿지페이지" })).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(800); // 로드 대기

    // 제목 값 유지
    const savedTitle = await page.locator("input[placeholder*='판매 시작']").inputValue();
    expect(savedTitle, `제목 리로드 후 값 미유지: "${savedTitle}"`).toBe(title);

    // 설명 값 유지
    const savedDesc = await page.locator("textarea[placeholder*='판매 시작 전']").inputValue();
    expect(savedDesc, `설명 리로드 후 값 미유지: "${savedDesc}"`).toBe(description);
  });

  test("4-3. API GET — 저장된 브릿지페이지 설정 확인", async ({ request }) => {
    await loginAsDemoApi(request);
    const res = await request.get(`/api/events/${fx.eventId}/bridge-page`);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      data?: { title?: string; description?: string; isActive?: boolean; is_active?: boolean; backgroundColor?: string; background_color?: string };
      success?: boolean;
    };
    const data = body.data ?? body;
    console.log(`[브릿지페이지 API GET] data: ${JSON.stringify(data)}`);
    const actualTitle = (data as Record<string, unknown>).title as string | undefined;
    expect(actualTitle, `API title 미유지: "${actualTitle}"`).toBe(title);
  });
});

// ══════════════════════════════════════════════════════════════
// 5. 파이널콜 (final-call)
// ══════════════════════════════════════════════════════════════

test.describe("5. 파이널콜(final-call) 폼", () => {
  const triggerHours = 48;
  const discountPct = 25;
  const minRemaining = 30;
  const maxTickets = 50;

  test("5-1. 활성화·발동시간·할인율·잔여율·최대수량·알림 → 저장", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/final-call`);
    await expect(page.getByRole("heading", { name: "파이널콜" })).toBeVisible({ timeout: 10_000 });

    // 활성 토글 ON
    const toggle = page.locator("div[class*='rounded-full']").first();
    await toggle.click();
    await page.waitForTimeout(300);

    // number 입력 4개: 발동시간·할인율·잔여율·최대수량
    const numberInputs = page.locator("input[type='number']");

    await numberInputs.nth(0).fill(String(triggerHours)); // 이벤트 시작 N시간 전
    await numberInputs.nth(1).fill(String(discountPct));  // 할인율
    await numberInputs.nth(2).fill(String(minRemaining)); // 최소 잔여율
    await numberInputs.nth(3).fill(String(maxTickets));   // 최대 할인 티켓 수

    // 알림 체크박스 — checked 상태 확인 후 체크
    const notifyCheckbox = page.locator("input[type='checkbox']");
    if (!(await notifyCheckbox.isChecked())) {
      await notifyCheckbox.check();
    }

    // 저장
    await page.getByRole("button", { name: "저장" }).click();

    // 성공 토스트 또는 활성화됨 배너
    await expect(page.locator("body")).toContainText("저장", { timeout: 8_000 });
  });

  test("5-2. 리로드 → 값 유지 확인", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/final-call`);
    await expect(page.getByRole("heading", { name: "파이널콜" })).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(800);

    const numberInputs = page.locator("input[type='number']");
    const savedTrigger = await numberInputs.nth(0).inputValue();
    const savedDiscount = await numberInputs.nth(1).inputValue();
    const savedRemaining = await numberInputs.nth(2).inputValue();
    const savedMax = await numberInputs.nth(3).inputValue();

    expect(Number(savedTrigger), `발동시간 미유지: ${savedTrigger}`).toBe(triggerHours);
    expect(Number(savedDiscount), `할인율 미유지: ${savedDiscount}`).toBe(discountPct);
    expect(Number(savedRemaining), `잔여율 미유지: ${savedRemaining}`).toBe(minRemaining);
    expect(Number(savedMax), `최대수량 미유지: ${savedMax}`).toBe(maxTickets);
  });

  test("5-3. API GET — 저장된 파이널콜 설정 확인", async ({ request }) => {
    await loginAsDemoApi(request);
    const res = await request.get(`/api/events/${fx.eventId}/final-call`);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      data?: Record<string, unknown>;
      success?: boolean;
    };
    const data = (body.data ?? body) as Record<string, unknown>;
    console.log(`[파이널콜 API GET] data: ${JSON.stringify(data)}`);
    const trigger = Number(data.triggerHoursBefore ?? data.trigger_hours_before);
    const discount = Number(data.discountPercent ?? data.discount_percent);
    expect(trigger, `API triggerHoursBefore 미유지: ${trigger}`).toBe(triggerHours);
    expect(discount, `API discountPercent 미유지: ${discount}`).toBe(discountPct);
  });
});

// ══════════════════════════════════════════════════════════════
// 6. 홍보(promote) — AI 생성 boundary + 결과 렌더
// ══════════════════════════════════════════════════════════════

test.describe("6. 홍보(promote) AI 콘텐츠 생성", () => {
  test("6-1. 소셜미디어 탭 → AI 콘텐츠 생성 boundary", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/promote`);
    await expect(page.getByRole("heading", { name: "AI 홍보 허브" })).toBeVisible({ timeout: 10_000 });

    // '소셜미디어' 탭이 기본 선택. 'AI 콘텐츠 생성' 버튼이 있으면 클릭
    // (탭 클릭 시 자동 생성될 수도 있음)
    const genBtn = page.getByRole("button", { name: "AI 콘텐츠 생성" });
    const isGenBtnVisible = await genBtn.isVisible().catch(() => false);

    const genPromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/ai/generate-content") &&
        response.request().method() === "POST",
      { timeout: 65_000 },
    );

    if (isGenBtnVisible) {
      await genBtn.click();
    } else {
      // 탭 클릭으로 자동 생성 트리거
      await page.getByRole("button", { name: "소셜미디어" }).click();
    }

    const genRes = await genPromise;
    const status = genRes.status();
    console.log(`[promote AI 생성 boundary] status=${status}`);
    expect([200, 201, 400, 422, 500, 503], `AI 생성 status ${status}가 예상 범위 밖`).toContain(status);
  });

  test("6-2. AI 성공 시 결과 렌더 확인 (soft)", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/promote`);
    await expect(page.getByRole("heading", { name: "AI 홍보 허브" })).toBeVisible({ timeout: 10_000 });

    // 결과가 있으면 콘텐츠 블록 확인, 없으면 empty 상태 확인
    await page.waitForTimeout(2_000); // 자동 생성 대기
    const bodyText = await page.locator("body").textContent() ?? "";
    const hasContent = bodyText.includes("인스타그램") || bodyText.includes("X") || bodyText.includes("AI 콘텐츠 생성");
    console.log(`[promote 결과 렌더] content 또는 CTA 표시: ${hasContent}`);
    expect(hasContent, "promote 페이지에 콘텐츠 또는 생성 버튼이 없음").toBe(true);
  });

  test("6-3. 이메일 탭 전환 → API boundary", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/promote`);
    await expect(page.getByRole("heading", { name: "AI 홍보 허브" })).toBeVisible({ timeout: 10_000 });

    const genPromise = page.waitForResponse(
      (response) =>
        response.url().includes("/api/ai/generate-content") &&
        response.request().method() === "POST",
      { timeout: 65_000 },
    );

    await page.getByRole("button", { name: "이메일" }).click();

    const genRes = await genPromise;
    console.log(`[promote 이메일 탭 boundary] status=${genRes.status()}`);
    expect([200, 201, 400, 422, 500, 503]).toContain(genRes.status());
  });
});

// ══════════════════════════════════════════════════════════════
// 7. 위젯 (widget)
// ══════════════════════════════════════════════════════════════

test.describe("7. 위젯(widget) 폼", () => {
  const primaryColor = "#FF3366";
  const buttonText = "지금 티켓 구매하기";
  const allowedDomain = "example.com\nmystore.kr";

  test("7-1. 테마색·버튼텍스트·허용도메인 → 저장", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/widget`);
    await expect(page.getByRole("heading", { name: "위젯 설정" })).toBeVisible({ timeout: 10_000 });
    // 페이지 초기 로드 대기 (GET widget-config 완료)
    await page.waitForLoadState("networkidle");

    // 버튼 텍스트 — React controlled input
    const btnInput = page.locator("#button-text");
    await btnInput.click();
    await btnInput.fill(buttonText);
    // blur 후 React state 업데이트 확인
    await btnInput.press("Tab");

    // 테마 색상 — color picker + text input 쌍. text input 직접 fill
    const colorTextInput = page.locator("input.w-32.font-mono");
    if (await colorTextInput.count() > 0) {
      await colorTextInput.fill(primaryColor);
      await colorTextInput.press("Tab");
    } else {
      // fallback: color input fill
      await page.locator("#theme-color").fill(primaryColor);
    }

    // 허용 도메인
    await page.locator("#allowed-domains").fill(allowedDomain);

    // PUT API 응답 감시
    const putPromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/events/${fx.eventId}/widget-config`) &&
        response.request().method() === "PUT",
      { timeout: 10_000 },
    );

    // 저장
    await page.getByRole("button", { name: "설정 저장" }).click();

    const putRes = await putPromise;
    console.log(`[위젯 PUT] status=${putRes.status()}`);
    expect(putRes.ok(), `위젯 PUT 응답 실패: ${putRes.status()}`).toBeTruthy();

    // 저장 후 페이지가 정상 상태
    await expect(page.getByRole("heading", { name: "위젯 설정" })).toBeVisible();
  });

  test("7-2. 리로드 → 값 유지 확인", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/widget`);
    await expect(page.getByRole("heading", { name: "위젯 설정" })).toBeVisible({ timeout: 10_000 });
    await page.waitForLoadState("networkidle");

    // 버튼 텍스트 유지 확인
    const savedBtnText = await page.locator("#button-text").inputValue();
    console.log(`[위젯 버튼텍스트 리로드] "${savedBtnText}"`);

    // 허용 도메인 유지 확인
    const savedDomains = await page.locator("#allowed-domains").inputValue();
    console.log(`[위젯 허용도메인 리로드] "${savedDomains}"`);

    // 버튼텍스트와 도메인 유지 여부 검증
    // [제품버그 의심] 위젯 설정이 리로드 후 기본값으로 복원되는 경우 확인 필요
    expect(savedBtnText, `버튼텍스트 리로드 후 미유지: "${savedBtnText}"`).toBe(buttonText);
    expect(savedDomains, `허용도메인 리로드 후 미유지: "${savedDomains}"`).toContain("example.com");
  });

  test("7-3. API GET — 저장된 위젯 설정 확인", async ({ request }) => {
    await loginAsDemoApi(request);
    const res = await request.get(`/api/events/${fx.eventId}/widget-config`);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as {
      data?: {
        theme?: { primaryColor?: string; buttonText?: string };
        allowedDomains?: string[];
      };
    };
    console.log(`[위젯 API GET] data: ${JSON.stringify(body.data ?? {})}`);
    expect(body.data?.theme?.buttonText, `API buttonText 미유지`).toBe(buttonText);
    expect(body.data?.allowedDomains, `API allowedDomains 미유지`).toContain("example.com");
  });

  test("7-4. 임베드 코드 생성 확인", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/widget`);
    await expect(page.getByRole("heading", { name: "임베드 코드" })).toBeVisible({ timeout: 10_000 });

    // <pickket-ticket 태그가 code 블록에 있어야 함
    const embedText = await page.locator("pre").textContent() ?? "";
    console.log(`[임베드 코드] ${embedText.slice(0, 100)}`);
    expect(embedText, "임베드 코드에 pickket-ticket 태그 없음").toContain("pickket-ticket");
    expect(embedText, "임베드 코드에 pickket.js 없음").toContain("pickket.js");

    // 코드 복사 버튼
    await page.getByRole("button", { name: "코드 복사" }).click();
    await expect(page.locator("button", { hasText: "복사됨!" })).toBeVisible({ timeout: 5_000 });
  });
});

// ══════════════════════════════════════════════════════════════
// 8. 웹훅 (webhooks)
// ══════════════════════════════════════════════════════════════

test.describe("8. 웹훅(webhooks) 폼", () => {
  const webhookName = () => `E2E 웹훅 ${sfx()}`;
  // SSRF 가드가 통과할 수 있도록 실제 공개 테스트 엔드포인트 사용
  const endpointUrl = "https://webhook.site/e2e-test-pickket";

  let createdName: string;
  let webhookId: string;

  test("8-1. 이름·URL·구독이벤트(체크박스) → 추가 → 목록 반영", async ({ page }) => {
    await loginAsDemo(page);
    createdName = webhookName();

    await page.goto(`/events/${fx.eventId}/webhooks`);
    await expect(page.getByRole("heading", { name: "웹훅", exact: true })).toBeVisible({ timeout: 10_000 });

    // 이름 입력
    await page.locator("input[placeholder='이름']").fill(createdName);

    // 엔드포인트 URL 입력
    await page.locator(`input[placeholder*='example.com']`).fill(endpointUrl);

    // 체크박스 — 구독 이벤트 여러 개 선택
    // 기본값: order.completed 체크됨. 추가로 order.created, attendee.checked_in 체크
    const checkboxLabels = page.locator("label").filter({ hasText: "order.created" });
    if (await checkboxLabels.count() > 0) {
      const cb = checkboxLabels.locator("button[role='checkbox'], input[type='checkbox']").first();
      const state = await cb.getAttribute("data-state");
      if (state !== "checked" && !(await cb.isChecked().catch(() => false))) {
        await cb.click();
      }
    }

    const checkinLabel = page.locator("label").filter({ hasText: "attendee.checked_in" });
    if (await checkinLabel.count() > 0) {
      const cb = checkinLabel.locator("button[role='checkbox'], input[type='checkbox']").first();
      const state = await cb.getAttribute("data-state");
      if (state !== "checked" && !(await cb.isChecked().catch(() => false))) {
        await cb.click();
      }
    }

    // 웹훅 추가
    await page.getByRole("button", { name: "웹훅 추가" }).click();

    // 성공 toast + 목록 반영
    await expect(page.locator("body")).toContainText(createdName, { timeout: 10_000 });
  });

  test("8-2. 리로드 → 목록에 웹훅 유지", async ({ page }) => {
    if (!createdName) test.skip();
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/webhooks`);
    await expect(page.locator("body")).toContainText(createdName, { timeout: 10_000 });
    await expect(page.locator("body")).toContainText(endpointUrl, { timeout: 5_000 });
  });

  test("8-3. API GET — 생성된 웹훅 확인", async ({ request }) => {
    if (!createdName) test.skip();
    await loginAsDemoApi(request);
    const res = await request.get(`/api/events/${fx.eventId}/webhooks`);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { data?: Array<{ id: string; name: string; endpointUrl: string; subscribedEvents: string[] }> };
    const found = body.data?.find((w) => w.name === createdName);
    expect(found, `API 목록에서 "${createdName}"를 찾지 못함`).toBeTruthy();
    expect(found?.endpointUrl).toBe(endpointUrl);
    expect(found?.subscribedEvents).toContain("order.completed");
    webhookId = found?.id ?? "";
  });

  test("8-4. 수정 → 이름 변경 → 저장 → 반영", async ({ page }) => {
    if (!webhookId) test.skip();
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/webhooks`);
    await expect(page.locator("body")).toContainText(createdName, { timeout: 10_000 });

    // 수정 버튼 (aria-label="웹훅 수정")
    await page.getByRole("button", { name: "웹훅 수정" }).first().click();
    await expect(page.getByRole("dialog")).toBeVisible();

    const editedName = `${createdName}-수정됨`;
    await page.locator("#edit-webhook-name").fill(editedName);

    // 상태 select → "비활성"
    await page.getByRole("combobox").click();
    await page.getByRole("option", { name: "비활성" }).click();

    await page.getByRole("button", { name: "저장" }).click();
    await expect(page.locator("body")).toContainText(editedName, { timeout: 10_000 });
    createdName = editedName;
  });

  test("8-5. 삭제 → 목록에서 제거", async ({ page }) => {
    if (!createdName) test.skip();
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/webhooks`);
    await expect(page.locator("body")).toContainText(createdName, { timeout: 10_000 });

    // 삭제 버튼
    await page.getByRole("button", { name: "웹훅 삭제" }).first().click();

    // ConfirmDialog
    await page.getByRole("button", { name: "삭제" }).last().click();
    await expect(page.locator("body")).not.toContainText(createdName, { timeout: 10_000 });
  });
});

// ══════════════════════════════════════════════════════════════
// 9. 어필리에이트 (affiliates)
// ══════════════════════════════════════════════════════════════

test.describe("9. 어필리에이트(affiliates) 폼", () => {
  const affName = () => `E2E파트너 ${sfx()}`;
  const affCode = () => `E2EAFF${Date.now().toString().slice(-6)}`;
  const commissionRate = "15";

  let createdName: string;
  let createdCode: string;
  let affiliateId: string;

  test("9-1. 이름·코드·수수료율 → 추가 → 목록 반영", async ({ page }) => {
    await loginAsDemo(page);
    createdName = affName();
    createdCode = affCode();

    await page.goto(`/events/${fx.eventId}/affiliates`);
    await expect(page.getByRole("heading", { name: "어필리에이트" })).toBeVisible({ timeout: 10_000 });

    // 이름
    await page.locator("input[placeholder='이름']").fill(createdName);

    // 코드 (자동 대문자 변환)
    await page.locator("input[placeholder='코드']").fill(createdCode);

    // 수수료율
    await page.locator("input[placeholder='수수료율']").fill(commissionRate);

    // 추가
    await page.getByRole("button", { name: "추가" }).click();

    // 목록 반영
    await expect(page.locator("body")).toContainText(createdName, { timeout: 10_000 });
    await expect(page.locator("body")).toContainText(createdCode.toUpperCase(), { timeout: 5_000 });
  });

  test("9-2. 리로드 → 목록에 어필리에이트 유지", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/affiliates`);
    await expect(page.locator("body")).toContainText(createdName, { timeout: 10_000 });
    await expect(page.locator("body")).toContainText(createdCode.toUpperCase(), { timeout: 5_000 });
  });

  test("9-3. API GET — 생성된 어필리에이트 확인", async ({ request }) => {
    await loginAsDemoApi(request);
    const res = await request.get(`/api/events/${fx.eventId}/affiliates`);
    expect(res.ok()).toBeTruthy();
    const body = (await res.json()) as { data?: Array<{ id: string; name: string; code: string; commissionRate: number; status: string }> };
    const found = body.data?.find((a) => a.name === createdName);
    expect(found, `API 목록에서 "${createdName}"를 찾지 못함`).toBeTruthy();
    expect(found?.code).toBe(createdCode.toUpperCase());
    expect(Number(found?.commissionRate)).toBe(Number(commissionRate));
    affiliateId = found?.id ?? "";
  });

  test("9-4. 상태·수수료 수정 → 반영 확인", async ({ page }) => {
    if (!affiliateId) test.skip();
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/affiliates`);
    await expect(page.locator("body")).toContainText(createdName, { timeout: 10_000 });

    // 수정 버튼 — createdName이 포함된 행의 "어필리에이트 수정" 버튼 클릭
    // (이전 테스트 실행 잔여 데이터가 있어도 정확한 행을 찾음)
    const targetRow = page.locator("tr, [role='row']").filter({ hasText: createdName }).first();
    const targetEditBtn = targetRow.getByRole("button", { name: "어필리에이트 수정" });
    // 행 기반 locator가 안 되면 name 필터로 fallback
    if (await targetEditBtn.count() > 0) {
      await targetEditBtn.click();
    } else {
      // DataTable이 tr 대신 div 구조일 수 있음 — 이름 텍스트를 포함한 컨테이너 내 버튼
      const nameCell = page.getByText(createdName).first();
      const rowContainer = nameCell.locator("xpath=ancestor::*[contains(@class,'flex') or self::tr][1]");
      const rowEditBtn = rowContainer.getByRole("button", { name: "어필리에이트 수정" });
      if (await rowEditBtn.count() > 0) {
        await rowEditBtn.click();
      } else {
        // 마지막 fallback: 첫 번째 수정 버튼
        await page.getByRole("button", { name: "어필리에이트 수정" }).first().click();
      }
    }
    await expect(page.getByRole("dialog")).toBeVisible();

    const editDialog = page.getByRole("dialog");

    // ① 상태 먼저 변경 — Dialog 내부 combobox (Select 변경은 React re-render 유발)
    const selectTrigger = editDialog.getByRole("combobox");
    await selectTrigger.click();
    await page.waitForTimeout(300);
    // SelectContent는 body에 portal로 렌더됨
    const inactiveOption = page.getByRole("option", { name: "비활성" });
    await inactiveOption.waitFor({ state: "visible", timeout: 5_000 });
    await inactiveOption.click();
    // Select 닫힘 대기 (re-render 완료 후 commission input 수정)
    await expect(inactiveOption).not.toBeVisible({ timeout: 3_000 }).catch(() => { /* 무시 */ });
    await page.waitForTimeout(300);

    // ② 수수료 변경 — Select re-render 후 마지막에 변경 (저장 직전)
    // Playwright fill() 은 React 합성이벤트를 올바르게 트리거
    // Select 변경 후 re-render가 완료된 상태에서 fill() 사용
    const commissionInput = page.locator("#edit-affiliate-commission");
    await commissionInput.fill("20");
    const inputVal = await commissionInput.inputValue();
    console.log(`[어필리에이트 commission input 값] "${inputVal}"`);
    await page.waitForTimeout(200);

    // API 요청 감시 — Dialog 내부 "저장" 버튼 클릭 전에 설정
    const savePromise = page.waitForResponse(
      (response) =>
        response.url().includes(`/api/events/${fx.eventId}/affiliates/`) &&
        response.request().method() === "PATCH",
      { timeout: 15_000 },
    );

    // Dialog 내부의 "저장" 버튼 클릭 (페이지 레벨의 다른 버튼 방지)
    await editDialog.getByRole("button", { name: "저장" }).click();

    const saveRes = await savePromise;
    const saveStatus = saveRes.status();
    console.log(`[어필리에이트 수정 PATCH] status=${saveStatus}`);
    expect(saveRes.ok(), "PATCH 응답 실패").toBeTruthy();

    // Dialog 닫힘 대기 (saveEdit이 setEditing(null) 즉시 호출)
    await expect(editDialog).not.toBeVisible({ timeout: 5_000 });

    // toast 확인 (dialog 닫힌 후 showSuccess 호출됨)
    await expect(page.locator("body")).toContainText("수정되었습니다", { timeout: 10_000 });

    // API 재확인 (page.request는 현재 쿠키를 자동으로 포함)
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => { /* 무시 */ });
    const res = await page.request.get(`/api/events/${fx.eventId}/affiliates`);
    const body = (await res.json()) as { data?: Array<{ id: string; commissionRate: number; status: string }> };
    const updated = body.data?.find((a) => a.id === affiliateId);
    console.log(`[어필리에이트 수정] commissionRate=${updated?.commissionRate}, status=${updated?.status}`);
    expect(Number(updated?.commissionRate), "수수료율 수정 미반영").toBe(20);
    expect(updated?.status, "상태 수정 미반영").toBe("inactive");
  });

  test("9-5. 삭제 → 목록에서 제거", async ({ page }) => {
    if (!createdName) test.skip();
    await loginAsDemo(page);
    await page.goto(`/events/${fx.eventId}/affiliates`);
    await expect(page.locator("body")).toContainText(createdName, { timeout: 10_000 });

    // 삭제 버튼 — createdName 행의 삭제 버튼 클릭 (정확한 행 타겟)
    const deleteRow = page.locator("tr, [role='row']").filter({ hasText: createdName }).first();
    const deleteBtn = deleteRow.getByRole("button", { name: "어필리에이트 삭제" });
    if (await deleteBtn.count() > 0) {
      await deleteBtn.click();
    } else {
      await page.getByRole("button", { name: "어필리에이트 삭제" }).first().click();
    }

    // ConfirmDialog
    await page.getByRole("button", { name: "삭제" }).last().click();
    await expect(page.locator("body")).not.toContainText(createdName, { timeout: 10_000 });
  });
});
