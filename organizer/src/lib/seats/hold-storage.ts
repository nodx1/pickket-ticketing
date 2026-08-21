"use client";

/**
 * P0-U1 + P0-U4 — 좌석 홀드 + 폼 상태 localStorage 보관.
 *
 * - 탭 새로고침/브라우저 크래시 대비 복원 지원
 * - 만료된 홀드는 자동 정리
 * - 이벤트 슬러그가 다르면 반환하지 않음(다른 이벤트로 이동 시 노이즈 방지)
 */

const STORAGE_KEY = "pickket:active-seat-hold";

export interface StoredHold {
  eventSlug: string;
  mapId: string;
  seatIds: string[];
  holdId: string;
  holdToken: string;
  expiresAt: string;
  formState?: Record<string, unknown>;
  savedAt: string;
}

export function saveHold(hold: Omit<StoredHold, "savedAt">): void {
  if (typeof window === "undefined") return;
  try {
    const data: StoredHold = { ...hold, savedAt: new Date().toISOString() };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {}
}

export function loadHold(eventSlug: string): StoredHold | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as StoredHold;
    if (data.eventSlug !== eventSlug) return null;
    if (new Date(data.expiresAt) < new Date()) {
      localStorage.removeItem(STORAGE_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

export function clearHold(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {}
}

export function updateFormState(formState: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw) as StoredHold;
    data.formState = formState;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {}
}
