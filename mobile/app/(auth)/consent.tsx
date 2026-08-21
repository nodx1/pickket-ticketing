/**
 * 약관/개인정보 동의 화면
 *
 * 첫 가입/로그인 후 표시. 필수 약관 동의 없이는 앱 사용 불가.
 * 선택 항목: 분석/마케팅 동의
 */
import { useState, useCallback } from "react";
import { View, Text, TouchableOpacity, StyleSheet, ScrollView, Alert } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { storage } from "@/lib/storage";
import { Button } from "@/components/ui/Button";

interface CheckItem {
  key: string;
  labelKey: string;
  required: boolean;
  linkTo?: string;
}

const CONSENT_ITEMS: CheckItem[] = [
  { key: "terms", labelKey: "consent.termsLabel", required: true, linkTo: "/legal/terms" },
  { key: "privacy", labelKey: "consent.privacyLabel", required: true, linkTo: "/legal/privacy" },
  { key: "analytics", labelKey: "consent.analyticsLabel", required: false },
];

export default function ConsentScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();

  const [checked, setChecked] = useState<Record<string, boolean>>({});

  const allRequiredChecked = CONSENT_ITEMS
    .filter((item) => item.required)
    .every((item) => checked[item.key]);

  const toggleAll = useCallback(() => {
    const allChecked = CONSENT_ITEMS.every((item) => checked[item.key]);
    const next: Record<string, boolean> = {};
    for (const item of CONSENT_ITEMS) {
      next[item.key] = !allChecked;
    }
    setChecked(next);
  }, [checked]);

  const toggle = useCallback((key: string) => {
    setChecked((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);

  const handleSubmit = useCallback(async () => {
    try {
      await storage.set("consent_accepted", "true");
      await storage.set("consent_accepted_at", new Date().toISOString());
      await storage.set("analytics_consent", checked.analytics ? "true" : "false");
      router.replace("/(auth)/onboarding");
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
      Alert.alert(t("common.error"), t("common.serverError"));
    }
  }, [checked, router, t]);

  return (
    <SafeAreaView testID="consent.screen" style={[styles.container, { backgroundColor: colors.background }]}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={[typography.h2, { color: colors.foreground, marginBottom: spacing.sm }]}>
          {t("consent.title")}
        </Text>
        <Text style={[typography.body, { color: colors.mutedForeground, marginBottom: spacing.xl }]}>
          {t("consent.subtitle")}
        </Text>

        {/* 전체 동의 */}
        <TouchableOpacity
          testID="consent.toggleAll"
          style={[styles.checkRow, { borderColor: colors.border, backgroundColor: colors.surface }]}
          onPress={toggleAll}
          accessibilityRole="checkbox"
        >
          <View style={[styles.checkbox, {
            borderColor: CONSENT_ITEMS.every((i) => checked[i.key]) ? colors.primary : colors.border,
            backgroundColor: CONSENT_ITEMS.every((i) => checked[i.key]) ? colors.primary : "transparent",
          }]}>
            {CONSENT_ITEMS.every((i) => checked[i.key]) && (
              <Text style={{ color: colors.primaryForeground, fontSize: 12 }}>✓</Text>
            )}
          </View>
          <Text style={[typography.h4, { color: colors.foreground, flex: 1 }]}>
            {t("consent.agreeAll")}
          </Text>
        </TouchableOpacity>

        <View style={[styles.divider, { backgroundColor: colors.border }]} />

        {/* 개별 항목 */}
        {CONSENT_ITEMS.map((item) => (
          <TouchableOpacity
            key={item.key}
            style={styles.itemRow}
            onPress={() => toggle(item.key)}
            accessibilityRole="checkbox"
            accessibilityState={{ checked: !!checked[item.key] }}
          >
            <View style={[styles.checkbox, {
              borderColor: checked[item.key] ? colors.primary : colors.border,
              backgroundColor: checked[item.key] ? colors.primary : "transparent",
            }]}>
              {checked[item.key] && (
                <Text style={{ color: colors.primaryForeground, fontSize: 12 }}>✓</Text>
              )}
            </View>
            <Text style={[typography.body, { color: colors.foreground, flex: 1 }]}>
              {item.required ? `[${t("consent.required")}] ` : `[${t("consent.optional")}] `}
              {t(item.labelKey)}
            </Text>
            {item.linkTo && (
              <TouchableOpacity
                onPress={() => router.push(item.linkTo as never)}
                hitSlop={8}
              >
                <Text style={[typography.bodySmall, { color: colors.primary }]}>
                  {t("consent.view")}
                </Text>
              </TouchableOpacity>
            )}
          </TouchableOpacity>
        ))}
      </ScrollView>

      <View style={[styles.footer, { borderTopColor: colors.border }]}>
        <Button
          testID="consent.submit"
          title={t("consent.submit")}
          onPress={handleSubmit}
          disabled={!allRequiredChecked}
          size="xl"
          style={{ width: "100%" }}
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    padding: spacing.xl,
    paddingTop: spacing.xxl * 2,
  },
  checkRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.md,
  },
  itemRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingVertical: spacing.md,
    gap: spacing.md,
  },
  checkbox: {
    width: 22,
    height: 22,
    borderRadius: 4,
    borderWidth: 2,
    alignItems: "center",
    justifyContent: "center",
  },
  divider: {
    height: 1,
    marginVertical: spacing.lg,
  },
  footer: {
    padding: spacing.xl,
    borderTopWidth: 1,
  },
});
