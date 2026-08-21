/**
 * 데일리 투표 화면
 * 피처플래그: DAILY_VOTE
 */
import { useCallback, useState } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack } from "expo-router";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { spacing } from "@/config/theme";
import { isFeatureEnabled } from "@/config/features";
import { EmptyState } from "@/components/common/EmptyState";
import { VoteCard } from "@/components/vote/VoteCard";
import type { DailyVote } from "@/types/vote";

const MOCK_VOTE: DailyVote = {
  id: "v-1",
  question: "2026 최고의 콘서트는?",
  options: [
    { id: "o-1", label: "IVE WORLD TOUR", vote_count: 4200 },
    { id: "o-2", label: "SEVENTEEN RIGHT HERE", vote_count: 3800 },
    { id: "o-3", label: "aespa SYNK", vote_count: 3100 },
    { id: "o-4", label: "Stray Kids DOMINARTE", vote_count: 2900 },
  ],
  total_votes: 14000,
  xp_reward: 10,
  expires_at: new Date(Date.now() + 86400000).toISOString(),
};

export default function VoteScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [vote, setVote] = useState<DailyVote>(MOCK_VOTE);

  if (!isFeatureEnabled("DAILY_VOTE")) {
    return (
      <SafeAreaView testID="vote.screen" style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: t("vote.title"), headerShown: true }} />
        <EmptyState testID="vote.comingSoon" icon="podium-outline" title={t("vote.comingSoon")} message={t("vote.comingSoonDesc")} />
      </SafeAreaView>
    );
  }

  const handleVote = useCallback((voteId: string, optionId: string) => {
    setVote((prev) => ({
      ...prev,
      user_voted_id: optionId,
      total_votes: prev.total_votes + 1,
      options: prev.options.map((o) =>
        o.id === optionId ? { ...o, vote_count: o.vote_count + 1 } : o,
      ),
    }));
  }, []);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: t("vote.daily"), headerShown: true }} />
      <ScrollView contentContainerStyle={styles.scroll}>
        <VoteCard vote={vote} onVote={handleVote} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: spacing.xl },
});
