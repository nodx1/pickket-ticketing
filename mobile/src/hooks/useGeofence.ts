/**
 * Phase E.1 — Geofence 훅
 *
 * 앱 포그라운드 전환 시 1회 위치 체크 + 서버 geofence 매칭 호출.
 * 알림 제어 센터의 `location_based` 토글이 OFF 면 호출하지 않는다.
 */
import { useEffect, useRef } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { runGeofenceCheck } from "@/lib/location-notify";
import { useNotificationPreferences } from "@/hooks/useNotifications";

export function useGeofenceForeground() {
  const { data: prefs } = useNotificationPreferences();
  const enabled = prefs?.location_based === true && prefs?.push_enabled !== false;
  const lastRunRef = useRef<number>(0);

  useEffect(() => {
    if (!enabled) return;

    const run = async () => {
      // throttle: 5분 내 중복 호출 방지
      const now = Date.now();
      if (now - lastRunRef.current < 5 * 60 * 1000) return;
      lastRunRef.current = now;
      await runGeofenceCheck();
    };

    // 최초 1회
    void run();

    const sub = AppState.addEventListener("change", (state: AppStateStatus) => {
      if (state === "active") {
        void run();
      }
    });

    return () => {
      sub.remove();
    };
  }, [enabled]);
}
