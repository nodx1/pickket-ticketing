/**
 * 팬 존 섹션 — FanLevelCard compact + PicksRing + 소셜 펄스
 * 게스트: 로그인 CTA
 */
import { useMemo } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { useAuthStore } from "@/hooks/useAuth";
import { useFanProfile } from "@/hooks/useFanProfile";
import { usePicks } from "@/hooks/usePicks";
import { FanLevelCard } from "@/components/fan/FanLevelCard";
import { PicksRing, type PickItem } from "@/components/home/PicksRing";

export function FanZoneSection() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const router = useRouter();
  // AUDIT §6 P1: 개별 selector로 불필요한 리렌더 방지
  const isGuest = useAuthStore((s) => s.isGuest);
  const { data: fanProfile } = useFanProfile();
  const { data: stamps } = usePicks();

  const pickItems: PickItem[] = useMemo(
    () =>
      (stamps ?? []).map((s) => ({
        eventId: s.eventId,
        imageUri: s.imageUri,
        label: s.eventId, // 이벤트명은 추후 이벤트 데이터와 조인
        isNew: !s.status || s.status === "completed",
        status: s.status,
      })),
    [stamps],
  );

  if (isGuest) {
    return (
      <View style={[styles.guestContainer, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Ionicons name="sparkles" size={28} color={colors.primary} />
        <Text style={[typography.h4, { color: colors.foreground, marginTop: spacing.sm }]}>
          {t("home.fanZone")}
        </Text>
        <Text style={[typography.bodySmall, { color: colors.mutedForeground, textAlign: "center", marginTop: spacing.xs }]}>
          {t("auth.loginToContinue")}
        </Text>
        <TouchableOpacity
          style={[styles.loginBtn, { backgroundColor: colors.primary }]}
          onPress={() => router.push("/(auth)/login")}
        >
          <Text style={[typography.h5, { color: colors.primaryForeground }]}>
            {t("auth.login.submit")}
          </Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* 팬 레벨 compact */}
      {fanProfile && (
        <View style={styles.levelWrap}>
          <FanLevelCard
            profile={fanProfile}
            compact
            onPress={() => router.push("/(tabs)/me")}
          />
        </View>
      )}

      {/* 내 픽 갤러리 */}
      <View style={styles.stampSection}>
        <Text style={[typography.h5, { color: colors.foreground, marginBottom: spacing.sm, paddingHorizontal: spacing.xl }]}>
          {t("picks.title")}
        </Text>
        <PicksRing picks={pickItems} />
      </View>

      {/* 소셜 펄스 */}
      <View style={[styles.socialPulse, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Ionicons name="people" size={16} color={colors.primary} />
        <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginLeft: spacing.sm }]}>
          {t("home.socialPulse", { count: 3 })}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: spacing.lg,
  },
  guestContainer: {
    marginHorizontal: spacing.xl,
    padding: spacing.xl,
    borderRadius: radius.card,
    borderWidth: 1,
    alignItems: "center",
  },
  loginBtn: {
    marginTop: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.sm,
    borderRadius: radius.full,
  },
  levelWrap: {
    paddingHorizontal: spacing.xl,
  },
  stampSection: {
    // paddingHorizontal handled inside PicksRing
  },
  socialPulse: {
    marginHorizontal: spacing.xl,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
});
