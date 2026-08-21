/**
 * EventOpenSubscribeSheet — 1-필드 opt-in 바텀시트 + 축하 화면
 * DICE 바텀시트 일원화 + Laylo 단일 CTA + 순번 공개 축하 DNA.
 *
 * Phase 4.3: 실 API 연동 + 카운트업 애니메이션 + 순번 BounceIn 배지
 */

import { useState } from "react";
import {
  Modal,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
  ActivityIndicator,
  Alert,
} from "react-native";
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  BounceIn,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { subscribeOpenNotification } from "@/config/api";

type Props = {
  visible: boolean;
  eventId: string;
  eventTitle: string;
  accent: string;
  accentFg: string;
  baseSubscriberCount: number;
  onClose: () => void;
};

type SheetState =
  | { status: "form" }
  | { status: "submitting" }
  | { status: "done"; rank: number; newCount: number };

export function EventOpenSubscribeSheet({
  visible,
  eventId,
  eventTitle,
  accent,
  accentFg,
  baseSubscriberCount: _baseSubscriberCount,
  onClose,
}: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<SheetState>({ status: "form" });
  const [phone, setPhone] = useState("");

  const subscribeMutation = useMutation({
    mutationFn: () => subscribeOpenNotification(eventId, "sms"),
    onSuccess: (data) => {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setState({
        status: "done",
        rank: data.subscriber_count,
        newCount: data.subscriber_count,
      });
    },
    onError: () => {
      Alert.alert(t("eventOpen.errorTitle"), t("eventOpen.subscribeFailed"));
      setState({ status: "form" });
    },
  });

  async function handleSubmit() {
    const cleaned = phone.replace(/-/g, "");
    if (!/^01[0-9]{8,9}$/.test(cleaned)) {
      Alert.alert(t("eventOpen.phoneErrorTitle"), t("eventOpen.phoneInvalid"));
      return;
    }
    setState({ status: "submitting" });
    Haptics.selectionAsync();
    subscribeMutation.mutate();
  }

  function handleClose() {
    setState({ status: "form" });
    setPhone("");
    onClose();
  }

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={handleClose}
    >
      <Pressable style={styles.backdrop} onPress={handleClose}>
        <Pressable style={styles.sheet} onPress={(e) => e.stopPropagation()}>
          <View style={styles.grabber} />

          {state.status === "done" ? (
            <SuccessContent
              rank={state.rank}
              eventTitle={eventTitle}
              accent={accent}
              onClose={handleClose}
            />
          ) : (
            <>
              <Text style={styles.title}>{t("eventOpen.subscribeCta")}</Text>
              <Text style={styles.desc}>{t("eventOpen.sheetDesc")}</Text>

              <TextInput
                value={phone}
                onChangeText={setPhone}
                placeholder="010-0000-0000"
                placeholderTextColor="rgba(255,255,255,0.3)"
                keyboardType="phone-pad"
                style={styles.input}
                autoFocus
                maxLength={13}
              />

              <Pressable
                onPress={handleSubmit}
                disabled={state.status === "submitting"}
                style={[
                  styles.cta,
                  {
                    backgroundColor: accent,
                    opacity: state.status === "submitting" ? 0.6 : 1,
                  },
                ]}
              >
                {state.status === "submitting" ? (
                  <ActivityIndicator color={accentFg} />
                ) : (
                  <Text style={[styles.ctaText, { color: accentFg }]}>
                    {t("eventOpen.submit")}
                  </Text>
                )}
              </Pressable>

              <Text style={styles.privacy}>{t("eventOpen.privacy")}</Text>
            </>
          )}
        </Pressable>
      </Pressable>
    </Modal>
  );
}

