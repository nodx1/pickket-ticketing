/**
 * 온보딩 화면 (첫 사용자)
 * 5단계: 환영 → 카테고리 선택 → 장르 선택 → 아티스트 선택 → 알림 설정
 */
import { useState, useCallback, useMemo } from "react";
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Dimensions,
  TextInput,
  ScrollView,
} from "react-native";
import Animated, { FadeInUp, SlideInRight } from "react-native-reanimated";
import { SafeAreaView } from "react-native-safe-area-context";
import { useRouter, Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { Button } from "@/components/ui/Button";
import { selectionFeedback, impactFeedback } from "@/lib/haptics";
import { savePreferences } from "@/config/api";
import AsyncStorage from "@react-native-async-storage/async-storage";

const ONBOARDING_KEY = "onboarding_completed";
const MIN_CATEGORIES = 3;

const CATEGORIES = [
  "CONCERT",
  "MUSICAL",
  "SPORTS",
  "EXHIBITION",
  "FESTIVAL",
  "THEATER",
  "FANMEETING",
  "CLASSIC",
] as const;

// Phase 6: 장르 칩 (Spotify pattern)
const GENRES = [
  { id: "music", emoji: "\uD83C\uDFB5", labelKey: "discover.category.music" },
  { id: "festival", emoji: "\uD83C\uDFAA", labelKey: "discover.category.festival" },
  { id: "club", emoji: "\uD83E\uDEA9", labelKey: "discover.category.club" },
  { id: "art", emoji: "\uD83C\uDFA8", labelKey: "discover.category.art" },
  { id: "sports", emoji: "\u26BD", labelKey: "discover.category.sports" },
  { id: "comedy", emoji: "\uD83D\uDE02", labelKey: "onboarding.genreComedy" },
] as const;

// Phase 6: Mock popular artists
const POPULAR_ARTISTS = [
  { id: "ive", name: "IVE" },
  { id: "aespa", name: "aespa" },
  { id: "newjeans", name: "NewJeans" },
  { id: "bts", name: "BTS" },
  { id: "blackpink", name: "BLACKPINK" },
  { id: "coldplay", name: "Coldplay" },
  { id: "lim-young-woong", name: "\uC784\uC601\uC6C5" },
  { id: "iu", name: "\uC544\uC774\uC720" },
] as const;

const MAX_GENRES = 3;
const MAX_ARTISTS = 5;

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const CHIP_WIDTH = (SCREEN_WIDTH - spacing.xl * 2 - spacing.sm * 3) / 4;
const GENRE_CHIP_WIDTH = (SCREEN_WIDTH - spacing.xl * 2 - spacing.md * 2) / 3;
const ARTIST_CHIP_SIZE = (SCREEN_WIDTH - spacing.xl * 2 - spacing.md * 3) / 4;

export default function OnboardingScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();

  // step 0=환영, 1=카테고리, 2=장르, 3=아티스트, 4=알림
  const [step, setStep] = useState(0);
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [selectedArtists, setSelectedArtists] = useState<string[]>([]);
  const [notifPref, setNotifPref] = useState<"all" | "mine" | null>(null);
  const [artistSearch, setArtistSearch] = useState("");

  const toggleCategory = useCallback((cat: string) => {
    selectionFeedback();
    setSelectedCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat],
    );
  }, []);

  const toggleGenre = useCallback((genreId: string) => {
    selectionFeedback();
    setSelectedGenres((prev) => {
      if (prev.includes(genreId)) return prev.filter((g) => g !== genreId);
      if (prev.length >= MAX_GENRES) return prev;
      return [...prev, genreId];
    });
  }, []);

  const toggleArtist = useCallback((artistId: string) => {
    selectionFeedback();
    setSelectedArtists((prev) => {
      if (prev.includes(artistId)) return prev.filter((a) => a !== artistId);
      if (prev.length >= MAX_ARTISTS) return prev;
      return [...prev, artistId];
    });
  }, []);

  const filteredArtists = useMemo(() => {
    if (!artistSearch.trim()) return POPULAR_ARTISTS;
    const q = artistSearch.toLowerCase();
    return POPULAR_ARTISTS.filter((a) => a.name.toLowerCase().includes(q));
  }, [artistSearch]);

  const handleComplete = useCallback(async () => {
    await impactFeedback();
    await AsyncStorage.setItem(ONBOARDING_KEY, "true");
    // 카테고리 선호도 로컬 저장
    if (selectedCategories.length > 0) {
      await AsyncStorage.setItem("preferred_categories", JSON.stringify(selectedCategories));
    }
    // Phase 6: 장르/아티스트 선호도 서버 전송 (실패해도 진행)
    if (selectedGenres.length > 0 || selectedArtists.length > 0) {
      try {
        await savePreferences(selectedGenres, selectedArtists);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (_err: unknown) {
        // graceful — 서버 미배포 시 무시
      }
    }
    router.replace("/(tabs)");
  }, [selectedCategories, selectedGenres, selectedArtists, router]);

  const handleNext = useCallback(() => {
    impactFeedback();
    setStep((s) => s + 1);
  }, []);

  const handleSkip = useCallback(() => {
    handleComplete();
  }, [handleComplete]);

  // Step 0: 환영
  if (step === 0) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.center}>
          <Text style={[typography.h1, { color: colors.primary, textAlign: "center" }]}>Pickket</Text>
          <Text
            style={[
              typography.bodyLarge,
              { color: colors.mutedForeground, textAlign: "center", marginTop: spacing.md },
            ]}
          >
            {t("auth.login.tagline")}
          </Text>
        </View>
        <View style={styles.bottomAction}>
          <Button testID="onboarding.welcome.next" title={t("common.next")} onPress={() => setStep(1)} size="lg" />
        </View>
      </SafeAreaView>
    );
  }

  // Step 1: 카테고리 선택 (기존)
  if (step === 1) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <View style={styles.stepContent}>
          <Text style={[typography.h2, { color: colors.foreground }]}>
            {t("onboarding.selectCategories")}
          </Text>
          <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.sm }]}>
            {t("onboarding.selectCategoriesDesc", { min: MIN_CATEGORIES })}
          </Text>

          <View style={styles.categoryGrid}>
            {CATEGORIES.map((cat) => {
              const selected = selectedCategories.includes(cat);
              return (
                <TouchableOpacity
                  key={cat}
                  style={[
                    styles.categoryChip,
                    {
                      backgroundColor: selected ? colors.primary : colors.card,
                      borderColor: selected ? colors.primary : colors.border,
                    },
                  ]}
                  onPress={() => toggleCategory(cat)}
                  activeOpacity={0.7}
                >
                  <Text
                    style={[
                      typography.bodySmall,
                      { color: selected ? colors.primaryForeground : colors.foreground, textAlign: "center" },
                    ]}
                  >
                    {t(`categories.${cat}`)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <View style={styles.bottomAction}>
          <Button
            title={t("onboarding.next")}
            onPress={handleNext}
            size="lg"
            disabled={selectedCategories.length < MIN_CATEGORIES}
          />
          <TouchableOpacity testID="onboarding.skip" onPress={handleSkip} style={{ marginTop: spacing.md }}>
            <Text style={[typography.bodySmall, { color: colors.mutedForeground, textAlign: "center" }]}>
              {t("onboarding.skip")}
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Step 2: 장르 선택 (Phase 6 — Spotify pattern)
  if (step === 2) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Animated.View entering={SlideInRight.springify()} style={styles.stepContent}>
          <Text style={[typography.h2, { color: colors.foreground }]}>
            {t("onboarding.genreTitle")}
          </Text>
          <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.sm }]}>
            {t("onboarding.genreSubtitle", { max: MAX_GENRES })}
          </Text>

          <View style={styles.genreGrid}>
            {GENRES.map((genre, index) => {
              const selected = selectedGenres.includes(genre.id);
              return (
                <Animated.View
                  key={genre.id}
                  entering={FadeInUp.springify().delay(index * 80)}
                >
                  <TouchableOpacity
                    style={[
                      styles.genreChip,
                      {
                        backgroundColor: selected ? colors.primary : colors.card,
                        borderColor: selected ? colors.primary : colors.border,
                      },
                    ]}
                    onPress={() => toggleGenre(genre.id)}
                    activeOpacity={0.7}
                  >
                    <Text style={styles.genreEmoji}>{genre.emoji}</Text>
                    <Text
                      style={[
                        typography.body,
                        {
                          color: selected ? colors.primaryForeground : colors.foreground,
                          marginTop: spacing.xs,
                        },
                      ]}
                    >
                      {t(genre.labelKey)}
                    </Text>
                  </TouchableOpacity>
                </Animated.View>
              );
            })}
          </View>
        </Animated.View>

        <View style={styles.bottomAction}>
          <Button
            title={t("onboarding.next")}
            onPress={handleNext}
            size="lg"
            disabled={selectedGenres.length === 0}
          />
          <TouchableOpacity testID="onboarding.skip" onPress={handleSkip} style={{ marginTop: spacing.md }}>
            <Text style={[typography.bodySmall, { color: colors.mutedForeground, textAlign: "center" }]}>
              {t("onboarding.skip")}
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Step 3: 아티스트 선택 (Phase 6)
  if (step === 3) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Animated.View entering={SlideInRight.springify()} style={styles.stepContentScroll}>
          <Text style={[typography.h2, { color: colors.foreground }]}>
            {t("onboarding.artistTitle")}
          </Text>
          <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.sm }]}>
            {t("onboarding.artistSubtitle", { max: MAX_ARTISTS })}
          </Text>

          {/* Search */}
          <View
            style={[
              styles.artistSearchBar,
              { backgroundColor: colors.surface, borderColor: colors.border },
            ]}
          >
            <TextInput
              style={[styles.artistSearchInput, typography.body, { color: colors.foreground }]}
              placeholder={t("common.search")}
              placeholderTextColor={colors.mutedForeground}
              value={artistSearch}
              onChangeText={setArtistSearch}
              autoCorrect={false}
              autoCapitalize="none"
            />
          </View>

          <ScrollView
            style={styles.artistScroll}
            contentContainerStyle={styles.artistGrid}
            showsVerticalScrollIndicator={false}
          >
            {filteredArtists.map((artist, index) => {
              const selected = selectedArtists.includes(artist.id);
              return (
                <Animated.View
                  key={artist.id}
                  entering={FadeInUp.springify().delay(index * 60)}
                >
                  <TouchableOpacity
                    style={[styles.artistChip]}
                    onPress={() => toggleArtist(artist.id)}
                    activeOpacity={0.7}
                  >
                    <View
                      style={[
                        styles.artistAvatar,
                        {
                          backgroundColor: selected ? colors.primary : colors.muted,
                          borderColor: selected ? colors.primary : colors.border,
                          borderWidth: selected ? 2 : 1,
                        },
                      ]}
                    >
                      <Text
                        style={[
                          typography.h3,
                          { color: selected ? colors.primaryForeground : colors.mutedForeground },
                        ]}
                      >
                        {artist.name.charAt(0)}
                      </Text>
                    </View>
                    <Text
                      style={[
                        typography.bodySmall,
                        {
                          color: selected ? colors.primary : colors.foreground,
                          marginTop: spacing.xs,
                          textAlign: "center",
                        },
                      ]}
                      numberOfLines={1}
                    >
                      {artist.name}
                    </Text>
                  </TouchableOpacity>
                </Animated.View>
              );
            })}
          </ScrollView>
        </Animated.View>

        <View style={styles.bottomAction}>
          <Button
            title={t("onboarding.next")}
            onPress={handleNext}
            size="lg"
            disabled={selectedArtists.length === 0}
          />
          <TouchableOpacity testID="onboarding.skip" onPress={handleSkip} style={{ marginTop: spacing.md }}>
            <Text style={[typography.bodySmall, { color: colors.mutedForeground, textAlign: "center" }]}>
              {t("onboarding.skip")}
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  // Step 4: 알림 설정 (Phase 6)
  if (step === 4) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ headerShown: false }} />
        <Animated.View entering={SlideInRight.springify()} style={styles.stepContent}>
          <Text style={[typography.h2, { color: colors.foreground }]}>
            {t("onboarding.notifTitle")}
          </Text>

          <View style={styles.notifCards}>
            {/* 모든 추천 */}
            <Animated.View entering={FadeInUp.springify().delay(100)}>
              <TouchableOpacity
                style={[
                  styles.notifCard,
                  {
                    backgroundColor: colors.card,
                    borderColor: notifPref === "all" ? colors.primary : colors.border,
                    borderWidth: notifPref === "all" ? 2 : 1,
                  },
                  notifPref === "all" && { backgroundColor: colors.surface },
                ]}
                onPress={() => {
                  selectionFeedback();
                  setNotifPref("all");
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.notifIcon}>{"\uD83D\uDD14"}</Text>
                <Text
                  style={[
                    typography.h3,
                    {
                      color: notifPref === "all" ? colors.primary : colors.foreground,
                      marginTop: spacing.sm,
                    },
                  ]}
                >
                  {t("onboarding.notifAll")}
                </Text>
                <Text
                  style={[
                    typography.bodySmall,
                    { color: colors.mutedForeground, marginTop: spacing.xs },
                  ]}
                >
                  {t("onboarding.notifAllDesc")}
                </Text>
              </TouchableOpacity>
            </Animated.View>

            {/* 내 관심만 */}
            <Animated.View entering={FadeInUp.springify().delay(200)}>
              <TouchableOpacity
                style={[
                  styles.notifCard,
                  {
                    backgroundColor: colors.card,
                    borderColor: notifPref === "mine" ? colors.primary : colors.border,
                    borderWidth: notifPref === "mine" ? 2 : 1,
                  },
                  notifPref === "mine" && { backgroundColor: colors.surface },
                ]}
                onPress={() => {
                  selectionFeedback();
                  setNotifPref("mine");
                }}
                activeOpacity={0.7}
              >
                <Text style={styles.notifIcon}>{"\uD83C\uDFAF"}</Text>
                <Text
                  style={[
                    typography.h3,
                    {
                      color: notifPref === "mine" ? colors.primary : colors.foreground,
                      marginTop: spacing.sm,
                    },
                  ]}
                >
                  {t("onboarding.notifMine")}
                </Text>
                <Text
                  style={[
                    typography.bodySmall,
                    { color: colors.mutedForeground, marginTop: spacing.xs },
                  ]}
                >
                  {t("onboarding.notifMineDesc")}
                </Text>
              </TouchableOpacity>
            </Animated.View>
          </View>
        </Animated.View>

        <View style={styles.bottomAction}>
          <Button
            title={t("onboarding.done")}
            onPress={handleComplete}
            size="lg"
          />
          <TouchableOpacity testID="onboarding.skip" onPress={handleSkip} style={{ marginTop: spacing.md }}>
            <Text style={[typography.bodySmall, { color: colors.mutedForeground, textAlign: "center" }]}>
              {t("onboarding.skip")}
            </Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  return null;
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  center: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: spacing.xl,
  },
  stepContent: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxl * 2,
  },
  stepContentScroll: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xxl * 2,
  },
  categoryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.sm,
    marginTop: spacing.xl,
  },
  categoryChip: {
    width: CHIP_WIDTH,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    alignItems: "center",
  },
  bottomAction: {
    paddingHorizontal: spacing.xl,
    paddingBottom: spacing.xxl,
  },
  // Phase 6: Genre grid
  genreGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.md,
    marginTop: spacing.xl,
    justifyContent: "center",
  },
  genreChip: {
    width: GENRE_CHIP_WIDTH,
    paddingVertical: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  genreEmoji: {
    fontSize: 28,
  },
  // Phase 6: Artist grid
  artistSearchBar: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    height: 44,
    marginTop: spacing.lg,
  },
  artistSearchInput: {
    flex: 1,
    height: "100%",
    paddingVertical: 0,
  },
  artistScroll: {
    flex: 1,
    marginTop: spacing.lg,
  },
  artistGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: spacing.md,
    justifyContent: "center",
    paddingBottom: spacing.xl,
  },
  artistChip: {
    width: ARTIST_CHIP_SIZE,
    alignItems: "center",
  },
  artistAvatar: {
    width: ARTIST_CHIP_SIZE - spacing.sm,
    height: ARTIST_CHIP_SIZE - spacing.sm,
    borderRadius: (ARTIST_CHIP_SIZE - spacing.sm) / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  // Phase 6: Notification cards
  notifCards: {
    gap: spacing.lg,
    marginTop: spacing.xxl,
  },
  notifCard: {
    paddingVertical: spacing.xl,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.xl,
    alignItems: "center",
  },
  notifIcon: {
    fontSize: 32,
  },
});
