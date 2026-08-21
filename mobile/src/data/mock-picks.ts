/**
 * Picks 개발용 Mock 데이터 — Going + Completed 혼합
 * __DEV__ + API 실패 시 폴백으로 사용
 */
import type { FanStamp } from "@/types/fan-stamp";

export const MOCK_PICKS: FanStamp[] = [
  {
    id: "mock-pick-1",
    eventId: "s1",
    imageUri: "https://picsum.photos/seed/pick1/400/400",
    frame: "default",
    createdAt: "2026-04-10T18:00:00Z",
    sequence_number: 42,
    status: "completed",
  },
  {
    id: "mock-pick-2",
    eventId: "s2",
    imageUri: "https://picsum.photos/seed/pick2/400/400",
    frame: "neon",
    createdAt: "2026-04-08T20:00:00Z",
    sequence_number: 17,
    status: "completed",
  },
  {
    id: "mock-pick-3",
    eventId: "s3",
    imageUri: "https://picsum.photos/seed/pick3/400/400",
    frame: "vintage",
    createdAt: "2026-04-12T10:00:00Z",
    status: "going",
    going_image_uri: "https://picsum.photos/seed/going3/400/400",
  },
  {
    id: "mock-pick-4",
    eventId: "s4",
    imageUri: "https://picsum.photos/seed/pick4/400/400",
    frame: "minimal",
    createdAt: "2026-04-05T15:00:00Z",
    sequence_number: 128,
    status: "completed",
  },
];

/** PicksRing용 간략 mock — 이벤트 제목 포함 */
export const MOCK_PICK_LABELS: Record<string, string> = {
  s1: "IVE 서울",
  s2: "aespa",
  s3: "WATERBOMB",
  s4: "FRIEZE",
};
