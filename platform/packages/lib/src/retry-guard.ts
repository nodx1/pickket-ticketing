/**
 * Retry Guard — prevents retry storms by enforcing server-mandated cooldowns
 * Persists across page refreshes via localStorage
 */

const STORAGE_KEY = "pickket_retry_until";

export function handleRetryAfter(retryAfterSeconds: number): void {
  const retryUntil = Date.now() + retryAfterSeconds * 1000;
  try {
    localStorage.setItem(STORAGE_KEY, String(retryUntil));
  } catch {
    // localStorage unavailable (SSR, private browsing)
  }
}

export function getRemainingCooldown(): number {
  try {
    const until = parseInt(localStorage.getItem(STORAGE_KEY) || "0", 10);
    return Math.max(0, until - Date.now());
  } catch {
    return 0;
  }
}

export function clearCooldown(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function isOnCooldown(): boolean {
  return getRemainingCooldown() > 0;
}
