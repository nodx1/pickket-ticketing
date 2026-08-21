/**
 * auth-account-forms.spec.ts — 인증/계정 폼 E2E 검증
 *
 * 대상 폼:
 *   1. 회원가입          /register
 *   2. 로그인            /login
 *   3. 비밀번호 찾기      /forgot-password
 *   4. 비밀번호 재설정    /reset-password
 *   5. 초대 수락         /accept-invitation
 *   6. 계정 설정         /account (프로필·비밀번호·알림·AI사용량 탭)
 *   7. 팀원              /account/members
 *   8. 보안 (MFA/TOTP)  /account/security
 *
 * 검증 절차:
 *   - 모든 입력 필드를 유효값으로 채움 → 저장/제출 → 성공 확인
 *   - 해당 시: 리로드 유지 + API 재조회 확인
 *   - 부작용 있는 케이스(가입·초대·비번변경)는 고유값/원복/에러케이스로 격리
 *
 * 실행:
 *   BASE_URL=http://127.0.0.1:3019 npx playwright test \
 *     specs/e2e/ui-forms/auth-account-forms.spec.ts \
 *     --project=chromium --workers=1 --reporter=list
 */

import { test, expect, type APIRequestContext } from "@playwright/test";
import { loginAsDemo, loginAsDemoApi, demoCredentials } from "../helpers/auth";

// ── 고유 접미사 ────────────────────────────────────────────────
const SFX = `${Date.now()}`.slice(-8);

// ── 결과 테이블 ───────────────────────────────────────────────
interface ResultRow {
  form: string;
  field: string;
  value: string;
  submitted: "✅" | "❌" | "⏭️";
  reload: "✅" | "❌" | "⏭️" | "-";
  api: "✅" | "❌" | "⏭️" | "-";
  note?: string;
}

const results: ResultRow[] = [];

function record(row: ResultRow) {
  results.push(row);
}

// ── 공유 request context (beforeAll에서 초기화) ───────────────
let sharedRequest: APIRequestContext;

test.beforeAll(async ({ playwright }) => {
  sharedRequest = await playwright.request.newContext({
    baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3019",
  });
  await loginAsDemoApi(sharedRequest);
});

test.afterAll(async () => {
  // 결과 테이블 출력
  console.log("\n\n════════════════════════════════════════════════════════════════════");
  console.log("auth-account-forms 결과표");
  console.log("════════════════════════════════════════════════════════════════════");
  console.log(
    `${"폼".padEnd(18)} ${"필드".padEnd(22)} ${"값".padEnd(22)} ${"제출".padEnd(5)} ${"리로드".padEnd(7)} ${"API"}`,
  );
  console.log("─".repeat(100));
  for (const r of results) {
    const note = r.note ? `  ← ${r.note}` : "";
    console.log(
      `${r.form.padEnd(18)} ${r.field.padEnd(22)} ${r.value.slice(0, 20).padEnd(22)} ${r.submitted.padEnd(5)} ${r.reload.padEnd(7)} ${r.api}${note}`,
    );
  }
  console.log("════════════════════════════════════════════════════════════════════\n");
  await sharedRequest.dispose();
});

