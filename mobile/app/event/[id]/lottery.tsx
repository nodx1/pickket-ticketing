/**
 * 복권(마일리지 경매) 화면
 * v2 web consumer LotteryWidget.tsx 기반 완전 이식
 *
 * 플로우:
 *   1. 이미 응모 여부 확인 (getMyEventStatus)
 *   2. 추첨 현황 표시 (경쟁률 바 + 카운트다운)
 *   3. AP 투자 슬라이더 + 유효 가중치/당첨 확률 실시간 계산
 *   4. 응모 → client_seed 생성 → confirmation_id 표시
 *   5. 배분 완료 시 → 당첨/미당첨 결과 인라인 표시
 */
import { useState, useEffect, useCallback, useMemo } from "react";
import {
  View,
  Text,
  ScrollView,
  Alert,
  StyleSheet,
  Pressable,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter, Stack } from "expo-router";
import { useTranslation } from "react-i18next";
import * as Crypto from "expo-crypto";
// expo-clipboard is optional — fallback to Alert
let Clipboard: { setStringAsync?: (s: string) => Promise<boolean> } | null = null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
try { Clipboard = require("expo-clipboard"); } catch (_err: unknown) { /* not installed */ }
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import * as haptics from "@/lib/haptics";
import { useEvent } from "@/hooks/useEvents";
import {
  useLotteryStatus,
  useApplyLottery,
  useMyEventStatus,
  useMyResult,
} from "@/hooks/useLottery";
import { usePointBalance } from "@/hooks/usePoints";
import { useAuthStore } from "@/hooks/useAuth";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/ui/Skeleton";
import { formatKRW, formatEventDate } from "@/lib/format";
import i18n from "@/i18n";
import type { MyResult } from "@/config/api";

// ── 상수 (v2 web과 동일) ──
const AP_MAX_INVEST = 10_000;
const AP_STEP = 100;
const WEIGHT_CAP = 50;

