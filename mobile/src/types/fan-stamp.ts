/**
 * 팬 스탬프(픽) 타입 정의
 * Phase 11: Fan Stamp — Photo + Artist Signature + Social Sharing
 */

// ── 한정 프레임 (이벤트/레벨 해금) ──
export interface ExclusiveFrame {
  id: string;
  name: string;
  thumbnailUri: string;
  /** "level:3" | "event:2026-06-15T00:00Z" (available_until) */
  unlock_condition: string;
  available_until?: string;
}

export interface StampAssets {
  artistSignature?: string; // PNG URL (투명 배경)
  eventFrame?: string; // PNG 프레임 템플릿
  eventLogo?: string; // 이벤트/아티스트 로고
  brandColor: string;
  exclusive_frames?: ExclusiveFrame[];
}

export type StampFrame =
  | "default"
  | "neon"
  | "vintage"
  | "minimal"
  | "hologram"
  | "legendary";

export type PickStatus = "going" | "completed";

export interface FanStamp {
  id: string;
  eventId: string;
  imageUri: string;
  frame: StampFrame;
  createdAt: string;
  /** 이벤트별 생성 순번 — 바이럴 FOMO */
  sequence_number?: number;
  /** going = 공연 전 기대 픽, completed = 공연 후 실제 사진 */
  status?: PickStatus;
  /** Going 픽에 사용된 포스터 이미지 (자동 생성) */
  going_image_uri?: string;
  /** 같이 간 친구 태그 */
  tagged_friends?: Array<{ id: string; name: string; avatar_url?: string }>;
}
