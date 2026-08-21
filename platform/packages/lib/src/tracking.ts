/**
 * Behavior tracking client — P1-5.
 *
 * Queues events client-side and flushes them in batches to POST /api/v1/track.
 * Auto-flush every 5 seconds or when the queue reaches 20 events.
 * Respects GDPR consent via `pickket_cookie_consent` in localStorage.
 */

import api from "./api";

// ── Types ──────────────────────────────────────────────────────────────────

export type TrackingEventType =
  | "page_view"
  | "event_view"
  | "search"
  | "bid"
  | "purchase"
  | "share"
  | "favorite"
  | "click";

export type TrackingTargetType = "event" | "tier" | "artist" | "category";

interface QueuedEvent {
  event_type: TrackingEventType;
  target_type?: TrackingTargetType | null;
  target_id?: string | null;
  metadata?: Record<string, unknown> | null;
  timestamp: string;
}

// ── Consent ────────────────────────────────────────────────────────────────

const CONSENT_KEY = "pickket_cookie_consent";
const TRACKING_CONSENT_KEY = "pickket_tracking_consent";

function hasTrackingConsent(): boolean {
  if (typeof window === "undefined") return false;
  try {
    // Primary: dedicated tracking consent key (set by CookieBanner)
    const dedicated = localStorage.getItem(TRACKING_CONSENT_KEY);
    if (dedicated === "true") return true;
    if (dedicated === "false") return false;

    // Fallback: read from cookie consent object (analytics flag)
    const raw = localStorage.getItem(CONSENT_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw);
    return parsed?.analytics === true;
  } catch {
    return false;
  }
}

// ── Queue & Flush ──────────────────────────────────────────────────────────

const MAX_QUEUE = 20;
const FLUSH_INTERVAL_MS = 5_000;

let queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setInterval> | null = null;
let flushing = false;

async function flush(): Promise<void> {
  if (flushing || queue.length === 0) return;
  if (!hasTrackingConsent()) {
    queue = [];
    return;
  }

  const batch = queue.splice(0, 50);
  flushing = true;

  try {
    await api.post(
      "/track",
      { events: batch },
      {
        headers: { "X-Tracking-Consent": "true" },
        // Tracking is fire-and-forget; don't let failures block UX
        timeout: 10_000,
      },
    );
  } catch {
    // Silent failure — tracking must never break the app
  } finally {
    flushing = false;
  }
}

function ensureTimer(): void {
  if (flushTimer !== null) return;
  flushTimer = setInterval(() => {
    void flush();
  }, FLUSH_INTERVAL_MS);

  // Flush on page unload (best-effort via sendBeacon fallback)
  if (typeof window !== "undefined") {
    window.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        void flush();
      }
    });
    window.addEventListener("pagehide", () => {
      void flush();
    });
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Queue a single tracking event. Events are batched and sent automatically.
 */
export function trackEvent(
  type: TrackingEventType,
  targetType?: TrackingTargetType | null,
  targetId?: string | null,
  metadata?: Record<string, unknown> | null,
): void {
  if (typeof window === "undefined") return;
  if (!hasTrackingConsent()) return;

  queue.push({
    event_type: type,
    target_type: targetType ?? null,
    target_id: targetId ?? null,
    metadata: metadata ?? null,
    timestamp: new Date().toISOString(),
  });

  ensureTimer();

  if (queue.length >= MAX_QUEUE) {
    void flush();
  }
}

/**
 * Track a page view. Call this on route changes.
 */
export function trackPageView(path?: string, referrer?: string): void {
  trackEvent("page_view", null, null, {
    path:
      path ?? (typeof window !== "undefined" ? window.location.pathname : "/"),
    referrer:
      referrer ?? (typeof document !== "undefined" ? document.referrer : ""),
  });
}

/**
 * Force-flush all queued events (e.g. before navigation).
 */
export async function flushTracking(): Promise<void> {
  await flush();
}

// ── React hook ─────────────────────────────────────────────────────────────

/**
 * React hook for tracking. Returns stable helpers.
 *
 * Usage:
 * ```tsx
 * const { track, trackPageView } = useTracking();
 *
 * useEffect(() => { trackPageView(); }, [pathname]);
 * <button onClick={() => track("click", "event", eventId)}>
 * ```
 */
export function useTracking() {
  return {
    track: trackEvent,
    trackPageView,
    flush: flushTracking,
  } as const;
}
