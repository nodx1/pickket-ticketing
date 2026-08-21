import { defineConfig, devices } from "@playwright/test";
import fs from "fs";
import path from "path";

/* .env.e2e 로드 (dotenv 없이) */
const envFile = path.resolve(__dirname, ".env.e2e");
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
}

/**
 * Pickket Consumer E2E Test Configuration
 *
 * 실행 방법:
 *   pnpm e2e              — headless 실행
 *   pnpm e2e:ui            — Playwright UI 모드
 *   pnpm e2e:headed        — 브라우저 표시 실행
 *
 * 사전 조건:
 *   - Backend API (localhost:8021) 실행 중 (E2E_TEST_MODE=true)
 *   - 시드 데이터 (testuser0001@seedtest.pickket.kr) 준비 완료
 */

const COOKIE_STATE = path.resolve(__dirname, "e2e/.auth/cookie-consent.json");
const AUTH_STATE = path.resolve(__dirname, "e2e/.auth/user.json");

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 1,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["github"]]
    : [["html", { open: "never" }]],

  /* 글로벌 셋업: 쿠키 동의 상태를 미리 설정 */
  globalSetup: path.resolve(__dirname, "e2e/global-setup.ts"),

  use: {
    baseURL: process.env.E2E_BASE_URL || "http://localhost:3020",
    locale: "ko-KR",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "retain-on-failure",
    storageState: COOKIE_STATE,
  },

  projects: [
    /* ── Auth Setup: 로그인 1회 → 인증 상태 저장 ── */
    {
      name: "setup",
      testMatch: /auth\.setup\.ts/,
      timeout: 60_000,
      use: { ...devices["Desktop Chrome"] },
    },

    /* ── Chromium: 모든 테스트 (인증 필요 테스트는 setup 의존) ── */
    {
      name: "chromium",
      testMatch: /(?!.*site-crawler).*\.spec\.ts/,
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        /* authTest 사용 테스트는 fixture에서 storageState를 활용 */
      },
    },

    /* ── Site Crawler: 인증 불필요, 독립 실행 ── */
    {
      name: "crawler",
      testMatch: /site-crawler\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },

    /* ── Mobile (Chromium 기반 모바일 에뮬레이션 — WebKit 미설치 대응) ── */
    {
      name: "mobile",
      testMatch: /(?!.*site-crawler).*\.spec\.ts/,
      dependencies: ["setup"],
      timeout: 45_000,
      use: {
        ...devices["Pixel 7"],
        isMobile: true,
      },
    },

    /* ── Firefox: 크로스브라우저 호환성 ── */
    {
      name: "firefox",
      testMatch: /(?!.*site-crawler).*\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Firefox"] },
    },

    /* ── WebKit (Safari): 크로스브라우저 호환성 ── */
    {
      name: "webkit",
      testMatch: /(?!.*site-crawler).*\.spec\.ts/,
      dependencies: ["setup"],
      use: { ...devices["Desktop Safari"] },
    },

    /* ── 접근성 (a11y): axe-core WCAG 2.1 AA 검증 ── */
    {
      name: "a11y",
      testMatch: /a11y.*\.spec\.ts/,
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: process.env.E2E_BASE_URL
    ? undefined /* 외부 URL(스테이징) 대상이면 로컬 서버 불필요 */
    : {
        command: "pnpm run dev",
        url: "http://localhost:3020",
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
