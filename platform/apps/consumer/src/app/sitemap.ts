import type { MetadataRoute } from "next";

const BASE_URL =
  process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/$/, "") ||
  "https://www.pickket.kr";
const API_URL =
  process.env.NEXT_PUBLIC_API_URL?.replace(/\/$/, "") ||
  "https://api.pickket.kr";
const LOCALES = ["ko", "en", "ja", "zh-CN", "fr", "ru", "vi"];

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const staticPages = [
    "",
    "/events",
    "/ranking",
    "/browse",
    "/guide/ap",
    "/blog",
    "/fairness",
    "/careers",
    "/support",
    "/auth",
    "/terms",
    "/privacy",
    "/refund-policy",
    "/government",
  ];

  // Static pages with locale variants
  // Note: static pages omit lastModified intentionally — using new Date() would
  // falsely signal to crawlers that every page changed on every sitemap generation.
  // Event pages below use actual updated_at from the API.
  const staticEntries: MetadataRoute.Sitemap = staticPages.map((path) => ({
    url: `${BASE_URL}${path}`,
    changeFrequency:
      path === "" || path === "/events" ? "daily" : ("weekly" as const),
    priority: path === "" ? 1.0 : path === "/events" ? 0.9 : 0.7,
    alternates: {
      languages: Object.fromEntries(
        LOCALES.map((locale) => [locale, `${BASE_URL}/${locale}${path}`]),
      ),
    },
  }));

  // Dynamic event pages
  let eventEntries: MetadataRoute.Sitemap = [];
  try {
    const res = await fetch(`${API_URL}/api/v1/public/sitemap-events`, {
      next: { revalidate: 3600 },
    });
    if (res.ok) {
      const events: Array<{
        id: string;
        updated_at: string;
        category: string;
      }> = await res.json();
      eventEntries = events.map((event) => ({
        url: `${BASE_URL}/events/${event.id}`,
        lastModified: new Date(event.updated_at),
        changeFrequency: "daily" as const,
        priority: 0.8,
        alternates: {
          languages: Object.fromEntries(
            LOCALES.map((locale) => [
              locale,
              `${BASE_URL}/${locale}/events/${event.id}`,
            ]),
          ),
        },
      }));
    }
  } catch {
    // Sitemap generation should not fail if API is down
  }

  return [...staticEntries, ...eventEntries];
}
