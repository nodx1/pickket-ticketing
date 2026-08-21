/**
 * Pick Celebration — XP 토스트 + 넘버 공개 연출
 * 픽 생성 성공 후 표시되는 셀레브레이션 오버레이
 */
import { useCallback, useEffect } from "react";
import { View, Text, StyleSheet } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  withSequence,
  withSpring,
  runOnJS,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { spacing, radius } from "@/config/theme";

interface PickCelebrationProps {
  sequenceNumber?: number;
  visible: boolean;
  onDismiss: () => void;
}

const DISPLAY_MS = 2500;

export function PickCelebration({ sequenceNumber, visible, onDismiss }: PickCelebrationProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  const translateY = useSharedValue(-120);
  const opacity = useSharedValue(0);
  const scale = useSharedValue(0.8);

  const dismiss = useCallback(() => {
    onDismiss();
  }, [onDismiss]);

  useEffect(() => {
    if (visible) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      translateY.value = withSpring(0, { damping: 14 });
      opacity.value = withTiming(1, { duration: 250 });
      scale.value = withSequence(
        withSpring(1.05, { damping: 10 }),
        withSpring(1, { damping: 14 }),
      );

      // 자동 사라짐
      translateY.value = withDelay(
        DISPLAY_MS,
        withTiming(-120, { duration: 300 }),
      );
      opacity.value = withDelay(
        DISPLAY_MS,
        withTiming(0, { duration: 300 }, () => {
          runOnJS(dismiss)();
        }),
      );
    } else {
      translateY.value = -120;
      opacity.value = 0;
      scale.value = 0.8;
    }
  }, [visible, translateY, opacity, scale, dismiss]);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }, { scale: scale.value }],
    opacity: opacity.value,
  }));

  if (!visible) return null;

  return (
    <Animated.View style={[styles.container, animatedStyle]}>
      <View style={[styles.toast, { backgroundColor: colors.primary }]}>
        <Ionicons name="sparkles" size={20} color={colors.primaryForeground} />
        <View style={styles.textWrap}>
          <Text style={[styles.title, { color: colors.primaryForeground }]}>
            {t("picks.xpEarned")}
          </Text>
          {sequenceNumber != null && (
            <Text style={[styles.subtitle, { color: colors.primaryForeground + "CC" }]}>
              #{sequenceNumber}{t("picks.sequenceLabel")}
            </Text>
          )}
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 60,
    left: spacing.xl,
    right: spacing.xl,
    zIndex: 100,
    alignItems: "center",
  },
  toast: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    borderRadius: radius.full,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.2,
    shadowRadius: 12,
    elevation: 8,
  },
  textWrap: { gap: 2 },
  title: { fontSize: 15, fontWeight: "700" },
  subtitle: { fontSize: 12, fontWeight: "600" },
});
