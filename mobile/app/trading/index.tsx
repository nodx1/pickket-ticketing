/**
 * 포토카드 트레이딩 마켓
 * 피처플래그: PHOTO_CARD_TRADING
 */
import { FlatList, View, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack } from "expo-router";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { spacing } from "@/config/theme";
import { isFeatureEnabled } from "@/config/features";
import { EmptyState } from "@/components/common/EmptyState";
import { TradeOfferCard } from "@/components/trading/TradeOfferCard";
import type { TradeOffer } from "@/types/trading";

const MOCK_OFFERS: TradeOffer[] = [
  {
    id: "tr-1",
    seller_id: "u-1",
    seller_name: "김팬덤",
    card_id: "pc-1",
    card_artist: "IVE 안유진",
    card_event: "IVE WORLD TOUR",
    card_rarity: "rare",
    card_image_url: "https://picsum.photos/seed/trade-1/300/450",
    asking_price: 15000,
    status: "open",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
  },
  {
    id: "tr-2",
    seller_id: "u-2",
    seller_name: "박콘서트",
    card_id: "pc-2",
    card_artist: "aespa 카리나",
    card_event: "aespa SYNK",
    card_rarity: "epic",
    card_image_url: "https://picsum.photos/seed/trade-2/300/450",
    trade_for: "IVE 원영 레전더리",
    status: "open",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 7 * 86400000).toISOString(),
  },
];

export default function TradingScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();

  if (!isFeatureEnabled("PHOTO_CARD_TRADING")) {
    return (
      <SafeAreaView testID="trading.screen" style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: t("trading.title"), headerShown: true }} />
        <EmptyState testID="trading.comingSoon" icon="swap-horizontal-outline" title={t("trading.comingSoon")} message={t("trading.comingSoonDesc")} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: t("trading.title"), headerShown: true }} />
      <FlatList
        data={MOCK_OFFERS}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => <TradeOfferCard offer={item} />}
        contentContainerStyle={styles.list}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  list: { padding: spacing.xl },
  separator: { height: spacing.md },
});