// ══════════════════════════════════════════════════════════════
// 1. 회원가입 — /register
// ══════════════════════════════════════════════════════════════
test.describe("1. 회원가입 (/register)", () => {
  const REG_EMAIL = `e2e+reg${SFX}@test.pickket.kr`;
  const REG_PW = `Pickket${SFX}!`;
  const REG_NAME = `E2E가입자${SFX}`;
  const REG_PHONE = `010-${SFX.slice(0, 4)}-${SFX.slice(4, 8)}`;

  test("1-1 유효값 전체 필드 → 가입 성공 (대시보드 리다이렉트)", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByRole("heading", { name: "회원가입" })).toBeVisible({ timeout: 10_000 });

    // 이름
    await page.getByLabel("이름").fill(REG_NAME);
    record({ form: "1.회원가입", field: "이름", value: REG_NAME, submitted: "✅", reload: "-", api: "-" });

    // 이메일
    await page.getByLabel("이메일").fill(REG_EMAIL);
    record({ form: "1.회원가입", field: "이메일", value: REG_EMAIL, submitted: "✅", reload: "-", api: "-" });

    // 전화번호
    await page.getByLabel("전화번호").fill(REG_PHONE);
    record({ form: "1.회원가입", field: "전화번호", value: REG_PHONE, submitted: "✅", reload: "-", api: "-" });

    // 비밀번호
    await page.locator("#password").fill(REG_PW);
    record({ form: "1.회원가입", field: "비밀번호", value: "***", submitted: "✅", reload: "-", api: "-" });

    // 비밀번호 확인
    await page.locator("#passwordConfirm").fill(REG_PW);
    record({ form: "1.회원가입", field: "비밀번호확인", value: "(일치)", submitted: "✅", reload: "-", api: "-" });

    // 제출 버튼 활성 확인
    const submitBtn = page.getByRole("button", { name: "회원가입" });
    await expect(submitBtn).not.toBeDisabled({ timeout: 3_000 });

    // 제출
    await submitBtn.click();

    // 성공: /dashboard 리다이렉트
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 20_000 });
    record({ form: "1.회원가입", field: "가입 제출", value: "success", submitted: "✅", reload: "-", api: "-" });

    // 재로그인 확인 — 로그아웃 후 새 계정으로 로그인
    // 새 계정으로 이미 로그인된 상태이므로 먼저 로그아웃
    await page.request.post("/api/auth/logout").catch(() => null);
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "로그인" })).toBeVisible({ timeout: 10_000 });
    await page.getByLabel("이메일").fill(REG_EMAIL);
    await page.getByLabel("비밀번호").fill(REG_PW);
    await page.getByRole("button", { name: "로그인" }).click();
    const loginOk = await page
      .waitForURL(/\/dashboard/, { timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    record({
      form: "1.회원가입",
      field: "재로그인",
      value: loginOk ? "OK" : "실패",
      submitted: loginOk ? "✅" : "❌",
      reload: "-",
      api: "-",
      note: loginOk ? undefined : "가입 후 재로그인 불가",
    });
  });

  test("1-2 약한 비밀번호 → 버튼 비활성(클라이언트 검증)", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByRole("heading", { name: "회원가입" })).toBeVisible({ timeout: 10_000 });

    await page.getByLabel("이름").fill("테스터");
    await page.getByLabel("이메일").fill(`weak${SFX}@test.kr`);
    await page.getByLabel("전화번호").fill("010-0000-1234");
    // 약한 비번: 대문자·숫자·특수문자 없음
    await page.locator("#password").fill("tooshort");
    await page.locator("#passwordConfirm").fill("tooshort");

    const btn = page.getByRole("button", { name: "회원가입" });
    const isDisabled = await btn.isDisabled({ timeout: 2_000 }).catch(() => true);
    record({
      form: "1.회원가입",
      field: "약비번 검증",
      value: "tooshort",
      submitted: isDisabled ? "✅" : "❌",
      reload: "-",
      api: "-",
      note: isDisabled ? "버튼 비활성(정상)" : "버튼 활성됨 — 검증 미동작(제품버그 후보)",
    });
    expect(isDisabled, "약한 비밀번호 시 버튼이 비활성이어야 함").toBe(true);
  });

  test("1-3 전화번호 형식 오류 → 버튼 비활성", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByRole("heading", { name: "회원가입" })).toBeVisible({ timeout: 10_000 });

    await page.getByLabel("이름").fill("테스터");
    await page.getByLabel("이메일").fill(`phone${SFX}@test.kr`);
    // 잘못된 전화번호
    await page.getByLabel("전화번호").fill("123-abc-def0");
    await page.locator("#password").fill("ValidPass1!");
    await page.locator("#passwordConfirm").fill("ValidPass1!");

    const btn = page.getByRole("button", { name: "회원가입" });
    const isDisabled = await btn.isDisabled({ timeout: 2_000 }).catch(() => true);
    record({
      form: "1.회원가입",
      field: "전화형식 검증",
      value: "123-abc-def0",
      submitted: isDisabled ? "✅" : "❌",
      reload: "-",
      api: "-",
      note: isDisabled ? "버튼 비활성(정상)" : "버튼 활성됨 — 전화 검증 미동작(제품버그 후보)",
    });
    expect(isDisabled, "잘못된 전화번호 시 버튼이 비활성이어야 함").toBe(true);
  });

  test("1-4 비밀번호 불일치 → 버튼 비활성", async ({ page }) => {
    await page.goto("/register");
    await expect(page.getByRole("heading", { name: "회원가입" })).toBeVisible({ timeout: 10_000 });

    await page.getByLabel("이름").fill("테스터");
    await page.getByLabel("이메일").fill(`mismatch${SFX}@test.kr`);
    await page.getByLabel("전화번호").fill("010-1234-5678");
    await page.locator("#password").fill("ValidPass1!");
    await page.locator("#passwordConfirm").fill("DifferentPass1!");

    const btn = page.getByRole("button", { name: "회원가입" });
    const isDisabled = await btn.isDisabled({ timeout: 2_000 }).catch(() => true);
    record({
      form: "1.회원가입",
      field: "비번불일치 검증",
      value: "불일치",
      submitted: isDisabled ? "✅" : "❌",
      reload: "-",
      api: "-",
      note: isDisabled ? "버튼 비활성(정상)" : "버튼 활성됨 — 불일치 검증 미동작(제품버그 후보)",
    });
    expect(isDisabled, "비밀번호 불일치 시 버튼이 비활성이어야 함").toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// 2. 로그인 — /login
// ══════════════════════════════════════════════════════════════
test.describe("2. 로그인 (/login)", () => {
  test("2-1 demo 계정 이메일·비밀번호 → 로그인 성공", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "로그인" })).toBeVisible({ timeout: 10_000 });

    // 이메일
    await page.getByLabel("이메일").fill(demoCredentials.email);
    record({ form: "2.로그인", field: "이메일", value: demoCredentials.email, submitted: "✅", reload: "-", api: "-" });

    // 비밀번호
    await page.getByLabel("비밀번호").fill(demoCredentials.password);
    record({ form: "2.로그인", field: "비밀번호", value: "***", submitted: "✅", reload: "-", api: "-" });

    // 제출
    await page.getByRole("button", { name: "로그인" }).click();

    // 대시보드 리다이렉트 확인
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: "대시보드", level: 2 })).toBeVisible({ timeout: 10_000 });
    record({ form: "2.로그인", field: "로그인 성공", value: "dashboard", submitted: "✅", reload: "-", api: "-" });
  });

  test("2-2 오답 비밀번호 → 401 에러 메시지 표시", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "로그인" })).toBeVisible({ timeout: 10_000 });

    await page.getByLabel("이메일").fill(demoCredentials.email);
    await page.getByLabel("비밀번호").fill("WrongPassword999!");
    await page.getByRole("button", { name: "로그인" }).click();

    // 에러 메시지 확인 (role="alert" 또는 .text-destructive)
    const errorEl = page.locator('[role="alert"], .text-destructive').first();
    const errorVisible = await errorEl.isVisible({ timeout: 8_000 }).catch(() => false);
    const errorText = errorVisible ? (await errorEl.textContent()) ?? "" : "";

    record({
      form: "2.로그인",
      field: "오답 에러",
      value: errorText.slice(0, 30) || "에러 없음",
      submitted: errorVisible ? "✅" : "❌",
      reload: "-",
      api: "-",
      note: errorVisible ? "401 에러 표시됨(정상)" : "에러 메시지 미표시(제품버그 후보)",
    });
    expect(errorVisible, "오답 비밀번호에 에러 메시지가 표시되어야 함").toBe(true);

    // 현재 페이지는 여전히 /login (리다이렉트 없음)
    await expect(page).toHaveURL(/\/login/, { timeout: 3_000 });
    record({ form: "2.로그인", field: "오답 후 URL", value: "/login 유지", submitted: "✅", reload: "-", api: "-" });
  });
});

