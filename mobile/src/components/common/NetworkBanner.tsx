import { useEffect, useState } from "react";
import { Text, StyleSheet, Animated } from "react-native";
import NetInfo from "@react-native-community/netinfo";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { spacing, typography } from "@/config/theme";

/**
 * 네트워크 오프라인 감지 → 상단 배너 표시
 * AppProviders 안, Navigation 위에 배치
 */
export function NetworkBanner() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [isOffline, setIsOffline] = useState(false);
  const [slideAnim] = useState(() => new Animated.Value(-40));

  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const offline = !(state.isConnected && state.isInternetReachable !== false);
      setIsOffline(offline);
    });
    return () => unsubscribe();
  }, []);

  useEffect(() => {
    Animated.timing(slideAnim, {
      toValue: isOffline ? 0 : -40,
      duration: 300,
      useNativeDriver: true,
    }).start();
  }, [isOffline, slideAnim]);

  return (
    <Animated.View
      style={[
        styles.banner,
        {
          backgroundColor: colors.destructive,
          transform: [{ translateY: slideAnim }],
        },
      ]}
      pointerEvents={isOffline ? "auto" : "none"}
    >
      <Text style={styles.text}>{t("common.offline")}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  banner: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 40,
    justifyContent: "center",
    alignItems: "center",
    zIndex: 1000,
    paddingHorizontal: spacing.lg,
  },
  text: {
    ...typography.bodySmall,
    color: "#FFFFFF",
    fontWeight: "600",
  },
});
