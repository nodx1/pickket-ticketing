/**
 * 그룹 예매 화면 (Phase C.3)
 *
 * 대표자가 N석 hold → 친구 초대링크 생성 → 친구 join.
 * 백엔드 미구현 시 createGroupOrder가 null 반환하므로 안내 메시지로 graceful fallback.
 */
import { useState } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Alert,
  Pressable,
  TextInput,
  Share,
  Platform,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import * as haptics from "@/lib/haptics";
import { useEvent } from "@/hooks/useEvents";
import { useCreateGroupOrder } from "@/hooks/useGroupBooking";
import { Button } from "@/components/ui/Button";
import type { GroupOrder } from "@/config/api";

const MIN_CAPACITY = 2;
const MAX_CAPACITY = 8;

export default function GroupBookingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { t } = useTranslation();
  const { colors } = useTheme();
  const { data: event } = useEvent(id);
  const createGroup = useCreateGroupOrder();

  const [capacity, setCapacity] = useState(2);
  const [tierId, setTierId] = useState<string>("");
  const [order, setOrder] = useState<GroupOrder | null>(null);

  const tiers = (event && "seat_tiers" in event ? event.seat_tiers : undefined) ?? [];
  const selectedTier = tiers.find((tt) => tt.id === tierId) ?? tiers[0];

  const handleCreate = async () => {
    if (!event || !selectedTier) return;
    try {
      const data = await createGroup.mutateAsync({
        event_id: event.id,
        tier_id: selectedTier.id,
        capacity,
      });
      if (!data) {
        haptics.medium();
        Alert.alert(t("group.title"), t("group.comingSoon"));
        return;
      }
      haptics.success();
      setOrder(data);
    } catch (err: unknown) {
      haptics.error();
      const msg = err instanceof Error ? err.message : t("common.error");
      Alert.alert(t("common.error"), msg);
    }
  };

  const handleShare = async () => {
    if (!order || !event) return;
    const message = `${event.title}\n${t("group.shareMessage")}\n${order.invite_url}`;
    try {
      await Share.share(
        Platform.OS === "ios"
          ? { message, url: order.invite_url }
          : { message },
        { dialogTitle: t("group.title") },
      );
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
      /* user cancelled */
    }
  };

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["bottom"]}>
      <Stack.Screen options={{ title: t("group.title") }} />
      <ScrollView contentContainerStyle={styles.content}>
        {event && (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[typography.h4, { color: colors.foreground }]} numberOfLines={2}>
              {event.title}
            </Text>
            {event.venue && (
              <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
                {event.venue}
              </Text>
            )}
          </View>
        )}

        {!order ? (
          <>
            {tiers.length > 0 && (
              <View style={styles.section}>
                <Text style={[typography.h5, { color: colors.foreground }]}>{t("booking.selectTier")}</Text>
                <View style={styles.tierRow}>
                  {tiers.map((tier) => {
                    const active = (tierId || tiers[0]?.id) === tier.id;
                    return (
                      <Pressable
                        key={tier.id}
                        onPress={() => {
                          haptics.light();
                          setTierId(tier.id);
                        }}
                        style={[
                          styles.tierChip,
                          {
                            backgroundColor: active ? colors.primary : colors.surface,
                            borderColor: active ? colors.primary : colors.border,
                          },
                        ]}
                      >
                        <Text
                          style={[
                            typography.bodySmall,
                            { color: active ? colors.primaryForeground : colors.foreground },
                          ]}
                        >
                          {tier.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            )}

            <View style={styles.section}>
              <Text style={[typography.h5, { color: colors.foreground }]}>{t("group.capacity")}</Text>
              <View style={styles.stepperRow}>
                <Pressable
                  onPress={() => {
                    haptics.light();
                    setCapacity((c) => Math.max(MIN_CAPACITY, c - 1));
                  }}
                  style={[styles.stepperBtn, { borderColor: colors.border }]}
                >
                  <Text style={[typography.h4, { color: colors.foreground }]}>−</Text>
                </Pressable>
                <Text style={[typography.h3, styles.capacityValue, { color: colors.foreground }]}>
                  {capacity}
                </Text>
                <Pressable
                  onPress={() => {
                    haptics.light();
                    setCapacity((c) => Math.min(MAX_CAPACITY, c + 1));
                  }}
                  style={[styles.stepperBtn, { borderColor: colors.border }]}
                >
                  <Text style={[typography.h4, { color: colors.foreground }]}>+</Text>
                </Pressable>
              </View>
              <Text style={[typography.micro, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
                {t("group.capacityHint", { min: MIN_CAPACITY, max: MAX_CAPACITY })}
              </Text>
            </View>

            <Button
              title={t("group.createInvite")}
              onPress={handleCreate}
              disabled={!event || !selectedTier || createGroup.isPending}
              loading={createGroup.isPending}
              variant="primary"
            />
          </>
        ) : (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[typography.h4, { color: colors.foreground }]}>{t("group.inviteSent")}</Text>
            <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.sm }]}>
              {t("group.inviteDescription", { count: order.capacity })}
            </Text>
            <View style={[styles.inviteBox, { backgroundColor: colors.surface, borderColor: colors.border }]}>
              <TextInput
                value={order.invite_url}
                editable={false}
                style={[typography.bodySmall, { color: colors.foreground }]}
                multiline
              />
            </View>
            <Button title={t("group.share")} onPress={handleShare} variant="primary" />
            <Text style={[typography.micro, { color: colors.mutedForeground, marginTop: spacing.sm }]}>
              {t("group.expiresAt", { time: new Date(order.expires_at).toLocaleString() })}
            </Text>
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: { padding: spacing.lg, gap: spacing.lg },
  card: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    gap: spacing.sm,
  },
  section: { gap: spacing.sm },
  tierRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm },
  tierChip: {
    paddingVertical: spacing.sm,
    paddingHorizontal: spacing.md,
    borderRadius: radius.full,
    borderWidth: 1,
  },
  stepperRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.lg,
    marginTop: spacing.sm,
  },
  stepperBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  capacityValue: { minWidth: 40, textAlign: "center" },
  inviteBox: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    marginTop: spacing.md,
  },
});