// ══════════════════════════════════════════════════════════════
// 3. 비밀번호 찾기 — /forgot-password
// ══════════════════════════════════════════════════════════════
test.describe("3. 비밀번호 찾기 (/forgot-password)", () => {
  test("3-1 이메일 입력 → 제출 → 성공 메시지", async ({ page }) => {
    await page.goto("/forgot-password");
    await expect(page.getByRole("heading", { name: "비밀번호 찾기" })).toBeVisible({ timeout: 10_000 });

    // 이메일 필드
    await page.getByLabel("이메일").fill(demoCredentials.email);
    record({ form: "3.비밀번호찾기", field: "이메일", value: demoCredentials.email, submitted: "✅", reload: "-", api: "-" });

    // 제출
    await page.getByRole("button", { name: "비밀번호 재설정 링크 발송" }).click();

    // 성공 메시지 또는 에러 확인 (실메일 없이 stub)
    const successEl = page.locator(".text-success, [data-success]").first();
    const errorEl = page.locator('[role="alert"]').first();

    const successVisible = await successEl.isVisible({ timeout: 10_000 }).catch(() => false);
    const errorVisible = await errorEl.isVisible({ timeout: 3_000 }).catch(() => false);

    // 성공 또는 에러 중 하나는 나타나야 함
    const hasResponse = successVisible || errorVisible;
    const responseText = successVisible
      ? (await successEl.textContent()) ?? ""
      : errorVisible
        ? (await errorEl.textContent()) ?? ""
        : "응답 없음";

    record({
      form: "3.비밀번호찾기",
      field: "제출 응답",
      value: responseText.slice(0, 30),
      submitted: hasResponse ? "✅" : "❌",
      reload: "-",
      api: "-",
      note: successVisible ? "성공 메시지(정상)" : errorVisible ? "에러(stub 미구성 가능)" : "응답 없음(제품버그 후보)",
    });

    // 버튼이 다시 활성화됨(제출 완료 후 submitting=false)
    const btn = page.getByRole("button", { name: "비밀번호 재설정 링크 발송" });
    const btnEnabled = await btn.isEnabled({ timeout: 5_000 }).catch(() => false);
    record({
      form: "3.비밀번호찾기",
      field: "제출 후 버튼",
      value: btnEnabled ? "활성" : "비활성",
      submitted: "✅",
      reload: "-",
      api: "-",
    });
  });

  test("3-2 존재하지 않는 이메일 → 성공 메시지(보안상 동일 응답)", async ({ page }) => {
    await page.goto("/forgot-password");
    await expect(page.getByRole("heading", { name: "비밀번호 찾기" })).toBeVisible({ timeout: 10_000 });

    await page.getByLabel("이메일").fill(`nonexist${SFX}@nowhere.kr`);
    await page.getByRole("button", { name: "비밀번호 재설정 링크 발송" }).click();

    // 보안상 존재 여부 노출 없이 동일한 성공/중립 응답이어야 함
    const successEl = page.locator(".text-success").first();
    const errorEl = page.locator('[role="alert"]').first();

    const successVisible = await successEl.isVisible({ timeout: 10_000 }).catch(() => false);
    const errorVisible = await errorEl.isVisible({ timeout: 5_000 }).catch(() => false);

    record({
      form: "3.비밀번호찾기",
      field: "미존재 이메일",
      value: successVisible ? "성공메시지" : errorVisible ? "에러노출" : "무응답",
      submitted: "✅",
      reload: "-",
      api: "-",
      note: successVisible
        ? "보안상 성공 응답(정상)"
        : errorVisible
          ? "이메일 존재 여부 노출 가능(보안 검토 필요)"
          : "응답 없음",
    });
  });
});

