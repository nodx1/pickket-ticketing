/**
 * Picks 타입 배럴 — fan-stamp 내부 타입을 "픽" 도메인으로 re-export
 */
export type {
  FanStamp,
  StampAssets,
  StampFrame,
  PickStatus,
  ExclusiveFrame,
} from "./fan-stamp";

/** UI 표시용 확장 타입 — 뷰어/컬렉션에서 사용 */
export interface PickDetail {
  id: string;
  eventId: string;
  imageUri: string;
  frame: string;
  createdAt: string;
  sequence_number?: number;
  status: "going" | "completed";
  eventTitle: string;
  eventDate: string;
  venue?: string;
  thumbnailUri?: string;
  tagged_friends?: Array<{ id: string; name: string; avatar_url?: string }>;
}
