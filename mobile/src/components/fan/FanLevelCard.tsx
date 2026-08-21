/**
 * 팬 레벨 카드 — 레벨 뱃지 + XP 프로그레스 바 + 5축 레이더 차트 + 최근 XP
 */
import { useEffect } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
} from "react-native-reanimated";
import Svg, { Polygon, Circle, Line, Text as SvgText } from "react-native-svg";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import type { FanProfile } from "@/types/fan";
import { getLevelInfo, FAN_LEVELS } from "@/types/fan";

interface FanLevelCardProps {
  profile: FanProfile;
  compact?: boolean;
  onPress?: () => void;
}

// ── 레이더 차트 계산 ──
const RADAR_SIZE = 160;
const RADAR_CENTER = RADAR_SIZE / 2;
const RADAR_RADIUS = 56;
const AXIS_COUNT = 5;

function polarToXY(angle: number, r: number): [number, number] {
  // 상단(12시)부터 시작하도록 -90도 오프셋
  const rad = ((angle - 90) * Math.PI) / 180;
  return [RADAR_CENTER + r * Math.cos(rad), RADAR_CENTER + r * Math.sin(rad)];
}

function RadarChart({
  dimensions,
  levelColor,
  colors,
}: {
  dimensions: FanProfile["dimensions"];
  levelColor: string;
  colors: Record<string, string>;
}) {
  const { t } = useTranslation();
  const axes = [
    { key: "loyalty" as const, label: t("fan.loyalty") },
    { key: "history" as const, label: t("fan.history") },
    { key: "fanclub" as const, label: t("fan.fanclub") },
    { key: "engagement" as const, label: t("fan.engagement") },
    { key: "behavior" as const, label: t("fan.behavior") },
  ];

  // 배경 그리드 (3단계)
  const gridLevels = [0.33, 0.66, 1.0];

  // 데이터 포인트
  const dataPoints = axes
    .map((axis, i) => {
      const value = dimensions[axis.key] / 100;
      const angle = (360 / AXIS_COUNT) * i;
      return polarToXY(angle, RADAR_RADIUS * value);
    })
    .map(([x, y]) => `${x},${y}`)
    .join(" ");

  return (
    <View style={radarStyles.container}>
      <Svg width={RADAR_SIZE} height={RADAR_SIZE}>
        {/* 배경 그리드 */}
        {gridLevels.map((level) => {
          const points = Array.from({ length: AXIS_COUNT })
            .map((_, i) => {
              const angle = (360 / AXIS_COUNT) * i;
              return polarToXY(angle, RADAR_RADIUS * level);
            })
            .map(([x, y]) => `${x},${y}`)
            .join(" ");
          return (
            <Polygon
              key={level}
              points={points}
              fill="none"
              stroke={colors.border}
              strokeWidth={0.8}
              opacity={0.5}
            />
          );
        })}

        {/* 축 라인 */}
        {axes.map((_, i) => {
          const angle = (360 / AXIS_COUNT) * i;
          const [x, y] = polarToXY(angle, RADAR_RADIUS);
          return (
            <Line
              key={i}
              x1={RADAR_CENTER}
              y1={RADAR_CENTER}
              x2={x}
              y2={y}
              stroke={colors.border}
              strokeWidth={0.6}
              opacity={0.4}
            />
          );
        })}

        {/* 데이터 영역 */}
        <Polygon
          points={dataPoints}
          fill={levelColor}
          fillOpacity={0.2}
          stroke={levelColor}
          strokeWidth={1.5}
        />

        {/* 데이터 꼭짓점 */}
        {axes.map((axis, i) => {
          const value = dimensions[axis.key] / 100;
          const angle = (360 / AXIS_COUNT) * i;
          const [cx, cy] = polarToXY(angle, RADAR_RADIUS * value);
          return <Circle key={i} cx={cx} cy={cy} r={3} fill={levelColor} />;
        })}

        {/* 축 라벨 */}
        {axes.map((axis, i) => {
          const angle = (360 / AXIS_COUNT) * i;
          const [x, y] = polarToXY(angle, RADAR_RADIUS + 18);
          return (
            <SvgText
              key={i}
              x={x}
              y={y}
              fontSize={10}
              fill={colors.mutedForeground}
              textAnchor="middle"
              alignmentBaseline="central"
            >
              {axis.label}
            </SvgText>
          );
        })}
      </Svg>
    </View>
  );
}

