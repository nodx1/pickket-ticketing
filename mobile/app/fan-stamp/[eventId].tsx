/**
 * 픽 상세 화면 — View / Create / Going / Upgrade 4모드
 * Route: /fan-stamp/{eventId}
 *
 * 모드 분기:
 * - "new" → Create: 사진 선택 → StampEditor → 저장
 * - 기존 eventId + picks 있음 → View: PickDetailViewer
 * - 기존 eventId + Going 픽만 있음 → Upgrade: 사진 선택 → completed로 전환
 * - 기존 eventId + picks 없음 → Create
 */
import { useState, useMemo, useCallback } from "react";
import { View, Text, StyleSheet, Pressable, Alert, ActivityIndicator, TouchableOpacity } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { useQuery } from "@tanstack/react-query";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { isFeatureEnabled } from "@/config/features";
import { EmptyState } from "@/components/common/EmptyState";
import { StampEditor } from "@/components/fan-stamp/StampEditor";
import { PickDetailViewer } from "@/components/picks/PickDetailViewer";
import { PickCelebration } from "@/components/picks/PickCelebration";
import { usePicksByEvent, useCreatePick, useDeletePick } from "@/hooks/usePicks";
import { useFanProfile } from "@/hooks/useFanProfile";
import { useFriendsList } from "@/hooks/useFriends";
import { FriendTagger, type TaggableFriend } from "@/components/picks/FriendTagger";
import Ionicons from "@expo/vector-icons/Ionicons";
import type { StampAssets, FanStamp } from "@/types/fan-stamp";
import { getStampAssets } from "@/config/api";
import { useEvent } from "@/hooks/useEvents";

// expo-image-picker는 네이티브 모듈 — dev client 재빌드 필요
let ImagePicker: typeof import("expo-image-picker") | null = null;
try {
  ImagePicker = require("expo-image-picker");
  } catch {
  // 네이티브 모듈 미설치 시 무시
}

type ScreenMode = "view" | "create" | "upgrade";

