/**
 * 챗 FAB — 하단 우측 플로팅 버튼, AI 챗 진입점
 * 피처플래그 CHAT_FAB로 제어
 */
import { TouchableOpacity, StyleSheet } from "react-native";
import Animated, { FadeIn, FadeOut } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { isFeatureEnabled } from "@/config/features";
import * as haptics from "@/lib/haptics";

const FAB_SIZE = 56;

export function ChatFAB() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  if (!isFeatureEnabled("CHAT_FAB")) return null;

  const handlePress = () => {
    haptics.impactFeedback();
    router.push("/discover/chat");
  };

  return (
    <Animated.View
      entering={FadeIn.springify().damping(18)}
      exiting={FadeOut.duration(150)}
      style={[
        styles.container,
        { bottom: insets.bottom + 80, right: 16 },
      ]}
    >
      <TouchableOpacity
        testID="chat.fab"
        onPress={handlePress}
        style={[styles.fab, { backgroundColor: colors.primary }]}
        activeOpacity={0.8}
        accessibilityRole="button"
        accessibilityLabel={t("discover.aiChat")}
      >
        <Ionicons name="chatbubble-ellipses" size={24} color={colors.primaryForeground} />
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    zIndex: 100,
  },
  fab: {
    width: FAB_SIZE,
    height: FAB_SIZE,
    borderRadius: FAB_SIZE / 2,
    alignItems: "center",
    justifyContent: "center",
    // 그림자
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 8,
  },
});