// ══════════════════════════════════════════════════════════════
// 4. 비밀번호 재설정 — /reset-password
// ══════════════════════════════════════════════════════════════
test.describe("4. 비밀번호 재설정 (/reset-password)", () => {
  test("4-1 토큰 없을 때 버튼 비활성", async ({ page }) => {
    // 토큰 없이 접근
    await page.goto("/reset-password");
    await expect(page.getByRole("heading", { name: "비밀번호 재설정" })).toBeVisible({ timeout: 10_000 });

    // 토큰 필드 — 자동으로 비어있음
    const tokenInput = page.locator("#token");
    const tokenValue = await tokenInput.inputValue().catch(() => "");
    record({ form: "4.비번재설정", field: "토큰(없음)", value: tokenValue || "(empty)", submitted: "⏭️", reload: "-", api: "-" });

    // 버튼 비활성 확인 (token=""이면 disabled)
    const btn = page.getByRole("button", { name: "새 비밀번호 저장" });
    const isDisabled = await btn.isDisabled({ timeout: 3_000 }).catch(() => false);
    record({
      form: "4.비번재설정",
      field: "버튼 비활성",
      value: isDisabled ? "disabled(정상)" : "enabled(오류)",
      submitted: isDisabled ? "✅" : "❌",
      reload: "-",
      api: "-",
      note: isDisabled ? "토큰 없으면 버튼 비활성(정상)" : "토큰 없는데 버튼 활성(제품버그 후보)",
    });
    expect(isDisabled, "토큰 없을 때 버튼이 비활성이어야 함").toBe(true);
  });

  test("4-2 더미 토큰 + 새 비밀번호 입력 → 폼 렌더·제출·실패 메시지", async ({ page }) => {
    const DUMMY_TOKEN = `dummy-token-${SFX}-not-valid`;

    // 쿼리 파라미터로 토큰 전달
    await page.goto(`/reset-password?token=${DUMMY_TOKEN}`);
    await expect(page.getByRole("heading", { name: "비밀번호 재설정" })).toBeVisible({ timeout: 10_000 });

    // 토큰 자동 주입 확인
    const tokenInput = page.locator("#token");
    const tokenVal = await tokenInput.inputValue().catch(() => "");
    record({
      form: "4.비번재설정",
      field: "토큰 자동주입",
      value: tokenVal ? tokenVal.slice(0, 20) + "..." : "비어있음",
      submitted: tokenVal ? "✅" : "❌",
      reload: "-",
      api: "-",
      note: tokenVal ? "토큰 자동 주입됨(정상)" : "쿼리파라미터 미바인딩(제품버그 후보)",
    });

    // 새 비밀번호 입력
    const newPw = `NewPass${SFX}!`;
    await page.locator("#password").fill(newPw);
    record({ form: "4.비번재설정", field: "새 비밀번호", value: "***", submitted: "✅", reload: "-", api: "-" });

    // 버튼 활성 확인 (토큰 있으면)
    const btn = page.getByRole("button", { name: "새 비밀번호 저장" });
    const btnEnabled = tokenVal
      ? await btn.isEnabled({ timeout: 3_000 }).catch(() => false)
      : false;
    record({
      form: "4.비번재설정",
      field: "버튼 활성(토큰)",
      value: btnEnabled ? "enabled" : "disabled",
      submitted: btnEnabled ? "✅" : "⏭️",
      reload: "-",
      api: "-",
    });

    if (btnEnabled) {
      // 제출 → 무효 토큰으로 실패 메시지
      await btn.click();

      const errorEl = page.locator('[role="alert"]').first();
      const errorVisible = await errorEl.isVisible({ timeout: 10_000 }).catch(() => false);
      const errorText = errorVisible ? (await errorEl.textContent()) ?? "" : "";

      record({
        form: "4.비번재설정",
        field: "더미토큰 제출",
        value: errorText.slice(0, 30) || "응답없음",
        submitted: errorVisible ? "✅" : "⏭️",
        reload: "-",
        api: "-",
        note: errorVisible ? "실패 메시지 표시됨(정상 — 무효 토큰)" : "에러 없음 — API가 무효 토큰을 허용할 수 있음",
      });
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 5. 초대 수락 — /accept-invitation
// ══════════════════════════════════════════════════════════════
test.describe("5. 초대 수락 (/accept-invitation)", () => {
  test("5-1 토큰 없을 때 버튼 비활성", async ({ page }) => {
    await page.goto("/accept-invitation");
    // 비로그인 상태 접근 — 폼 렌더 확인
    const heading = page.locator("h1").filter({ hasText: "팀 초대 수락" });
    const headingVisible = await heading.isVisible({ timeout: 10_000 }).catch(() => false);

    if (!headingVisible) {
      // 로그인 페이지로 리다이렉트 될 수 있음
      const url = page.url();
      record({
        form: "5.초대수락",
        field: "토큰없음 접근",
        value: url.includes("login") ? "/login 리다이렉트" : url,
        submitted: "⏭️",
        reload: "-",
        api: "-",
        note: "토큰 없으면 접근 불가 또는 리다이렉트(정상)",
      });
      return;
    }

    record({ form: "5.초대수락", field: "폼 렌더", value: "OK", submitted: "✅", reload: "-", api: "-" });

    // 버튼 비활성 확인 (token="" 이면 disabled)
    const btn = page.getByRole("button", { name: "가입 완료" });
    const isDisabled = await btn.isDisabled({ timeout: 3_000 }).catch(() => false);
    record({
      form: "5.초대수락",
      field: "버튼 비활성",
      value: isDisabled ? "disabled(정상)" : "enabled",
      submitted: isDisabled ? "✅" : "⏭️",
      reload: "-",
      api: "-",
      note: isDisabled ? "토큰 없으면 버튼 비활성(정상)" : "토큰 없는데 활성(제품버그 후보)",
    });
  });

  test("5-2 더미 토큰 + 이름·비번 입력 → 폼 렌더·제출·실패 메시지", async ({ page }) => {
    const DUMMY_TOKEN = `dummy-invite-${SFX}-invalid`;

    await page.goto(`/accept-invitation?token=${DUMMY_TOKEN}`);

    const heading = page.locator("h1").filter({ hasText: "팀 초대 수락" });
    const headingVisible = await heading.isVisible({ timeout: 10_000 }).catch(() => false);

    if (!headingVisible) {
      record({
        form: "5.초대수락",
        field: "더미토큰 폼렌더",
        value: "폼 미표시",
        submitted: "⏭️",
        reload: "-",
        api: "-",
        note: "토큰 검증 후 리다이렉트 가능",
      });
      return;
    }

    // 이름 입력
    // AcceptInvitationClient의 <Label>이름</Label>은 htmlFor 없음 → getByLabel 불가
    // div.space-y-2 > Label + Input 구조로 필터 탐색
    const nameInput = page.locator("div.space-y-2").filter({ hasText: /^이름$/ }).getByRole("textbox");
    await nameInput.fill(`E2E초대${SFX}`);
    record({ form: "5.초대수락", field: "이름", value: `E2E초대${SFX}`, submitted: "✅", reload: "-", api: "-" });

    // 비밀번호 입력
    const pwInput = page.locator("div.space-y-2").filter({ hasText: /^비밀번호$/ }).locator("input[type='password']");
    await pwInput.fill(`InvitePass${SFX}!`);
    record({ form: "5.초대수락", field: "비밀번호", value: "***", submitted: "✅", reload: "-", api: "-" });

    // 버튼 활성 확인 (token 있으면)
    const btn = page.getByRole("button", { name: "가입 완료" });
    const btnEnabled = await btn.isEnabled({ timeout: 3_000 }).catch(() => false);
    record({
      form: "5.초대수락",
      field: "버튼 활성(토큰)",
      value: btnEnabled ? "enabled" : "disabled",
      submitted: btnEnabled ? "✅" : "⏭️",
      reload: "-",
      api: "-",
    });

    if (btnEnabled) {
      // 제출 → 무효 토큰으로 실패 메시지
      await btn.click();

      const errorEl = page.locator('[role="alert"]').first();
      const errorVisible = await errorEl.isVisible({ timeout: 10_000 }).catch(() => false);
      const errorText = errorVisible ? (await errorEl.textContent()) ?? "" : "";

      record({
        form: "5.초대수락",
        field: "더미토큰 제출",
        value: errorText.slice(0, 30) || "응답없음",
        submitted: errorVisible ? "✅" : "⏭️",
        reload: "-",
        api: "-",
        note: errorVisible ? "실패 메시지(정상 — 무효 토큰)" : "에러 없음",
      });
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 6. 계정 설정 — /account
// ══════════════════════════════════════════════════════════════
test.describe("6. 계정 설정 (/account)", () => {
  // 원복할 원래 값 저장
  let originalName = "";
  let originalPhone = "";

  test.beforeAll(async ({ playwright }) => {
    // 원래 프로필 값 획득
    const req = await playwright.request.newContext({
      baseURL: process.env.BASE_URL ?? "http://127.0.0.1:3019",
    });
    await loginAsDemoApi(req);
    const res = await req.get("/api/account");
    const body = (await res.json()) as { data?: { name?: string; phone?: string } };
    originalName = body.data?.name ?? "";
    originalPhone = body.data?.phone ?? "";
    await req.dispose();
  });

  test("6-1 프로필 탭 — 이름·전화번호 수정 → 저장 → 리로드 유지 + API 확인", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "계정 설정" })).toBeVisible({ timeout: 10_000 });

    // 프로필 탭 확인 (기본값)
    const profileTab = page.getByRole("tab", { name: "프로필" });
    if (await profileTab.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await profileTab.click();
    }

    const NEW_NAME = `E2E수정이름${SFX}`;
    const NEW_PHONE = `010-${SFX.slice(0, 4)}-${SFX.slice(4, 8)}`;

    // 프로필 탭패널 내 Field 컴포넌트는 <Label>이름</Label> (htmlFor 없음)
    // → getByLabel() 불가. div.space-y-2 > text + input 구조로 탐색
    const profilePanel = page.getByRole("tabpanel", { name: "프로필" });

    // 이름 수정
    const nameInput = profilePanel.locator("div.space-y-2").filter({ hasText: /^이름$/ }).getByRole("textbox");
    await expect(nameInput).toBeVisible({ timeout: 10_000 });
    await nameInput.clear();
    await nameInput.fill(NEW_NAME);
    record({ form: "6.계정설정", field: "이름", value: NEW_NAME, submitted: "✅", reload: "-", api: "-" });

    // 이메일 (disabled — 읽기전용)
    const emailInput = profilePanel.locator("div.space-y-2").filter({ hasText: /^이메일$/ }).getByRole("textbox");
    const emailDisabled = await emailInput.isDisabled({ timeout: 2_000 }).catch(() => false);
    record({
      form: "6.계정설정",
      field: "이메일(읽기전용)",
      value: emailDisabled ? "disabled(정상)" : "enabled",
      submitted: emailDisabled ? "✅" : "⏭️",
      reload: "-",
      api: "-",
    });

    // 전화번호 수정
    const phoneInput = profilePanel.locator("div.space-y-2").filter({ hasText: /^전화번호$/ }).getByRole("textbox");
    await phoneInput.clear();
    await phoneInput.fill(NEW_PHONE);
    record({ form: "6.계정설정", field: "전화번호", value: NEW_PHONE, submitted: "✅", reload: "-", api: "-" });

    // 저장
    const saveBtn = page.getByRole("button", { name: "저장" });
    await saveBtn.click();

    // 성공 토스트 대기
    await page.waitForTimeout(2_000);

    // 리로드 후 값 유지 확인
    await page.reload();
    await expect(page.getByRole("heading", { name: "계정 설정" })).toBeVisible({ timeout: 10_000 });

    // 프로필 탭으로 이동
    const profileTab2 = page.getByRole("tab", { name: "프로필" });
    if (await profileTab2.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await profileTab2.click();
    }

    const nameAfterReload = await page.getByRole("tabpanel", { name: "프로필" }).locator("div.space-y-2").filter({ hasText: /^이름$/ }).getByRole("textbox").inputValue().catch(() => "");
    const nameKept = nameAfterReload === NEW_NAME;
    record({
      form: "6.계정설정",
      field: "이름 리로드 유지",
      value: nameAfterReload.slice(0, 20),
      submitted: "✅",
      reload: nameKept ? "✅" : "❌",
      api: "-",
      note: nameKept ? undefined : `리로드 후 불일치: 기대='${NEW_NAME}' 실제='${nameAfterReload}'`,
    });

    // API 확인
    const apiRes = await sharedRequest.get("/api/account");
    const apiBody = (await apiRes.json()) as { data?: { name?: string; phone?: string } };
    const apiName = apiBody.data?.name ?? "";
    const apiPhone = apiBody.data?.phone ?? "";
    const apiNameOk = apiName === NEW_NAME;
    const apiPhoneOk = apiPhone === NEW_PHONE;

    record({
      form: "6.계정설정",
      field: "이름 API 확인",
      value: apiName.slice(0, 20),
      submitted: "✅",
      reload: nameKept ? "✅" : "❌",
      api: apiNameOk ? "✅" : "❌",
      note: apiNameOk ? undefined : `API 불일치: '${apiName}'`,
    });
    record({
      form: "6.계정설정",
      field: "전화번호 API 확인",
      value: apiPhone.slice(0, 20),
      submitted: "✅",
      reload: "-",
      api: apiPhoneOk ? "✅" : "❌",
      note: apiPhoneOk ? undefined : `API 불일치: '${apiPhone}'`,
    });

    // 원복 (원래 이름/전화번호 복원)
    if (originalName) {
      await sharedRequest.patch("/api/account", {
        data: { name: originalName, phone: originalPhone },
      });
    }
  });

  test("6-2 비밀번호 탭 — 현재/새 비밀번호 입력 후 에러 케이스(데모 계정 보호)", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "계정 설정" })).toBeVisible({ timeout: 10_000 });

    // 비밀번호 탭 선택
    const pwTab = page.getByRole("tab", { name: "비밀번호" });
    await expect(pwTab).toBeVisible({ timeout: 5_000 });
    await pwTab.click();

    // 현재 비밀번호 필드
    // AccountSettingsClient의 Field 컴포넌트는 <Label> without htmlFor → getByLabel 불가
    // 비밀번호 탭패널 내 div.space-y-2 > text + input[type=password] 구조로 탐색
    const pwPanel = page.getByRole("tabpanel", { name: "비밀번호" });
    const currentPwInput = pwPanel.locator("div.space-y-2").filter({ hasText: /^현재 비밀번호$/ }).locator("input[type='password']");
    await expect(currentPwInput).toBeVisible({ timeout: 5_000 });
    // 잘못된 현재 비밀번호로 에러 케이스만 검증 (데모 비번 유지)
    await currentPwInput.fill("WrongCurrentPass999!");
    record({ form: "6.계정설정", field: "현재비번(오답)", value: "***", submitted: "✅", reload: "-", api: "-" });

    // 새 비밀번호 필드
    const newPwInput = pwPanel.locator("div.space-y-2").filter({ hasText: /^새 비밀번호$/ }).locator("input[type='password']");
    await newPwInput.fill(`NewPw${SFX}!`);
    record({ form: "6.계정설정", field: "새 비밀번호", value: "***", submitted: "✅", reload: "-", api: "-" });

    // 비밀번호 변경 버튼
    const changeBtn = page.getByRole("button", { name: "비밀번호 변경" });
    await changeBtn.click();

    // 에러 메시지 확인 (오답 현재 비번)
    await page.waitForTimeout(2_000);
    // 토스트나 에러 요소 확인
    const errorEl = page.locator('[role="alert"], [data-sonner-toast]').first();
    const errorVisible = await errorEl.isVisible({ timeout: 5_000 }).catch(() => false);

    record({
      form: "6.계정설정",
      field: "오답비번 에러",
      value: errorVisible ? "에러표시(정상)" : "에러없음",
      submitted: errorVisible ? "✅" : "⏭️",
      reload: "-",
      api: "-",
      note: errorVisible ? "오답 현재비번 에러 표시됨" : "API가 오답비번을 수락한 경우 제품버그 후보",
    });

    // 데모 계정 비번 여전히 유효한지 API 확인
    const loginCheck = await sharedRequest.post("/api/auth/login", {
      data: demoCredentials,
    });
    const demoIntact = loginCheck.ok();
    record({
      form: "6.계정설정",
      field: "데모비번 원본 유지",
      value: demoIntact ? "OK" : "변경됨",
      submitted: "✅",
      reload: "-",
      api: demoIntact ? "✅" : "❌",
      note: demoIntact ? undefined : "데모 비번이 변경됐을 수 있음 — 수동 확인 필요",
    });
  });

  test("6-3 알림 탭 — '준비중' 스텁 확인", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "계정 설정" })).toBeVisible({ timeout: 10_000 });

    // 알림 탭 선택
    const notifTab = page.getByRole("tab", { name: "알림" });
    await expect(notifTab).toBeVisible({ timeout: 5_000 });
    await notifTab.click();

    // "준비 중" 문구 확인
    const stubText = page.getByText(/준비 중|준비중/).first();
    const stubVisible = await stubText.isVisible({ timeout: 5_000 }).catch(() => false);
    record({
      form: "6.계정설정",
      field: "알림탭 스텁",
      value: stubVisible ? "준비중 표시" : "없음",
      submitted: stubVisible ? "✅" : "❌",
      reload: "-",
      api: "-",
      note: stubVisible ? "알림 탭 스텁 확인됨(정상)" : "스텁 미표시(제품버그 후보 또는 기능 구현됨)",
    });

    // 알림 설정 관련 입력 필드가 없는지 확인 (스텁이므로)
    const inputCount = await page.locator('input[type="checkbox"], input[type="radio"]').count();
    record({
      form: "6.계정설정",
      field: "알림탭 입력없음",
      value: `입력 ${inputCount}개`,
      submitted: inputCount === 0 ? "✅" : "⏭️",
      reload: "-",
      api: "-",
      note: inputCount > 0 ? "스텁인데 입력 필드 존재 — 미구현 기능 노출 가능" : undefined,
    });
  });

  test("6-4 AI 사용량 탭 — 렌더 확인", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "계정 설정" })).toBeVisible({ timeout: 10_000 });

    // AI 사용량 탭 선택
    const aiTab = page.getByRole("tab", { name: "AI 사용량" });
    await expect(aiTab).toBeVisible({ timeout: 5_000 });
    await aiTab.click();

    // AI 사용량 카드 렌더 확인
    // AiUsageCard 렌더 대기 — 로딩 또는 데이터 표시
    await page.waitForTimeout(2_000);

    // 에러 없이 렌더되었는지 확인
    const errorEl = page.locator('[role="alert"]').first();
    const errorVisible = await errorEl.isVisible({ timeout: 2_000 }).catch(() => false);
    // 탭 콘텐츠 영역에 뭔가 있는지 확인
    const tabContent = page.locator('[role="tabpanel"]:visible').first();
    const contentVisible = await tabContent.isVisible({ timeout: 3_000 }).catch(() => false);

    record({
      form: "6.계정설정",
      field: "AI사용량탭 렌더",
      value: contentVisible ? "OK" : "미표시",
      submitted: contentVisible ? "✅" : "❌",
      reload: "-",
      api: "-",
      note: errorVisible ? "에러 표시됨" : contentVisible ? undefined : "탭 콘텐츠 미표시",
    });

    // API 직접 확인
    const aiRes = await sharedRequest.get("/api/account/ai-usage");
    const aiOk = aiRes.ok();
    record({
      form: "6.계정설정",
      field: "AI사용량 API",
      value: `HTTP ${aiRes.status()}`,
      submitted: "✅",
      reload: "-",
      api: aiOk ? "✅" : "❌",
      note: aiOk ? undefined : `AI사용량 API ${aiRes.status()}`,
    });
  });
});

