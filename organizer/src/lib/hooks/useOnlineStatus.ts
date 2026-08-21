"use client";

import { useEffect, useState } from "react";

/**
 * §13 네트워크 온라인/오프라인 감지. navigator.onLine + online/offline 이벤트.
 * SSR 안전(초기값 true, 클라이언트에서 실제값 반영). 오프라인 "감지"용 — 실제 모드 전환은
 * 스태프 명시 토글이 결정한다(자동 무단 전환 아님).
 */
function readOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(readOnline);

  useEffect(() => {
    const sync = () => setOnline(readOnline());
    // 마운트 시 이벤트로만 동기화(effect 내 동기 setState 회피). 초기값은 lazy init 이 처리.
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  return online;
}
