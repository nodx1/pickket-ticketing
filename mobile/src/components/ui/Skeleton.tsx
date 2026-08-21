import { useEffect } from "react";
import { StyleSheet, View, type ViewStyle } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withTiming,
  interpolate,
  Easing,
} from "react-native-reanimated";
import { LinearGradient } from "expo-linear-gradient";
import { useTheme } from "@/hooks/useTheme";
import { radius } from "@/config/theme";

interface Props {
  width: number | string;
  height: number;
  borderRadius?: number;
  style?: ViewStyle;
}

const SHIMMER_DURATION = 1200;

/**
 * Reanimated 기반 시머 스켈레톤 로더
 * LinearGradient가 좌→우로 반복 스윕하는 효과
 */
export function Skeleton({
  width,
  height,
  borderRadius = radius.sm,
  style,
}: Props) {
  const { colors } = useTheme();
  const progress = useSharedValue(0);

  useEffect(() => {
    progress.value = withRepeat(
      withTiming(1, { duration: SHIMMER_DURATION, easing: Easing.linear }),
      -1, // 무한 반복
      false, // 역방향 없이 0→1 반복
    );
  }, [progress]);

  // 시머 너비 계산 — 문자열 width일 경우 기본값 사용
  const numericWidth = typeof width === "number" ? width : 200;

  const animatedStyle = useAnimatedStyle(() => {
    const translateX = interpolate(
      progress.value,
      [0, 1],
      [-numericWidth, numericWidth],
    );
    return {
      transform: [{ translateX }],
    };
  });

  return (
    <View
      style={[
        styles.container,
        {
          width: width as number,
          height,
          borderRadius,
          backgroundColor: colors.muted,
        },
        style,
      ]}
    >
      <Animated.View style={[styles.shimmerWrapper, animatedStyle]}>
        <LinearGradient
          colors={[
            "transparent",
            "rgba(255, 255, 255, 0.15)",
            "transparent",
          ]}
          start={{ x: 0, y: 0.5 }}
          end={{ x: 1, y: 0.5 }}
          style={styles.shimmerGradient}
        />
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    overflow: "hidden",
  },
  shimmerWrapper: {
    ...StyleSheet.absoluteFillObject,
  },
  shimmerGradient: {
    flex: 1,
  },
});
