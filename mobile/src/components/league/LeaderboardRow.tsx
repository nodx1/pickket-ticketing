/**
 * LeaderboardRow — 리그 순위표 행
 * 디자인 정책: radius.xl(16), 44pt 터치
 */
import { View, Text, StyleSheet } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import type { LeagueRanking } from "@/types/league";

interface Props {
  ranking: LeagueRanking;
  isMe?: boolean;
}

const TIER_COLORS: Record<string, string> = {
  bronze: "#CD7F32",
  silver: "#C0C0C0",
  gold: "#FFD700",
  platinum: "#E5E4E2",
  diamond: "#B9F2FF",
};

export function LeaderboardRow({ ranking, isMe = false }: Props) {
  const { colors } = useTheme();
  const tierColor = TIER_COLORS[ranking.tier] ?? colors.mutedForeground;

  return (
    <View style={[styles.row, {
      backgroundColor: isMe ? colors.primary + "10" : colors.card,
      borderColor: isMe ? colors.primary : colors.border,
    }]}>
      {/* 순위 */}
      <View style={styles.rankCol}>
        {ranking.rank <= 3 ? (
          <Ionicons
            name="trophy"
            size={20}
            color={ranking.rank === 1 ? "#FFD700" : ranking.rank === 2 ? "#C0C0C0" : "#CD7F32"}
          />
        ) : (
          <Text style={[typography.h4, { color: colors.foreground }]}>
            {ranking.rank}
          </Text>
        )}
      </View>

      {/* 유저 정보 */}
      <View style={styles.userCol}>
        <Text style={[typography.h5, { color: colors.foreground }]} numberOfLines={1}>
          {ranking.user_name}
        </Text>
        <Text style={[typography.micro, { color: tierColor }]}>
          Lv.{ranking.level}
        </Text>
      </View>

      {/* XP */}
      <Text style={[typography.h5, { color: colors.primary }]}>
        {ranking.total_xp.toLocaleString()} XP
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
    minHeight: 52,
  },
  rankCol: {
    width: 36,
    alignItems: "center",
    marginRight: spacing.md,
  },
  userCol: {
    flex: 1,
    marginRight: spacing.md,
  },
});
