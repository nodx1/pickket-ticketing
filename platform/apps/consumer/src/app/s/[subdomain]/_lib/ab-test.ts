/**
 * Client-side A/B test variant assignment.
 *
 * Uses cookie-based consistent hashing so a visitor always sees the
 * same variant for a given test, even across page reloads.
 */

export interface ABVariant {
  id: string;
  name: string;
  weight: number;
}

// ─── Cookie helpers ─────────────────────────────────────────────────────────

const AB_COOKIE_PREFIX = "pk_ab_";

function shouldUseSecureCookie(): boolean {
  return typeof window !== "undefined" && window.location.protocol === "https:";
}

function buildCookieValue(name: string, value: string, maxAge: number): string {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "path=/",
    `max-age=${maxAge}`,
    "SameSite=Lax",
  ];
  if (shouldUseSecureCookie()) {
    parts.push("Secure");
  }
  return parts.join(";");
}

/** Get the variant ID stored in a cookie for the given test. */
export function getABCookie(testId: string): string | null {
  if (typeof document === "undefined") return null;
  const name = `${AB_COOKIE_PREFIX}${testId}`;
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** Persist the selected variant in a cookie (30-day expiry). */
export function setABCookie(testId: string, variantId: string): void {
  if (typeof document === "undefined") return;
  const name = `${AB_COOKIE_PREFIX}${testId}`;
  const maxAge = 30 * 24 * 60 * 60; // 30 days
  document.cookie = buildCookieValue(name, variantId, maxAge);
}

// ─── Cookie ID (anonymous visitor identifier) ───────────────────────────────

const VISITOR_COOKIE = "pk_visitor_id";

/** Get or create a stable anonymous visitor ID for hashing. */
export function getVisitorId(): string {
  if (typeof document === "undefined") return "ssr-fallback";
  const match = document.cookie.match(
    new RegExp(`(?:^|;\\s*)${VISITOR_COOKIE}=([^;]*)`),
  );
  if (match) return decodeURIComponent(match[1]);

  const id = crypto.randomUUID();
  const maxAge = 365 * 24 * 60 * 60; // 1 year
  document.cookie = buildCookieValue(VISITOR_COOKIE, id, maxAge);
  return id;
}

// ─── Consistent hashing ─────────────────────────────────────────────────────

/**
 * Simple string → 32-bit integer hash (djb2).
 * Deterministic and fast — no crypto needed for traffic splitting.
 */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Select a variant based on consistent hashing of (cookieId + testId).
 *
 * The hash is mapped onto the cumulative weight distribution so that
 * variant selection is stable and respects traffic weights.
 */
export function getVariant(
  testId: string,
  variants: ABVariant[],
  cookieId: string,
): ABVariant {
  if (variants.length === 0) {
    throw new Error("At least one variant is required");
  }
  if (variants.length === 1) return variants[0];

  const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
  const hash = hashString(`${cookieId}:${testId}`);
  const bucket = hash % totalWeight;

  let cumulative = 0;
  for (const variant of variants) {
    cumulative += variant.weight;
    if (bucket < cumulative) return variant;
  }

  // Should not happen, but fallback to last variant
  return variants[variants.length - 1];
}

/**
 * High-level: resolve the variant for a test, reading/writing cookies automatically.
 *
 * If the visitor already has a cookie for this test, that variant is returned
 * (even if the weights have changed). Otherwise a new assignment is made.
 */
export function resolveVariant(
  testId: string,
  variants: ABVariant[],
): ABVariant {
  const cookieId = getVisitorId();

  // Check for an existing assignment
  const existingId = getABCookie(testId);
  if (existingId) {
    const existing = variants.find((v) => v.id === existingId);
    if (existing) return existing;
    // Cookie points to a deleted variant — re-assign below
  }

  const selected = getVariant(testId, variants, cookieId);
  setABCookie(testId, selected.id);
  return selected;
}
