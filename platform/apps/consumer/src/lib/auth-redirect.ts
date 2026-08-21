const INTERNAL_REDIRECT_ORIGIN = "https://pickket.local";

export function sanitizeReturnUrl(
  returnUrl: string | null | undefined,
): string | null {
  if (!returnUrl) return null;

  const candidate = returnUrl.trim();
  if (!candidate.startsWith("/") || candidate.startsWith("//")) {
    return null;
  }

  try {
    const parsed = new URL(candidate, INTERNAL_REDIRECT_ORIGIN);
    if (parsed.origin !== INTERNAL_REDIRECT_ORIGIN) {
      return null;
    }
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return null;
  }
}

export function resolveAuthReturnUrl(
  ...candidates: Array<string | null | undefined>
): string | null {
  for (const candidate of candidates) {
    const safe = sanitizeReturnUrl(candidate);
    if (safe) return safe;
  }
  return null;
}
