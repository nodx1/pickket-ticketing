/**
 * TenasiaMediaBadge — 데이터 소스 신뢰도 뱃지
 * trust_score 기반 시각적 표시 (텐아시아/공식/크롤링/UGC)
 */
import { View, Text, StyleSheet } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import type { ScheduleSource } from "@/types/schedule";

interface Props {
  source: ScheduleSource;
  trustScore: number;
}

const SOURCE_CONFIG: Record<
  ScheduleSource,
  { label: string; icon: React.ComponentProps<typeof Ionicons>["name"] }
> = {
  pickket: { label: "Pickket", icon: "shield-checkmark" },
  tenasia: { label: "텐아시아", icon: "newspaper" },
  bandsintown: { label: "Bandsintown", icon: "globe" },
  setlist_fm: { label: "Setlist.fm", icon: "musical-notes" },
  broadcast: { label: "방송사", icon: "tv" },
  ugc: { label: "팬 제보", icon: "person" },
};

function getTrustColor(score: number, colors: { success: string; warning: string; mutedForeground: string }) {
  if (score >= 90) return colors.success;
  if (score >= 70) return colors.warning;
  return colors.mutedForeground;
}

export function TenasiaMediaBadge({ source, trustScore }: Props) {
  const { colors } = useTheme();
  const config = SOURCE_CONFIG[source] ?? SOURCE_CONFIG.ugc;
  const trustColor = getTrustColor(trustScore, colors);

  return (
    <View style={[styles.badge, { backgroundColor: colors.secondary, borderColor: colors.border }]}>
      <Ionicons name={config.icon} size={14} color={trustColor} />
      <Text style={[typography.micro, styles.label, { color: colors.foreground }]}>
        {config.label}
      </Text>
      <View style={[styles.dot, { backgroundColor: trustColor }]} />
      <Text style={[typography.micro, { color: trustColor }]}>
        {trustScore}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
    borderWidth: 1,
    alignSelf: "flex-start",
  },
  label: {
    marginLeft: 4,
    marginRight: 4,
  },
  dot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    marginRight: 4,
  },
});
