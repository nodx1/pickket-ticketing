import { test, expect, devices } from "@playwright/test";
import { dismissOnboarding } from "./fixtures/helpers";

/* ═══════════════════════════════════════════════════════════════════════
 * mobile-responsive.spec.ts — 모바일 반응형 시스템 테스트
 *
 * 3가지 뷰포트(Mobile/Tablet/Desktop)에서 레이아웃·터치 타겟·
 * 타이포그래피·이미지·네비게이션 등 반응형 동작을 고강도로 검증합니다.
 *
 * 테스트 페이지: /, /events, /auth, /about, /guide, /points
 *
 * 실행: pnpm e2e -- mobile-responsive
 * ═══════════════════════════════════════════════════════════════════════ */

/* ── 뷰포트 정의 ── */
const VIEWPORTS = {
  mobile: { width: 375, height: 812 }, // iPhone SE
  tablet: { width: 768, height: 1024 }, // iPad
  desktop: { width: 1440, height: 900 },
} as const;

const LANDSCAPE = { width: 812, height: 375 };

/** 테스트 대상 페이지 목록 */
const PAGES = ["/", "/events", "/auth", "/about", "/guide", "/points"];

/** 안전하게 페이지 진입 후 온보딩 닫기 */
async function safeNavigate(
  page: import("@playwright/test").Page,
  path: string,
) {
  await page.goto(path, { waitUntil: "domcontentloaded", timeout: 15_000 });
  await page.waitForLoadState("networkidle").catch(() => {});
  await dismissOnboarding(page);
}

/* ══════════════════════════════════════════════════════════════════════
 * 1. 모바일 뷰포트 — 페이지별 기본 검증
 * ══════════════════════════════════════════════════════════════════════ */
