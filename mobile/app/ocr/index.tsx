/**
 * OCR 티켓 임포트 화면
 * 피처플래그: OCR_IMPORT
 */
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Stack } from "expo-router";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { typography, spacing, radius } from "@/config/theme";
import { isFeatureEnabled } from "@/config/features";
import { EmptyState } from "@/components/common/EmptyState";
import * as haptics from "@/lib/haptics";

export default function OcrScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();

  if (!isFeatureEnabled("OCR_IMPORT")) {
    return (
      <SafeAreaView testID="ocr.screen" style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: t("ocr.title"), headerShown: true }} />
        <EmptyState testID="ocr.comingSoon" icon="scan-outline" title={t("ocr.comingSoon")} message={t("ocr.comingSoonDesc")} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: t("ocr.title"), headerShown: true }} />

      <View style={styles.content}>
        <Ionicons name="camera-outline" size={64} color={colors.mutedForeground} />
        <Text style={[typography.h2, { color: colors.foreground, marginTop: spacing.xl }]}>
          {t("ocr.scanTitle")}
        </Text>
        <Text style={[typography.body, { color: colors.mutedForeground, textAlign: "center", marginTop: spacing.sm }]}>
          {t("ocr.scanDesc")}
        </Text>

        <TouchableOpacity
          onPress={() => haptics.impactFeedback()}
          style={[styles.scanBtn, { backgroundColor: colors.primary }]}
          accessibilityRole="button"
        >
          <Ionicons name="scan" size={20} color={colors.primaryForeground} />
          <Text style={[typography.h4, { color: colors.primaryForeground, marginLeft: spacing.sm }]}>
            {t("ocr.startScan")}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
  },
  scanBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: 52,
    paddingHorizontal: spacing.xxl,
    borderRadius: radius.xl,
    marginTop: spacing.xxl,
  },
});
