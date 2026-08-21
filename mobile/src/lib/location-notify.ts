/**
 * Phase E.1 — 위치 기반 알림
 *
 * 포그라운드 전용 정책 (거부율이 높은 백그라운드 위치 권한 회피):
 *  - 앱 시작/포그라운드 복귀 시 `runGeofenceCheck()` 1회 호출
 *  - 현재 좌표를 `checkGeofence(lat, lng)` 로 서버에 전송, 서버가 매칭 시 알림 발송
 *  - 즐겨찾기 변경 시 `registerGeofence()` / `unregisterGeofence()` 로 구독 동기화
 *
 * NOTE: expo-location 이 dev client 에 포함되지 않은 경우 앱 전체 크래시를 방지하기
 *       위해 lazy require + try/catch 로 모듈 로드를 감싼다.
 */
import { reportError } from "@/lib/crash-reporting";
import {
  checkGeofence,
  createGeofence,
  deleteGeofence,
  listMyGeofences,
  type Geofence,
  type GeofenceMatch,
} from "@/config/api";

// Lazy require — 네이티브 모듈이 빌드에 포함되지 않아도 import 단계에서 크래시하지 않음
type LocationModule = typeof import("expo-location");
let cachedLocation: LocationModule | null | undefined;

function getLocation(): LocationModule | null {
  if (cachedLocation !== undefined) return cachedLocation;
  try {
     
    cachedLocation = require("expo-location") as LocationModule;
  } catch (err: unknown) {
    reportError(err instanceof Error ? err : new Error(String(err)), {
      tags: { scope: "location_module_missing" },
    });
    cachedLocation = null;
  }
  return cachedLocation;
}

/** 현재 권한 상태 반환 (요청 없이 조회만). */
export async function getLocationPermissionStatus(): Promise<string> {
  const Location = getLocation();
  if (!Location) return "undetermined";
  try {
    const { status } = await Location.getForegroundPermissionsAsync();
    return status;
  } catch (err: unknown) {
    reportError(err instanceof Error ? err : new Error(String(err)), {
      tags: { scope: "location" },
    });
    return "undetermined";
  }
}

/** 권한 요청 — 이미 허용/거부된 경우 그대로 반환. */
export async function requestLocationPermission(): Promise<boolean> {
  const Location = getLocation();
  if (!Location) return false;
  try {
    const existing = await Location.getForegroundPermissionsAsync();
    if (existing.status === "granted") return true;
    if (!existing.canAskAgain) return false;
    const result = await Location.requestForegroundPermissionsAsync();
    return result.status === "granted";
  } catch (err: unknown) {
    reportError(err instanceof Error ? err : new Error(String(err)), {
      tags: { scope: "location" },
    });
    return false;
  }
}

/** 1회성 현재 좌표 획득. 권한 없으면 null. */
export async function getCurrentPosition(): Promise<{ lat: number; lng: number } | null> {
  const Location = getLocation();
  if (!Location) return null;
  try {
    const granted = await requestLocationPermission();
    if (!granted) return null;
    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.Balanced,
    });
    return { lat: pos.coords.latitude, lng: pos.coords.longitude };
  } catch (err: unknown) {
    if (__DEV__) {
      console.warn("[Location] getCurrentPosition failed:", err);
    } else {
      reportError(err instanceof Error ? err : new Error(String(err)), {
        tags: { scope: "location" },
      });
    }
    return null;
  }
}

/** 포그라운드 전환 등 훅에서 호출 — 현재 위치로 geofence 체크. */
export async function runGeofenceCheck(): Promise<GeofenceMatch[]> {
  const pos = await getCurrentPosition();
  if (!pos) return [];
  try {
    return await checkGeofence(pos.lat, pos.lng);
  } catch (err: unknown) {
    reportError(err instanceof Error ? err : new Error(String(err)), {
      tags: { scope: "geofence_check" },
    });
    return [];
  }
}

/** 이벤트 즐겨찾기 시 서버에 구독 등록. 좌표는 venue 정보에서 주입. */
export async function registerGeofence(params: {
  eventId?: string;
  venueId?: string;
  lat: number;
  lng: number;
  radiusM?: number;
}): Promise<Geofence | null> {
  try {
    return await createGeofence({
      event_id: params.eventId,
      venue_id: params.venueId,
      lat: params.lat,
      lng: params.lng,
      radius_m: params.radiusM ?? 1000,
    });
  } catch (err: unknown) {
    reportError(err instanceof Error ? err : new Error(String(err)), {
      tags: { scope: "geofence_register" },
    });
    return null;
  }
}

export async function unregisterGeofence(id: string): Promise<boolean> {
  try {
    await deleteGeofence(id);
    return true;
  } catch (err: unknown) {
    reportError(err instanceof Error ? err : new Error(String(err)), {
      tags: { scope: "geofence_unregister" },
    });
    return false;
  }
}

export async function listGeofences(): Promise<Geofence[]> {
  try {
    return await listMyGeofences();
  } catch (err: unknown) {
    reportError(err instanceof Error ? err : new Error(String(err)), {
      tags: { scope: "geofence_list" },
    });
    return [];
  }
}
