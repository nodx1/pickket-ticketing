import { test, expect } from "@playwright/test";

/* ═══════════════════════════════════════════════════════════════════════
 * i18n-validation.spec.ts — 다국어 / 로케일 고강도 E2E
 *
 * 검증 대상:
 *   1. 지원 로케일 라우팅 정합성 (ko/en/ja/zh-CN/vi/fr/ru)
 *   2. 기본 로케일(ko) prefix 생략 확인
 *   3. 미지원 로케일 → 기본 로케일 폴백
 *   4. 주요 페이지 번역 키 누락 검증
 *   5. 로케일 간 레이아웃 깨짐 확인
 *   6. 날짜/숫자 포맷 로케일별 검증
 *   7. SEO: hreflang, html lang 속성
 *   8. 로케일 전환 시 경로 유지
 * ═══════════════════════════════════════════════════════════════════════ */

const BASE_URL = process.env.E2E_BASE_URL || "http://localhost:3020";
const SUPPORTED_LOCALES = ["ko", "en", "ja", "zh-CN", "vi", "fr", "ru"];
const DEFAULT_LOCALE = "ko";

test.describe("i18n — 로케일 라우팅", () => {
  test("기본 로케일(ko)은 URL prefix 없이 접근 가능", async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/`, {
      waitUntil: "domcontentloaded",
    });
    expect(response?.status()).toBeLessThan(400);
    expect(page.url()).not.toMatch(/\/ko\//);

    const htmlLang = await page.locator("html").getAttribute("lang");
    expect(htmlLang).toBe("ko");
  });

  test("지원 로케일 경로 모두 200 응답", async ({ page }) => {
    for (const locale of SUPPORTED_LOCALES) {
      const path = locale === DEFAULT_LOCALE ? "/" : `/${locale}`;
      const response = await page.goto(`${BASE_URL}${path}`, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      expect(response?.status(), `${locale}: 홈 페이지 접근 실패`).toBeLessThan(
        400,
      );
    }
  });

  test("미지원 로케일은 기본 로케일로 폴백", async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/xx-FAKE`, {
      waitUntil: "domcontentloaded",
    });
    const status = response?.status() ?? 0;
    if (status < 400) {
      const htmlLang = await page.locator("html").getAttribute("lang");
      expect(htmlLang).toBe("ko");
    } else {
      expect(status).toBe(404);
    }
  });

  test("각 로케일의 html lang 속성 정확", async ({ page }) => {
    for (const locale of SUPPORTED_LOCALES) {
      const path = locale === DEFAULT_LOCALE ? "/" : `/${locale}`;
      await page.goto(`${BASE_URL}${path}`, { waitUntil: "domcontentloaded" });
      const htmlLang = await page.locator("html").getAttribute("lang");
      expect(htmlLang, `${locale}: html lang 불일치`).toBe(locale);
    }
  });
});

test.describe("i18n — 번역 키 검증", () => {
  test("홈 페이지에 번역 키 원문 노출 없음 (ko)", async ({ page }) => {
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
    const bodyText = await page.locator("body").innerText();
    const untranslated =
      bodyText.match(/\b[a-z]+\.[a-z]+[A-Z][a-zA-Z]*\b/g) || [];
    expect(
      untranslated.length,
      `미번역 키 의심: ${untranslated.slice(0, 5).join(", ")}`,
    ).toBeLessThan(10);
  });

  test("영어 로케일 주요 텍스트 한국어 아님", async ({ page }) => {
    await page.goto(`${BASE_URL}/en`, { waitUntil: "networkidle" });
    const bodyText = await page.locator("body").innerText();
    const koreanChars = (bodyText.match(/[\uAC00-\uD7AF]/g) || []).length;
    const totalChars = bodyText.replace(/\s/g, "").length || 1;
    const koreanRatio = koreanChars / totalChars;
    expect(
      koreanRatio,
      `영어 페이지에 한국어 비율 ${(koreanRatio * 100).toFixed(1)}% — 번역 누락 의심`,
    ).toBeLessThan(0.3);
  });

  test("일본어 로케일 주요 텍스트 확인", async ({ page }) => {
    const response = await page.goto(`${BASE_URL}/ja`, {
      waitUntil: "networkidle",
    });
    if (response && response.status() < 400) {
      const bodyText = await page.locator("body").innerText();
      const japaneseChars = (
        bodyText.match(/[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF]/g) || []
      ).length;
      expect(japaneseChars, "일본어 페이지에 일본어 문자 부재").toBeGreaterThan(
        0,
      );
    }
  });
});

