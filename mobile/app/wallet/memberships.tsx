/**
 * Phase F.2 — 멤버십 상세 리스트 (Fanclub 재매핑)
 */
import { View, Text, ScrollView, StyleSheet, Image } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { useMyFanclubs } from "@/hooks/useFanclubs";
import { Skeleton } from "@/components/ui/Skeleton";
import i18n from "@/i18n";

export default function MembershipsScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { data: memberships, isLoading } = useMyFanclubs();

  return (
    <SafeAreaView testID="wallet.memberships.screen" style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen options={{ title: t("wallet.memberships") }} />

      <ScrollView contentContainerStyle={{ padding: spacing.xl, gap: spacing.md }}>
        {isLoading ? (
          [1, 2, 3].map((i) => <Skeleton key={i} width="100%" height={80} borderRadius={16} />)
        ) : !memberships || memberships.length === 0 ? (
          <View style={styles.empty}>
            <Text style={[typography.body, { color: colors.mutedForeground }]}>
              {t("wallet.membershipsEmpty")}
            </Text>
          </View>
        ) : (
          memberships.map((m) => (
            <View
              key={m.id}
              style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
            >
              <View style={styles.row}>
                {m.logo_url ? (
                  <Image source={{ uri: m.logo_url }} style={styles.logo} />
                ) : (
                  <View style={[styles.logo, { backgroundColor: colors.muted }]} />
                )}
                <View style={{ flex: 1, marginLeft: spacing.md }}>
                  <Text style={[typography.h4, { color: colors.foreground }]}>
                    {m.fanclub_name}
                  </Text>
                  <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: 2 }]}>
                    {m.artist_name}
                  </Text>
                </View>
                <View style={[styles.tierBadge, { backgroundColor: colors.primary }]}>
                  <Text style={[typography.micro, { color: "#fff", fontWeight: "700" }]}>
                    {t(`memberships.tier.${m.tier || "basic"}`, { defaultValue: m.tier })}
                  </Text>
                </View>
              </View>
              <View style={[styles.divider, { backgroundColor: colors.border }]} />
              <View style={styles.metaRow}>
                <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
                  {t("memberships.joined")}
                </Text>
                <Text style={[typography.bodySmall, { color: colors.foreground }]}>
                  {m.joined_at ? new Date(m.joined_at).toLocaleDateString(i18n.language?.startsWith("ko") ? "ko-KR" : "en-US") : "-"}
                </Text>
              </View>
              {m.expires_at && (
                <View style={styles.metaRow}>
                  <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
                    {t("memberships.expiresAt")}
                  </Text>
                  <Text style={[typography.bodySmall, { color: colors.foreground }]}>
                    {new Date(m.expires_at).toLocaleDateString(i18n.language?.startsWith("ko") ? "ko-KR" : "en-US")}
                  </Text>
                </View>
              )}
            </View>
          ))
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  card: {
    padding: spacing.lg,
    borderRadius: radius.md,
    borderWidth: 1,
    gap: spacing.md,
  },
  row: { flexDirection: "row", alignItems: "center" },
  logo: { width: 48, height: 48, borderRadius: 24 },
  tierBadge: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    borderRadius: radius.full,
  },
  divider: { height: 1 },
  metaRow: { flexDirection: "row", justifyContent: "space-between" },
  empty: { padding: spacing.xxl, alignItems: "center" },
});
