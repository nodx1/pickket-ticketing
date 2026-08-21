/**
 * Phase E.2 — 가격 알림 버튼
 *
 * 이벤트 상세 상단에 배치. 탭하면 티어별 목표 가격 입력 시트를 열고,
 * 등록 후 백엔드가 tier update 시 NotificationService 경유로 푸시 발송.
 */
import { useMemo, useState } from "react";
import {
  Modal,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  StyleSheet,
  Alert,
} from "react-native";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { formatKRW } from "@/lib/format";
import * as haptics from "@/lib/haptics";
import { useCreatePriceAlert, useMyPriceAlerts } from "@/hooks/usePriceAlert";
import type { SeatTier, SeatTierCompact } from "@/config/api";

type TierLike = SeatTier | SeatTierCompact;

interface Props {
  eventId: string;
  tiers: TierLike[];
}

function tierRemaining(tier: TierLike): number {
  if ("remaining" in tier && typeof tier.remaining === "number") return tier.remaining;
  return Math.max(0, (tier.capacity ?? 0) - (tier.sold_count ?? 0));
}

export function PriceAlertButton({ eventId, tiers }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const [selectedTier, setSelectedTier] = useState<string | null>(null);
  const [target, setTarget] = useState("");

  const { data: alerts } = useMyPriceAlerts(false);
  const createMut = useCreatePriceAlert();

  const hasAlertForEvent = useMemo(
    () => (alerts ?? []).some((a) => a.event_id === eventId && !a.triggered),
    [alerts, eventId]
  );

  const availableTiers = useMemo(
    () => tiers.filter((tier) => tierRemaining(tier) > 0),
    [tiers]
  );

  const handleSubmit = async () => {
    if (!selectedTier || !target) return;
    const targetPrice = Number(target.replace(/[^0-9]/g, ""));
    if (!Number.isFinite(targetPrice) || targetPrice <= 0) {
      Alert.alert(t("priceAlert.invalidAmount"));
      return;
    }
    try {
      await createMut.mutateAsync({
        eventId,
        tierId: selectedTier,
        targetPrice,
      });
      haptics.success();
      setOpen(false);
      setTarget("");
      setSelectedTier(null);
      Alert.alert(t("priceAlert.created"));
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
      haptics.error();
      Alert.alert(t("priceAlert.failed"));
    }
  };

  return (
    <>
      <TouchableOpacity
        testID="event.detail.priceAlert"
        style={[styles.btn, { borderColor: colors.border, backgroundColor: colors.card }]}
        onPress={() => setOpen(true)}
        accessibilityLabel={t("priceAlert.button")}
        accessibilityRole="button"
      >
        <Text style={{ fontSize: 18, color: hasAlertForEvent ? colors.primary : colors.foreground }}>
          {hasAlertForEvent ? "🔔" : "🔕"}
        </Text>
      </TouchableOpacity>

      <Modal
        visible={open}
        transparent
        animationType="slide"
        onRequestClose={() => setOpen(false)}
      >
        <View style={styles.backdrop}>
          <View testID="priceAlert.sheet" style={[styles.sheet, { backgroundColor: colors.background }]}>
            <View style={styles.sheetHeader}>
              <Text style={[typography.h3, { color: colors.foreground }]}>
                {t("priceAlert.title")}
              </Text>
              <TouchableOpacity
                onPress={() => setOpen(false)}
                accessibilityRole="button"
                accessibilityLabel={t("common.close")}
              >
                <Text style={{ fontSize: 24, color: colors.foreground }}>×</Text>
              </TouchableOpacity>
            </View>

            <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginBottom: spacing.md }]}>
              {t("priceAlert.subtitle")}
            </Text>

            <Text style={[typography.body, { color: colors.foreground, marginBottom: spacing.sm, fontWeight: "600" }]}>
              {t("priceAlert.selectTier")}
            </Text>
            <View style={{ gap: spacing.xs, marginBottom: spacing.lg }}>
              {availableTiers.length === 0 ? (
                <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
                  {t("priceAlert.noTiers")}
                </Text>
              ) : (
                availableTiers.map((tier) => {
                  const isSelected = selectedTier === tier.id;
                  return (
                    <TouchableOpacity
                      key={tier.id}
                      style={[
                        styles.tierRow,
                        {
                          borderColor: isSelected ? colors.primary : colors.border,
                          backgroundColor: isSelected ? colors.muted : colors.card,
                        },
                      ]}
                      onPress={() => setSelectedTier(tier.id)}
                      accessibilityLabel={`${tier.name} ${formatKRW(tier.base_price || tier.face_price || 0)}`}
                      accessibilityRole="radio"
                      accessibilityState={{ selected: isSelected }}
                    >
                      <Text style={[typography.body, { color: colors.foreground }]}>
                        {tier.name}
                      </Text>
                      <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>
                        {formatKRW(tier.base_price || tier.face_price || 0)}
                      </Text>
                    </TouchableOpacity>
                  );
                })
              )}
            </View>

            <Text style={[typography.body, { color: colors.foreground, marginBottom: spacing.sm, fontWeight: "600" }]}>
              {t("priceAlert.targetPrice")}
            </Text>
            <TextInput
              style={[
                styles.input,
                {
                  borderColor: colors.border,
                  backgroundColor: colors.card,
                  color: colors.foreground,
                },
              ]}
              value={target}
              onChangeText={setTarget}
              keyboardType="numeric"
              placeholder={t("priceAlert.targetPlaceholder")}
              placeholderTextColor={colors.mutedForeground}
            />

            <TouchableOpacity
              style={[
                styles.submit,
                {
                  backgroundColor:
                    selectedTier && target ? colors.primary : colors.muted,
                },
              ]}
              onPress={handleSubmit}
              disabled={!selectedTier || !target || createMut.isPending}
              accessibilityLabel={t("priceAlert.submit")}
              accessibilityRole="button"
            >
              <Text style={[typography.body, { color: "#fff", fontWeight: "600" }]}>
                {createMut.isPending ? t("common.loading") : t("priceAlert.submit")}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </>
  );
}

const styles = StyleSheet.create({
  btn: {
    width: 44,
    height: 44,
    borderRadius: radius.full,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.5)",
    justifyContent: "flex-end",
  },
  sheet: {
    padding: spacing.xl,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    paddingBottom: spacing.xxl,
  },
  sheetHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: spacing.sm,
  },
  tierRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  input: {
    borderWidth: 1,
    borderRadius: radius.md,
    padding: spacing.md,
    fontSize: 16,
    marginBottom: spacing.lg,
  },
  submit: {
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    alignItems: "center",
  },
});
