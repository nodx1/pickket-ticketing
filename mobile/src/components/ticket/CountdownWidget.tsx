/**
 * CountdownWidget — 티켓 D-day 카운트다운 (Phase D.1)
 *
 * 표시 규칙 (computeCountdown stage):
 * - far     : D-{N}
 * - week    : D-{N} + 셋리스트 힌트
 * - approaching : D-{N} + 동선/맛집 힌트
 * - tomorrow : D-1 + 입장 가이드
 * - today   : D-day 🎉 + "지금 출발"
 * - live    : 공연 중
 * - past    : 숨김
 */
import { useEffect, useState } from "react";
import { View, Text, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { computeCountdown, type CountdownStage } from "@/lib/countdown";

interface Props {
  eventDate?: string | null;
  /** 테스트 주입 */
  now?: number;
}

const STAGE_TO_HINT: Record<CountdownStage, string | null> = {
  far: null,
  week: "countdown.hintWeek",
  approaching: "countdown.hintApproaching",
  tomorrow: "countdown.hintTomorrow",
  today: "countdown.hintToday",
  live: "countdown.hintLive",
  past: null,
};

export function CountdownWidget({ eventDate, now }: Props) {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (now !== undefined) return; // 테스트 모드
    const id = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(id);
  }, [now]);

  const info = computeCountdown(eventDate, now ?? Date.now());
  // tick 참조로 60초마다 리렌더 유도
  void tick;

  if (info.stage === "past") return null;

  const headline =
    info.stage === "today"
      ? t("countdown.dDay")
      : info.stage === "live"
      ? t("countdown.live")
      : info.stage === "tomorrow"
      ? t("countdown.dayMinus", { n: 1 })
      : t("countdown.dayMinus", { n: info.daysRemaining });

  const hintKey = STAGE_TO_HINT[info.stage];

  return (
    <View
      style={[
        styles.container,
        { backgroundColor: colors.card, borderColor: colors.primary },
      ]}
    >
      <Text style={[typography.h2, styles.headline, { color: colors.primary }]}>
        {headline}
      </Text>
      {hintKey && (
        <Text
          style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.xs }]}
          numberOfLines={2}
        >
          {t(hintKey)}
        </Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderLeftWidth: 4,
    alignItems: "flex-start",
  },
  headline: {
    fontVariant: ["tabular-nums"],
  },
});