export default function FanStampScreen() {
  const params = useLocalSearchParams<{ eventId: string | string[] }>();
  const eventIdParam = Array.isArray(params.eventId) ? params.eventId[0] : params.eventId;
  const isNewRoute = !eventIdParam || eventIdParam === "new";
  const eventId = isNewRoute ? "" : eventIdParam;
  const router = useRouter();
  const { colors, typography, spacing, radius } = useTheme();
  const { t, i18n } = useTranslation();

  // 데이터
  const { data: event, isLoading: eventLoading, isError: eventError, refetch: refetchEvent } = useEvent(eventId);
  const { picks, isLoading: picksLoading } = usePicksByEvent(eventId);
  const { data: fanProfile } = useFanProfile();
  const { data: assets, refetch: refetchAssets } = useQuery<StampAssets | null>({
    queryKey: ["stampAssets", eventId],
    queryFn: async () => {
      try {
        return await getStampAssets(eventId);
  } catch {
        return null;
      }
    },
    enabled: !!eventId,
  });

  const createPick = useCreatePick();
  const deletePick = useDeletePick();
  const { data: friendsData } = useFriendsList();

  // UI 상태
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [showCelebration, setShowCelebration] = useState(false);
  const [celebrationSeqNum, setCelebrationSeqNum] = useState<number | undefined>();
  const [forceMode, setForceMode] = useState<ScreenMode | null>(null);
  const [taggedFriends, setTaggedFriends] = useState<TaggableFriend[]>([]);
  const [showFriendTagger, setShowFriendTagger] = useState(false);

  const friendsList: TaggableFriend[] = useMemo(
    () =>
      (friendsData?.friends ?? []).map((f) => ({
        id: f.id,
        name: f.name ?? "",
        avatar_url: f.profile_image_url ?? undefined,
      })),
    [friendsData],
  );

  const handleSelectFriend = useCallback((friend: TaggableFriend) => {
    setTaggedFriends((prev) => [...prev, friend]);
  }, []);

  const handleDeselectFriend = useCallback((friendId: string) => {
    setTaggedFriends((prev) => prev.filter((f) => f.id !== friendId));
  }, []);

  // 모드 판별
  const screenMode: ScreenMode = useMemo(() => {
    if (forceMode) return forceMode;
    if (isNewRoute) return "create";
    if (picksLoading) return "view"; // 로딩 중 기본
    if (picks.length === 0) return "create";
    return "view";
  }, [forceMode, isNewRoute, picksLoading, picks]);

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(i18n.language, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    [i18n.language],
  );

  // ── 피처플래그 OFF ──
  if (!isFeatureEnabled("FAN_STAMP")) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["top"]}>
        <Stack.Screen
          options={{
            title: t("picks.title"),
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.foreground,
          }}
        />
        <EmptyState icon="camera-outline" title={t("fanStamp.comingSoon")} message={t("fanStamp.comingSoonDesc")} />
      </SafeAreaView>
    );
  }

  // ── 로딩 ──
  if (!isNewRoute && (eventLoading || picksLoading)) {
    return (
      <SafeAreaView style={[styles.container, styles.center, { backgroundColor: colors.background }]} edges={["top"]}>
        <Stack.Screen
          options={{
            title: t("picks.title"),
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.foreground,
          }}
        />
        <ActivityIndicator size="large" color={colors.primary} />
        <Text style={[typography.body, { color: colors.mutedForeground, marginTop: spacing.lg }]}>
          {t("common.loading")}
        </Text>
      </SafeAreaView>
    );
  }

  // ── 이벤트 로드 실패 ──
  if (!isNewRoute && (eventError || !event)) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["top"]}>
        <Stack.Screen
          options={{
            title: t("picks.title"),
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.foreground,
          }}
        />
        <EmptyState
          icon="image-outline"
          title={t("fanStamp.loadFailed")}
          message={t("fanStamp.loadFailedDesc")}
          actionLabel={t("common.retry")}
          onAction={() => {
            void refetchEvent();
            void refetchAssets();
          }}
        />
      </SafeAreaView>
    );
  }

  const eventTitle = event?.title ?? t("fanStamp.defaultEventTitle");
  const eventDate = event?.event_date ? dateFormatter.format(new Date(event.event_date)) : t("fanStamp.dateTbd");
  const venue = event?.venue ?? event?.location_city ?? t("fanStamp.venueTbd");
  const brandColor = assets?.brandColor ?? colors.primary;

  // ── 사진 선택 ──
  const requestPermissionAndPick = async (source: "camera" | "gallery") => {
    if (!ImagePicker) {
      Alert.alert(t("common.error"), t("fanStamp.imagePickerUnavailable"));
      return;
    }
    if (source === "camera") {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(t("common.error"), t("voice.permissionDenied"));
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.9,
      });
      if (!result.canceled && result.assets[0]) {
        setPhotoUri(result.assets[0].uri);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }
    } else {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== "granted") {
        Alert.alert(t("common.error"), t("voice.permissionDenied"));
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsEditing: true,
        aspect: [1, 1],
        quality: 0.9,
      });
      if (!result.canceled && result.assets[0]) {
        setPhotoUri(result.assets[0].uri);
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      }
    }
  };

  // ── 저장 ──
  const handleSave = async (uri: string) => {
    if (eventId) {
      try {
        const result = await createPick.mutateAsync({
          eventId,
          imageUri: uri,
          status: "completed",
        });
        setCelebrationSeqNum(result.sequence_number);
        setShowCelebration(true);
  } catch {
        Alert.alert(t("common.error"), t("fanStamp.syncFailed"), [
          { text: t("common.confirm"), onPress: () => router.back() },
        ]);
        return;
      }
    }
  };

  // ── 삭제 ──
  const handleDelete = (pickId: string) => {
    deletePick.mutate(pickId, {
      onSuccess: () => {
        if (picks.length <= 1) {
          router.back();
        }
      },
    });
  };

  // ── 편집 (Going → Completed 업그레이드 포함) ──
  const handleEdit = (_pick: FanStamp) => {
    setForceMode("create");
  };

  // ── VIEW 모드 ──
  if (screenMode === "view" && picks.length > 0) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["top"]}>
        <Stack.Screen
          options={{
            title: eventTitle,
            headerStyle: { backgroundColor: colors.background },
            headerTintColor: colors.foreground,
          }}
        />
        <PickDetailViewer
          picks={picks}
          eventTitle={eventTitle}
          eventDate={eventDate}
          venue={venue}
          fanLevel={fanProfile?.level}
          onEdit={handleEdit}
          onDelete={handleDelete}
        />
      </SafeAreaView>
    );
  }

  // ── CREATE / UPGRADE 모드 ──
  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]} edges={["top"]}>
      <Stack.Screen
        options={{
          title: t("picks.create"),
          headerStyle: { backgroundColor: colors.background },
          headerTintColor: colors.foreground,
        }}
      />

      <PickCelebration
        sequenceNumber={celebrationSeqNum}
        visible={showCelebration}
        onDismiss={() => {
          setShowCelebration(false);
          setForceMode("view");
        }}
      />

      {!photoUri ? (
        <View style={styles.pickerContainer}>
          <Text style={[typography.h2, { color: colors.foreground, marginBottom: spacing.sm }]}>
            {t("picks.create")}
          </Text>
          <Text
            style={[typography.body, { color: colors.mutedForeground, marginBottom: spacing.xxl, textAlign: "center" }]}
          >
            {t("picks.selectPhoto")}
          </Text>

          <Pressable
            onPress={() => requestPermissionAndPick("camera")}
            style={[styles.pickerButton, { backgroundColor: colors.primary, borderRadius: radius.lg, marginBottom: spacing.md }]}
            accessibilityRole="button"
            accessibilityLabel={t("picks.takePhoto")}
          >
            <Text style={styles.pickerIcon}>📷</Text>
            <Text style={[typography.h4, { color: colors.primaryForeground }]}>{t("picks.takePhoto")}</Text>
          </Pressable>

          <Pressable
            onPress={() => requestPermissionAndPick("gallery")}
            style={[
              styles.pickerButton,
              { backgroundColor: colors.surface, borderRadius: radius.lg, borderWidth: 1, borderColor: colors.border },
            ]}
            accessibilityRole="button"
            accessibilityLabel={t("picks.fromGallery")}
          >
            <Text style={styles.pickerIcon}>🖼️</Text>
            <Text style={[typography.h4, { color: colors.foreground }]}>{t("picks.fromGallery")}</Text>
          </Pressable>

          {/* 같이 간 친구 태그 */}
          {friendsList.length > 0 && (
            <View style={styles.friendSection}>
              <TouchableOpacity
                style={[styles.friendToggle, { borderColor: colors.border }]}
                onPress={() => setShowFriendTagger(!showFriendTagger)}
              >
                <Ionicons name="people-outline" size={18} color={colors.primary} />
                <Text style={[{ fontSize: 14, fontWeight: "600", color: colors.primary, flex: 1 }]}>
                  {t("picks.friendTag")}
                  {taggedFriends.length > 0 ? ` (${taggedFriends.length})` : ""}
                </Text>
                <Ionicons name={showFriendTagger ? "chevron-up" : "chevron-down"} size={18} color={colors.mutedForeground} />
              </TouchableOpacity>
              {showFriendTagger && (
                <View style={styles.friendTaggerWrap}>
                  <FriendTagger
                    friends={friendsList}
                    selected={taggedFriends}
                    onSelect={handleSelectFriend}
                    onDeselect={handleDeselectFriend}
                  />
                </View>
              )}
            </View>
          )}
        </View>
      ) : (
        <StampEditor
          photoUri={photoUri}
          eventTitle={eventTitle}
          eventDate={eventDate}
          venue={venue}
          brandColor={brandColor}
          assets={assets ?? undefined}
          onSave={handleSave}
          isSaving={createPick.isPending}
        />
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { justifyContent: "center", alignItems: "center" },
  pickerContainer: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    paddingHorizontal: 32,
  },
  pickerButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    width: "100%",
    paddingVertical: 18,
    gap: 12,
    minHeight: 56,
  },
  pickerIcon: { fontSize: 24 },
  friendSection: {
    width: "100%",
    marginTop: 24,
  },
  friendToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderWidth: 1,
    borderRadius: 12,
  },
  friendTaggerWrap: {
    height: 240,
    marginTop: 8,
  },
});