export default function LotteryScreen() {
  const { t } = useTranslation();
  const { colors } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{
    id: string;
    tierId: string;
    tierName: string;
    tierPrice: string;
  }>();
  const eventId = typeof params.id === "string" ? params.id : params.id?.[0] ?? "";
  const tierId = typeof params.tierId === "string" ? params.tierId : "";
  const tierName = typeof params.tierName === "string" ? params.tierName : "";
  const tierPrice = Number(params.tierPrice) || 0;

  // ── 데이터 훅 ──
  const { data: event } = useEvent(eventId);
  const { data: lotteryStatus, isLoading: statusLoading, isError: statusError } = useLotteryStatus(eventId, tierId);
  const { data: myEventStatus } = useMyEventStatus(eventId);
  const { data: pointData } = usePointBalance();
  const applyMutation = useApplyLottery(eventId, tierId);

  // 배분 완료 시 결과 조회
  const isAllocated = event?.status === "allocated" || event?.status === "completed";
  const { data: myResult } = useMyResult(eventId, isAllocated);

  // ── 상태 ──
  const [quantity, setQuantity] = useState(1);
  const [investedAp, setInvestedAp] = useState(0);
  const [applied, setApplied] = useState(false);
  const [confirmationId, setConfirmationId] = useState<string | null>(null);
  const [countdown, setCountdown] = useState("");

  // 이미 응모 확인 → 상태 복원
  useEffect(() => {
    if (myEventStatus?.has_lottery_entry) {
      setApplied(true);
      setConfirmationId(myEventStatus.lottery_entry_id);
      if (myEventStatus.invested_ap > 0) setInvestedAp(myEventStatus.invested_ap);
      if (myEventStatus.lottery_group_size > 1) setQuantity(myEventStatus.lottery_group_size);
    }
  }, [myEventStatus]);

  // ── 카운트다운 타이머 ──
  const biddingClosesAt = event?.bidding_closes_at;
  useEffect(() => {
    if (!biddingClosesAt) return;
    const update = () => {
      const diff = new Date(biddingClosesAt).getTime() - Date.now();
      if (diff <= 0) {
        setCountdown(t("lottery.deadlineExpired"));
        return;
      }
      const d = Math.floor(diff / 86400000);
      const h = Math.floor((diff % 86400000) / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);
      setCountdown(
        d > 0
          ? t("lottery.countdownDhm", { d, h, m })
          : `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`,
      );
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [biddingClosesAt, t]);

  // ── 계산 (v2 web 동일) ──
  // pool이 아직 생성 전일 수 있음 (첫 응모 시 자동 생성) — 티어 capacity로 fallback
  const tierCapacity = event?.seat_tiers?.find((t) => t.id === tierId)?.capacity ?? 0;
  const displayStatus = lotteryStatus ?? (statusError ? { total_seats: tierCapacity, total_applicants: event?.bid_count ?? 0, status: "pending" } : null);
  const applicants = displayStatus?.total_applicants ?? event?.bid_count ?? 0;
  const capacity = displayStatus?.total_seats ?? tierCapacity;
  const competitionRatio = capacity > 0 ? applicants / capacity : 0;
  const competitionPct = Math.min(competitionRatio * 100, 100);

  const apBalance = pointData ? pointData.fan + pointData.social : null;
  const apMax = apBalance !== null ? Math.min(AP_MAX_INVEST, apBalance) : AP_MAX_INVEST;
  const effectiveWeight = Math.min(Math.sqrt(investedAp), WEIGHT_CAP);
  const avgWeight = Math.sqrt(500); // ~22.4 median assumption

  const estimatedProb = useMemo(() => {
    if (applicants <= 0 || capacity <= 0 || effectiveWeight <= 0) return 0;
    return Math.min((effectiveWeight / (avgWeight * applicants)) * capacity * 100, 100);
  }, [effectiveWeight, avgWeight, applicants, capacity]);

  const matchedTier = event?.seat_tiers?.find((st) => st.id === tierId);
  const maxQty = (matchedTier as unknown as { max_group_size?: number })?.max_group_size ?? 4;

  // ── 색상 ──
  const getRatioColor = () => {
    if (competitionRatio >= 2) return colors.destructive;
    if (competitionRatio >= 1) return colors.warning;
    return colors.success;
  };

  const getProbColor = () => {
    if (estimatedProb >= 10) return colors.success;
    if (estimatedProb >= 5) return colors.warning;
    return colors.destructive;
  };

  // ── 핸들러 ──
  const handleApply = useCallback(async () => {
    const user = useAuthStore.getState().user;
    if (!user) {
      Alert.alert(t("lottery.loginFirst"));
      return;
    }

    Alert.alert(
      t("lottery.confirmTitle"),
      t("lottery.confirmMessage", { qty: quantity, price: formatKRW(tierPrice) }),
      [
        { text: t("common.cancel"), style: "cancel" },
        {
          text: t("common.confirm"),
          onPress: async () => {
            try {
              const clientSeed = Crypto.randomUUID();
              const result = await applyMutation.mutateAsync({
                group_size: quantity,
                client_seed: clientSeed,
                invested_ap: investedAp > 0 ? investedAp : undefined,
              });
              setApplied(true);
              setConfirmationId(result.id);
              haptics.success();
              Alert.alert(t("lottery.applied"), t("lottery.appliedWait"));
            } catch (err: unknown) {
              const { isAxiosError } = await import("axios");
              if (isAxiosError(err)) {
                const status = err.response?.status;
                if (status === 401) {
                  Alert.alert(t("common.error"), t("lottery.loginFirst"));
                } else if (status === 409) {
                  Alert.alert(t("common.error"), t("lottery.alreadyApplied"));
                } else {
                  Alert.alert(t("common.error"), t("lottery.applyFail"));
                }
              } else {
                const msg = err instanceof Error ? err.message : t("lottery.applyFail");
                Alert.alert(t("common.error"), msg);
              }
            }
          },
        },
      ],
    );
  }, [quantity, investedAp, tierPrice, applyMutation, t]);

  const handleCopyConfirmation = useCallback(async () => {
    if (!confirmationId) return;
    if (Clipboard?.setStringAsync) {
      await Clipboard.setStringAsync(confirmationId);
    }
    Alert.alert(t("lottery.confirmationCopied"));
  }, [confirmationId, t]);

  // ── 배분 완료: 결과 화면 ──
  if (myResult) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
        <Stack.Screen options={{ title: t("lottery.resultTitle") }} />
        <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
          {myResult.won ? (
            <WonResult
              myResult={myResult}
              eventId={eventId}
              colors={colors}
              t={t}
              router={router}
            />
          ) : (
            <LostResult colors={colors} t={t} />
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── 메인 응모 화면 ──
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={[]}>
      <Stack.Screen options={{ title: t("lottery.title") }} />

      <ScrollView contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        {/* 이벤트 요약 */}
        {event && (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[typography.h4, { color: colors.foreground }]} numberOfLines={2}>
              {event.title}
            </Text>
            {event.event_date && (
              <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
                {formatEventDate(event.event_date)}
              </Text>
            )}
          </View>
        )}

        {/* 티어 정보 */}
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, marginTop: spacing.lg }]}>
          <View style={styles.row}>
            <Text style={[typography.h4, { color: colors.foreground, flex: 1 }]}>{tierName}</Text>
            <Text style={[typography.h4, { color: colors.primary }]}>{formatKRW(tierPrice)}</Text>
          </View>
          <Badge label={t("booking.saleModeLottery")} variant="outline" style={{ marginTop: spacing.sm }} />
        </View>

        {/* 추첨 현황 + 경쟁률 바 */}
        {statusLoading ? (
          <Skeleton width="100%" height={120} borderRadius={radius.xl} style={{ marginTop: spacing.lg }} />
        ) : displayStatus ? (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, marginTop: spacing.lg }]}>
            <Text style={[typography.h4, { color: colors.foreground }]}>{t("lottery.status")}</Text>

            {/* 경쟁률 프로그레스 바 */}
            <View style={[styles.progressBg, { backgroundColor: colors.muted, marginTop: spacing.md }]}>
              <View
                style={[
                  styles.progressFill,
                  { width: `${Math.min(competitionPct, 100)}%`, backgroundColor: getRatioColor() },
                ]}
              />
            </View>
            <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
              {t("lottery.currentApplicants", { count: applicants, capacity })}
            </Text>

            {/* 통계 */}
            <View style={[styles.statsRow, { marginTop: spacing.md }]}>
              <View style={styles.statItem}>
                <Text style={[typography.h3, { color: colors.primary }]}>{capacity}</Text>
                <Text style={[typography.micro, { color: colors.mutedForeground }]}>{t("lottery.totalSeats")}</Text>
              </View>
              <View style={styles.statItem}>
                <Text style={[typography.h3, { color: colors.warning }]}>{applicants}</Text>
                <Text style={[typography.micro, { color: colors.mutedForeground }]}>{t("lottery.totalApplicants")}</Text>
              </View>
              <View style={styles.statItem}>
                <Text style={[typography.h3, { color: getRatioColor() }]}>{competitionRatio.toFixed(2)}:1</Text>
                <Text style={[typography.micro, { color: colors.mutedForeground }]}>{t("lottery.competitionRatio")}</Text>
              </View>
            </View>
          </View>
        ) : null}

        {/* 마감 카운트다운 */}
        {biddingClosesAt && countdown && (
          <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, marginTop: spacing.md }]}>
            <View style={styles.row}>
              <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>{t("lottery.deadline")}</Text>
              <Text style={[typography.h4, { color: countdown === t("lottery.deadlineExpired") ? colors.destructive : colors.foreground }]}>
                {countdown}
              </Text>
            </View>
          </View>
        )}

        {/* 이미 응모한 경우 */}
        {applied ? (
          <View style={[styles.card, { backgroundColor: colors.success + "15", borderColor: colors.success, marginTop: spacing.lg }]}>
            <Text style={[typography.h4, { color: colors.success }]}>{t("lottery.appliedTitle")}</Text>
            <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
              {t("lottery.appliedWait")}
            </Text>
            {confirmationId && (
              <Pressable
                onPress={handleCopyConfirmation}
                style={[styles.confirmationRow, { marginTop: spacing.md }]}
                accessibilityLabel={t("lottery.copyConfirmationLabel")}
                accessibilityRole="button"
              >
                <Text style={[typography.micro, { color: colors.mutedForeground }]}>{t("lottery.confirmationLabel")}</Text>
                <Text style={[typography.bodySmall, { color: colors.primary }]} numberOfLines={1}>
                  {confirmationId}
                </Text>
                <Text style={[typography.micro, { color: colors.primary }]}>{t("common.copy")}</Text>
              </Pressable>
            )}
          </View>
        ) : (
          <>
            {/* 수량 선택 */}
            <View style={{ marginTop: spacing.xl }}>
              <Text style={[typography.h4, { color: colors.foreground }]}>{t("lottery.quantity")}</Text>
              <Text style={[typography.micro, { color: colors.mutedForeground, marginTop: spacing.xs }]}>
                {t("lottery.qtyInfo", { max: maxQty })}
              </Text>
              <View style={styles.groupRow}>
                {Array.from({ length: maxQty }, (_, i) => i + 1).map((n) => (
                  <Button
                    key={n}
                    title={`${n}`}
                    variant={quantity === n ? "primary" : "outline"}
                    size="md"
                    onPress={() => setQuantity(n)}
                    style={{ flex: 1 }}
                  />
                ))}
              </View>
            </View>

            {/* AP 투자 슬라이더 */}
            <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, marginTop: spacing.xl }]}>
              <View style={styles.row}>
                <Text style={[typography.h4, { color: colors.foreground }]}>{t("lottery.apInvestTitle")}</Text>
                {apBalance !== null && (
                  <Text style={[typography.micro, { color: colors.mutedForeground }]}>
                    {t("lottery.apBalance", { balance: apBalance.toLocaleString() })}
                  </Text>
                )}
              </View>

              {/* 슬라이더 (네이티브 View 기반) */}
              <View style={{ marginTop: spacing.md }}>
                <View style={[styles.sliderTrack, { backgroundColor: colors.muted }]}>
                  <View
                    style={[
                      styles.sliderFill,
                      {
                        width: `${apMax > 0 ? (investedAp / apMax) * 100 : 0}%`,
                        backgroundColor: colors.primary,
                      },
                    ]}
                  />
                </View>
                <View style={[styles.sliderBtnRow, { marginTop: spacing.sm }]}>
                  <Pressable
                    onPress={() => setInvestedAp(Math.max(0, investedAp - AP_STEP))}
                    style={[styles.sliderBtn, { backgroundColor: colors.muted }]}
                    accessibilityLabel={`AP -${AP_STEP}`}
                    accessibilityRole="button"
                  >
                    <Text style={[typography.h4, { color: colors.foreground }]}>−</Text>
                  </Pressable>
                  <Text
                    style={[typography.h3, { color: colors.primary, minWidth: 80, textAlign: "center" }]}
                    accessibilityLabel={`${investedAp} AP`}
                  >
                    {investedAp.toLocaleString()} AP
                  </Text>
                  <Pressable
                    onPress={() => setInvestedAp(Math.min(apMax, investedAp + AP_STEP))}
                    style={[styles.sliderBtn, { backgroundColor: colors.muted }]}
                    accessibilityLabel={`AP +${AP_STEP}`}
                    accessibilityRole="button"
                  >
                    <Text style={[typography.h4, { color: colors.foreground }]}>+</Text>
                  </Pressable>
                </View>
              </View>

              {/* 유효 가중치 + 당첨 확률 */}
              {investedAp > 0 ? (
                <View style={[styles.statsRow, { marginTop: spacing.md }]}>
                  <View style={styles.statItem}>
                    <Text style={[typography.h4, { color: colors.primary }]}>{effectiveWeight.toFixed(1)}</Text>
                    <Text style={[typography.micro, { color: colors.mutedForeground }]}>{t("lottery.effectiveWeight")}</Text>
                  </View>
                  <View style={styles.statItem}>
                    <Text style={[typography.h4, { color: getProbColor() }]}>{estimatedProb.toFixed(1)}%</Text>
                    <Text style={[typography.micro, { color: colors.mutedForeground }]}>{t("lottery.estimatedProb")}</Text>
                  </View>
                </View>
              ) : (
                <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.sm, fontStyle: "italic" }]}>
                  {t("lottery.noInvestHint")}
                </Text>
              )}
            </View>

            {/* 공정성 안내 */}
            <Text style={[typography.micro, { color: colors.mutedForeground, marginTop: spacing.lg, textAlign: "center" }]}>
              {t("lottery.fairnessInfo")}
            </Text>

            {/* 연령 등급 면책조항 */}
            <Text style={[typography.micro, { color: colors.mutedForeground, marginTop: spacing.sm, textAlign: "center" }]}>
              {t("lottery.disclaimer")}
            </Text>

            {/* 응모 버튼 */}
            <Button
              title={applyMutation.isPending ? t("lottery.submitting") : t("lottery.apply")}
              onPress={handleApply}
              disabled={applyMutation.isPending}
              size="xl"
              style={{ marginTop: spacing.lg }}
            />
          </>
        )}

        <View style={{ height: 40 }} />
      </ScrollView>
    </SafeAreaView>
  );
}