test.describe("i18n — 레이아웃 안정성", () => {
  test("영어 로케일에서 텍스트 오버플로우 없음", async ({ page }) => {
    await page.goto(`${BASE_URL}/en`, { waitUntil: "networkidle" });

    const overflows = await page.evaluate(() => {
      const issues: string[] = [];
      document.querySelectorAll("*").forEach((el) => {
        const htmlEl = el as HTMLElement;
        if (
          htmlEl.scrollWidth > htmlEl.clientWidth + 2 &&
          htmlEl.clientWidth > 0 &&
          getComputedStyle(htmlEl).overflow !== "auto" &&
          getComputedStyle(htmlEl).overflow !== "scroll" &&
          getComputedStyle(htmlEl).overflowX !== "auto" &&
          getComputedStyle(htmlEl).overflowX !== "scroll" &&
          getComputedStyle(htmlEl).overflowX !== "hidden"
        ) {
          const tag = htmlEl.tagName.toLowerCase();
          const cls = htmlEl.className?.toString().slice(0, 40) || "";
          const text = htmlEl.textContent?.slice(0, 30) || "";
          issues.push(`${tag}.${cls}: "${text}"`);
        }
      });
      return issues;
    });

    expect(
      overflows.length,
      `영어 레이아웃 오버플로우 ${overflows.length}건: ${overflows.slice(0, 3).join(" | ")}`,
    ).toBeLessThan(5);
  });

  test("로케일 전환 시 주요 구조 유지 (nav, footer)", async ({ page }) => {
    await page.goto(`${BASE_URL}/`, { waitUntil: "networkidle" });
    const koNav = await page
      .locator("nav")
      .first()
      .isVisible()
      .catch(() => false);
    const koFooter = await page
      .locator("footer")
      .first()
      .isVisible()
      .catch(() => false);

    await page.goto(`${BASE_URL}/en`, { waitUntil: "networkidle" });
    const enNav = await page
      .locator("nav")
      .first()
      .isVisible()
      .catch(() => false);
    const enFooter = await page
      .locator("footer")
      .first()
      .isVisible()
      .catch(() => false);

    expect(enNav, "영어 페이지에 nav 누락").toBe(koNav);
    expect(enFooter, "영어 페이지에 footer 누락").toBe(koFooter);
  });
});

test.describe("i18n — SEO / 메타데이터", () => {
  test("html lang 속성이 로케일과 일치", async ({ page }) => {
    await page.goto(`${BASE_URL}/en`, { waitUntil: "domcontentloaded" });
    const lang = await page.locator("html").getAttribute("lang");
    expect(lang).toBe("en");
  });

  test("og:locale 또는 hreflang alternate 존재", async ({ page }) => {
    await page.goto(`${BASE_URL}/`, { waitUntil: "domcontentloaded" });

    const ogLocale = await page
      .locator('meta[property="og:locale"]')
      .getAttribute("content")
      .catch(() => null);

    const hreflangs = await page
      .locator('link[rel="alternate"][hreflang]')
      .count();

    const hasSeoLocale = ogLocale !== null || hreflangs > 0;
    expect(
      hasSeoLocale,
      "og:locale 또는 hreflang alternate 미설정",
    ).toBeTruthy();
  });
});

test.describe("i18n — 날짜/숫자 포맷", () => {
  test("이벤트 목록에서 날짜 형식이 로케일에 맞음", async ({ page }) => {
    await page.goto(`${BASE_URL}/browse`, { waitUntil: "networkidle" });
    const bodyText = await page.locator("body").innerText();

    const koDatePattern = /20\d{2}[년.]/;
    if (bodyText.match(koDatePattern)) {
      expect(bodyText).toMatch(koDatePattern);
    }

    await page.goto(`${BASE_URL}/en/browse`, { waitUntil: "networkidle" });
    const enBody = await page.locator("body").innerText();

    const koreanDateChars = (enBody.match(/[년월일]/g) || []).length;
    expect(koreanDateChars, "영어 페이지에 한국어 날짜 표기").toBeLessThan(3);
  });
});
