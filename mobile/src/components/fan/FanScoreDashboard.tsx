/**
 * FanScoreDashboard — 팬 스코어 대시보드 (me.tsx 내 섹션)
 * 레벨 진행 + 미션 목록 + 스트릭
 * 피처플래그: FAN_SCORE_MISSIONS
 * 디자인 정책: radius.xl(16), spacing.xxl(32) 상단 간격, spring 애니메이션
 */
import { View, Text, StyleSheet } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { typography, spacing, radius } from "@/config/theme";
import { isFeatureEnabled } from "@/config/features";
import { MissionCard } from "./MissionCard";
import type { Mission, FanScoreSummary } from "@/types/mission";

interface Props {
  summary: FanScoreSummary;
  missions: Mission[];
  onMissionPress?: (mission: Mission) => void;
}

export function FanScoreDashboard({ summary, missions, onMissionPress }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  if (!isFeatureEnabled("FAN_SCORE_MISSIONS")) return null;

  const progressPct = summary.next_level_xp > 0
    ? Math.round((summary.total_xp / summary.next_level_xp) * 100)
    : 100;

  return (
    <Animated.View entering={FadeIn.springify()} style={styles.container}>
      {/* 레벨 카드 */}
      <View style={[styles.levelCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={styles.levelHeader}>
          <View>
            <Text style={[typography.h3, { color: colors.foreground }]}>
              Lv.{summary.level} {summary.level_name}
            </Text>
            <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
              {t("fan.nextLevel", { xp: summary.next_level_xp - summary.total_xp })}
            </Text>
          </View>
          <View style={styles.statsRow}>
            <View style={styles.stat}>
              <Ionicons name="flame" size={16} color={colors.hot} />
              <Text style={[typography.h5, { color: colors.foreground, marginLeft: 4 }]}>
                {summary.streak_days}{t("fanScore.days")}
              </Text>
            </View>
            <View style={styles.stat}>
              <Ionicons name="trophy" size={16} color={colors.warning} />
              <Text style={[typography.h5, { color: colors.foreground, marginLeft: 4 }]}>
                {t("fanScore.topPercent", { n: summary.rank_percentile })}
              </Text>
            </View>
          </View>
        </View>

        {/* XP 프로그레스 */}
        <View style={[styles.progressTrack, { backgroundColor: colors.secondary }]}>
          <View
            style={[
              styles.progressFill,
              { backgroundColor: colors.primary, width: `${Math.min(100, progressPct)}%` },
            ]}
          />
        </View>
        <Text style={[typography.micro, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
          {summary.total_xp} / {summary.next_level_xp} XP
        </Text>
      </View>

      {/* 미션 리스트 */}
      {missions.length > 0 && (
        <View style={styles.missions}>
          <Text style={[typography.h3, { color: colors.foreground, marginBottom: spacing.md }]}>
            {t("fanScore.missions")}
          </Text>
          <View style={styles.missionList}>
            {missions.map((mission) => (
              <MissionCard key={mission.id} mission={mission} onPress={onMissionPress} />
            ))}
          </View>
        </View>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingHorizontal: spacing.xl,
    marginTop: spacing.xxl,
  },
  levelCard: {
    padding: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 1,
  },
  levelHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    marginBottom: spacing.md,
  },
  statsRow: {
    flexDirection: "row",
    gap: spacing.md,
  },
  stat: {
    flexDirection: "row",
    alignItems: "center",
  },
  progressTrack: {
    height: 8,
    borderRadius: 4,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 4,
  },
  missions: {
    marginTop: spacing.xxl,
  },
  missionList: {
    gap: spacing.md,
  },
});