export function FanLevelCard({ profile, compact, onPress }: FanLevelCardProps) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const levelInfo = getLevelInfo(profile.level);
  const nextLevel = FAN_LEVELS.find((l) => l.level === profile.level + 1);
  const remaining = profile.maxXp - profile.xp;

  // XP 프로그레스 바 애니메이션
  const progress = useSharedValue(0);
  const targetProgress = profile.maxXp > 0 ? profile.xp / profile.maxXp : 0;

  useEffect(() => {
    progress.value = withSpring(targetProgress, {
      damping: 18,
      stiffness: 90,
    });
  }, [targetProgress, progress]);

  const progressStyle = useAnimatedStyle(() => ({
    width: `${Math.min(progress.value * 100, 100)}%`,
  }));

  const showFanclubTip =
    profile.dimensions.fanclub < 50;

  return (
    <TouchableOpacity
      activeOpacity={onPress ? 0.7 : 1}
      onPress={onPress}
      style={[
        cardStyles.card,
        { backgroundColor: colors.card, borderColor: colors.border },
      ]}
      accessibilityLabel={t("fan.level")}
      accessibilityRole="button"
    >
      {/* 레벨 뱃지 */}
      <View style={cardStyles.levelRow}>
        <Text style={cardStyles.levelIcon}>{levelInfo.icon}</Text>
        <View style={cardStyles.levelTextWrap}>
          <Text style={[typography.h3, { color: levelInfo.color }]}>
            {levelInfo.name} Lv.{profile.level}
          </Text>
          <Text
            style={[
              typography.micro,
              { color: colors.mutedForeground, marginTop: 2 },
            ]}
          >
            {t("fan.level")}
          </Text>
        </View>
      </View>

      {/* XP 프로그레스 바 */}
      <View style={cardStyles.progressSection}>
        <View
          style={[
            cardStyles.progressTrack,
            { backgroundColor: colors.border },
          ]}
        >
          <Animated.View
            style={[
              cardStyles.progressFill,
              { backgroundColor: levelInfo.color },
              progressStyle,
            ]}
          />
        </View>
        <Text
          style={[
            typography.micro,
            { color: colors.mutedForeground, marginTop: spacing.xs },
          ]}
        >
          {profile.xp} / {profile.maxXp} XP
        </Text>
        {nextLevel && (
          <Text
            style={[
              typography.micro,
              { color: levelInfo.color, marginTop: 2 },
            ]}
          >
            {t("fan.nextLevel", { xp: remaining })}
          </Text>
        )}
      </View>

      {/* 레이더 차트 (compact 시 숨김) */}
      {!compact && (
        <RadarChart
          dimensions={profile.dimensions}
          levelColor={levelInfo.color}
          colors={colors}
        />
      )}

      {/* 팬클럽 팁 (compact 시 숨김) */}
      {!compact && showFanclubTip && (
        <View
          style={[
            cardStyles.tipBanner,
            { backgroundColor: `${levelInfo.color}15` },
          ]}
        >
          <Text style={[typography.micro, { color: levelInfo.color }]}>
            💡 {t("fan.fanclub")} 인증하면 +20XP
          </Text>
        </View>
      )}

      {/* 최근 XP 히스토리 (compact 시 숨김) */}
      {!compact && profile.recentXpEvents.length > 0 && (
        <View style={cardStyles.recentSection}>
          <Text
            style={[
              typography.bodySmall,
              {
                color: colors.foreground,
                fontWeight: "600",
                marginBottom: spacing.xs,
              },
            ]}
          >
            {t("fan.recentXp")}
          </Text>
          {profile.recentXpEvents.slice(0, 3).map((ev, idx) => (
            <View key={idx} style={cardStyles.xpRow}>
              <Text
                style={[typography.micro, { color: colors.mutedForeground, flex: 1 }]}
                numberOfLines={1}
              >
                {ev.description}
              </Text>
              <Text
                style={[
                  typography.micro,
                  { color: levelInfo.color, fontWeight: "600" },
                ]}
              >
                +{ev.xp}XP
              </Text>
            </View>
          ))}
        </View>
      )}
    </TouchableOpacity>
  );
}

const cardStyles = StyleSheet.create({
  card: {
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
  },
  levelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  levelIcon: {
    fontSize: 32,
  },
  levelTextWrap: {
    flex: 1,
  },
  progressSection: {
    marginTop: spacing.md,
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
  tipBanner: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.sm,
    alignItems: "center",
    marginTop: spacing.md,
  },
  recentSection: {
    marginTop: spacing.md,
  },
  xpRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    paddingVertical: 4,
  },
});

const radarStyles = StyleSheet.create({
  container: {
    alignItems: "center",
    marginTop: spacing.md,
  },
});
