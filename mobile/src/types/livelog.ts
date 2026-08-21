/**
 * 라이브 로그 타입 — 공연 중/후 실시간 기록
 * 피처플래그: LIVE_LOG
 */

export type LiveLogEntryType = "setlist" | "photo" | "note" | "rating" | "highlight";

export interface LiveLogEntry {
  id: string;
  event_id: string;
  type: LiveLogEntryType;
  timestamp: string;
  content: string;
  image_url?: string;
  song_title?: string;
  rating?: number; // 1-5
}

export interface SetlistItem {
  order: number;
  title: string;
  is_encore: boolean;
  note?: string;
}

export interface LiveLogSession {
  id: string;
  event_id: string;
  event_title: string;
  artist_name: string;
  started_at: string;
  ended_at?: string;
  entries: LiveLogEntry[];
  setlist: SetlistItem[];
}
