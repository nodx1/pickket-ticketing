/**
 * Phase F.3 — 포인트 잔액 + 거래 내역
 */
import { View, Text, FlatList, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { usePointBalance, usePointHistory } from "@/hooks/usePoints";
import { getTotalPoints, type PointTransaction } from "@/config/api";
import { Skeleton } from "@/components/ui/Skeleton";
import i18n from "@/i18n";

export default function PointsScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const { data: balance, isLoading: loadingBalance } = usePointBalance();
  const { data: history, isLoading: loadingHistory } = usePointHistory(50, 0);

  const transactions = history?.transactions ?? [];

  return (
    <SafeAreaView testID="wallet.points.screen" style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen options={{ title: t("wallet.points") }} />

      <View style={{ padding: spacing.xl }}>
        {loadingBalance ? (
          <Skeleton width="100%" height={100} borderRadius={12} />
        ) : (
          <View style={[styles.balanceCard, { backgroundColor: colors.primary }]}>
            <Text style={[typography.bodySmall, { color: "#fff", opacity: 0.85 }]}>
              {t("points.total")}
            </Text>
            <Text style={[typography.h1, { color: "#fff", marginTop: spacing.xs }]}>
              {(balance ? getTotalPoints(balance) : 0).toLocaleString()} AP
            </Text>
            <View style={styles.breakdown}>
              <View style={{ flex: 1 }}>
                <Text style={[typography.bodySmall, { color: "#fff", opacity: 0.85 }]}>
                  {t("points.fan")}
                </Text>
                <Text style={[typography.body, { color: "#fff", fontWeight: "700" }]}>
                  {(balance?.fan ?? 0).toLocaleString()}
                </Text>
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[typography.bodySmall, { color: "#fff", opacity: 0.85 }]}>
                  {t("points.social")}
                </Text>
                <Text style={[typography.body, { color: "#fff", fontWeight: "700" }]}>
                  {(balance?.social ?? 0).toLocaleString()}
                </Text>
              </View>
            </View>
          </View>
        )}
      </View>

      <Text style={[typography.h4, { color: colors.foreground, paddingHorizontal: spacing.xl }]}>
        {t("points.history")}
      </Text>

      <FlatList
        contentContainerStyle={{ padding: spacing.xl, paddingTop: spacing.md, gap: spacing.sm }}
        data={transactions}
        keyExtractor={(tx) => tx.id}
        ListEmptyComponent={
          loadingHistory ? (
            <Skeleton width="100%" height={60} borderRadius={16} />
          ) : (
            <View style={{ padding: spacing.xxl, alignItems: "center" }}>
              <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
                {t("points.empty")}
              </Text>
            </View>
          )
        }
        renderItem={({ item }) => <TransactionRow tx={item} />}
      />
    </SafeAreaView>
  );
}

function TransactionRow({ tx }: { tx: PointTransaction }) {
  const { colors } = useTheme();
  const positive = tx.amount >= 0;
  return (
    <View style={[styles.txRow, { backgroundColor: colors.card, borderColor: colors.border }]}>
      <View style={{ flex: 1 }}>
        <Text style={[typography.body, { color: colors.foreground }]} numberOfLines={1}>
          {tx.description ?? tx.tx_type}
        </Text>
        <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: 2 }]}>
          {new Date(tx.created_at).toLocaleDateString(i18n.language?.startsWith("ko") ? "ko-KR" : "en-US")}
        </Text>
      </View>
      <Text
        style={[
          typography.body,
          { color: positive ? colors.primary : colors.destructive, fontWeight: "700" },
        ]}
      >
        {positive ? "+" : ""}{tx.amount.toLocaleString()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  balanceCard: {
    padding: spacing.xl,
    borderRadius: radius.lg,
  },
  breakdown: {
    flexDirection: "row",
    marginTop: spacing.lg,
    gap: spacing.lg,
  },
  txRow: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
});
