/** Centralized environment variable access — single source of truth */
const LOCALHOST = "localhost";
const warnedKeys = new Set<string>();
const strictBuildEnv =
  typeof window === "undefined" && process.env.NODE_ENV === "production";

function localOrigin(port: number): string {
  return `http://${LOCALHOST}:${port}`;
}

function normalizeUrl(
  name: string,
  value: string | undefined,
  fallback: string,
): string {
  const resolved = value?.trim() || fallback;
  if (
    typeof window === "undefined" &&
    process.env.NODE_ENV === "production" &&
    resolved.includes("localhost") &&
    !warnedKeys.has(name)
  ) {
    warnedKeys.add(name);
    const message =
      `[pickket] CRITICAL: Production build contains localhost URL in ${name}: ${resolved}. ` +
      "NEXT_PUBLIC_* must be set at BUILD TIME via Docker --build-arg.";
    if (strictBuildEnv) {
      throw new Error(message);
    }
    console.error(message);
  }
  return resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
}

export const BASE_URL = normalizeUrl(
  "NEXT_PUBLIC_BASE_URL",
  process.env.NEXT_PUBLIC_BASE_URL,
  localOrigin(3020),
);
export const API_URL = normalizeUrl(
  "NEXT_PUBLIC_API_URL",
  process.env.NEXT_PUBLIC_API_URL,
  localOrigin(8021),
);
export const CONSUMER_URL = normalizeUrl(
  "NEXT_PUBLIC_CONSUMER_URL",
  process.env.NEXT_PUBLIC_CONSUMER_URL,
  BASE_URL,
);
export const GO_URL = normalizeUrl(
  "NEXT_PUBLIC_GO_URL",
  process.env.NEXT_PUBLIC_GO_URL,
  localOrigin(3021),
);
export const CDN_URL = process.env.NEXT_PUBLIC_CDN_URL || "";
