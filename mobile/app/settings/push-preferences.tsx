/**
 * 푸시 알림 설정
 * 카테고리별 ON/OFF 토글
 */
import { View, Text, Switch, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { useNotificationPreferences, useUpdateNotificationPreferences } from "@/hooks/useNotifications";
import { Skeleton } from "@/components/ui/Skeleton";

type PrefSection = {
  titleKey: string;
  items: { key: string; i18nKey: string; descKey?: string }[];
};

const PREF_SECTIONS: PrefSection[] = [
  {
    titleKey: "notification.section.general",
    items: [
      { key: "push_enabled", i18nKey: "notification.pushEnabled" },
      { key: "email_enabled", i18nKey: "notification.emailEnabled" },
      { key: "sms_enabled", i18nKey: "notification.smsEnabled" },
    ],
  },
  {
    titleKey: "notification.section.types",
    items: [
      { key: "allocation_result", i18nKey: "notification.allocationResult" },
      { key: "payment_reminder", i18nKey: "notification.paymentReminder" },
      { key: "event_update", i18nKey: "notification.eventUpdate" },
      { key: "price_alert", i18nKey: "notification.priceAlert" },
    ],
  },
  {
    titleKey: "notification.section.proactive",
    items: [
      { key: "location_based", i18nKey: "notification.locationBased", descKey: "notification.locationBasedDesc" },
      { key: "price_watch", i18nKey: "notification.priceWatch", descKey: "notification.priceWatchDesc" },
      { key: "weekly_curation", i18nKey: "notification.weeklyCuration", descKey: "notification.weeklyCurationDesc" },
      { key: "friend_activity", i18nKey: "notification.friendActivity", descKey: "notification.friendActivityDesc" },
    ],
  },
  {
    titleKey: "notification.section.marketing",
    items: [
      { key: "marketing", i18nKey: "notification.marketing" },
    ],
  },
];

export default function PushPreferencesScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const { data: prefs, isLoading } = useNotificationPreferences();
  const updatePrefs = useUpdateNotificationPreferences();

  const handleToggle = (key: string, value: boolean) => {
    updatePrefs.mutate({ [key]: value });
  };

  return (
    <SafeAreaView testID="notifications.screen" style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen options={{ title: t("profile.notifications") }} />

      <View style={styles.body}>
        {isLoading ? (
          <View style={{ gap: spacing.md }}>
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} width="100%" height={48} borderRadius={16} />
            ))}
          </View>
        ) : (
          <View style={{ gap: spacing.xl }}>
            {PREF_SECTIONS.map((section) => (
              <View key={section.titleKey}>
                <Text
                  style={[
                    typography.bodySmall,
                    {
                      color: colors.mutedForeground,
                      marginBottom: spacing.sm,
                      marginLeft: spacing.xs,
                      textTransform: "uppercase",
                    },
                  ]}
                >
                  {t(section.titleKey)}
                </Text>
                <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
                  {section.items.map((item, idx) => (
                    <View key={item.key}>
                      {idx > 0 && <View style={[styles.divider, { backgroundColor: colors.border }]} />}
                      <View style={styles.prefRow}>
                        <View style={{ flex: 1, marginRight: spacing.md }}>
                          <Text style={[typography.body, { color: colors.foreground }]}>
                            {t(item.i18nKey)}
                          </Text>
                          {item.descKey ? (
                            <Text
                              style={[
                                typography.bodySmall,
                                { color: colors.mutedForeground, marginTop: 2 },
                              ]}
                            >
                              {t(item.descKey)}
                            </Text>
                          ) : null}
                        </View>
                        <Switch
                          testID={`notification.toggle.${item.key}`}
                          value={prefs?.[item.key as keyof typeof prefs] ?? false}
                          onValueChange={(v) => handleToggle(item.key, v)}
                          trackColor={{ false: colors.muted, true: colors.primary }}
                          accessibilityLabel={t(item.i18nKey)}
                          accessibilityRole="switch"
                        />
                      </View>
                    </View>
                  ))}
                </View>
              </View>
            ))}
          </View>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  body: {
    padding: spacing.xl,
  },
  card: {
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: "hidden",
  },
  prefRow: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  divider: {
    height: 1,
  },
});
