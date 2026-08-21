/**
 * 팬 스코어 미션 타입
 * Phase B: 팬 참여도 향상을 위한 미션 시스템
 */

export type MissionCategory = "daily" | "social" | "content" | "purchase" | "community";
export type MissionStatus = "available" | "in_progress" | "completed" | "expired";

export interface Mission {
  id: string;
  title: string;
  description: string;
  category: MissionCategory;
  status: MissionStatus;
  xp_reward: number;
  progress: number; // 0-100
  target: number;
  current: number;
  icon: string; // Ionicons name
  expires_at?: string;
}

export interface FanScoreSummary {
  total_xp: number;
  level: number;
  level_name: string;
  next_level_xp: number;
  completed_missions: number;
  streak_days: number;
  rank_percentile: number; // 상위 N%
}