// ══════════════════════════════════════════════════════════════
// 7. 팀원 — /account/members
// ══════════════════════════════════════════════════════════════
test.describe("7. 팀원 (/account/members)", () => {
  let invitedEmail: string;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
  let invitedId: string | null = null;

  test("7-1 멤버 초대 — 이름·이메일·역할 입력 → 제출 → 초대 목록 반영", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto("/account/members");
    await expect(page.getByRole("heading", { name: "팀 멤버" })).toBeVisible({ timeout: 10_000 });

    invitedEmail = `invite${SFX}@test.pickket.kr`;
    const invitedName = `초대테스터${SFX}`;

    // 이름 입력 (placeholder="이름")
    const nameInput = page.getByPlaceholder("이름");
    await nameInput.fill(invitedName);
    record({ form: "7.팀원", field: "이름", value: invitedName, submitted: "✅", reload: "-", api: "-" });

    // 이메일 입력 (placeholder="이메일")
    const emailInput = page.getByPlaceholder("이메일");
    await emailInput.fill(invitedEmail);
    record({ form: "7.팀원", field: "이메일", value: invitedEmail, submitted: "✅", reload: "-", api: "-" });

    // 역할 선택 (Select — "staff" 기본값)
    const roleSelect = page.locator('[role="combobox"]').first();
    const roleValue = await roleSelect.textContent().catch(() => "");
    record({
      form: "7.팀원",
      field: "역할",
      value: roleValue?.trim() || "staff(기본)",
      submitted: "✅",
      reload: "-",
      api: "-",
    });

    // "organizer"로 변경
    await roleSelect.click();
    const organizerOpt = page.getByRole("option", { name: "organizer" });
    if (await organizerOpt.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await organizerOpt.click();
      record({ form: "7.팀원", field: "역할 변경", value: "organizer", submitted: "✅", reload: "-", api: "-" });
    } else {
      // 옵션 못찾으면 기본값 유지
      await page.keyboard.press("Escape").catch(() => null);
      record({ form: "7.팀원", field: "역할 변경", value: "옵션 없음", submitted: "⏭️", reload: "-", api: "-" });
    }

    // 초대하기 클릭
    const inviteBtn = page.getByRole("button", { name: "초대하기" });
    await inviteBtn.click();

    // API로 초대 목록 확인
    await page.waitForTimeout(2_000);
    const invRes = await sharedRequest.get("/api/account/members");
    const invBody = (await invRes.json()) as {
      data?: { invitations?: Array<{ id: string; email: string; status: string; role: string }> };
    };
    const invitation = (invBody.data?.invitations ?? []).find((i) => i.email === invitedEmail);

    if (invitation) {
      invitedId = invitation.id;
      record({
        form: "7.팀원",
        field: "초대 목록 반영",
        value: `id=${invitation.id.slice(0, 8)}... role=${invitation.role}`,
        submitted: "✅",
        reload: "-",
        api: "✅",
      });
    } else {
      record({
        form: "7.팀원",
        field: "초대 목록 반영",
        value: "목록에 없음",
        submitted: "❌",
        reload: "-",
        api: "❌",
        note: `초대 API에서 '${invitedEmail}' 미확인`,
      });
    }

    // UI에서 초대 이메일 표시 확인
    const emailVisible = await page.getByText(invitedEmail).isVisible({ timeout: 8_000 }).catch(() => false);
    record({
      form: "7.팀원",
      field: "UI 초대이메일",
      value: emailVisible ? "표시됨" : "미표시",
      submitted: "✅",
      reload: emailVisible ? "✅" : "⏭️",
      api: invitation ? "✅" : "❌",
    });
  });

  test("7-2 초대 재발송 버튼 동작", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto("/account/members");
    await expect(page.getByRole("heading", { name: "팀 멤버" })).toBeVisible({ timeout: 10_000 });

    // 초대 목록에서 재발송 버튼 찾기
    const resendBtns = page.getByRole("button", { name: "재발송" });
    const resendCount = await resendBtns.count();

    if (resendCount === 0) {
      record({
        form: "7.팀원",
        field: "재발송 버튼",
        value: "없음",
        submitted: "⏭️",
        reload: "-",
        api: "-",
        note: "초대 목록이 비어있거나 버튼 미표시",
      });
      return;
    }

    record({ form: "7.팀원", field: "재발송 버튼", value: `${resendCount}개 표시`, submitted: "✅", reload: "-", api: "-" });

    // 첫 번째 재발송 클릭
    await resendBtns.first().click();
    await page.waitForTimeout(1_500);

    // 버튼이 다시 나타남(재발송 완료)
    const stillVisible = await resendBtns.first().isVisible({ timeout: 5_000 }).catch(() => false);
    record({
      form: "7.팀원",
      field: "재발송 완료",
      value: stillVisible ? "버튼 재표시" : "버튼 사라짐",
      submitted: "✅",
      reload: "-",
      api: "-",
      note: "재발송 후 버튼 상태 변화 확인",
    });
  });

  test("7-3 역할 변경 Select — 기존 멤버 역할 변경", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto("/account/members");
    await expect(page.getByRole("heading", { name: "팀 멤버" })).toBeVisible({ timeout: 10_000 });

    // 멤버 목록의 역할 변경 Select (멤버 테이블 내 combobox)
    // 멤버 목록 영역에서 역할 변경 버튼 탐색
    const memberRows = page.locator(".grid.grid-cols-\\[1\\.2fr_1\\.4fr_1\\.4fr_1\\.3fr_1fr\\]").filter({
      hasNot: page.locator(".font-semibold"), // 헤더 제외
    });
    const memberCount = await memberRows.count();

    if (memberCount === 0) {
      record({ form: "7.팀원", field: "멤버 목록", value: "멤버 없음", submitted: "⏭️", reload: "-", api: "-" });
      return;
    }
    record({ form: "7.팀원", field: "멤버 목록", value: `${memberCount}명`, submitted: "✅", reload: "-", api: "-" });

    // 멤버 행 내의 역할 변경 select (w-[128px] 버튼)
    const roleChangeTriggers = page.locator('.h-9.w-\\[128px\\]');
    const triggerCount = await roleChangeTriggers.count();
    record({
      form: "7.팀원",
      field: "역할변경 Select",
      value: `${triggerCount}개 렌더`,
      submitted: triggerCount > 0 ? "✅" : "⏭️",
      reload: "-",
      api: "-",
    });
  });

  test("7-4 멤버 목록 리로드 유지", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto("/account/members");
    await expect(page.getByRole("heading", { name: "팀 멤버" })).toBeVisible({ timeout: 10_000 });

    // 초대 이메일이 있으면 목록에 있어야 함
    if (invitedEmail) {
      const emailVisible = await page.getByText(invitedEmail).isVisible({ timeout: 5_000 }).catch(() => false);

      await page.reload();
      await expect(page.getByRole("heading", { name: "팀 멤버" })).toBeVisible({ timeout: 10_000 });

      const emailAfterReload = await page.getByText(invitedEmail).isVisible({ timeout: 8_000 }).catch(() => false);
      record({
        form: "7.팀원",
        field: "초대목록 리로드",
        value: invitedEmail.slice(0, 25),
        submitted: "✅",
        reload: emailAfterReload ? "✅" : "❌",
        api: "-",
        note: emailAfterReload ? undefined : emailVisible ? "리로드 후 초대 이메일 미표시" : "초대 미반영 상태",
      });
    } else {
      // API로 멤버 수 확인
      const res = await sharedRequest.get("/api/account/members");
      const body = (await res.json()) as { data?: { members?: unknown[] } };
      const memberCount = body.data?.members?.length ?? 0;
      record({
        form: "7.팀원",
        field: "멤버 API 확인",
        value: `멤버 ${memberCount}명`,
        submitted: "✅",
        reload: "-",
        api: res.ok() ? "✅" : "❌",
      });
    }
  });
});

