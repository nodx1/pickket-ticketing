/**
 * PhotoCardItem — 포토카드 개별 아이템
 * 디자인 정책: radius.xl(16), spring 애니메이션
 * 피처플래그: PHOTO_CARDS
 */
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import { Image } from "expo-image";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { typography, spacing, radius } from "@/config/theme";
import type { PhotoCard } from "@/types/photocard";

interface Props {
  card: PhotoCard;
  onPress?: (card: PhotoCard) => void;
}

const RARITY_COLORS: Record<string, string> = {
  common: "#8E8E93",
  rare: "#007AFF",
  epic: "#AF52DE",
  legendary: "#FFD700",
};

export function PhotoCardItem({ card, onPress }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const rarityColor = RARITY_COLORS[card.rarity] ?? colors.mutedForeground;

  return (
    <Animated.View entering={FadeIn.springify()}>
      <TouchableOpacity
        onPress={() => onPress?.(card)}
        style={[styles.card, { backgroundColor: colors.card, borderColor: rarityColor }]}
        activeOpacity={0.8}
        accessibilityRole="button"
      >
        <Image source={{ uri: card.image_url }} style={styles.image} contentFit="cover" />
        <View style={styles.info}>
          <Text style={[typography.h5, { color: colors.foreground }]} numberOfLines={1}>
            {card.artist_name}
          </Text>
          <Text style={[typography.micro, { color: colors.mutedForeground }]} numberOfLines={1}>
            {card.event_title}
          </Text>
          <View style={styles.metaRow}>
            <View style={[styles.rarityBadge, { backgroundColor: rarityColor + "20" }]}>
              <Text style={[typography.micro, { color: rarityColor }]}>
                {t(`photoCard.rarity.${card.rarity}`)}
              </Text>
            </View>
            <Text style={[typography.micro, { color: colors.mutedForeground }]}>
              {card.serial_number}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: radius.xl,
    borderWidth: 2,
    overflow: "hidden",
  },
  image: {
    width: "100%",
    aspectRatio: 2 / 3,
  },
  info: {
    padding: spacing.sm,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginTop: spacing.xs,
  },
  rarityBadge: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
    borderRadius: radius.full,
  },
});
