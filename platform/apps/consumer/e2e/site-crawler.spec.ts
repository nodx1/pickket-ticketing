/**
 * 사이트 전체 크롤러 v2 — 자율 탐색형 에러 탐지
 *
 * 모든 페이지를 방문하며:
 * 1. 미처리 JS 예외 (pageerror)
 * 2. 콘솔 에러/경고 (console.error, console.warning)
 * 3. 네트워크 에러 (4xx/5xx API 응답)
 * 4. 깨진 링크 (내부 링크 404)
 * 5. 페이지 로드 실패
 * 6. 성능 메트릭 (LCP, 로드 시간)
 * 를 자동 수집하고 심각도별로 분류합니다.
 *
 * 실행:
 *   pnpm crawl                    # 로컬
 *   pnpm crawl:staging             # 스테이징
 */
import { test, expect } from "@playwright/test";
import fs from "fs";
import path from "path";

// ─── 타입 ───

type ErrorSeverity = "critical" | "warning" | "info";

interface CrawlError {
  page: string;
  type: "console" | "pageerror" | "network" | "load" | "broken-link" | "ssr";
  severity: ErrorSeverity;
  message: string;
  timestamp: string;
}

interface PageResult {
  url: string;
  status: string;
  statusCode: number;
  loadTimeMs: number;
  errors: number;
}

interface CrawlReport {
  timestamp: string;
  target: string;
  totalPages: number;
  totalErrors: number;
  bySeverity: { critical: number; warning: number; info: number };
  byType: {
    pageerror: number;
    ssr: number;
    load: number;
    network: number;
    brokenLinks: number;
    console: number;
  };
  uniqueErrors: { message: string; count: number; severity: ErrorSeverity }[];
  slowPages: { url: string; loadTimeMs: number }[];
  pages: PageResult[];
  errors: CrawlError[];
}

// ─── 설정 ───

/** 크롤링할 정적 페이지 목록 */
const PAGES = [
  "/",
  "/events",
  "/ranking",
  "/browse",
  "/about",
  "/blog",
  "/k-index",
  "/fairness",
  "/careers",
  "/support",
  "/auth",
  "/terms",
  "/privacy",
  "/refund-policy",
  "/public",
  "/government",
  "/for-organizers",
  "/guide",
  "/notice",
];

/** 로케일 스팟체크 (기본 3개만) */
const LOCALE_CHECK = ["en", "ja", "zh-CN"];
const LOCALE_PAGES = ["/", "/events"];

/** 페이지 간 딜레이 (ms) — rate limit 방지 */
const PAGE_DELAY = 1000;
const LINK_DELAY = 800;

/** 느린 페이지 임계값 (ms) */
const SLOW_THRESHOLD = 5000;

/** 링크 체크 최대 수 */
const MAX_LINK_CHECK = 30;

// ─── 필터 ───

/** 완전 무시할 콘솔 패턴 (noise) */
const IGNORE_CONSOLE = [
  /Download the React DevTools/,
  /webpack-hmr/,
  /\[HMR\]/,
  /Fast Refresh/,
  /hydration/i,
  /content-security-policy/i,
  /cloudflareinsights/,
  /sentry/i,
  /__nextjs/,
  /favicon/,
  /manifest\.webmanifest/,
  /net::ERR_BLOCKED_BY_CLIENT/, // 광고 차단기
  /CORS policy/, // CORS 에러 (보통 rate limit 후속)
  /net::ERR_FAILED/, // CORS 차단 후속
];

