/**
 * WrappedCard — Live Wrapped 요약 카드
 * 디자인 정책: radius.xl(16), spring 애니메이션
 * 피처플래그: LIVE_WRAPPED
 */
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { typography, spacing, radius } from "@/config/theme";
import type { WrappedStats } from "@/types/wrapped";

interface Props {
  stats: WrappedStats;
  onShare?: () => void;
}

export function WrappedCard({ stats, onShare }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <Animated.View entering={FadeIn.springify()}>
      <View style={[styles.card, { backgroundColor: colors.primary }]}>
        <Text style={[typography.h1, { color: colors.primaryForeground }]}>
          {t("wrapped.myYear", { year: stats.year })}
        </Text>

        <View style={styles.statsGrid}>
          <StatItem
            icon="musical-notes"
            value={String(stats.total_shows)}
            label={t("wrapped.totalShows", { count: stats.total_shows })}
            color={colors.primaryForeground}
          />
          <StatItem
            icon="time"
            value={`${stats.total_hours}h`}
            label={t("wrapped.totalHours", { hours: stats.total_hours })}
            color={colors.primaryForeground}
          />
          <StatItem
            icon="heart"
            value={stats.top_artist.name}
            label={t("wrapped.topArtist")}
            color={colors.primaryForeground}
          />
          <StatItem
            icon="disc"
            value={stats.top_genre.name}
            label={t("wrapped.topGenre")}
            color={colors.primaryForeground}
          />
        </View>

        {onShare && (
          <TouchableOpacity
            onPress={onShare}
            style={[styles.shareBtn, { backgroundColor: colors.primaryForeground }]}
            accessibilityRole="button"
          >
            <Ionicons name="share-outline" size={18} color={colors.primary} />
            <Text style={[typography.h5, { color: colors.primary, marginLeft: spacing.sm }]}>
              {t("wrapped.share")}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    </Animated.View>
  );
}

function StatItem({ icon, value, label, color }: { icon: React.ComponentProps<typeof Ionicons>["name"]; value: string; label: string; color: string }) {
  return (
    <View style={styles.statItem}>
      <Ionicons name={icon} size={20} color={color} style={{ opacity: 0.7 }} />
      <Text style={[typography.h3, { color, marginTop: spacing.xs }]}>{value}</Text>
      <Text style={[typography.micro, { color, opacity: 0.7 }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    padding: spacing.xl,
  },
  statsGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    marginTop: spacing.xl,
    gap: spacing.lg,
  },
  statItem: {
    width: "45%",
    alignItems: "center",
  },
  shareBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 44,
    borderRadius: radius.xl,
    marginTop: spacing.xl,
  },
});
