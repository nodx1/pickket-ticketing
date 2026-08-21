/**
 * 리뷰 작성 화면
 * 별점 + 제목 + 내용
 */
import { useState, useCallback } from "react";
import { View, Text, TouchableOpacity, Alert, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing } from "@/config/theme";
import { useCreateReview } from "@/hooks/useReviews";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

const STARS = [1, 2, 3, 4, 5] as const;

export default function ReviewScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ id: string }>();
  const eventId = typeof params.id === "string" ? params.id : params.id?.[0] ?? "";

  const createReview = useCreateReview(eventId);

  const [rating, setRating] = useState(0);
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");

  const canSubmit = rating > 0 && title.trim().length > 0 && content.trim().length >= 10;

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return;

    createReview.mutate(
      { rating, title: title.trim(), content: content.trim() },
      {
        onSuccess: () => {
          Alert.alert(t("common.confirm"), t("review.submitted"), [
            { text: t("common.confirm"), onPress: () => router.back() },
          ]);
        },
        onError: (error: unknown) => {
          Alert.alert(t("common.error"), error instanceof Error ? error.message : t("common.error"));
        },
      },
    );
  }, [canSubmit, rating, title, content, createReview, router, t]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen options={{ title: t("review.write") }} />

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {/* 별점 */}
        <Text style={[typography.h4, { color: colors.foreground }]}>{t("review.rating")}</Text>
        <View style={styles.starsRow}>
          {STARS.map((star) => (
            <TouchableOpacity key={star} onPress={() => setRating(star)} activeOpacity={0.6}>
              <Text style={[styles.star, { color: star <= rating ? colors.warning : colors.muted }]}>
                ★
              </Text>
            </TouchableOpacity>
          ))}
        </View>

        {/* 제목 */}
        <Text style={[typography.h4, { color: colors.foreground, marginTop: spacing.xl }]}>
          {t("review.titleLabel")}
        </Text>
        <Input
          value={title}
          onChangeText={setTitle}
          placeholder={t("review.titlePlaceholder")}
          maxLength={200}
          style={{ marginTop: spacing.sm }}
        />

        {/* 내용 */}
        <Text style={[typography.h4, { color: colors.foreground, marginTop: spacing.xl }]}>
          {t("review.contentLabel")}
        </Text>
        <Input
          value={content}
          onChangeText={setContent}
          placeholder={t("review.contentPlaceholder")}
          multiline
          maxLength={2000}
          style={{ marginTop: spacing.sm, minHeight: 120, textAlignVertical: "top" }}
        />
        <Text style={[typography.micro, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
          {t("review.minLength")}
        </Text>

        <Button
          title={createReview.isPending ? t("booking.processing") : t("review.submit")}
          onPress={handleSubmit}
          disabled={!canSubmit || createReview.isPending}
          size="lg"
          style={{ marginTop: spacing.xl }}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  body: {
    padding: spacing.xl,
  },
  starsRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.sm,
  },
  star: {
    fontSize: 32,
  },
});
