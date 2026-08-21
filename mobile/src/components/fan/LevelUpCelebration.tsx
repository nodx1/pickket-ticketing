/**
 * 레벨업 축하 오버레이 — 컨페티 + 바운스 뱃지 + 자동 dismiss
 */
import { useEffect, useMemo } from "react";
import {  Text, StyleSheet, Dimensions } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withDelay,
  withSequence,
  withSpring,
  FadeIn,
  FadeOut,
  
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { useTranslation } from "react-i18next";
import { typography } from "@/config/theme";
import { getLevelInfo } from "@/types/fan";

interface LevelUpCelebrationProps {
  level: number;
  visible: boolean;
  onDismiss: () => void;
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get("window");
const CONFETTI_COUNT = 40;

// ── Confetti Particle ──
function ConfettiParticle({ color, delay }: { color: string; delay: number }) {
  const translateY = useSharedValue(-20);
  const translateX = useSharedValue(0);
  const opacity = useSharedValue(1);
  const startX = useMemo(() => Math.random() * SCREEN_W, []);
  const size = useMemo(() => 4 + Math.random() * 6, []);
  const drift = useMemo(() => (Math.random() - 0.5) * 80, []);

  useEffect(() => {
    translateY.value = withDelay(
      delay,
      withTiming(SCREEN_H + 40, { duration: 2000 + Math.random() * 1500 }),
    );
    translateX.value = withDelay(
      delay,
      withTiming(drift, { duration: 2000 + Math.random() * 1500 }),
    );
    opacity.value = withDelay(delay + 1800, withTiming(0, { duration: 600 }));
  }, [delay, drift, translateY, translateX, opacity]);

  const style = useAnimatedStyle(() => ({
    transform: [
      { translateY: translateY.value },
      { translateX: translateX.value },
    ],
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={[
        {
          position: "absolute",
          left: startX,
          top: -10,
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: color,
        },
        style,
      ]}
    />
  );
}

export function LevelUpCelebration({
  level,
  visible,
  onDismiss,
}: LevelUpCelebrationProps) {
  const { t } = useTranslation();
  const levelInfo = getLevelInfo(level);
  const badgeScale = useSharedValue(0);

  // 컨페티 색상
  const confettiColors = useMemo(
    () => [levelInfo.color, "#FFD700", "#FFFFFF", "#FF6B6B", "#4ECDC4"],
    [levelInfo.color],
  );

  // 컨페티 파티클 데이터
  const particles = useMemo(
    () =>
      Array.from({ length: CONFETTI_COUNT }).map((_, i) => ({
        id: i,
        color: confettiColors[i % confettiColors.length],
        delay: Math.random() * 600,
      })),
    [confettiColors],
  );

  useEffect(() => {
    if (!visible) return;

    // 햅틱 피드백
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

    // 뱃지 바운스 인
    badgeScale.value = withSequence(
      withTiming(0, { duration: 0 }),
      withSpring(1.15, { damping: 8, stiffness: 200 }),
      withSpring(1, { damping: 12 }),
    );

    // 3초 후 자동 dismiss
    const timer = setTimeout(() => {
      onDismiss();
    }, 3000);

    return () => clearTimeout(timer);
  }, [visible, badgeScale, onDismiss]);

  const badgeStyle = useAnimatedStyle(() => ({
    transform: [{ scale: badgeScale.value }],
  }));

  if (!visible) return null;

  return (
    <Animated.View
      entering={FadeIn.duration(300)}
      exiting={FadeOut.duration(400)}
      style={styles.overlay}
      pointerEvents="auto"
    >
      {/* 컨페티 */}
      {particles.map((p) => (
        <ConfettiParticle key={p.id} color={p.color} delay={p.delay} />
      ))}

      {/* 중앙 뱃지 */}
      <Animated.View style={[styles.badgeContainer, badgeStyle]}>
        <Text style={styles.badgeIcon}>{levelInfo.icon}</Text>
        <Text style={[typography.h2, { color: "#FFFFFF", marginTop: 12 }]}>
          {levelInfo.name}
        </Text>
        <Text
          style={[
            typography.h3,
            { color: levelInfo.color, marginTop: 4 },
          ]}
        >
          {t("fan.levelUp")}
        </Text>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.7)",
    justifyContent: "center",
    alignItems: "center",
    zIndex: 9999,
  },
  badgeContainer: {
    alignItems: "center",
    justifyContent: "center",
  },
  badgeIcon: {
    fontSize: 64,
  },
});
