/**
 * 팬 스코어 리그 타입
 * 피처플래그: FAN_SCORE_LEAGUE
 */

export type LeagueTier = "bronze" | "silver" | "gold" | "platinum" | "diamond";

export interface LeagueRanking {
  rank: number;
  user_id: string;
  user_name: string;
  avatar_url?: string;
  level: number;
  total_xp: number;
  tier: LeagueTier;
}

export interface LeagueInfo {
  current_tier: LeagueTier;
  current_rank: number;
  total_participants: number;
  top_rankings: LeagueRanking[];
  my_ranking: LeagueRanking;
  season_end: string;
  rewards: LeagueReward[];
}

export interface LeagueReward {
  tier: LeagueTier;
  description: string;
  xp_bonus: number;
  badge_image_url?: string;
}
