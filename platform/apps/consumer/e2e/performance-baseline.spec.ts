import { test, expect, devices } from "@playwright/test";
import { dismissOnboarding } from "./fixtures/helpers";

/* ═══════════════════════════════════════════════════════════════════════
 * performance-baseline.spec.ts — 성능 기준선 테스트
 *
 * 페이지 로딩 시간, API 응답 속도, Core Web Vitals, 번들 크기,
 * 이미지 최적화, 폰트 로딩 등 성능 메트릭을 기준선으로 검증합니다.
 *
 * 기준값:
 *   - 페이지 로딩: < 5초
 *   - API 응답: < 2초
 *   - LCP: < 2.5초
 *   - CLS: < 0.1
 *   - 초기 JS 번들: < 500KB
 *
 * 실행: pnpm e2e -- performance-baseline
 * ═══════════════════════════════════════════════════════════════════════ */

const API_BASE = process.env.E2E_API_BASE || "http://localhost:8021/api/v1";

/** 안전하게 페이지 진입 후 온보딩 닫기 */
async function safeNavigate(
  page: import("@playwright/test").Page,
  path: string,
  waitUntil: "domcontentloaded" | "networkidle" = "networkidle",
) {
  await page.goto(path, { waitUntil, timeout: 15_000 });
  await dismissOnboarding(page);
}

/* ══════════════════════════════════════════════════════════════════════
 * 1. 페이지 로딩 시간 테스트
 * ══════════════════════════════════════════════════════════════════════ */
