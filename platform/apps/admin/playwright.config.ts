import { defineConfig, devices } from "@playwright/test";

/**
 * Pickket Admin E2E Test Configuration
 *
 * 실행 방법:
 *   pnpm --filter admin e2e           — headless 실행
 *   pnpm --filter admin e2e:ui        — Playwright UI 모드
 *   pnpm --filter admin e2e:headed    — 브라우저 표시 실행
 *
 * 사전 조건:
 *   - Backend API (localhost:8021) 실행 중
 *   - 시드 데이터 (관리자 계정) 준비 완료
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 2,
  workers: process.env.CI ? 1 : 3,
  reporter: process.env.CI
    ? [["html", { open: "never" }], ["github"]]
    : [["html", { open: "never" }]],

  use: {
    baseURL: "http://localhost:3022",
    locale: "ko-KR",
    screenshot: "only-on-failure",
    trace: "on-first-retry",
    video: "retain-on-failure",
  },

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: "pnpm run dev",
    url: "http://localhost:3022",
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