function SuccessContent({
  rank,
  eventTitle,
  accent,
  onClose,
}: {
  rank: number;
  eventTitle: string;
  accent: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // 카운트업 애니메이션
  const countProgress = useSharedValue(0);

  // 진입 시 0→1 애니메이션
  countProgress.value = withTiming(1, { duration: 800 });

  const countStyle = useAnimatedStyle(() => ({
    opacity: 0.3 + countProgress.value * 0.7,
    transform: [{ scale: 0.8 + countProgress.value * 0.2 }],
  }));

  return (
    <View style={styles.successWrap}>
      <Text style={styles.party}>🎉</Text>
      <Text style={styles.successSub}>{t("eventOpen.youAre")}</Text>

      {/* 카운트업 + BounceIn 순번 배지 */}
      <Animated.View entering={BounceIn.delay(200).springify()}>
        <Animated.Text style={[styles.successRank, { color: accent }, countStyle]}>
          #{rank.toLocaleString()}
        </Animated.Text>
      </Animated.View>

      {/* 팬 순번 배지 */}
      <Animated.View
        entering={BounceIn.delay(500).springify()}
        style={[styles.fanBadge, { backgroundColor: accent + "20" }]}
      >
        <Text style={[styles.fanBadgeText, { color: accent }]}>
          #{rank.toLocaleString()}
          {t("eventOpen.fanRankSuffix")}
        </Text>
      </Animated.View>

      <Text style={styles.successTitle}>{eventTitle}</Text>
      <Text style={styles.successNote}>{t("eventOpen.notifySchedule")}</Text>

      <View style={styles.shareRow}>
        {["카카오", "스토리", "X"].map((label) => (
          <Pressable
            key={label}
            style={styles.shareBtn}
            onPress={() =>
              Alert.alert(
                t("eventOpen.shareTitle"),
                t("eventOpen.sharePrototype", { label }),
              )
            }
          >
            <Text style={styles.shareBtnText}>{label}</Text>
          </Pressable>
        ))}
      </View>

      <Pressable onPress={onClose} style={styles.closeBtn}>
        <Text style={styles.closeText}>{t("eventOpen.close")}</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: "#15151A",
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    paddingHorizontal: 24,
    paddingTop: 12,
    paddingBottom: 40,
  },
  grabber: {
    alignSelf: "center",
    width: 48,
    height: 4,
    borderRadius: 2,
    backgroundColor: "rgba(255,255,255,0.2)",
    marginBottom: 24,
  },
  title: { color: "#FFFFFF", fontSize: 24, fontWeight: "900", marginBottom: 8 },
  desc: {
    color: "rgba(255,255,255,0.6)",
    fontSize: 14,
    marginBottom: 24,
    lineHeight: 20,
  },
  input: {
    height: 56,
    backgroundColor: "rgba(255,255,255,0.06)",
    borderRadius: 16,
    paddingHorizontal: 20,
    color: "#FFFFFF",
    fontSize: 18,
    fontWeight: "600",
    marginBottom: 16,
  },
  cta: {
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  ctaText: { fontSize: 16, fontWeight: "700" },
  privacy: {
    color: "rgba(255,255,255,0.4)",
    fontSize: 11,
    textAlign: "center",
    marginTop: 16,
  },

  successWrap: { alignItems: "center", gap: 6, paddingVertical: 8 },
  party: { fontSize: 40 },
  successSub: { color: "rgba(255,255,255,0.6)", fontSize: 14 },
  successRank: {
    fontSize: 56,
    fontWeight: "900",
    fontVariant: ["tabular-nums"],
    lineHeight: 60,
  },
  fanBadge: {
    borderRadius: 9999,
    paddingHorizontal: 16,
    paddingVertical: 6,
    marginTop: 4,
  },
  fanBadgeText: {
    fontSize: 14,
    fontWeight: "700",
  },
  successTitle: {
    color: "#FFFFFF",
    fontSize: 16,
    fontWeight: "700",
    marginTop: 12,
    textAlign: "center",
  },
  successNote: {
    color: "rgba(255,255,255,0.5)",
    fontSize: 12,
    marginTop: 4,
    textAlign: "center",
  },
  shareRow: { flexDirection: "row", gap: 12, marginTop: 20 },
  shareBtn: {
    height: 44,
    minWidth: 80,
    paddingHorizontal: 16,
    borderRadius: 22,
    backgroundColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
    justifyContent: "center",
  },
  shareBtnText: { color: "#FFFFFF", fontSize: 12, fontWeight: "600" },
  closeBtn: { marginTop: 20, padding: 12 },
  closeText: { color: "rgba(255,255,255,0.5)", fontSize: 14 },
});
