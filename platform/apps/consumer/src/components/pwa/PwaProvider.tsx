"use client";

import { useEffect } from "react";
import { initPwa } from "@/lib/pwa";

/**
 * PWA 초기화 — 설치 이벤트 구독 + 서비스 워커 등록.
 * 개발 서버에서는 HMR 과 충돌하므로 서비스 워커를 등록하지 않는다(NEXT_PUBLIC_ENABLE_SW=1 로 강제 가능).
 */
export function PwaProvider() {
  useEffect(() => {
    initPwa();
    const enabled =
      process.env.NODE_ENV === "production" || process.env.NEXT_PUBLIC_ENABLE_SW === "1";
    if (!enabled || !("serviceWorker" in navigator)) return;
    const register = () => {
      navigator.serviceWorker
        .register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
        /* 등록 실패해도 사이트 이용에는 지장 없음 */
      });
    };
    if (document.readyState === "complete") register();
    else window.addEventListener("load", register, { once: true });
  }, []);
  return null;
}