// ── 당첨 결과 ──
function WonResult({
  myResult,
  eventId,
  colors,
  t,
  router,
}: {
  myResult: MyResult;
  eventId: string;
  colors: Record<string, string>;
  t: (key: string) => string;
  router: ReturnType<typeof useRouter>;
}) {
  const savings =
    myResult.bid_price !== null && myResult.final_price !== null
      ? myResult.bid_price - myResult.final_price
      : 0;

  return (
    <>
      {/* 당첨 헤더 */}
      <View style={[styles.resultCard, { backgroundColor: colors.success + "15", borderColor: colors.success }]}>
        <Text style={[typography.h2, { color: colors.success, textAlign: "center" }]}>🎉</Text>
        <Text style={[typography.h3, { color: colors.success, textAlign: "center", marginTop: spacing.sm }]}>
          {t("lottery.resultWon")}
        </Text>
      </View>

      {/* 좌석 정보 */}
      {(myResult.tier_name || myResult.seat_label) && (
        <View style={[styles.infoRow, { marginTop: spacing.md }]}>
          {myResult.tier_name && (
            <Text style={[typography.body, { color: colors.foreground }]}>
              {myResult.tier_name}{myResult.seat_label ? ` · ${myResult.seat_label}` : ""}
            </Text>
          )}
        </View>
      )}

      {/* 가격 카드 */}
      {myResult.fair_price !== null && (
        <PriceCard label={t("lottery.allocationPrice")} value={myResult.fair_price} colors={colors} />
      )}
      {myResult.final_price !== null && (
        <PriceCard label={t("lottery.finalPrice")} value={myResult.final_price} colors={colors} highlight />
      )}
      {savings > 0 && (
        <PriceCard label={t("lottery.savings")} value={savings} colors={colors} note={t("lottery.savingsNote")} isPositive />
      )}

      {/* 결제 브리지 */}
      {myResult.order_id && (
        <View style={{ marginTop: spacing.xl }}>
          <Text style={[typography.bodySmall, { color: colors.warning, textAlign: "center" }]}>
            {myResult.payment_deadline
              ? `${t("lottery.payDeadlineWarn")} (${new Date(myResult.payment_deadline).toLocaleString(i18n.language?.startsWith("ko") ? "ko-KR" : "en-US")})`
              : t("lottery.payDeadlineWarn")}
          </Text>
          <Button
            title={t("lottery.payNow")}
            onPress={() =>
              router.push({
                pathname: "/event/[id]/payment",
                params: { id: eventId, orderId: myResult.order_id! },
              })
            }
            size="xl"
            style={{ marginTop: spacing.md }}
          />
        </View>
      )}
    </>
  );
}