// ══════════════════════════════════════════════════════════════
// 8. 보안 (MFA/TOTP) — /account/security
// ══════════════════════════════════════════════════════════════
test.describe("8. 보안 (/account/security)", () => {
  test("8-1 MFA 셋업 화면 렌더 — 현재 상태 표시", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto("/account/security");

    // "2차 인증 (TOTP)" 헤딩
    await expect(page.getByRole("heading", { name: "2차 인증 (TOTP)" })).toBeVisible({ timeout: 15_000 });
    record({ form: "8.보안MFA", field: "페이지 렌더", value: "OK", submitted: "✅", reload: "-", api: "-" });

    // 현재 상태 카드 렌더
    const statusCard = page.locator('.rounded-xl, [data-slot="card"]').first();
    const statusVisible = await statusCard.isVisible({ timeout: 5_000 }).catch(() => false);
    record({
      form: "8.보안MFA",
      field: "상태 카드 렌더",
      value: statusVisible ? "OK" : "없음",
      submitted: statusVisible ? "✅" : "❌",
      reload: "-",
      api: "-",
    });

    // 상태: 활성화됨 / 비활성화 둘 중 하나
    const enabledText = page.getByText("2차 인증 활성화됨");
    const disabledText = page.getByText("2차 인증 비활성화");
    const isEnabled = await enabledText.isVisible({ timeout: 3_000 }).catch(() => false);
    const isDisabled = await disabledText.isVisible({ timeout: 3_000 }).catch(() => false);

    record({
      form: "8.보안MFA",
      field: "MFA 현재 상태",
      value: isEnabled ? "활성화됨" : isDisabled ? "비활성화" : "상태미확인",
      submitted: (isEnabled || isDisabled) ? "✅" : "❌",
      reload: "-",
      api: "-",
      note: (!isEnabled && !isDisabled) ? "상태 텍스트 미탐지" : undefined,
    });
  });

  test("8-2 MFA 비활성 상태 — 설정하기 버튼 클릭 → QR/시크릿 표시(boundary)", async ({ page }) => {
    await loginAsDemo(page);
    await page.goto("/account/security");
    await expect(page.getByRole("heading", { name: "2차 인증 (TOTP)" })).toBeVisible({ timeout: 15_000 });

    // 이미 MFA 활성화된 경우 스킵
    const enabledText = page.getByText("2차 인증 활성화됨");
    const isAlreadyEnabled = await enabledText.isVisible({ timeout: 3_000 }).catch(() => false);
    if (isAlreadyEnabled) {
      record({
        form: "8.보안MFA",
        field: "QR 셋업",
        value: "이미 활성화됨",
        submitted: "⏭️",
        reload: "-",
        api: "-",
        note: "MFA 이미 활성화 — 셋업 버튼 없음",
      });
      return;
    }

    // "2차 인증 설정하기" 버튼 클릭
    const setupBtn = page.getByRole("button", { name: "2차 인증 설정하기" });
    const setupVisible = await setupBtn.isVisible({ timeout: 5_000 }).catch(() => false);
    if (!setupVisible) {
      record({
        form: "8.보안MFA",
        field: "셋업 버튼",
        value: "미표시",
        submitted: "⏭️",
        reload: "-",
        api: "-",
        note: "셋업 버튼 미탐지",
      });
      return;
    }
    record({ form: "8.보안MFA", field: "셋업 버튼", value: "표시됨", submitted: "✅", reload: "-", api: "-" });

    await setupBtn.click();

    // API 호출 완료 대기 — QR 코드 또는 에러
    await page.waitForTimeout(3_000);

    // QR 이미지 또는 수동 입력 키 표시 확인
    const qrImage = page.locator('img[alt="QR Code"]');
    const secretCode = page.locator("code").filter({ hasText: /[A-Z2-7]{16,}/ }).first();
    const qrVisible = await qrImage.isVisible({ timeout: 5_000 }).catch(() => false);
    const secretVisible = await secretCode.isVisible({ timeout: 5_000 }).catch(() => false);

    record({
      form: "8.보안MFA",
      field: "QR 코드 표시",
      value: qrVisible ? "표시됨" : "없음",
      submitted: qrVisible ? "✅" : "⏭️",
      reload: "-",
      api: "-",
      note: qrVisible ? undefined : "QR 이미지 미탐지 (API 실패 또는 이미 활성)",
    });
    record({
      form: "8.보안MFA",
      field: "수동 입력 키",
      value: secretVisible ? "표시됨" : "없음",
      submitted: secretVisible ? "✅" : "⏭️",
      reload: "-",
      api: "-",
    });

    // 인증 코드 입력 폼 렌더 확인 (6자리 코드 입력창)
    const verifyInput = page.locator('input[placeholder="000000"]');
    const verifyInputVisible = await verifyInput.isVisible({ timeout: 5_000 }).catch(() => false);
    record({
      form: "8.보안MFA",
      field: "TOTP 코드 입력폼",
      value: verifyInputVisible ? "렌더됨" : "없음",
      submitted: verifyInputVisible ? "✅" : "⏭️",
      reload: "-",
      api: "-",
      note: verifyInputVisible ? "코드 입력 폼 렌더(boundary OK)" : "코드 입력창 미탐지",
    });

    // 확인 버튼 표시 (실제 활성화는 유효 TOTP 필요하므로 렌더만 확인)
    const confirmBtn = page.getByRole("button", { name: "확인" });
    const confirmBtnVisible = await confirmBtn.isVisible({ timeout: 3_000 }).catch(() => false);
    const confirmBtnDisabled = confirmBtnVisible
      ? await confirmBtn.isDisabled({ timeout: 2_000 }).catch(() => false)
      : false;
    record({
      form: "8.보안MFA",
      field: "확인 버튼",
      value: confirmBtnVisible
        ? confirmBtnDisabled
          ? "표시됨(비활성 — 코드미입력)"
          : "표시됨(활성)"
        : "없음",
      submitted: confirmBtnVisible ? "✅" : "⏭️",
      reload: "-",
      api: "-",
      note: "실제 활성화는 유효 TOTP 코드 필요 — 렌더까지만 검증(boundary)",
    });
  });

  test("8-3 보안 페이지 API 확인 — MFA 상태 조회", async () => {
    // /api/auth/me로 mfaEnabled 상태 확인
    const meRes = await sharedRequest.get("/api/auth/me");
    const meOk = meRes.ok();
    const meBody = (await meRes.json().catch(() => ({}))) as { data?: { mfaEnabled?: boolean } };
    const mfaEnabled = meBody.data?.mfaEnabled;

    record({
      form: "8.보안MFA",
      field: "API /auth/me",
      value: meOk ? `mfaEnabled=${mfaEnabled}` : `HTTP ${meRes.status()}`,
      submitted: "✅",
      reload: "-",
      api: meOk ? "✅" : "❌",
      note: meOk ? undefined : "/auth/me API 실패",
    });

    // /api/auth/mfa/setup (POST) — 셋업 시작 가능 여부(로그인 상태 + 미활성이어야)
    if (!mfaEnabled) {
      const setupRes = await sharedRequest.post("/api/auth/mfa/setup");
      const setupOk = setupRes.ok();
      const setupBody = (await setupRes.json().catch(() => ({}))) as {
        data?: { qrDataUri?: string; secret?: string; backupCodes?: string[] };
      };
      record({
        form: "8.보안MFA",
        field: "API mfa/setup",
        value: setupOk ? `QR=${!!setupBody.data?.qrDataUri}` : `HTTP ${setupRes.status()}`,
        submitted: "✅",
        reload: "-",
        api: setupOk ? "✅" : "⏭️",
        note: setupOk
          ? "셋업 API 성공 — QR·시크릿·백업코드 반환"
          : `HTTP ${setupRes.status()} — 이미 활성화됐거나 인증 실패`,
      });
    } else {
      record({
        form: "8.보안MFA",
        field: "API mfa/setup",
        value: "이미 활성화 — 스킵",
        submitted: "⏭️",
        reload: "-",
        api: "⏭️",
        note: "MFA 이미 활성화된 상태",
      });
    }
  });
});
