/**
 * EventOpenCountdown — 거대 카운트다운 (Laylo DNA, 모바일)
 *
 * 디자인 근거: docs/design/DICE_LAYLO_UI_ABSORPTION_2026-04-09.md §2.2
 * variant-numeric가 RN에서 지원 제한적이라 fontVariant 사용.
 */

import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";

type Props = {
  targetIso: string;
  accent: string;
};

type Remaining = {
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  isLive: boolean;
};

function calculate(iso: string): Remaining {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) {
    return { days: 0, hours: 0, minutes: 0, seconds: 0, isLive: true };
  }
  return {
    days: Math.floor(diff / 86_400_000),
    hours: Math.floor((diff / 3_600_000) % 24),
    minutes: Math.floor((diff / 60_000) % 60),
    seconds: Math.floor((diff / 1000) % 60),
    isLive: false,
  };
}

const pad = (n: number) => n.toString().padStart(2, "0");

export function EventOpenCountdown({ targetIso, accent }: Props) {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [r, setR] = useState<Remaining>(() => calculate(targetIso));

  useEffect(() => {
    const tick = () => setR(calculate(targetIso));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [targetIso]);

  if (r.isLive) {
    return (
      <View style={[styles.liveBox, { backgroundColor: accent }]}>
        <Text style={[styles.liveLabel, { color: colors.primaryForeground }]}>LIVE</Text>
        <Text style={[styles.liveTitle, { color: colors.primaryForeground }]}>{t("eventOpen.live")}</Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.label}>{t("eventOpen.remaining")}</Text>
      <Text
        style={[styles.count, { color: accent, textShadowColor: accent }]}
        numberOfLines={1}
        adjustsFontSizeToFit
      >
        {r.days > 0 ? `${pad(r.days)}${t("eventOpen.dayUnit")} ` : ""}
        {pad(r.hours)}
        <Text style={styles.colon}>:</Text>
        {pad(r.minutes)}
        <Text style={styles.colon}>:</Text>
        {pad(r.seconds)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: "center", gap: 8 },
  label: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 11,
    fontWeight: "600",
    letterSpacing: 2.5,
    textTransform: "uppercase",
  },
  count: {
    fontSize: 64,
    fontWeight: "900",
    letterSpacing: -2,
    fontVariant: ["tabular-nums"],
    textShadowOffset: { width: 0, height: 0 },
    textShadowRadius: 32,
  },
  colon: { color: "rgba(255,255,255,0.3)" },
  liveBox: {
    alignItems: "center",
    paddingHorizontal: 32,
    paddingVertical: 24,
    borderRadius: 24,
    gap: 8,
  },
  liveLabel: {
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 2.5,
  },
  liveTitle: { fontSize: 24, fontWeight: "900" },
});
