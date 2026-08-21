import { test, expect } from "@playwright/test";

const crawlSeeds = ["/", "/about", "/privacy", "/terms", "/refund-policy"];
const skipPrefixes = ["/api/", "/dashboard", "/events/", "/admin", "/notifications"];

function normalizePath(baseURL: string, href: string | null): string | null {
  if (!href || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("#")) {
    return null;
  }

  const target = new URL(href, baseURL);
  if (target.origin !== new URL(baseURL).origin) {
    return null;
  }

  if (skipPrefixes.some((prefix) => target.pathname.startsWith(prefix))) {
    return null;
  }

  return `${target.pathname}${target.search}`;
}

test("공개 링크 크롤링 스모크", async ({ page, baseURL }) => {
  const origin = baseURL ?? "http://127.0.0.1:3011";
  const queue = [...crawlSeeds];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) {
      continue;
    }

    visited.add(current);
    const response = await page.goto(current);
    const status = response?.status() ?? 0;
    // 404는 비활성 이벤트 등으로 허용, 5xx만 실패 처리
    expect(status, `${current} → ${status}`).toBeLessThan(500);

    const hrefs = await page.locator("a[href]").evaluateAll((anchors) =>
      anchors
        .map((anchor) => anchor.getAttribute("href"))
        .filter((href): href is string => typeof href === "string"),
    );

    for (const href of hrefs) {
      const nextPath = normalizePath(origin, href);
      if (nextPath && !visited.has(nextPath) && !queue.includes(nextPath)) {
        queue.push(nextPath);
      }
    }
  }

  expect(visited.size).toBeGreaterThanOrEqual(crawlSeeds.length);
});
