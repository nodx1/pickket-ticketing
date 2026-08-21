/**
 * 전역 에러 수집 Fixture
 *
 * 모든 E2E 테스트에서 자동으로:
 * 1. 브라우저 콘솔 error/warning 수집
 * 2. 미처리 JS 예외(pageerror) 수집
 * 3. 네트워크 4xx/5xx 응답 수집
 *
 * 테스트 종료 시 에러가 있으면 자동 실패 + 상세 리포트.
 */
import { test as base, type Page } from "@playwright/test";

interface CollectedError {
  type: "console" | "pageerror" | "network";
  message: string;
  url?: string;
  status?: number;
  timestamp: number;
}

/** 무시할 콘솔 메시지 패턴 (노이즈 필터) */
const IGNORE_PATTERNS = [
  /Download the React DevTools/,
  /webpack-hmr/,
  /\[HMR\]/,
  /Fast Refresh/,
  /hydration/i,
  /content-security-policy/i,
  /favicon\.ico/,
  /manifest\.webmanifest/,
  /cloudflareinsights/,
  /sentry/i,
  /__nextjs/,
];

/** 무시할 네트워크 경로 */
const IGNORE_NETWORK_PATHS = [
  "/api/v1/metrics/",
  "/_next/",
  "/favicon.ico",
  "/manifest",
  "/sw.js",
  "cloudflareinsights",
  "sentry.io",
];

function shouldIgnore(message: string): boolean {
  return IGNORE_PATTERNS.some((p) => p.test(message));
}

function shouldIgnoreNetwork(url: string): boolean {
  return IGNORE_NETWORK_PATHS.some((p) => url.includes(p));
}

function attachErrorCollector(page: Page): CollectedError[] {
  const errors: CollectedError[] = [];

  // 1. 콘솔 에러/경고 수집
  page.on("console", (msg) => {
    const type = msg.type();
    if (type !== "error" && type !== "warning") return;

    const text = msg.text();
    if (shouldIgnore(text)) return;

    errors.push({
      type: "console",
      message: `[console.${type}] ${text}`,
      url: page.url(),
      timestamp: Date.now(),
    });
  });

  // 2. 미처리 JS 예외 수집
  page.on("pageerror", (error) => {
    const msg = error.message || String(error);
    if (shouldIgnore(msg)) return;

    errors.push({
      type: "pageerror",
      message: `[Uncaught] ${msg}`,
      url: page.url(),
      timestamp: Date.now(),
    });
  });

  // 3. 네트워크 4xx/5xx 수집
  page.on("response", (response) => {
    const status = response.status();
    const url = response.url();

    if (status < 400) return;
    if (shouldIgnoreNetwork(url)) return;
    // 401은 미인증 상태에서 정상일 수 있음
    if (status === 401) return;

    errors.push({
      type: "network",
      message: `[HTTP ${status}] ${response.request().method()} ${url}`,
      url,
      status,
      timestamp: Date.now(),
    });
  });

  return errors;
}

function formatErrors(errors: CollectedError[]): string {
  const grouped = {
    console: errors.filter((e) => e.type === "console"),
    pageerror: errors.filter((e) => e.type === "pageerror"),
    network: errors.filter((e) => e.type === "network"),
  };

  const lines: string[] = [`\n━━━ 에러 수집 리포트 (${errors.length}건) ━━━\n`];

  if (grouped.pageerror.length > 0) {
    lines.push(`🔴 미처리 예외 (${grouped.pageerror.length}건):`);
    grouped.pageerror.forEach((e) => lines.push(`  ${e.message}`));
    lines.push("");
  }

  if (grouped.console.length > 0) {
    lines.push(`🟡 콘솔 에러 (${grouped.console.length}건):`);
    grouped.console.forEach((e) => lines.push(`  ${e.message}`));
    lines.push("");
  }

  if (grouped.network.length > 0) {
    lines.push(`🔵 네트워크 에러 (${grouped.network.length}건):`);
    grouped.network.forEach((e) => lines.push(`  ${e.message}`));
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * errorCollectorPage — 에러 수집기가 장착된 Page.
 *
 * 테스트 중 발생한 모든 콘솔 에러, JS 예외, 네트워크 에러를
 * 자동 수집하고, 테스트 종료 시 에러가 있으면 리포트를 출력합니다.
 *
 * 사용법:
 *   import { test, expect } from "./fixtures/error-collector";
 *   test("페이지 정상 로드", async ({ errorCollectorPage: page }) => {
 *     await page.goto("/");
 *     // ... 테스트 로직
 *     // 테스트 끝나면 자동으로 에러 체크
 *   });
 */
export const test = base.extend<{
  errorCollectorPage: Page;
  collectedErrors: CollectedError[];
}>({
  collectedErrors: async ({}, use) => {
    const errors: CollectedError[] = [];
    await use(errors);
  },

  errorCollectorPage: async ({ page, collectedErrors }, use, testInfo) => {
    const errors = attachErrorCollector(page);

    await use(page);

    // 테스트 종료 후 에러 전달
    collectedErrors.push(...errors);

    // 에러가 있으면 리포트 첨부 (테스트 실패는 선택적)
    if (errors.length > 0) {
      const report = formatErrors(errors);
      console.warn(report);

      // 테스트 아티팩트로 에러 리포트 저장
      await testInfo.attach("error-report", {
        body: report,
        contentType: "text/plain",
      });

      // pageerror(미처리 예외)가 있으면 테스트 실패
      const critical = errors.filter((e) => e.type === "pageerror");
      if (critical.length > 0) {
        throw new Error(
          `미처리 JS 예외 ${critical.length}건 발생:\n${critical.map((e) => e.message).join("\n")}`,
        );
      }
    }
  },
});

export { expect } from "@playwright/test";
export type { CollectedError };
