const baseURL = process.env.BASE_URL ?? "http://127.0.0.1:3011";
const publicSeeds = ["/", "/about", "/privacy", "/terms", "/refund-policy", "/login", "/register"];
const skipPrefixes = ["/api/", "/dashboard", "/events/", "/admin", "/notifications"];

function normalizePath(href: string): string | null {
  if (!href || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("#")) {
    return null;
  }

  const url = new URL(href, baseURL);
  if (url.origin !== new URL(baseURL).origin) {
    return null;
  }

  if (skipPrefixes.some((prefix) => url.pathname.startsWith(prefix))) {
    return null;
  }

  return `${url.pathname}${url.search}`;
}

function extractLinks(html: string): string[] {
  const matches = html.matchAll(/href=["']([^"'#]+)["']/g);
  const links = new Set<string>();

  for (const match of matches) {
    const rawHref = match[1];
    if (!rawHref) {
      continue;
    }

    const normalized = normalizePath(rawHref);
    if (normalized) {
      links.add(normalized);
    }
  }

  return [...links];
}

async function crawl() {
  const queue = [...publicSeeds];
  const visited = new Set<string>();
  const failures: Array<{ path: string; status: number; reason: string }> = [];

  while (queue.length > 0) {
    const currentPath = queue.shift();
    if (!currentPath || visited.has(currentPath)) {
      continue;
    }

    visited.add(currentPath);
    const response = await fetch(new URL(currentPath, baseURL), {
      redirect: "manual",
    });

    if (response.status >= 400) {
      failures.push({
        path: currentPath,
        status: response.status,
        reason: `HTTP ${response.status}`,
      });
      continue;
    }

    if (response.status >= 300 && response.status < 400) {
      continue;
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      continue;
    }

    const html = await response.text();
    for (const link of extractLinks(html)) {
      if (!visited.has(link) && !queue.includes(link)) {
        queue.push(link);
      }
    }
  }

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`[crawl-smoke] ${failure.path} -> ${failure.reason}`);
    }
    process.exit(1);
  }

  console.log(`[crawl-smoke] ${visited.size}개 공개 경로 점검 완료`);
}

void crawl().catch((err: unknown) => {
  if (err instanceof Error) {
    console.error(`[crawl-smoke] ${err.message}`);
  } else {
    console.error("[crawl-smoke] 알 수 없는 오류가 발생했습니다");
  }
  process.exit(1);
});
