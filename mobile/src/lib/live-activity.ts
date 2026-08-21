import { NativeModules, Platform } from "react-native";

/**
 * iOS Live Activity 브릿지
 * Swift WidgetKit Extension (ios/PickketWidgets/)과 통신
 *
 * 트리거 시점:
 * - /e/[slug] 구독 → startTicketOpenActivity (countdown)
 * - 티켓오픈 10분 전 → updateActivity (imminent)
 * - 티켓오픈 시점 → updateActivity (live)
 * - P4 추첨 참여 → startDrawingActivity (drawing)
 * - 공연 당일 → startCheckinActivity (checkin)
 * - 공연 종료 → endActivity (ended)
 */

interface TicketOpenActivityParams {
  eventId: string;
  title: string;
  venue: string;
  targetDate: string;
  brandColor: string;
  subscriberCount: number;
}

interface ActivityUpdateState {
  phase:
    | "countdown"
    | "imminent"
    | "live"
    | "drawing"
    | "checkin"
    | "entered"
    | "ended";
  subscriberCount?: number;
  message?: string;
}

const LiveActivityModule = NativeModules.PickketLiveActivity;

/** 티켓오픈 카운트다운 Live Activity 시작 */
export async function startTicketOpenActivity(
  params: TicketOpenActivityParams,
): Promise<void> {
  if (Platform.OS !== "ios" || !LiveActivityModule) return;
  try {
    await LiveActivityModule.start(params);
  } catch (e: unknown) {
    if (__DEV__) console.warn("[LiveActivity] start failed:", e);
  }
}

/** Live Activity 상태 업데이트 */
export async function updateActivity(
  eventId: string,
  state: ActivityUpdateState,
): Promise<void> {
  if (Platform.OS !== "ios" || !LiveActivityModule) return;
  try {
    await LiveActivityModule.update({ eventId, ...state });
  } catch (e: unknown) {
    if (__DEV__) console.warn("[LiveActivity] update failed:", e);
  }
}

/** Live Activity 종료 */
export async function endActivity(eventId: string): Promise<void> {
  if (Platform.OS !== "ios" || !LiveActivityModule) return;
  try {
    await LiveActivityModule.end({ eventId });
  } catch (e: unknown) {
    if (__DEV__) console.warn("[LiveActivity] end failed:", e);
  }
}

/** P4 추첨 대기 Activity 시작 */
export async function startDrawingActivity(params: {
  eventId: string;
  title: string;
  brandColor: string;
}): Promise<void> {
  if (Platform.OS !== "ios" || !LiveActivityModule) return;
  try {
    await LiveActivityModule.startDrawing(params);
  } catch (e: unknown) {
    if (__DEV__) console.warn("[LiveActivity] startDrawing failed:", e);
  }
}

/** 공연 당일 체크인 Activity 시작 */
export async function startCheckinActivity(params: {
  eventId: string;
  title: string;
  venue: string;
  brandColor: string;
  checkinTime: string;
}): Promise<void> {
  if (Platform.OS !== "ios" || !LiveActivityModule) return;
  try {
    await LiveActivityModule.startCheckin(params);
  } catch (e: unknown) {
    if (__DEV__) console.warn("[LiveActivity] startCheckin failed:", e);
  }
}
