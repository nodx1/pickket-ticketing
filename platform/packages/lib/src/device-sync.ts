/**
 * P2-7: Multi-device continuity hook.
 *
 * 다른 기기에서 진행 중인 세션을 감지하고 이어서 하기 배너를 제공.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import api from "./api";

// ── Types ──────────────────────────────────────────────────────────────

interface ActivityItem {
  type: string;
  metadata: Record<string, unknown>;
  ts: number;
}

interface DeviceInfo {
  device_id: string;
  info: Record<string, unknown>;
  last_seen: number;
}

interface RecentActivitiesResponse {
  activities: ActivityItem[];
  active_devices: DeviceInfo[];
}

interface CartResponse {
  cart: Record<string, unknown> | null;
}

interface HeartbeatResponse {
  active_devices: number;
  synced_at: string;
}

export interface DeviceSyncState {
  /** 다른 기기 활성 세션이 있는지 */
  hasOtherDevice: boolean;
  /** 다른 기기에서 진행 중인 이벤트 정보 */
  pendingSession: {
    eventId: string | null;
    eventTitle: string | null;
    page: string | null;
  } | null;
  /** 최근 활동 목록 */
  recentActivities: ActivityItem[];
  /** 장바구니 상태 */
  cart: Record<string, unknown> | null;
  /** 활성 디바이스 수 */
  activeDeviceCount: number;
  /** 배너 닫기 */
  dismissBanner: () => void;
  /** 배너 표시 여부 */
  showBanner: boolean;
  /** 로딩 상태 */
  loading: boolean;
}

// ── Device ID ──────────────────────────────────────────────────────────

function getDeviceId(): string {
  if (typeof window === "undefined") return "ssr";
  const key = "pickket_device_id";
  let id = localStorage.getItem(key);
  if (!id) {
    id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    localStorage.setItem(key, id);
  }
  return id;
}

function getDeviceInfo(): Record<string, string> {
  if (typeof window === "undefined") return {};
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    language: navigator.language,
    screenWidth: String(screen.width),
    screenHeight: String(screen.height),
  };
}

// ── API calls ──────────────────────────────────────────────────────────

async function fetchRecentActivities(): Promise<RecentActivitiesResponse | null> {
  try {
    const { data } = await api.get<RecentActivitiesResponse>("/sync/recent");
    return data;
  } catch {
    return null;
  }
}

async function fetchCart(): Promise<CartResponse | null> {
  try {
    const { data } = await api.get<CartResponse>("/sync/cart");
    return data;
  } catch {
    return null;
  }
}

async function sendHeartbeat(
  currentPage: string | null,
): Promise<HeartbeatResponse | null> {
  try {
    const { data } = await api.post<HeartbeatResponse>("/sync/heartbeat", {
      device_id: getDeviceId(),
      device_info: getDeviceInfo(),
      current_page: currentPage,
    });
    return data;
  } catch {
    return null;
  }
}

export async function recordActivity(
  activityType: "page_view" | "cart_update" | "bid_placed" | "search",
  metadata?: Record<string, unknown>,
): Promise<void> {
  try {
    await api.post("/sync/activity", {
      activity_type: activityType,
      metadata: metadata ?? {},
    });
  } catch {
    // non-critical, silently fail
  }
}

export async function updateCart(cartData: {
  event_id?: string;
  items: Array<Record<string, unknown>>;
  extra?: Record<string, unknown>;
}): Promise<void> {
  try {
    await api.post("/sync/cart", cartData);
  } catch {
    // non-critical
  }
}

// ── Hook ───────────────────────────────────────────────────────────────

const HEARTBEAT_INTERVAL = 30_000; // 30초
const SYNC_INTERVAL = 60_000; // 1분

export function useDeviceSync(): DeviceSyncState {
  const [state, setState] = useState<{
    hasOtherDevice: boolean;
    pendingSession: DeviceSyncState["pendingSession"];
    recentActivities: ActivityItem[];
    cart: Record<string, unknown> | null;
    activeDeviceCount: number;
    showBanner: boolean;
    loading: boolean;
  }>({
    hasOtherDevice: false,
    pendingSession: null,
    recentActivities: [],
    cart: null,
    activeDeviceCount: 0,
    showBanner: false,
    loading: true,
  });

  const dismissedRef = useRef(false);
  const heartbeatRef = useRef<ReturnType<typeof setInterval> | undefined>(
    undefined,
  );
  const syncRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const dismissBanner = useCallback(() => {
    dismissedRef.current = true;
    setState((prev) => ({ ...prev, showBanner: false }));
  }, []);

  const syncData = useCallback(async () => {
    const [activitiesRes, cartRes] = await Promise.all([
      fetchRecentActivities(),
      fetchCart(),
    ]);

    if (!activitiesRes) {
      setState((prev) => ({ ...prev, loading: false }));
      return;
    }

    const myDeviceId = getDeviceId();
    const otherDevices = activitiesRes.active_devices.filter(
      (d) => d.device_id !== myDeviceId,
    );
    const hasOther = otherDevices.length > 0;

    // 다른 기기에서 진행 중인 세션 감지
    let pendingSession: DeviceSyncState["pendingSession"] = null;
    if (hasOther) {
      // 가장 최근 다른 기기의 활동에서 이벤트 정보 추출
      const otherDevice = otherDevices[0];
      const otherPage =
        (otherDevice.info as Record<string, string>)?.current_page ?? null;

      // 최근 활동에서 이벤트 관련 정보 찾기
      const eventActivity = activitiesRes.activities.find(
        (a) =>
          a.metadata?.event_id ||
          a.metadata?.event_title ||
          a.type === "cart_update",
      );

      pendingSession = {
        eventId: (eventActivity?.metadata?.event_id as string) ?? null,
        eventTitle: (eventActivity?.metadata?.event_title as string) ?? null,
        page: otherPage,
      };
    }

    setState({
      hasOtherDevice: hasOther,
      pendingSession,
      recentActivities: activitiesRes.activities,
      cart: cartRes?.cart ?? null,
      activeDeviceCount: activitiesRes.active_devices.length,
      showBanner: hasOther && !dismissedRef.current,
      loading: false,
    });
  }, []);

  useEffect(() => {
    // 초기 동기화
    syncData();

    // Heartbeat 주기적 전송
    const doHeartbeat = () => {
      const page =
        typeof window !== "undefined" ? window.location.pathname : null;
      sendHeartbeat(page);
    };

    doHeartbeat();
    heartbeatRef.current = setInterval(doHeartbeat, HEARTBEAT_INTERVAL);
    syncRef.current = setInterval(syncData, SYNC_INTERVAL);

    return () => {
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      if (syncRef.current) clearInterval(syncRef.current);
    };
  }, [syncData]);

  return {
    ...state,
    dismissBanner,
  };
}
