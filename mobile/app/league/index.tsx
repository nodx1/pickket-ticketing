/**
 * 팬 스코어 리그 화면
 * 피처플래그: FAN_SCORE_LEAGUE
 */
import { View, Text, FlatList, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, { FadeIn } from "react-native-reanimated";
import { Stack } from "expo-router";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { typography, spacing, radius } from "@/config/theme";
import { isFeatureEnabled } from "@/config/features";
import { EmptyState } from "@/components/common/EmptyState";
import { LeaderboardRow } from "@/components/league/LeaderboardRow";
import type { LeagueRanking } from "@/types/league";

const MOCK_RANKINGS: LeagueRanking[] = [
  { rank: 1, user_id: "u-1", user_name: "별빛팬", level: 5, total_xp: 9800, tier: "diamond" },
  { rank: 2, user_id: "u-2", user_name: "콘서트마니아", level: 5, total_xp: 9500, tier: "diamond" },
  { rank: 3, user_id: "u-3", user_name: "음악사랑", level: 4, total_xp: 8900, tier: "platinum" },
  { rank: 4, user_id: "u-4", user_name: "공연왕", level: 4, total_xp: 8200, tier: "platinum" },
  { rank: 5, user_id: "u-5", user_name: "김팬덤", level: 4, total_xp: 7800, tier: "gold" },
  { rank: 42, user_id: "me", user_name: "나", level: 3, total_xp: 4200, tier: "silver" },
];

export default function LeagueScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();

  if (!isFeatureEnabled("FAN_SCORE_LEAGUE")) {
    return (
      <SafeAreaView testID="league.screen" style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: t("league.title"), headerShown: true }} />
        <EmptyState testID="league.comingSoon" icon="podium-outline" title={t("league.comingSoon")} message={t("league.comingSoonDesc")} />
      </SafeAreaView>
    );
  }

  const myRanking = MOCK_RANKINGS.find((r) => r.user_id === "me");

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: t("league.title"), headerShown: true }} />

      {/* 내 순위 카드 */}
      {myRanking && (
        <Animated.View entering={FadeIn.springify()} style={styles.myRankCard}>
          <View style={[styles.myRank, { backgroundColor: colors.primary }]}>
            <Text style={[typography.h1, { color: colors.primaryForeground }]}>
              #{myRanking.rank}
            </Text>
            <Text style={[typography.bodySmall, { color: colors.primaryForeground, opacity: 0.7 }]}>
              {myRanking.total_xp.toLocaleString()} XP
            </Text>
          </View>
        </Animated.View>
      )}

      {/* 순위표 */}
      <FlatList
        data={MOCK_RANKINGS.filter((r) => r.user_id !== "me")}
        keyExtractor={(item) => item.user_id}
        renderItem={({ item }) => <LeaderboardRow ranking={item} />}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  myRankCard: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
  },
  myRank: {
    padding: spacing.xl,
    borderRadius: radius.xl,
    alignItems: "center",
  },
  list: {
    padding: spacing.xl,
  },
  separator: { height: spacing.sm },
});