// ── 미당첨 결과 ──
function LostResult({ colors, t }: { colors: Record<string, string>; t: (key: string) => string }) {
  return (
    <>
      <View style={[styles.resultCard, { backgroundColor: colors.warning + "15", borderColor: colors.warning }]}>
        <Text style={[typography.h3, { color: colors.warning, textAlign: "center" }]}>
          {t("lottery.resultLost")}
        </Text>
      </View>

      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border, marginTop: spacing.lg }]}>
        <Text style={[typography.h4, { color: colors.foreground, marginBottom: spacing.sm }]}>💡</Text>
        <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>{t("lottery.lostTip1")}</Text>
        <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginTop: spacing.xs }]}>{t("lottery.lostTip2")}</Text>
      </View>
    </>
  );
}

// ── 가격 카드 ──
function PriceCard({
  label,
  value,
  colors,
  highlight,
  note,
  isPositive,
}: {
  label: string;
  value: number;
  colors: Record<string, string>;
  highlight?: boolean;
  note?: string;
  isPositive?: boolean;
}) {
  return (
    <View
      style={[
        styles.card,
        {
          backgroundColor: highlight ? colors.primary + "10" : colors.card,
          borderColor: highlight ? colors.primary : colors.border,
          marginTop: spacing.md,
        },
      ]}
    >
      <Text style={[typography.bodySmall, { color: colors.mutedForeground }]}>{label}</Text>
      <Text
        style={[
          typography.h3,
          { color: isPositive ? colors.success : highlight ? colors.primary : colors.foreground, marginTop: spacing.xs },
        ]}
      >
        {isPositive ? "−" : ""}{formatKRW(value)}
      </Text>
      {note && (
        <Text style={[typography.micro, { color: colors.mutedForeground, marginTop: spacing.xs }]}>{note}</Text>
      )}
    </View>
  );
}

// ── 스타일 ──
const styles = StyleSheet.create({
  container: { flex: 1 },
  body: { padding: spacing.xl },
  card: {
    padding: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 1,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  infoRow: {
    alignItems: "center",
    paddingVertical: spacing.sm,
  },
  statsRow: {
    flexDirection: "row",
    justifyContent: "space-around",
  },
  statItem: {
    alignItems: "center",
  },
  groupRow: {
    flexDirection: "row",
    gap: spacing.sm,
    marginTop: spacing.md,
  },
  progressBg: {
    height: 8,
    borderRadius: 4,
    overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    borderRadius: 4,
  },
  confirmationRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
  },
  sliderTrack: {
    height: 6,
    borderRadius: 3,
    overflow: "hidden",
  },
  sliderFill: {
    height: "100%",
    borderRadius: 3,
  },
  sliderBtnRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xl,
  },
  sliderBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
  resultCard: {
    padding: spacing.xl,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
});
