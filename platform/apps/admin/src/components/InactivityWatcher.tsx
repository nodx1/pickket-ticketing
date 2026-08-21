"use client";

import { useEffect, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { useAuthStore } from "@pickket/store";

// 30-minute inactivity logout for admin sessions. Watches mouse/keyboard/scroll
// on the window; resets the timer on activity. On timeout, clears the logged-in
// cookie and redirects to /auth with an expired=1 query param.
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes
const ACTIVITY_EVENTS: (keyof WindowEventMap)[] = [
  "mousemove",
  "mousedown",
  "keydown",
  "scroll",
  "touchstart",
];

function clearSessionCookies(): void {
  if (typeof document === "undefined") return;
  const expiredCookies = ["pickket_logged_in", "pickket_csrf"];
  for (const name of expiredCookies) {
    document.cookie = `${name}=; Path=/; Max-Age=0; SameSite=Strict`;
  }
}

export function InactivityWatcher({
  timeoutMs = INACTIVITY_TIMEOUT_MS,
}: {
  timeoutMs?: number;
} = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Skip on auth pages — no session to expire there.
    if (pathname?.startsWith("/auth")) return;

    function resetTimer() {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(async () => {
        // 서버 측 refresh 토큰 패밀리까지 폐기해야 /auth/refresh 재획득을 막는다(P2-C4).
        // 클라 쿠키만 지우면 HttpOnly refresh 쿠키가 살아있어 세션 재생성이 가능.
        try {
          await useAuthStore.getState().logout();
        } catch {
          // 네트워크 실패해도 클라 정리 + 리다이렉트는 진행
        }
        clearSessionCookies();
        router.replace("/auth?expired=1");
      }, timeoutMs);
    }

    resetTimer();
    for (const ev of ACTIVITY_EVENTS) {
      window.addEventListener(ev, resetTimer, { passive: true });
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      for (const ev of ACTIVITY_EVENTS) {
        window.removeEventListener(ev, resetTimer);
      }
    };
  }, [pathname, router, timeoutMs]);

  return null;
}