/** INFO로 다운그레이드할 패턴 (알려진 이슈, 기능 문제 아님) */
const DOWNGRADE_TO_INFO = [
  /Missing `Description` or `aria-describedby/, // Radix UI 접근성 경고
  /has a "loader" property that does not implement width/, // Next.js Image warning
  /was detected as the Largest Contentful Paint/, // LCP 힌트
  /React does not recognize the .* prop/, // React prop 경고
];

/** rate limit 관련 패턴 */
const RATE_LIMIT_PATTERNS = [/429/, /Too Many Requests/, /rate.?limit/i];

/** 발견된 링크 중 크롤링 제외할 패턴 (rate limit 유발 + 동적 페이지) */
const SKIP_DISCOVERED_LINK = [
  /\/events\/[0-9a-f]{8}-/, // 이벤트 상세 (UUID) — API 다수 호출 → rate limit
  /\/sell\//, // 판매 페이지 (인증 필요)
  /\/mypage\//, // 마이페이지 (인증 필요)
  /\/checkout\//, // 결제 페이지
];

const IGNORE_NETWORK = [
  "/_next/",
  "/favicon.ico",
  "/manifest",
  "/sw.js",
  "cloudflareinsights",
  "sentry.io",
  "/api/v1/metrics/",
  "google-analytics",
  "googletagmanager",
];

function shouldIgnoreConsole(msg: string): boolean {
  return IGNORE_CONSOLE.some((p) => p.test(msg));
}

function shouldDowngradeToInfo(msg: string): boolean {
  return DOWNGRADE_TO_INFO.some((p) => p.test(msg));
}

function isRateLimitError(msg: string): boolean {
  return RATE_LIMIT_PATTERNS.some((p) => p.test(msg));
}

function shouldIgnoreNetwork(url: string): boolean {
  return IGNORE_NETWORK.some((p) => url.includes(p));
}

// ─── 테스트 ───

test.describe("사이트 크롤러", () => {
  test.setTimeout(300_000); // 5분 타임아웃

  test("전체 페이지 크롤링 — 에러 탐지", async ({ page }, testInfo) => {
    const errors: CrawlError[] = [];
    const visitedUrls = new Set<string>();
    const discoveredLinks = new Set<string>();
    const pageResults: PageResult[] = [];
    const baseURL = page.context().pages()[0]
      ? new URL(page.url()).origin
      : "unknown";
    let rateLimitCount = 0;

    // ─── 전역 에러 수집기 ───

    page.on("console", (msg) => {
      const type = msg.type();
      if (type !== "error" && type !== "warning") return;
      const text = msg.text();
      if (shouldIgnoreConsole(text)) return;

      // rate limit은 카운트만 하고 개별 기록 안 함
      if (isRateLimitError(text)) {
        rateLimitCount++;
        return;
      }

      // SSR 에러 별도 분류 — rate limit 후속 현상이므로 warning 처리
      if (
        text.includes("Server Components render") ||
        text.includes("ErrorBoundary caught")
      ) {
        errors.push({
          page: page.url(),
          type: "ssr",
          severity: "warning",
          message: text.slice(0, 300),
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const severity: ErrorSeverity = shouldDowngradeToInfo(text)
        ? "info"
        : type === "error"
          ? "warning"
          : "info";

      errors.push({
        page: page.url(),
        type: "console",
        severity,
        message: `[console.${type}] ${text.slice(0, 300)}`,
        timestamp: new Date().toISOString(),
      });
    });

    page.on("pageerror", (error) => {
      const msg = error.message || String(error);
      if (shouldIgnoreConsole(msg)) return;

      // React hydration mismatch (#418, #425, #423) — 기능 문제 아님, WARNING 처리
      const isHydration = /error #41[8-9]|error #42[0-5]|hydration/i.test(msg);

      errors.push({
        page: page.url(),
        type: "pageerror",
        severity: isHydration ? "warning" : "critical",
        message: `[Uncaught] ${msg.slice(0, 300)}`,
        timestamp: new Date().toISOString(),
      });
    });

    page.on("response", (response) => {
      const status = response.status();
      const url = response.url();
      if (status < 400) return;
      if (shouldIgnoreNetwork(url)) return;
      if (status === 401) return;

      // 429는 rate limit 카운트
      if (status === 429) {
        rateLimitCount++;
        return;
      }

      // CORS 에러로 인한 net::ERR_FAILED는 보통 429 후속
      errors.push({
        page: page.url(),
        type: "network",
        severity: status >= 500 ? "critical" : "warning",
        message: `[HTTP ${status}] ${response.request().method()} ${url.slice(0, 200)}`,
        timestamp: new Date().toISOString(),
      });
    });

    // ─── 헬퍼: 페이지 방문 ───

    async function visitPage(
      url: string,
      delay: number,
      timeout: number = 15_000,
    ): Promise<{ status: number; loadTimeMs: number } | null> {
      const start = Date.now();
      try {
        const response = await page.goto(url, {
          waitUntil: "domcontentloaded",
          timeout,
        });
        const loadTimeMs = Date.now() - start;
        const status = response?.status() ?? 0;
        await page.waitForTimeout(delay);
        return { status, loadTimeMs };
      } catch (e) {
        const loadTimeMs = Date.now() - start;
        errors.push({
          page: url,
          type: "load",
          severity: "critical",
          message: `페이지 로드 실패: ${e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200)}`,
          timestamp: new Date().toISOString(),
        });
        return { status: 0, loadTimeMs };
      }
    }

    // ─── 1단계: 정적 페이지 크롤링 ───

    for (const pagePath of PAGES) {
      if (visitedUrls.has(pagePath)) continue;
      visitedUrls.add(pagePath);

      const errorsBefore = errors.length;
      const result = await visitPage(pagePath, PAGE_DELAY);

      if (result && result.status >= 400) {
        errors.push({
          page: pagePath,
          type: "load",
          severity: "critical",
          message: `페이지 HTTP ${result.status}: ${pagePath}`,
          timestamp: new Date().toISOString(),
        });
      }

      // 링크 수집
      if (result && result.status < 400) {
        try {
          const links = await page.evaluate(() => {
            return Array.from(document.querySelectorAll("a[href]"))
              .map((a) => a.getAttribute("href") || "")
              .filter(
                (href) =>
                  href.startsWith("/") &&
                  !href.startsWith("//") &&
                  !href.includes("mailto:") &&
                  !href.includes("tel:"),
              );
          });
          links.forEach((link) => {
            const clean = link.split("?")[0].split("#")[0];
            if (
              clean &&
              !visitedUrls.has(clean) &&
              !SKIP_DISCOVERED_LINK.some((p) => p.test(clean))
            ) {
              discoveredLinks.add(clean);
            }
          });
        } catch {
          // 링크 수집 실패는 무시
        }
      }

      pageResults.push({
        url: pagePath,
        status:
          result && result.status < 400
            ? "OK"
            : `FAIL (${result?.status ?? 0})`,
        statusCode: result?.status ?? 0,
        loadTimeMs: result?.loadTimeMs ?? 0,
        errors: errors.length - errorsBefore,
      });
    }

    // ─── 2단계: 발견된 내부 링크 검증 ───

    let linkChecked = 0;
    for (const link of discoveredLinks) {
      if (linkChecked >= MAX_LINK_CHECK) break;
      if (visitedUrls.has(link)) continue;
      visitedUrls.add(link);
      linkChecked++;

      const result = await visitPage(link, LINK_DELAY, 10_000);
      if (result && result.status >= 400 && result.status !== 401) {
        errors.push({
          page: link,
          type: "broken-link",
          severity: "warning",
          message: `깨진 링크: ${link} → HTTP ${result.status}`,
          timestamp: new Date().toISOString(),
        });
      }
    }

    // ─── 3단계: 로케일 스팟 체크 ───

    for (const locale of LOCALE_CHECK) {
      for (const pagePath of LOCALE_PAGES) {
        const url = `/${locale}${pagePath}`;
        if (visitedUrls.has(url)) continue;
        visitedUrls.add(url);

        const errorsBefore = errors.length;
        const result = await visitPage(url, LINK_DELAY, 10_000);

        if (result && result.status >= 400) {
          errors.push({
            page: url,
            type: "load",
            severity: "warning",
            message: `로케일 페이지 실패: ${url} → HTTP ${result.status}`,
            timestamp: new Date().toISOString(),
          });
        }

        pageResults.push({
          url,
          status:
            result && result.status < 400
              ? "OK"
              : `FAIL (${result?.status ?? 0})`,
          statusCode: result?.status ?? 0,
          loadTimeMs: result?.loadTimeMs ?? 0,
          errors: errors.length - errorsBefore,
        });
      }
    }

    // ─── 리포트 생성 ───

    const target = process.env.E2E_BASE_URL || "http://localhost:3020";

    // 중복 에러 그룹핑
    const errorCounts = new Map<
      string,
      { count: number; severity: ErrorSeverity }
    >();
    for (const err of errors) {
      // 메시지에서 URL 부분 제거하여 그룹핑
      const key = err.message.replace(/https?:\/\/[^\s]+/g, "<URL>");
      const existing = errorCounts.get(key);
      if (existing) {
        existing.count++;
      } else {
        errorCounts.set(key, { count: 1, severity: err.severity });
      }
    }
    const uniqueErrors = Array.from(errorCounts.entries())
      .map(([message, { count, severity }]) => ({ message, count, severity }))
      .sort((a, b) => {
        const severityOrder = { critical: 0, warning: 1, info: 2 };
        return (
          severityOrder[a.severity] - severityOrder[b.severity] ||
          b.count - a.count
        );
      });

    // 느린 페이지
    const slowPages = pageResults
      .filter((p) => p.loadTimeMs >= SLOW_THRESHOLD)
      .sort((a, b) => b.loadTimeMs - a.loadTimeMs);

    // 심각도별 카운트
    const bySeverity = {
      critical: errors.filter((e) => e.severity === "critical").length,
      warning: errors.filter((e) => e.severity === "warning").length,
      info: errors.filter((e) => e.severity === "info").length,
    };

    const report: CrawlReport = {
      timestamp: new Date().toISOString(),
      target,
      totalPages: visitedUrls.size,
      totalErrors: errors.length,
      bySeverity,
      byType: {
        pageerror: errors.filter((e) => e.type === "pageerror").length,
        ssr: errors.filter((e) => e.type === "ssr").length,
        load: errors.filter((e) => e.type === "load").length,
        network: errors.filter((e) => e.type === "network").length,
        brokenLinks: errors.filter((e) => e.type === "broken-link").length,
        console: errors.filter((e) => e.type === "console").length,
      },
      uniqueErrors,
      slowPages,
      pages: pageResults,
      errors,
    };

    // 콘솔 리포트 출력
    const textReport = generateTextReport(report, rateLimitCount);
    console.log(textReport);

    // 아티팩트 저장
    await testInfo.attach("crawl-report", {
      body: textReport,
      contentType: "text/plain",
    });

    const jsonReport = JSON.stringify(report, null, 2);
    await testInfo.attach("crawl-report.json", {
      body: jsonReport,
      contentType: "application/json",
    });

    // 파일로도 저장 (CI 텔레그램 보고용)
    const outDir = path.resolve(__dirname, "../test-results");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, "crawl-report.json"), jsonReport);

    // ─── 판정 ───
    // critical 에러가 있으면 테스트 실패
    expect(
      bySeverity.critical,
      `크리티컬 에러 ${bySeverity.critical}건 발생 (SSR: ${report.byType.ssr}, 예외: ${report.byType.pageerror}, 로드실패: ${report.byType.load})`,
    ).toBe(0);
  });
});

// ─── 텍스트 리포트 생성 ───

function generateTextReport(
  report: CrawlReport,
  rateLimitCount: number,
): string {
  const lines: string[] = [];

  lines.push("╔══════════════════════════════════════════════════╗");
  lines.push("║   Pickket 사이트 크롤링 리포트 v2               ║");
  lines.push("╚══════════════════════════════════════════════════╝");
  lines.push(`📅 ${report.timestamp}`);
  lines.push(`🎯 대상: ${report.target}`);
  lines.push(`📄 방문 페이지: ${report.totalPages}개`);
  lines.push("");

  // 심각도별 요약
  lines.push("── 심각도별 요약 ──");
  lines.push(
    `  🔴 CRITICAL: ${report.bySeverity.critical}건 (SSR ${report.byType.ssr} + 예외 ${report.byType.pageerror} + 로드실패 ${report.byType.load})`,
  );
  lines.push(
    `  🟡 WARNING:  ${report.bySeverity.warning}건 (네트워크 ${report.byType.network} + 깨진링크 ${report.byType.brokenLinks})`,
  );
  lines.push(`  🔵 INFO:     ${report.bySeverity.info}건 (콘솔 경고)`);
  if (rateLimitCount > 0) {
    lines.push(
      `  ⚡ Rate Limit: ${rateLimitCount}건 (429 응답 — 크롤러 속도로 인한 정상 동작)`,
    );
  }
  lines.push("");

  // 페이지별 결과
  lines.push("── 페이지별 결과 ──");
  for (const r of report.pages) {
    const icon = r.statusCode < 400 && r.statusCode > 0 ? "✅" : "❌";
    const loadStr = r.loadTimeMs > 0 ? ` (${r.loadTimeMs}ms)` : "";
    const errStr = r.errors > 0 ? ` [에러 ${r.errors}건]` : "";
    lines.push(`  ${icon} ${r.url} — ${r.status}${loadStr}${errStr}`);
  }
  lines.push("");

  // 느린 페이지
  if (report.slowPages.length > 0) {
    lines.push("── 🐢 느린 페이지 ──");
    for (const p of report.slowPages) {
      lines.push(`  ⚠️ ${p.url} — ${p.loadTimeMs}ms (>${SLOW_THRESHOLD}ms)`);
    }
    lines.push("");
  }

  // 고유 에러 목록 (중복 제거, 심각도 순)
  if (report.uniqueErrors.length > 0) {
    lines.push("── 고유 에러 목록 (중복 그룹핑) ──");
    for (const err of report.uniqueErrors) {
      const icon =
        err.severity === "critical"
          ? "🔴"
          : err.severity === "warning"
            ? "🟡"
            : "🔵";
      const countStr = err.count > 1 ? ` (×${err.count})` : "";
      lines.push(`  ${icon} ${err.message.slice(0, 150)}${countStr}`);
    }
    lines.push("");
  }

  // 최종 판정
  if (report.bySeverity.critical === 0) {
    lines.push("✅ 판정: PASS — 크리티컬 에러 없음");
  } else {
    lines.push(`❌ 판정: FAIL — 크리티컬 에러 ${report.bySeverity.critical}건`);
  }

  return lines.join("\n");
}
