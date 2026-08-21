/**
 * 개인정보처리방침 (WebView)
 */
import { StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack } from "expo-router";
import { WebView } from "react-native-webview";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";

export default function PrivacyScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();

  return (
    <SafeAreaView testID="legal.privacy.screen" style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen options={{ title: t("profile.privacy") }} />
      <WebView
        source={{ uri: "https://pickket.kr/privacy" }}
        style={styles.webview}
        startInLoadingState
        javaScriptEnabled={false}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1 },
});
