/**
 * 포토카드 컬렉션 화면
 * 피처플래그: PHOTO_CARDS
 */
import { View, FlatList, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack } from "expo-router";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { spacing } from "@/config/theme";
import { isFeatureEnabled } from "@/config/features";
import { EmptyState } from "@/components/common/EmptyState";
import { PhotoCardItem } from "@/components/photocard/PhotoCardItem";
import type { PhotoCard } from "@/types/photocard";

const MOCK_CARDS: PhotoCard[] = [
  {
    id: "pc-1",
    artist_name: "IVE 안유진",
    event_title: "IVE THE 1ST WORLD TOUR",
    image_url: "https://picsum.photos/seed/pc-yujin/300/450",
    rarity: "rare",
    obtained_at: "2026-04-10T18:00:00Z",
    serial_number: "#0042/1000",
    is_tradeable: true,
  },
  {
    id: "pc-2",
    artist_name: "aespa 카리나",
    event_title: "aespa SYNK TOUR",
    image_url: "https://picsum.photos/seed/pc-karina/300/450",
    rarity: "epic",
    obtained_at: "2026-04-08T19:00:00Z",
    serial_number: "#0015/500",
    is_tradeable: true,
  },
  {
    id: "pc-3",
    artist_name: "NewJeans 하니",
    event_title: "WATERBOMB SEOUL",
    image_url: "https://picsum.photos/seed/pc-hanni/300/450",
    rarity: "legendary",
    obtained_at: "2026-03-20T14:00:00Z",
    serial_number: "#0003/100",
    is_tradeable: false,
  },
  {
    id: "pc-4",
    artist_name: "ENHYPEN 희승",
    event_title: "ENHYPEN FATE+ TOUR",
    image_url: "https://picsum.photos/seed/pc-heeseung/300/450",
    rarity: "common",
    obtained_at: "2026-03-15T19:00:00Z",
    serial_number: "#0123/2000",
    is_tradeable: true,
  },
];

export default function PhotoCardScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();

  if (!isFeatureEnabled("PHOTO_CARDS")) {
    return (
      <SafeAreaView testID="photocard.screen" style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: t("photoCard.title"), headerShown: true }} />
        <EmptyState testID="photocard.comingSoon" icon="images-outline" title={t("photoCard.comingSoon")} message={t("photoCard.comingSoonDesc")} />
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: t("photoCard.collection"), headerShown: true }} />

      <FlatList
        data={MOCK_CARDS}
        numColumns={2}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <View style={styles.gridItem}>
            <PhotoCardItem card={item} />
          </View>
        )}
        contentContainerStyle={styles.grid}
        columnWrapperStyle={styles.gridRow}
        showsVerticalScrollIndicator={false}
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  grid: {
    padding: spacing.xl,
  },
  gridRow: {
    gap: spacing.md,
  },
  gridItem: {
    flex: 1,
    marginBottom: spacing.md,
  },
});