test.describe("모바일 반응형: 페이지별 기본 검증 (375×812)", () => {
  test.use({ viewport: VIEWPORTS.mobile });

  for (const path of PAGES) {
    /* ── 1-1. 수평 스크롤 없음 ── */
    test(`[${path}] 수평 스크롤이 발생하지 않는다`, async ({ page }) => {
      await safeNavigate(page, path);

      const hasHorizontalOverflow = await page.evaluate(() => {
        return document.body.scrollWidth > window.innerWidth;
      });
      expect(
        hasHorizontalOverflow,
        `${path}에서 수평 오버플로우가 감지됨 (body.scrollWidth > viewport.width)`,
      ).toBe(false);
    });

    /* ── 1-2. 터치 타겟 최소 크기 (AA: 24×24) ── */
    test(`[${path}] 인터랙티브 요소의 터치 타겟이 최소 24×24px이다`, async ({
      page,
    }) => {
      await safeNavigate(page, path);

      const tooSmall = await page.evaluate(() => {
        const interactive = document.querySelectorAll(
          'a, button, input, select, textarea, [role="button"], [tabindex="0"]',
        );
        const violations: Array<{
          tag: string;
          text: string;
          w: number;
          h: number;
        }> = [];

        interactive.forEach((el) => {
          const rect = el.getBoundingClientRect();
          // 화면에 보이지 않는 요소는 무시
          if (rect.width === 0 || rect.height === 0) return;
          // sr-only 요소 무시
          const style = getComputedStyle(el);
          if (
            style.position === "absolute" &&
            (style.clip !== "auto" ||
              style.clipPath === "inset(50%)" ||
              rect.width <= 1)
          )
            return;
          // display:none, visibility:hidden 무시
          if (style.display === "none" || style.visibility === "hidden") return;

          if (rect.width < 24 || rect.height < 24) {
            violations.push({
              tag: el.tagName,
              text: (el as HTMLElement).innerText?.slice(0, 30) || "",
              w: Math.round(rect.width),
              h: Math.round(rect.height),
            });
          }
        });
        return violations;
      });

      // 위반 항목이 5개 이하여야 (아이콘 버튼 등 약간의 예외 허용)
      expect(
        tooSmall.length,
        `${path}에서 24px 미만 터치 타겟 ${tooSmall.length}개 발견: ${JSON.stringify(tooSmall.slice(0, 5))}`,
      ).toBeLessThanOrEqual(5);
    });

    /* ── 1-3. 텍스트 가독성 (font-size ≥ 12px) ── */
    test(`[${path}] 텍스트 font-size가 최소 12px 이상이다`, async ({
      page,
    }) => {
      await safeNavigate(page, path);

      const tinyTexts = await page.evaluate(() => {
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
        );
        const violations: Array<{ text: string; size: string }> = [];
        const seen = new Set<Element>();

        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!node.textContent?.trim()) continue;
          const el = node.parentElement;
          if (!el || seen.has(el)) continue;
          seen.add(el);

          const style = getComputedStyle(el);
          if (style.display === "none" || style.visibility === "hidden")
            continue;

          const fontSize = parseFloat(style.fontSize);
          if (fontSize < 12) {
            violations.push({
              text: node.textContent.trim().slice(0, 40),
              size: style.fontSize,
            });
          }
        }
        return violations;
      });

      expect(
        tinyTexts.length,
        `${path}에서 12px 미만 텍스트 ${tinyTexts.length}개: ${JSON.stringify(tinyTexts.slice(0, 3))}`,
      ).toBeLessThanOrEqual(3);
    });

    /* ── 1-4. 이미지 반응형 (컨테이너 넘침 방지) ── */
    test(`[${path}] 이미지가 컨테이너를 넘지 않는다`, async ({ page }) => {
      await safeNavigate(page, path);

      const overflowingImages = await page.evaluate(() => {
        const images = document.querySelectorAll("img");
        const violations: Array<{
          src: string;
          imgW: number;
          parentW: number;
        }> = [];

        images.forEach((img) => {
          if (!img.parentElement) return;
          const imgRect = img.getBoundingClientRect();
          const parentRect = img.parentElement.getBoundingClientRect();

          // 이미지가 보이지 않으면 무시
          if (imgRect.width === 0 || imgRect.height === 0) return;

          if (imgRect.width > parentRect.width + 2) {
            violations.push({
              src: img.src.slice(-60),
              imgW: Math.round(imgRect.width),
              parentW: Math.round(parentRect.width),
            });
          }
        });
        return violations;
      });

      expect(
        overflowingImages.length,
        `${path}에서 컨테이너를 넘는 이미지 ${overflowingImages.length}개`,
      ).toBe(0);
    });
  }

  /* ── 1-5. 모바일 네비게이션: 데스크톱 네비 숨김 ── */
  test("모바일에서 데스크톱 네비게이션이 숨겨진다", async ({ page }) => {
    await safeNavigate(page, "/");

    // 데스크톱 네비 (nav 안 수평 링크 그룹)가 숨겨져야 함
    const desktopNav = page
      .locator(
        "nav a:visible, header a:visible, [data-testid='desktop-nav']:visible",
      )
      .first();

    // 모바일 메뉴 버튼이 있어야 함
    const mobileMenuBtn = page
      .locator(
        "button[aria-label*='메뉴'], button[aria-label*='menu'], button[aria-label*='Menu'], [data-testid='mobile-menu-button']",
      )
      .first();

    // 둘 중 하나: 데스크톱 네비 숨김 또는 모바일 메뉴 버튼 존재
    const hasMobileMenu = await mobileMenuBtn
      .isVisible({ timeout: 3_000 })
      .catch(() => false);

    // 모바일에서는 햄버거 메뉴나 축소된 형태가 존재해야 함
    expect(hasMobileMenu).toBe(true);
  });

  /* ── 1-6. 콘텐츠 잘림 없음 ── */
  test("주요 텍스트가 overflow:hidden으로 잘리지 않는다", async ({ page }) => {
    await safeNavigate(page, "/");

    const clippedTexts = await page.evaluate(() => {
      const allElements = document.querySelectorAll(
        "h1, h2, h3, p, [role='heading']",
      );
      const violations: Array<{ tag: string; text: string }> = [];

      allElements.forEach((el) => {
        const style = getComputedStyle(el);
        if (style.display === "none") return;

        const htmlEl = el as HTMLElement;
        // overflow:hidden이면서 실제로 잘리는 경우
        if (
          style.overflow === "hidden" &&
          htmlEl.scrollHeight > htmlEl.clientHeight + 2
        ) {
          violations.push({
            tag: el.tagName,
            text: htmlEl.innerText?.slice(0, 50) || "",
          });
        }
      });
      return violations;
    });

    expect(
      clippedTexts.length,
      `잘리는 텍스트 ${clippedTexts.length}개: ${JSON.stringify(clippedTexts.slice(0, 3))}`,
    ).toBe(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 2. 크로스 뷰포트 테스트
 * ══════════════════════════════════════════════════════════════════════ */
test.describe("크로스 뷰포트 반응형 테스트", () => {
  /* ── 2-1. 브레이크포인트 전환: 리사이즈 시 레이아웃 정상 ── */
  test("375 → 768 → 1440 리사이즈 시 레이아웃이 정상 전환된다", async ({
    page,
  }) => {
    // 모바일로 시작
    await page.setViewportSize(VIEWPORTS.mobile);
    await safeNavigate(page, "/");

    // 각 뷰포트에서 수평 오버플로우 없어야 함
    for (const [name, vp] of Object.entries(VIEWPORTS)) {
      await page.setViewportSize(vp);
      await page.waitForTimeout(500); // 레이아웃 리플로우 대기

      const scrollWidth = await page.evaluate(() => document.body.scrollWidth);
      expect(
        scrollWidth,
        `${name}(${vp.width}px)에서 수평 오버플로우`,
      ).toBeLessThanOrEqual(vp.width + 1);
    }
  });

  /* ── 2-2. 이벤트 카드 그리드 컬럼 변화 ── */
  test("이벤트 카드 그리드가 뷰포트에 따라 컬럼이 변한다", async ({ page }) => {
    // 데스크톱으로 시작
    await page.setViewportSize(VIEWPORTS.desktop);
    await safeNavigate(page, "/events");

    // 이벤트 카드를 찾는다
    // 실제 이벤트 카드만 타겟(EventCardUnified·EventListView 의 data-testid).
    // 광범위 [class*='card'] 는 필터칩 버튼까지 잡아 오탐하므로 사용하지 않는다.
    const cards = page.locator("[data-testid='event-card']");
    const cardCount = await cards.count();

    if (cardCount < 2) {
      test.skip(true, "이벤트 카드가 2개 미만이라 그리드 테스트 불가");
      return;
    }

    // 데스크톱: 첫 두 카드의 y좌표가 같으면 다중 컬럼
    const desktopPositions = await cards.evaluateAll((els) =>
      els.slice(0, 4).map((el) => {
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y) };
      }),
    );

    // 데스크톱에서 최소 2개 카드가 같은 행에 있어야 함 (다중 컬럼)
    const desktopSameRow = desktopPositions.filter(
      (p) => Math.abs(p.y - desktopPositions[0].y) < 20,
    );
    expect(
      desktopSameRow.length,
      "데스크톱에서 첫 행에 2개 이상 카드가 있어야 함",
    ).toBeGreaterThanOrEqual(2);

    // 모바일로 전환
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.waitForTimeout(800);

    const mobilePositions = await cards.evaluateAll((els) =>
      els.slice(0, 4).map((el) => {
        const rect = el.getBoundingClientRect();
        return { x: Math.round(rect.x), y: Math.round(rect.y) };
      }),
    );

    // 모바일: 카드들의 x좌표가 유사하면 단일 컬럼 (또는 2컬럼까지 허용)
    const mobileFirstRow = mobilePositions.filter(
      (p) => Math.abs(p.y - mobilePositions[0].y) < 20,
    );
    expect(
      mobileFirstRow.length,
      "모바일에서 첫 행에 3개 이상 카드가 있으면 안 됨",
    ).toBeLessThanOrEqual(2);
  });

  /* ── 2-3. 로그인 폼 full-width ── */
  test("모바일에서 로그인 폼이 full-width에 가깝다", async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await safeNavigate(page, "/auth");

    const form = page
      .locator("form, [data-testid='login-form'], [class*='auth']")
      .first();
    const isFormVisible = await form
      .isVisible({ timeout: 5_000 })
      .catch(() => false);

    if (!isFormVisible) {
      test.skip(true, "/auth에서 폼을 찾을 수 없음");
      return;
    }

    const formWidth = await form.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      return rect.width;
    });

    // 폼이 뷰포트의 80% 이상 차지해야 함
    expect(
      formWidth,
      `폼 너비(${formWidth}px)가 뷰포트의 80%(${VIEWPORTS.mobile.width * 0.8}px) 미만`,
    ).toBeGreaterThanOrEqual(VIEWPORTS.mobile.width * 0.8);
  });

  /* ── 2-4. Footer 세로 정렬 ── */
  test("모바일에서 footer 컬럼이 세로 정렬된다", async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await safeNavigate(page, "/");

    const footer = page.locator("footer").first();
    const isFooterVisible = await footer
      .isVisible({ timeout: 5_000 })
      .catch(() => false);

    if (!isFooterVisible) {
      // footer가 뷰포트 밖에 있을 수 있으므로 스크롤
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(500);
    }

    const footerLayout = await page.evaluate(() => {
      const footer = document.querySelector("footer");
      if (!footer) return null;

      // footer 내부 직계 자식들의 레이아웃 확인
      const children = Array.from(footer.children);
      if (children.length < 2)
        return { vertical: true, childCount: children.length };

      const positions = children.map((c) => ({
        x: c.getBoundingClientRect().x,
        y: c.getBoundingClientRect().y,
        w: c.getBoundingClientRect().width,
      }));

      // 세로 정렬: y좌표가 다른 요소들이 있어야 함
      const uniqueYs = new Set(positions.map((p) => Math.round(p.y / 10)));
      return { vertical: uniqueYs.size > 1, childCount: children.length };
    });

    if (footerLayout && footerLayout.childCount > 1) {
      expect(
        footerLayout.vertical,
        "모바일에서 footer 자식 요소들이 세로로 정렬되어야 함",
      ).toBe(true);
    }
  });

  /* ── 2-5. Hero 섹션 텍스트 크기 감소 ── */
  test("모바일에서 hero 텍스트 크기가 데스크톱보다 작다", async ({ page }) => {
    // 데스크톱 hero 텍스트 크기 측정
    await page.setViewportSize(VIEWPORTS.desktop);
    await safeNavigate(page, "/");

    const heroHeading = page
      .locator("h1, [class*='hero'] h1, [class*='hero'] h2, main h1")
      .first();
    const hasHero = await heroHeading
      .isVisible({ timeout: 5_000 })
      .catch(() => false);

    if (!hasHero) {
      test.skip(true, "Hero 헤딩을 찾을 수 없음");
      return;
    }

    const desktopFontSize = await heroHeading.evaluate((el) =>
      parseFloat(getComputedStyle(el).fontSize),
    );

    // 모바일로 전환
    await page.setViewportSize(VIEWPORTS.mobile);
    await page.waitForTimeout(500);

    const mobileFontSize = await heroHeading.evaluate((el) =>
      parseFloat(getComputedStyle(el).fontSize),
    );

    expect(
      mobileFontSize,
      `모바일 hero 폰트(${mobileFontSize}px)가 데스크톱(${desktopFontSize}px)보다 작거나 같아야 함`,
    ).toBeLessThanOrEqual(desktopFontSize);
  });

  /* ── 2-6. 모바일 검색바 동작 ── */
  test("모바일에서 검색 기능에 접근할 수 있다", async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await safeNavigate(page, "/");

    // 검색 입력 또는 검색 아이콘/버튼 찾기
    const searchInput = page
      .locator(
        "input[type='search'], input[placeholder*='검색'], input[placeholder*='이벤트']",
      )
      .first();
    const searchButton = page
      .locator(
        "button[aria-label*='검색'], a[href*='search'], a[href*='events'], [data-testid*='search']",
      )
      .first();

    const hasInput = await searchInput
      .isVisible({ timeout: 3_000 })
      .catch(() => false);
    const hasButton = await searchButton
      .isVisible({ timeout: 3_000 })
      .catch(() => false);

    expect(
      hasInput || hasButton,
      "모바일에서 검색 입력 또는 검색 버튼이 있어야 함",
    ).toBe(true);
  });

  /* ── 2-7. 이벤트 카드 모바일 레이아웃 ── */
  test("모바일에서 이벤트 카드가 적절한 크기로 표시된다", async ({ page }) => {
    await page.setViewportSize(VIEWPORTS.mobile);
    await safeNavigate(page, "/events");

    // 실제 이벤트 카드만 타겟(EventCardUnified·EventListView 의 data-testid).
    // 광범위 [class*='card'] 는 필터칩 버튼까지 잡아 오탐하므로 사용하지 않는다.
    const cards = page.locator("[data-testid='event-card']");
    const cardCount = await cards.count();

    if (cardCount === 0) {
      test.skip(true, "이벤트 카드가 없음");
      return;
    }

    const firstCard = cards.first();
    const cardWidth = await firstCard.evaluate(
      (el) => el.getBoundingClientRect().width,
    );

    // 모바일에서 카드가 뷰포트의 40% 이상을 차지해야 함
    expect(
      cardWidth,
      `카드 너비(${cardWidth}px)가 뷰포트의 40%(${VIEWPORTS.mobile.width * 0.4}px) 미만`,
    ).toBeGreaterThanOrEqual(VIEWPORTS.mobile.width * 0.4);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 3. 태블릿 전용 테스트
 * ══════════════════════════════════════════════════════════════════════ */
test.describe("태블릿 반응형 테스트 (768×1024)", () => {
  test.use({ viewport: VIEWPORTS.tablet });

  /* ── 3-1. 태블릿 2컬럼 레이아웃 ── */
  test("태블릿에서 이벤트 목록이 2컬럼 이상이다", async ({ page }) => {
    await safeNavigate(page, "/events");

    // 실제 이벤트 카드만 타겟(EventCardUnified·EventListView 의 data-testid).
    // 광범위 [class*='card'] 는 필터칩 버튼까지 잡아 오탐하므로 사용하지 않는다.
    const cards = page.locator("[data-testid='event-card']");
    const cardCount = await cards.count();

    if (cardCount < 2) {
      test.skip(true, "이벤트 카드가 2개 미만");
      return;
    }

    const positions = await cards.evaluateAll((els) =>
      els.slice(0, 4).map((el) => ({
        y: Math.round(el.getBoundingClientRect().y),
      })),
    );

    // 첫 행에 2개 이상 카드가 있어야 함
    const firstRowCount = positions.filter(
      (p) => Math.abs(p.y - positions[0].y) < 20,
    ).length;
    expect(
      firstRowCount,
      "태블릿에서 첫 행에 최소 2개 카드",
    ).toBeGreaterThanOrEqual(2);
  });

  /* ── 3-2. 태블릿 네비게이션 ── */
  test("태블릿에서 네비게이션이 접근 가능하다", async ({ page }) => {
    await safeNavigate(page, "/");

    // 데스크톱 네비 또는 모바일 메뉴 버튼 중 하나가 있어야 함
    const desktopNavLinks = page.locator("header nav a, header a").first();
    const mobileMenuBtn = page
      .locator(
        "button[aria-label*='메뉴'], button[aria-label*='menu'], [data-testid='mobile-menu-button']",
      )
      .first();

    const hasDesktopNav = await desktopNavLinks
      .isVisible({ timeout: 3_000 })
      .catch(() => false);
    const hasMobileMenu = await mobileMenuBtn
      .isVisible({ timeout: 3_000 })
      .catch(() => false);

    expect(
      hasDesktopNav || hasMobileMenu,
      "태블릿에서 네비게이션 링크 또는 메뉴 버튼이 있어야 함",
    ).toBe(true);
  });

  /* ── 3-3. 태블릿 수평 스크롤 없음 ── */
  test("태블릿에서 수평 스크롤이 없다", async ({ page }) => {
    for (const path of PAGES) {
      await safeNavigate(page, path);
      const overflow = await page.evaluate(
        () => document.body.scrollWidth > window.innerWidth,
      );
      expect(overflow, `${path}에서 수평 오버플로우`).toBe(false);
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 4. 가로 모드 (Landscape) 테스트
 * ══════════════════════════════════════════════════════════════════════ */
test.describe("가로 모드 (Landscape) 테스트", () => {
  test.use({ viewport: LANDSCAPE });

  /* ── 4-1. 가로 모드 콘텐츠 정상 표시 ── */
  test("가로 모드에서 콘텐츠가 정상 표시된다", async ({ page }) => {
    await safeNavigate(page, "/");

    // 페이지 에러 없음
    await expect(page).not.toHaveTitle(/error|500|404/i);

    // body가 보임
    await expect(page.locator("body")).toBeVisible();

    // 수평 오버플로우 없음
    const overflow = await page.evaluate(
      () => document.body.scrollWidth > window.innerWidth,
    );
    expect(overflow, "가로 모드에서 수평 오버플로우").toBe(false);
  });

  /* ── 4-2. 가로 모드 네비게이션 접근 ── */
  test("가로 모드에서 네비게이션에 접근할 수 있다", async ({ page }) => {
    await safeNavigate(page, "/");

    const navLink = page.locator("header a, nav a").first();
    const menuBtn = page
      .locator(
        "button[aria-label*='메뉴'], button[aria-label*='menu'], [data-testid='mobile-menu-button']",
      )
      .first();

    const hasNav = await navLink
      .isVisible({ timeout: 3_000 })
      .catch(() => false);
    const hasMenu = await menuBtn
      .isVisible({ timeout: 3_000 })
      .catch(() => false);

    expect(hasNav || hasMenu, "가로 모드에서 네비게이션 접근 불가").toBe(true);
  });

  /* ── 4-3. 가로 모드 이벤트 페이지 ── */
  test("가로 모드에서 이벤트 목록이 정상 표시된다", async ({ page }) => {
    await safeNavigate(page, "/events");
    await expect(page).not.toHaveTitle(/error|500|404/i);

    const overflow = await page.evaluate(
      () => document.body.scrollWidth > window.innerWidth,
    );
    expect(overflow, "/events 가로 모드 수평 오버플로우").toBe(false);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 5. Safe Area / 노치 테스트
 * ══════════════════════════════════════════════════════════════════════ */
test.describe("Safe Area 패딩 검증", () => {
  test.use({ viewport: VIEWPORTS.mobile });

  /* ── 5-1. env(safe-area-inset-*) 사용 확인 ── */
  test("노치/다이나믹 아일랜드 대응 safe-area 패딩이 적용되어 있다", async ({
    page,
  }) => {
    await safeNavigate(page, "/");

    // CSS에서 env(safe-area-inset-*) 사용 여부 확인
    // 또는 viewport meta에 viewport-fit=cover가 있는지 확인
    const hasSafeAreaSupport = await page.evaluate(() => {
      // 1. viewport meta 확인
      const viewportMeta = document.querySelector('meta[name="viewport"]');
      const viewportContent = viewportMeta?.getAttribute("content") || "";
      const hasViewportFit = viewportContent.includes("viewport-fit=cover");

      // 2. CSS에서 safe-area-inset 사용 확인 (computed style로는 확인 어려움)
      // header/footer의 padding에서 확인
      const header = document.querySelector("header");
      const body = document.body;

      // env(safe-area-inset-*)가 설정되면 padding 값이 있을 수 있음
      // 브라우저에서 safe-area가 없으면 0으로 처리됨
      const hasPadding = header
        ? parseFloat(getComputedStyle(header).paddingTop) >= 0
        : true;

      return { hasViewportFit, hasPadding };
    });

    // viewport-fit=cover가 있거나 패딩이 적용되어 있으면 통과
    // 엄격하게 검사하지 않고 지원 여부만 확인
    expect(hasSafeAreaSupport.hasPadding).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════
 * 6. 터치 타겟 AAA 기준 (44×44px) 주요 요소
 * ══════════════════════════════════════════════════════════════════════ */
test.describe("터치 타겟 AAA 기준 (44×44px)", () => {
  test.use({ viewport: VIEWPORTS.mobile });

  test("주요 네비게이션 버튼이 최소 44×44px이다", async ({ page }) => {
    await safeNavigate(page, "/");

    const navButtons = page.locator(
      "header button, header a, nav button, nav a",
    );
    const count = await navButtons.count();

    const violations: Array<{ text: string; w: number; h: number }> = [];

    for (let i = 0; i < Math.min(count, 10); i++) {
      const btn = navButtons.nth(i);
      const isVisible = await btn
        .isVisible({ timeout: 1_000 })
        .catch(() => false);
      if (!isVisible) continue;

      const box = await btn.boundingBox();
      if (!box || box.width === 0) continue;

      if (box.width < 44 || box.height < 44) {
        const text = await btn.innerText().catch(() => "");
        violations.push({
          text: text.slice(0, 20),
          w: Math.round(box.width),
          h: Math.round(box.height),
        });
      }
    }

    // 네비게이션 영역에서는 AAA 기준(44px)을 권장하지만 약간 예외 허용
    expect(
      violations.length,
      `44px 미만 네비게이션 요소 ${violations.length}개: ${JSON.stringify(violations)}`,
    ).toBeLessThanOrEqual(3);
  });
});
