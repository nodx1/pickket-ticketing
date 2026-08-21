/**
 * Live Wrapped 화면 — 연말 공연 회고
 * 피처플래그: LIVE_WRAPPED
 */
import { ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack } from "expo-router";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { spacing } from "@/config/theme";
import { isFeatureEnabled } from "@/config/features";
import { EmptyState } from "@/components/common/EmptyState";
import { WrappedCard } from "@/components/wrapped/WrappedCard";
import type { WrappedStats } from "@/types/wrapped";

const MOCK_STATS: WrappedStats = {
  year: 2026,
  total_shows: 23,
  total_hours: 67,
  total_artists: 15,
  top_artist: { name: "IVE", count: 5 },
  top_genre: { name: "K-POP", count: 18 },
  top_venue: { name: "KSPO DOME", count: 6 },
  monthly_breakdown: [
    { month: 1, count: 1 }, { month: 2, count: 2 }, { month: 3, count: 3 },
    { month: 4, count: 4 }, { month: 5, count: 2 }, { month: 6, count: 3 },
    { month: 7, count: 2 }, { month: 8, count: 1 }, { month: 9, count: 2 },
    { month: 10, count: 1 }, { month: 11, count: 1 }, { month: 12, count: 1 },
  ],
  highlights: [
    { event_title: "IVE THE 1ST WORLD TOUR", date: "2026-06-15" },
    { event_title: "WATERBOMB SEOUL 2026", date: "2026-07-20" },
  ],
};

export default function WrappedScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();

  if (!isFeatureEnabled("LIVE_WRAPPED")) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: t("wrapped.title"), headerShown: true }} />
        <EmptyState icon="sparkles-outline" title={t("wrapped.comingSoon")} message={t("wrapped.comingSoonDesc")} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: t("wrapped.title"), headerShown: true }} />
      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        <WrappedCard stats={MOCK_STATS} />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { padding: spacing.xl },
});
