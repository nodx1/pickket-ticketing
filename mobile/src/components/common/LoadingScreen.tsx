/**
 * LoadingScreen — "Ticket Pulse" 브랜드 로딩 화면
 *
 * Phase 1: 로고 scale-in + 글로우 페이드
 * Phase 2: 글로우 pulse + 태그라인 페이드인
 * Phase 3: 앱 준비 완료 시 전체 fade-out
 */
import { useEffect } from "react";
import { View, Text, StyleSheet } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  withTiming,
  withRepeat,
  withSequence,
  withDelay,
  Easing,
  runOnJS,
} from "react-native-reanimated";
import { Image } from "expo-image";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing } from "@/config/theme";
import { useTranslation } from "react-i18next";

const LOGO_SIZE = 72;
const GLOW_SIZE = 160;

interface Props {
  message?: string;
  /** true → 퇴장 애니메이션 실행 후 onExitComplete 호출 */
  exiting?: boolean;
  onExitComplete?: () => void;
}

export function LoadingScreen({ message, exiting, onExitComplete }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  // --- shared values ---
  const logoScale = useSharedValue(0.8);
  const logoOpacity = useSharedValue(0);
  const glowOpacity = useSharedValue(0);
  const glowScale = useSharedValue(1);
  const taglineOpacity = useSharedValue(0);
  const taglineTranslateY = useSharedValue(12);
  const screenOpacity = useSharedValue(1);

  // --- entry animation ---
  useEffect(() => {
    // Phase 1: 로고 등장 (0~600ms)
    logoOpacity.value = withTiming(1, { duration: 400 });
    logoScale.value = withSpring(1, { damping: 14, stiffness: 120 });
    glowOpacity.value = withDelay(200, withTiming(0.18, { duration: 500 }));

    // Phase 2: 글로우 pulse + 태그라인 (600ms~)
    glowScale.value = withDelay(
      600,
      withRepeat(
        withSequence(
          withTiming(1.15, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
          withTiming(1.0, { duration: 1200, easing: Easing.inOut(Easing.ease) }),
        ),
        -1,
        true,
      ),
    );
    taglineOpacity.value = withDelay(700, withTiming(1, { duration: 500 }));
    taglineTranslateY.value = withDelay(700, withSpring(0, { damping: 16 }));
  }, []);

  // --- exit animation ---
  useEffect(() => {
    if (!exiting) return;

    logoScale.value = withTiming(1.1, { duration: 250 });
    logoOpacity.value = withDelay(100, withTiming(0, { duration: 250 }));
    glowOpacity.value = withTiming(0, { duration: 200 });
    taglineOpacity.value = withTiming(0, { duration: 150 });

    screenOpacity.value = withDelay(
      150,
      withTiming(0, { duration: 300 }, (finished) => {
        if (finished && onExitComplete) {
          runOnJS(onExitComplete)();
        }
      }),
    );
  }, [exiting]);

  // --- animated styles ---
  const screenStyle = useAnimatedStyle(() => ({
    opacity: screenOpacity.value,
  }));

  const logoStyle = useAnimatedStyle(() => ({
    opacity: logoOpacity.value,
    transform: [{ scale: logoScale.value }],
  }));

  const glowStyle = useAnimatedStyle(() => ({
    opacity: glowOpacity.value,
    transform: [{ scale: glowScale.value }],
  }));

  const taglineStyle = useAnimatedStyle(() => ({
    opacity: taglineOpacity.value,
    transform: [{ translateY: taglineTranslateY.value }],
  }));

  return (
    <Animated.View style={[styles.container, exiting && styles.overlay, { backgroundColor: colors.background }, screenStyle]}>
      <View style={styles.logoArea}>
        {/* 글로우 링 */}
        <Animated.View
          style={[
            styles.glow,
            { backgroundColor: colors.primary },
            glowStyle,
          ]}
        />

        {/* P 로고 */}
        <Animated.View style={logoStyle}>
          <Image
            source={require("../../../assets/splash-icon.png")}
            style={styles.logo}
            contentFit="contain"
          />
        </Animated.View>
      </View>

      {/* 태그라인 */}
      <Animated.View style={[styles.taglineWrap, taglineStyle]}>
        <Text style={[typography.h3, { color: colors.foreground }]}>
          Pickket
        </Text>
        <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
          {t("home.tagline")}
        </Text>
      </Animated.View>

      {/* 커스텀 메시지 (업데이트 필요 등) */}
      {message && (
        <Text style={[typography.body, { color: colors.mutedForeground, marginTop: spacing.xl }]}>
          {message}
        </Text>
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
  },
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 999,
  },
  logoArea: {
    width: GLOW_SIZE,
    height: GLOW_SIZE,
    justifyContent: "center",
    alignItems: "center",
  },
  glow: {
    position: "absolute",
    width: GLOW_SIZE,
    height: GLOW_SIZE,
    borderRadius: GLOW_SIZE / 2,
  },
  logo: {
    width: LOGO_SIZE,
    height: LOGO_SIZE,
  },
  taglineWrap: {
    alignItems: "center",
    marginTop: spacing.xl,
  },
});
