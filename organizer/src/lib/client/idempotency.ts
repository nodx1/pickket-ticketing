"use client";

interface StoredAttempt {
  fingerprint: string;
  key: string;
}

export function getDurableIdempotencyKey(
  scope: string,
  fingerprint: string,
): string {
  const storageKey = `pickket-idempotency:${scope}`;
  try {
    const current = JSON.parse(
      sessionStorage.getItem(storageKey) ?? "null",
    ) as StoredAttempt | null;
    if (current?.fingerprint === fingerprint && current.key) {
      return current.key;
    }
  } catch {
    sessionStorage.removeItem(storageKey);
  }
  const key = crypto.randomUUID();
  sessionStorage.setItem(storageKey, JSON.stringify({ fingerprint, key }));
  return key;
}

export function clearDurableIdempotencyKey(scope: string, key: string): void {
  const storageKey = `pickket-idempotency:${scope}`;
  try {
    const current = JSON.parse(
      sessionStorage.getItem(storageKey) ?? "null",
    ) as StoredAttempt | null;
    if (current?.key === key) sessionStorage.removeItem(storageKey);
  } catch {
    sessionStorage.removeItem(storageKey);
  }
}
