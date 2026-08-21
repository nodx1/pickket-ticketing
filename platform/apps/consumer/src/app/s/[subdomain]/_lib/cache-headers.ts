/**
 * Cache-Control helpers for subdomain pages.
 * CDN (Cloudflare) caches at edge, browser caches for shorter duration.
 */
export const CACHE_PROFILES = {
  /** Event landing page — moderate freshness */
  landing: {
    "Cache-Control": "public, s-maxage=60, stale-while-revalidate=300",
    "CDN-Cache-Control": "public, max-age=60",
  },
  /** Static assets / images */
  static: {
    "Cache-Control": "public, max-age=31536000, immutable",
  },
  /** Dynamic content (booking, community) */
  dynamic: {
    "Cache-Control": "public, s-maxage=10, stale-while-revalidate=60",
  },
} as const;

export type CacheProfile = keyof typeof CACHE_PROFILES;

export function getCacheHeaders(profile: CacheProfile): Record<string, string> {
  return CACHE_PROFILES[profile];
}
