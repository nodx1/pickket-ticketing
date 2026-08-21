/**
 * TradeOfferCard — 포토카드 트레이딩 오퍼 카드
 * 피처플래그: PHOTO_CARD_TRADING
 * 디자인 정책: radius.xl(16), 44pt 터치
 */
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { Image } from "expo-image";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { typography, spacing, radius } from "@/config/theme";
import { formatKRW } from "@/lib/format";
import * as haptics from "@/lib/haptics";
import type { TradeOffer } from "@/types/trading";

interface Props {
  offer: TradeOffer;
  onPress?: (offer: TradeOffer) => void;
}

export function TradeOfferCard({ offer, onPress }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();

  return (
    <Animated.View entering={FadeIn.springify()}>
      <TouchableOpacity
        onPress={() => {
          haptics.lightImpact();
          onPress?.(offer);
        }}
        style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`${offer.card_artist} - ${offer.card_event}`}
      >
        <Image source={{ uri: offer.card_image_url }} style={styles.image} contentFit="cover" />
        <View style={styles.info}>
          <Text style={[typography.h5, { color: colors.foreground }]} numberOfLines={1}>
            {offer.card_artist}
          </Text>
          <Text style={[typography.bodySmall, { color: colors.mutedForeground }]} numberOfLines={1}>
            {offer.card_event}
          </Text>
          <View style={styles.priceRow}>
            {offer.asking_price ? (
              <Text style={[typography.h5, { color: colors.primary }]}>
                {formatKRW(offer.asking_price)}
              </Text>
            ) : (
              <Text style={[typography.bodySmall, { color: colors.violet }]}>
                {t("trading.tradeOnly")}
              </Text>
            )}
          </View>
          <Text style={[typography.micro, { color: colors.mutedForeground }]}>
            {offer.seller_name}
          </Text>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    padding: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
  },
  image: {
    width: 64,
    height: 96,
    borderRadius: radius.xl,
    marginRight: spacing.md,
  },
  info: {
    flex: 1,
    justifyContent: "center",
  },
  priceRow: {
    marginTop: spacing.xs,
  },
});