test.describe("페이지 로딩 시간", () => {
  /* ── 1-1. 홈페이지 로딩 시간 < 5초 ── */
  test("홈페이지가 5초 이내에 로딩된다", async ({ page }) => {
    const start = Date.now();
    await page.goto("/", { waitUntil: "networkidle", timeout: 10_000 });
    const loadTime = Date.now() - start;

    // Navigation Timing API로 정밀 측정
    const navTiming = await page.evaluate(() => {
      const entries = performance.getEntriesByType(
        "navigation",
      ) as PerformanceNavigationTiming[];
      if (entries.length === 0) return null;
      const nav = entries[0];
      return {
        domContentLoaded: Math.round(
          nav.domContentLoadedEventEnd - nav.startTime,
        ),
        loadComplete: Math.round(nav.loadEventEnd - nav.startTime),
        ttfb: Math.round(nav.responseStart - nav.startTime),
        domInteractive: Math.round(nav.domInteractive - nav.startTime),
      };
    });

    console.log(`홈페이지 로딩 시간: ${loadTime}ms`, navTiming);

    expect(loadTime, `홈페이지 로딩 ${loadTime}ms > 5000ms`).toBeLessThan(
      5_000,
    );
  });

  /* ── 1-2. 이벤트 목록 로딩 < 5초 ── */
  test("이벤트 목록 페이지가 5초 이내에 로딩된다", async ({ page }) => {
    const start = Date.now();
    await page.goto("/events", { waitUntil: "networkidle", timeout: 10_000 });
    const loadTime = Date.now() - start;

    console.log(`이벤트 목록 로딩 시간: ${loadTime}ms`);
    expect(loadTime, `이벤트 목록 로딩 ${loadTime}ms > 5000ms`).toBeLessThan(
      5_000,
    );
  });

  /* ── 1-3. 이벤트 상세 로딩 < 5초 ── */
  test("이벤트 상세 페이지가 5초 이내에 로딩된다", async ({ page }) => {
    // 먼저 이벤트 목록에서 이벤트 ID를 찾는다
    await page.goto("/events", { waitUntil: "networkidle", timeout: 10_000 });
    await dismissOnboarding(page);

    const eventLink = page.locator("a[href*='/events/']").first();
    const hasEvent = await eventLink
      .isVisible({ timeout: 5_000 })
      .catch(() => false);

    if (!hasEvent) {
      test.skip(true, "이벤트 링크를 찾을 수 없음");
      return;
    }

    const href = await eventLink.getAttribute("href");
    if (!href) {
      test.skip(true, "이벤트 href가 없음");
      return;
    }

    const start = Date.now();
    await page.goto(href, { waitUntil: "networkidle", timeout: 10_000 });
    const loadTime = Date.now() - start;

    console.log(`이벤트 상세 로딩 시간: ${loadTime}ms (${href})`);
    expect(loadTime, `이벤트 상세 로딩 ${loadTime}ms > 5000ms`).toBeLessThan(
      5_000,
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 2. 검색 응답 시간
 * ══════════════════════════════════════════════════════════════════════ */
test.describe("검색 성능", () => {
  /* ── 2-1. 검색 결과 표시 < 3초 ── */
  test("검색 쿼리 결과가 3초 이내에 표시된다", async ({ page }) => {
    const start = Date.now();
    await page.goto("/events?q=콘서트", {
      waitUntil: "networkidle",
      timeout: 10_000,
    });
    const loadTime = Date.now() - start;

    console.log(`검색 결과 표시 시간: ${loadTime}ms`);
    expect(loadTime, `검색 응답 ${loadTime}ms > 3000ms`).toBeLessThan(3_000);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 3. API 응답 시간 테스트
 * ══════════════════════════════════════════════════════════════════════ */
test.describe("API 응답 시간", () => {
  /** API 엔드포인트별 응답 시간 측정 */
  const publicEndpoints = [
    { name: "이벤트 검색", path: "/events/search?limit=10" },
  ];

  for (const endpoint of publicEndpoints) {
    test(`${endpoint.name} API 응답이 2초 이내이다`, async ({ request }) => {
      const start = Date.now();
      const response = await request.get(`${API_BASE}${endpoint.path}`, {
        timeout: 5_000,
      });
      const elapsed = Date.now() - start;

      console.log(
        `${endpoint.name}: ${elapsed}ms (status: ${response.status()})`,
      );

      // 서버가 응답하면 2초 이내여야 함 (404/401도 응답 시간만 측정)
      expect(
        elapsed,
        `${endpoint.name} 응답 ${elapsed}ms > 2000ms`,
      ).toBeLessThan(2_000);
    });
  }

  /* ── 3-1. 페이지 로드 중 API 응답 시간 측정 ── */
  test("페이지 로드 시 모든 API 응답이 2초 이내이다", async ({ page }) => {
    const apiTimings: Array<{ url: string; duration: number; status: number }> =
      [];

    // API 요청 인터셉트
    page.on("response", async (response) => {
      const url = response.url();
      if (url.includes("/api/") || url.includes(":8021")) {
        const timing = response.request().timing();
        apiTimings.push({
          url: url.replace(/.*\/api/, "/api").slice(0, 80),
          duration: Math.round(timing.responseEnd - timing.requestStart),
          status: response.status(),
        });
      }
    });

    await page.goto("/events", { waitUntil: "networkidle", timeout: 10_000 });
    await dismissOnboarding(page);

    console.log("API 응답 시간 목록:", JSON.stringify(apiTimings, null, 2));

    // 모든 API 응답이 2초 이내
    const slowApis = apiTimings.filter((t) => t.duration > 2_000);
    expect(
      slowApis.length,
      `2초 초과 API ${slowApis.length}개: ${JSON.stringify(slowApis)}`,
    ).toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 4. 이미지 최적화 테스트
 * ══════════════════════════════════════════════════════════════════════ */
test.describe("이미지 최적화", () => {
  /* ── 4-1. Next.js Image 컴포넌트 사용 ── */
  test("이미지가 Next.js Image 최적화를 사용한다", async ({ page }) => {
    await safeNavigate(page, "/");

    const imageAnalysis = await page.evaluate(() => {
      const images = document.querySelectorAll("img");
      let nextOptimized = 0;
      let unoptimized = 0;
      const unoptimizedSrcs: string[] = [];

      images.forEach((img) => {
        // 보이지 않는 이미지 무시
        if (img.getBoundingClientRect().width === 0) return;
        // 추적/분석 픽셀 무시
        if (img.width <= 1 || img.height <= 1) return;

        const src = img.src || "";
        const srcset = img.srcset || "";

        // Next.js Image: _next/image URL 또는 srcset 포함
        if (
          src.includes("_next/image") ||
          srcset.includes("_next/image") ||
          img.getAttribute("data-nimg") !== null ||
          src.includes("imagedelivery") ||
          src.includes("cloudflare")
        ) {
          nextOptimized++;
        } else if (
          src.startsWith("data:") ||
          src.includes("svg") ||
          src.includes("favicon")
        ) {
          // 인라인/SVG/파비콘은 무시
        } else {
          unoptimized++;
          unoptimizedSrcs.push(src.slice(-60));
        }
      });

      return {
        total: images.length,
        nextOptimized,
        unoptimized,
        unoptimizedSrcs: unoptimizedSrcs.slice(0, 5),
      };
    });

    console.log("이미지 분석:", imageAnalysis);

    // 최적화되지 않은 이미지가 전체의 30% 이하
    if (imageAnalysis.total > 0) {
      const unoptimizedRatio = imageAnalysis.unoptimized / imageAnalysis.total;
      expect(
        unoptimizedRatio,
        `최적화되지 않은 이미지 비율 ${Math.round(unoptimizedRatio * 100)}%`,
      ).toBeLessThanOrEqual(0.3);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 5. 번들 크기 테스트
 * ══════════════════════════════════════════════════════════════════════ */
test.describe("번들 크기", () => {
  /* ── 5-1. 초기 JS 로드 < 500KB ── */
  test("초기 JS 번들이 500KB 이하이다", async ({ page }) => {
    let totalJsBytes = 0;
    const jsFiles: Array<{ url: string; size: number }> = [];

    // JS 요청 크기 추적
    page.on("response", async (response) => {
      const url = response.url();
      const contentType = response.headers()["content-type"] || "";

      if (
        url.endsWith(".js") ||
        contentType.includes("javascript") ||
        url.includes("/_next/static")
      ) {
        try {
          const body = await response.body();
          const size = body.length;
          totalJsBytes += size;
          jsFiles.push({
            url: url.replace(/.*\/_next/, "/_next").slice(0, 80),
            size,
          });
        } catch {
          // 일부 요청은 body를 읽을 수 없음
        }
      }
    });

    await page.goto("/", { waitUntil: "networkidle", timeout: 15_000 });

    const totalKB = Math.round(totalJsBytes / 1024);
    console.log(`초기 JS 번들 총 크기: ${totalKB}KB`);
    console.log(
      "JS 파일 목록 (상위 10개):",
      jsFiles
        .sort((a, b) => b.size - a.size)
        .slice(0, 10)
        .map((f) => `${f.url}: ${Math.round(f.size / 1024)}KB`),
    );

    expect(totalKB, `초기 JS 번들 ${totalKB}KB > 500KB`).toBeLessThanOrEqual(
      500,
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 6. Core Web Vitals
 * ══════════════════════════════════════════════════════════════════════ */
test.describe("Core Web Vitals", () => {
  /* ── 6-1. LCP < 2.5초 ── */
  test("Largest Contentful Paint (LCP)가 2.5초 이내이다", async ({ page }) => {
    // LCP 측정을 위한 PerformanceObserver 설치
    await page.addInitScript(() => {
      (window as any).__LCP_VALUE = 0;
      const observer = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        const lastEntry = entries[entries.length - 1];
        (window as any).__LCP_VALUE = lastEntry.startTime;
      });
      observer.observe({ type: "largest-contentful-paint", buffered: true });
    });

    await page.goto("/", { waitUntil: "networkidle", timeout: 15_000 });
    // LCP가 확정되려면 사용자 인터랙션 또는 약간의 대기 필요
    await page.waitForTimeout(1_000);

    const lcp = await page.evaluate(() => (window as any).__LCP_VALUE || 0);
    console.log(`LCP: ${Math.round(lcp)}ms`);

    expect(lcp, `LCP ${Math.round(lcp)}ms > 2500ms`).toBeLessThan(2_500);
  });

  /* ── 6-2. CLS < 0.1 ── */
  test("Cumulative Layout Shift (CLS)가 0.1 이하이다", async ({ page }) => {
    // CLS 측정을 위한 PerformanceObserver 설치
    await page.addInitScript(() => {
      (window as any).__CLS_VALUE = 0;
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (!(entry as any).hadRecentInput) {
            (window as any).__CLS_VALUE += (entry as any).value;
          }
        }
      });
      observer.observe({ type: "layout-shift", buffered: true });
    });

    await page.goto("/", { waitUntil: "networkidle", timeout: 15_000 });
    // 이미지/폰트 로딩으로 인한 레이아웃 시프트 대기
    await page.waitForTimeout(2_000);

    // 스크롤하여 추가 CLS 유발 확인
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await page.waitForTimeout(1_000);

    const cls = await page.evaluate(() => (window as any).__CLS_VALUE || 0);
    console.log(`CLS: ${cls.toFixed(4)}`);

    expect(cls, `CLS ${cls.toFixed(4)} > 0.1`).toBeLessThan(0.1);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 7. 네비게이션 속도
 * ══════════════════════════════════════════════════════════════════════ */
test.describe("네비게이션 속도", () => {
  /* ── 7-1. 페이지 간 이동 < 2초 ── */
  test("페이지 간 이동이 각각 2초 이내이다", async ({ page }) => {
    const routes = ["/", "/events", "/auth"];
    const timings: Array<{ from: string; to: string; duration: number }> = [];

    // 첫 페이지 로드
    await page.goto(routes[0], {
      waitUntil: "networkidle",
      timeout: 10_000,
    });
    await dismissOnboarding(page);

    for (let i = 1; i < routes.length; i++) {
      const from = routes[i - 1];
      const to = routes[i];

      const start = Date.now();
      await page.goto(to, { waitUntil: "domcontentloaded", timeout: 5_000 });
      const duration = Date.now() - start;

      timings.push({ from, to, duration });
    }

    console.log("네비게이션 타이밍:", timings);

    for (const t of timings) {
      expect(
        t.duration,
        `${t.from} → ${t.to} 이동 ${t.duration}ms > 2000ms`,
      ).toBeLessThan(2_000);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 8. 폰트 로딩
 * ══════════════════════════════════════════════════════════════════════ */
test.describe("폰트 로딩", () => {
  /* ── 8-1. Pretendard 폰트 로드 확인 ── */
  test("Pretendard 폰트가 정상 로드된다", async ({ page }) => {
    await safeNavigate(page, "/");

    const fontStatus = await page.evaluate(async () => {
      // document.fonts API로 폰트 로딩 확인
      await document.fonts.ready;

      const allFonts = Array.from(document.fonts as any).map((f: any) => ({
        family: f.family,
        status: f.status,
      }));

      // Pretendard 관련 폰트 찾기
      const pretendardFonts = allFonts.filter(
        (f) =>
          f.family.toLowerCase().includes("pretendard") ||
          f.family.toLowerCase().includes("pretendard variable"),
      );

      // body의 computed font-family 확인
      const bodyFontFamily = getComputedStyle(document.body).fontFamily;

      return {
        pretendardFonts,
        bodyFontFamily,
        totalLoadedFonts: allFonts.filter((f) => f.status === "loaded").length,
        hasPretendardInBody: bodyFontFamily
          .toLowerCase()
          .includes("pretendard"),
      };
    });

    console.log("폰트 상태:", fontStatus);

    // Pretendard가 body font-family에 포함되어 있거나, 로드된 폰트 목록에 있어야 함
    const hasPretendard =
      fontStatus.hasPretendardInBody || fontStatus.pretendardFonts.length > 0;

    expect(
      hasPretendard,
      `Pretendard 폰트를 찾을 수 없음. body font-family: ${fontStatus.bodyFontFamily}`,
    ).toBe(true);
  });

  /* ── 8-2. 폰트 로딩이 3초 이내에 완료 ── */
  test("폰트 로딩이 3초 이내에 완료된다", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded", timeout: 10_000 });

    const start = Date.now();
    const fontsReady = await page.evaluate(async () => {
      await document.fonts.ready;
      return true;
    });
    const elapsed = Date.now() - start;

    console.log(`폰트 로딩 완료: ${elapsed}ms`);
    expect(fontsReady).toBe(true);
    expect(elapsed, `폰트 로딩 ${elapsed}ms > 3000ms`).toBeLessThan(3_000);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 9. 동시 요청 수 제한
 * ══════════════════════════════════════════════════════════════════════ */
test.describe("동시 요청 관리", () => {
  /* ── 9-1. 동시 API 요청 수 < 10 ── */
  test("페이지 로드 시 동시 API 요청이 10개 미만이다", async ({ page }) => {
    let concurrentRequests = 0;
    let maxConcurrent = 0;
    const apiRequests: string[] = [];

    page.on("request", (request) => {
      const url = request.url();
      if (url.includes("/api/") || url.includes(":8021")) {
        concurrentRequests++;
        if (concurrentRequests > maxConcurrent) {
          maxConcurrent = concurrentRequests;
        }
        apiRequests.push(url.replace(/.*\/api/, "/api").slice(0, 60));
      }
    });

    page.on("requestfinished", (request) => {
      const url = request.url();
      if (url.includes("/api/") || url.includes(":8021")) {
        concurrentRequests--;
      }
    });

    page.on("requestfailed", (request) => {
      const url = request.url();
      if (url.includes("/api/") || url.includes(":8021")) {
        concurrentRequests--;
      }
    });

    await page.goto("/", { waitUntil: "networkidle", timeout: 15_000 });

    console.log(`최대 동시 API 요청: ${maxConcurrent}개`);
    console.log(`총 API 요청: ${apiRequests.length}개`);

    expect(
      maxConcurrent,
      `동시 API 요청 ${maxConcurrent}개 >= 10개`,
    ).toBeLessThan(10);
  });

  /* ── 9-2. 이벤트 페이지 동시 요청 ── */
  test("이벤트 페이지에서 동시 API 요청이 10개 미만이다", async ({ page }) => {
    let concurrentRequests = 0;
    let maxConcurrent = 0;

    page.on("request", (request) => {
      if (request.url().includes("/api/") || request.url().includes(":8021")) {
        concurrentRequests++;
        maxConcurrent = Math.max(maxConcurrent, concurrentRequests);
      }
    });

    page.on("requestfinished", (request) => {
      if (request.url().includes("/api/") || request.url().includes(":8021")) {
        concurrentRequests--;
      }
    });

    page.on("requestfailed", (request) => {
      if (request.url().includes("/api/") || request.url().includes(":8021")) {
        concurrentRequests--;
      }
    });

    await page.goto("/events", { waitUntil: "networkidle", timeout: 15_000 });

    console.log(`이벤트 페이지 최대 동시 API 요청: ${maxConcurrent}개`);

    expect(
      maxConcurrent,
      `이벤트 페이지 동시 API 요청 ${maxConcurrent}개 >= 10개`,
    ).toBeLessThan(10);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 10. 리소스 로딩 종합
 * ══════════════════════════════════════════════════════════════════════ */
test.describe("리소스 로딩 종합", () => {
  /* ── 10-1. 페이지 전체 리소스 로딩 시간 ── */
  test("전체 리소스 로딩이 8초 이내에 완료된다", async ({ page }) => {
    const start = Date.now();
    await page.goto("/", { waitUntil: "networkidle", timeout: 15_000 });
    const totalTime = Date.now() - start;

    const resourceSummary = await page.evaluate(() => {
      const resources = performance.getEntriesByType(
        "resource",
      ) as PerformanceResourceTiming[];

      const byType: Record<string, { count: number; totalSize: number }> = {};

      resources.forEach((r) => {
        const ext = r.name.split(".").pop()?.split("?")[0] || "other";
        const type = [
          "js",
          "css",
          "woff",
          "woff2",
          "ttf",
          "png",
          "jpg",
          "webp",
          "svg",
        ].includes(ext)
          ? ext
          : "other";

        if (!byType[type]) byType[type] = { count: 0, totalSize: 0 };
        byType[type].count++;
        byType[type].totalSize += r.transferSize || 0;
      });

      return {
        totalResources: resources.length,
        byType,
      };
    });

    console.log(`전체 로딩 시간: ${totalTime}ms`);
    console.log("리소스 요약:", JSON.stringify(resourceSummary, null, 2));

    expect(totalTime, `전체 로딩 ${totalTime}ms > 8000ms`).toBeLessThan(8_000);
  });
});
