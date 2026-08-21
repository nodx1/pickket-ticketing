export interface FanProfile {
  level: number;
  levelName: string;
  xp: number;
  maxXp: number;
  dimensions: {
    loyalty: number;    // 충성도 0-100
    history: number;    // 히스토리 0-100
    fanclub: number;    // 팬클럽 0-100
    engagement: number; // 참여 0-100
    behavior: number;   // 행동 0-100
  };
  recentXpEvents: Array<{
    description: string;
    xp: number;
    date: string;
  }>;
}

export const FAN_LEVELS = [
  { level: 1, name: "입문러", minXp: 0, maxXp: 19, color: "#8E8E93", icon: "🌱" },
  { level: 2, name: "관심러", minXp: 20, maxXp: 49, color: "#34C759", icon: "🎵" },
  { level: 3, name: "열정러", minXp: 50, maxXp: 79, color: "#007AFF", icon: "🔥" },
  { level: 4, name: "매니아", minXp: 80, maxXp: 94, color: "#AF52DE", icon: "⭐" },
  { level: 5, name: "전설러", minXp: 95, maxXp: 100, color: "#FFD700", icon: "🏆" },
] as const;

export function getLevelInfo(level: number) {
  return FAN_LEVELS.find((l) => l.level === level) ?? FAN_LEVELS[0];
}
