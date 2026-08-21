/**
 * MissionCard — 개별 미션 카드
 * 디자인 정책: radius.xl(16), 44pt 터치, spring 애니메이션
 * 피처플래그: FAN_SCORE_MISSIONS
 */
import { TouchableOpacity, View, Text, StyleSheet } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import * as haptics from "@/lib/haptics";
import type { Mission } from "@/types/mission";

interface Props {
  mission: Mission;
  onPress?: (mission: Mission) => void;
}

export function MissionCard({ mission, onPress }: Props) {
  const { colors } = useTheme();
  ;
  const isCompleted = mission.status === "completed";
  const progressPct = Math.min(100, Math.round((mission.current / mission.target) * 100));

  const handlePress = () => {
    if (!isCompleted && onPress) {
      haptics.lightImpact();
      onPress(mission);
    }
  };

  return (
    <Animated.View entering={FadeIn.springify()}>
      <TouchableOpacity
        onPress={handlePress}
        disabled={isCompleted}
        style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
        activeOpacity={0.7}
        accessibilityRole="button"
      >
        {/* 아이콘 */}
        <View style={[styles.iconBox, { backgroundColor: isCompleted ? colors.success + "20" : colors.secondary }]}>
          <Ionicons
            name={mission.icon as React.ComponentProps<typeof Ionicons>["name"]}
            size={22}
            color={isCompleted ? colors.success : colors.primary}
          />
        </View>

        {/* 내용 */}
        <View style={styles.content}>
          <Text style={[typography.h5, { color: colors.foreground }]} numberOfLines={1}>
            {mission.title}
          </Text>
          <Text style={[typography.bodySmall, { color: colors.mutedForeground }]} numberOfLines={1}>
            {mission.description}
          </Text>

          {/* 프로그레스 바 */}
          {!isCompleted && (
            <View style={[styles.progressTrack, { backgroundColor: colors.secondary }]}>
              <View
                style={[
                  styles.progressFill,
                  {
                    backgroundColor: colors.primary,
                    width: `${progressPct}%`,
                  },
                ]}
              />
            </View>
          )}
        </View>

        {/* XP 보상 */}
        <View style={styles.reward}>
          {isCompleted ? (
            <Ionicons name="checkmark-circle" size={24} color={colors.success} />
          ) : (
            <Text style={[typography.h5, { color: colors.primary }]}>
              +{mission.xp_reward}XP
            </Text>
          )}
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
    minHeight: 72,
  },
  iconBox: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    marginRight: spacing.md,
  },
  content: {
    flex: 1,
    marginRight: spacing.sm,
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    marginTop: spacing.xs,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 2,
  },
  reward: {
    alignItems: "flex-end",
    minWidth: 60,
  },
});
