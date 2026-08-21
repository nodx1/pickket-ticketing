/**
 * DICE 스타일 접이식 하단 네비게이션 — 기본은 Home 버튼만 표시,
 * 탭하면 우측으로 슬라이드하며 Search · Me 탭 노출.
 * 스크롤 다운 시 전체 숨김, 스크롤 업 시 다시 등장.
 */
import { useCallback, useEffect, useState } from "react";
import { TouchableOpacity, StyleSheet } from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  withSpring,
  Easing,
  interpolate,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { useScrollDirection } from "@/stores/scrollDirection";
import { useTranslation } from "react-i18next";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";

const PILL_HEIGHT = 48;
const ICON_SIZE = 22;
const COLLAPSED_WIDTH = 52;
const TAB_SLOT_WIDTH = 48;
const PILL_MARGIN = 16;
const SPRING_CONFIG = { damping: 18, stiffness: 200, mass: 0.8 };

const TAB_META: Record<
  string,
  {
    icon: React.ComponentProps<typeof Ionicons>["name"];
    iconFocused: React.ComponentProps<typeof Ionicons>["name"];
  }
> = {
  index: { icon: "flame-outline", iconFocused: "flame" },
  schedule: { icon: "calendar-outline", iconFocused: "calendar" },
  tickets: { icon: "ticket-outline", iconFocused: "ticket" },
  me: { icon: "person-outline", iconFocused: "person" },
};

export function AnimatedTabBar({ state, descriptors, navigation }: BottomTabBarProps) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const direction = useScrollDirection((s) => s.direction);
  const resetDirection = useScrollDirection((s) => s.resetDirection);
  const homeRoute = state.routes.find((route) => route.name === "index") ?? state.routes[0];
  const secondaryRoutes = state.routes.filter((route) => route.key !== homeRoute.key);

  const [expanded, setExpanded] = useState(true);
  const [mounted, setMounted] = useState(false);
  const expandProgress = useSharedValue(1); // 0 = collapsed, 1 = expanded
  const translateY = useSharedValue(0);

  const expandedWidth =
    COLLAPSED_WIDTH + secondaryRoutes.length * TAB_SLOT_WIDTH + PILL_MARGIN;

  // 초기 레이아웃 스크롤 무시 — FlatList 초기 렌더 시 발생하는 스크롤 이벤트 방어
  useEffect(() => {
    const timer = setTimeout(() => setMounted(true), 800);
    return () => clearTimeout(timer);
  }, []);

  // 탭 전환 시 스크롤 상태 리셋 → 탭바 강제 노출
  useEffect(() => {
    resetDirection();
  }, [state.index, resetDirection]);

  // 스크롤 방향에 따라 전체 숨기기
  useEffect(() => {
    if (!mounted) return;
    const hideOffset = PILL_HEIGHT + insets.bottom + 20;
    translateY.value = withTiming(direction === "down" ? hideOffset : 0, {
      duration: 250,
      easing: Easing.bezier(0.25, 0.1, 0.25, 1),
    });
    // 숨길 때 접기, 보일 때 펼치기
    if (direction === "down" && expanded) {
      setExpanded(false);
      expandProgress.value = withSpring(0, SPRING_CONFIG);
    } else if (direction === "up" && !expanded) {
      setExpanded(true);
      expandProgress.value = withSpring(1, SPRING_CONFIG);
    }
  }, [direction, insets.bottom, translateY, expanded, expandProgress, mounted]);

  // expanded 상태 토글 애니메이션
  useEffect(() => {
    expandProgress.value = withSpring(expanded ? 1 : 0, SPRING_CONFIG);
  }, [expanded, expandProgress]);

  const toggleExpand = useCallback(() => {
    setExpanded((prev) => !prev);
  }, []);

  // 다른 탭으로 이동 (expanded 유지 — 스크롤 시 자동 collapse)
  const navigateAndCollapse = useCallback(
    (routeName: string, routeKey: string) => {
      const event = navigation.emit({
        type: "tabPress",
        target: routeKey,
        canPreventDefault: true,
      });
      if (!event.defaultPrevented) {
        navigation.navigate(routeName);
      }
    },
    [navigation],
  );

  // 필 컨테이너 애니메이션
  const pillStyle = useAnimatedStyle(() => {
    const width = interpolate(
      expandProgress.value,
      [0, 1],
      [COLLAPSED_WIDTH, expandedWidth],
    );
    return {
      width,
      transform: [{ translateY: translateY.value }],
    };
  });

  // 개별 탭 아이콘 페이드 + 슬라이드 (동일 애니메이션, 고정 호출)
  const slidingTabStyle = useAnimatedStyle(() => {
    const opacity = interpolate(expandProgress.value, [0.3, 0.7], [0, 1]);
    const translateX = interpolate(expandProgress.value, [0, 1], [-12, 0]);
    return {
      opacity,
      transform: [{ translateX }],
    };
  });

  // Home 토글 버튼 회전
  const homeIconStyle = useAnimatedStyle(() => {
    const rotate = interpolate(expandProgress.value, [0, 1], [0, 180]);
    return {
      transform: [{ rotate: `${rotate}deg` }],
    };
  });

  const isHomeActive = state.routes[state.index]?.key === homeRoute.key;

  return (
    <Animated.View
      style={[
        styles.pill,
        {
          bottom: insets.bottom + 12,
          backgroundColor: colors.glass,
          borderColor: colors.glassBorder,
        },
        pillStyle,
      ]}
    >
      {/* Home / 토글 버튼 */}
      <TouchableOpacity
        testID="tab.index"
        accessibilityRole="button"
        accessibilityLabel={descriptors[homeRoute.key]?.options.title ?? t("tabs.home")}
        accessibilityState={isHomeActive ? { selected: true } : {}}
        onPress={() => {
          if (isHomeActive) {
            toggleExpand();
          } else {
            navigateAndCollapse(homeRoute.name, homeRoute.key);
          }
        }}
        style={styles.homeButton}
      >
        <Animated.View style={homeIconStyle}>
          <Ionicons
            name={expanded ? "chevron-back" : isHomeActive ? "flame" : "flame-outline"}
            size={ICON_SIZE}
            color={isHomeActive ? colors.primary : colors.mutedForeground}
          />
        </Animated.View>
      </TouchableOpacity>

      {/* 슬라이딩 탭들 */}
      {secondaryRoutes.map((route) => {
        const meta = TAB_META[route.name];
        if (!meta) return null;
        const isFocused = state.routes[state.index]?.key === route.key;

        return (
          <Animated.View key={route.key} style={[styles.tabSlot, slidingTabStyle]}>
            <TouchableOpacity
              testID={`tab.${route.name}`}
              accessibilityRole="button"
              accessibilityLabel={descriptors[route.key]?.options.title ?? t(`tabs.${route.name}`, { defaultValue: route.name })}
              accessibilityState={isFocused ? { selected: true } : {}}
              onPress={() => navigateAndCollapse(route.name, route.key)}
              style={styles.tabTouch}
              hitSlop={8}
            >
              <Ionicons
                name={isFocused ? meta.iconFocused : meta.icon}
                size={ICON_SIZE}
                color={isFocused ? colors.primary : colors.mutedForeground}
              />
            </TouchableOpacity>
          </Animated.View>
        );
      })}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: "absolute",
    left: PILL_MARGIN,
    height: PILL_HEIGHT,
    borderRadius: PILL_HEIGHT / 2,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 4,
    overflow: "hidden",
    // 그림자
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
  homeButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
  },
  tabSlot: {
    width: TAB_SLOT_WIDTH,
    height: PILL_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
  },
  tabTouch: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 22,
  },
});
