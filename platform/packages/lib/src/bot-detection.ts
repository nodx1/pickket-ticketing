import { API_URL } from "./env";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BehaviorData {
  mouseMoves: number;
  keyPresses: number;
  scrolls: number;
  timeOnPage: number;
}

// ─── Behavior collection ─────────────────────────────────────────────────────

let collectedBehaviors: BehaviorData | null = null;
let collectorCleanup: (() => void) | null = null;

/**
 * Start collecting user behavior data. Call this on page mount.
 * Behaviors accumulate until generateBehaviorToken() is called.
 */
export function startBehaviorCollection(): void {
  if (typeof window === "undefined") return;

  // Clean up previous collector if any
  stopBehaviorCollection();

  const data: BehaviorData = {
    mouseMoves: 0,
    keyPresses: 0,
    scrolls: 0,
    timeOnPage: 0,
  };

  const startTime = Date.now();

  const onMove = () => {
    data.mouseMoves += 1;
  };
  const onKeydown = () => {
    data.keyPresses += 1;
  };
  const onScroll = () => {
    data.scrolls += 1;
  };

  window.addEventListener("mousemove", onMove, { passive: true });
  window.addEventListener("keydown", onKeydown, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });

  // Update timeOnPage continuously
  const interval = window.setInterval(() => {
    data.timeOnPage = Math.floor((Date.now() - startTime) / 1000);
  }, 1000);

  collectedBehaviors = data;
  collectorCleanup = () => {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("keydown", onKeydown);
    window.removeEventListener("scroll", onScroll);
    window.clearInterval(interval);
    // Finalize timeOnPage
    data.timeOnPage = Math.max(1, Math.floor((Date.now() - startTime) / 1000));
  };
}

export function stopBehaviorCollection(): void {
  if (collectorCleanup) {
    collectorCleanup();
    collectorCleanup = null;
  }
}

// ─── Server-side token generation ───────────────────────────────────────────

/**
 * Submit collected behavior data to the server, which returns an opaque
 * signed behavior token. The signing key never leaves the server.
 *
 * Returns `{token, sessionId}` for use as X-Behavior-Token and
 * X-Behavior-Session headers on protected routes.
 */
export async function generateBehaviorToken(): Promise<{
  token: string;
  sessionId: string;
} | null> {
  if (typeof window === "undefined") return null;

  const behaviors = collectedBehaviors;
  if (!behaviors) return null;
  if (behaviors.timeOnPage <= 0) {
    behaviors.timeOnPage = Math.max(1, behaviors.timeOnPage);
  }

  try {
    const res = await fetch(`${API_URL}/api/v1/bot/challenge`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ behaviors }),
    });
    if (!res.ok) return null;
    const data: { token: string; session_id: string } = await res.json();
    return { token: data.token, sessionId: data.session_id };
  } catch {
    return null;
  }
}

// ─── Honeypot (unchanged) ────────────────────────────────────────────────────

export function createHoneypotProps() {
  return {
    name: "website",
    autoComplete: "off",
    tabIndex: -1,
    "aria-hidden": true as const,
  };
}
