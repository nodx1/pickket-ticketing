/**
 * SeatViewPreview — 좌석 시야 미리보기 (Phase D.2)
 *
 * SeatTier에 이미 있는 view_image_url / view_description / view_rating /
 * distance_from_stage 를 시각화. 데이터 없으면 null 반환.
 */
import { View, Text, StyleSheet } from "react-native";
import { Image } from "expo-image";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import type { SeatTier } from "@/config/api";

interface Props {
  tier: Pick<
    SeatTier,
    | "view_image_url"
    | "view_description"
    | "view_rating"
    | "distance_from_stage"
    | "position_label"
  >;
}

export function SeatViewPreview({ tier }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();

  const hasImage = !!tier.view_image_url;
  const hasMeta =
    tier.view_rating != null ||
    tier.distance_from_stage != null ||
    !!tier.position_label ||
    !!tier.view_description;

  if (!hasImage && !hasMeta) return null;

  return (
    <View style={[styles.container, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <Text style={[typography.h5, { color: colors.foreground }]}>
        {t("seatView.title")}
      </Text>
      {hasImage && (
        <Image
          source={{ uri: tier.view_image_url! }}
          style={styles.image}
          contentFit="cover"
          transition={200}
          accessibilityLabel={t("seatView.title")}
        />
      )}
      {tier.view_description && (
        <Text
          style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.sm }]}
          numberOfLines={3}
        >
          {tier.view_description}
        </Text>
      )}
      <View style={styles.metaRow}>
        {tier.position_label && (
          <Text style={[typography.micro, styles.chip, { color: colors.foreground, backgroundColor: colors.muted }]}>
            {tier.position_label}
          </Text>
        )}
        {tier.distance_from_stage != null && (
          <Text style={[typography.micro, styles.chip, { color: colors.foreground, backgroundColor: colors.muted }]}>
            {t("seatView.distance", { m: tier.distance_from_stage })}
          </Text>
        )}
        {tier.view_rating != null && (
          <Text style={[typography.micro, styles.chip, { color: colors.primaryForeground, backgroundColor: colors.primary }]}>
            ★ {tier.view_rating.toFixed(1)}
          </Text>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    marginTop: spacing.sm,
    gap: spacing.sm,
  },
  image: {
    width: "100%",
    aspectRatio: 16 / 9,
    borderRadius: radius.sm,
    marginTop: spacing.sm,
  },
  metaRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.xs,
  },
  chip: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
    overflow: "hidden",
  },
});
