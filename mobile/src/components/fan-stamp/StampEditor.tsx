import { useCallback, useEffect, useRef, useState } from "react";
import {
  Alert,
  View,
  Text,
  StyleSheet,
  Pressable,
  Image,
  ScrollView,
  Dimensions,
  PanResponder,
  type GestureResponderEvent,
  type PanResponderGestureState,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useTheme } from "@/hooks/useTheme";
import type ViewShot from "react-native-view-shot";

// react-native-view-shot은 네이티브 모듈 — dev client 재빌드 필요
let ViewShotComponent: typeof import("react-native-view-shot").default | null = null;
try { ViewShotComponent = require("react-native-view-shot").default; } catch { /* */ }
import { useTranslation } from "react-i18next";
import { FRAME_STYLES, saveStampToLibrary, shareToInstagramStory, shareToKakao } from "@/lib/fan-stamp";
import type { StampAssets, StampFrame } from "@/types/fan-stamp";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const PREVIEW_SIZE = SCREEN_WIDTH - 48;

interface StampEditorProps {
  photoUri: string;
  eventTitle: string;
  eventDate: string;
  venue: string;
  seatInfo?: string;
  fanLevel?: number;
  brandColor: string;
  assets?: StampAssets;
  onSave: (uri: string) => Promise<void> | void;
  /** 저장+공유 완료 후 호출 — 부모가 화면 전환 등 처리 */
  onComplete?: () => void;
  isSaving?: boolean;
}

const FRAME_OPTIONS: StampFrame[] = ["default", "neon", "vintage", "minimal"];

export function StampEditor({
  photoUri,
  eventTitle,
  eventDate,
  venue,
  seatInfo,
  fanLevel,
  brandColor,
  assets,
  onSave,
  onComplete,
  isSaving = false,
}: StampEditorProps) {
  const { colors, typography, spacing, radius } = useTheme();
  const { t } = useTranslation();
  const [selectedFrame, setSelectedFrame] = useState<StampFrame>("default");
  const [signaturePos, setSignaturePos] = useState({ x: PREVIEW_SIZE / 2 - 40, y: PREVIEW_SIZE / 2 - 40 });
  const signatureStartRef = useRef(signaturePos);
  const signaturePosRef = useRef(signaturePos);
  const viewShotRef = useRef<ViewShot | null>(null);

  const frameStyle = FRAME_STYLES[selectedFrame];

  useEffect(() => {
    signaturePosRef.current = signaturePos;
  }, [signaturePos]);

  // 아티스트 서명 드래그
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        signatureStartRef.current = signaturePosRef.current;
      },
      onPanResponderMove: (
        _event: GestureResponderEvent,
        gestureState: PanResponderGestureState,
      ) => {
        const start = signatureStartRef.current;
        setSignaturePos({
          x: Math.max(0, Math.min(PREVIEW_SIZE - 80, start.x + gestureState.dx)),
          y: Math.max(0, Math.min(PREVIEW_SIZE - 80, start.y + gestureState.dy)),
        });
      },
      onPanResponderRelease: () => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      },
    }),
  ).current;

  const handleFrameSelect = useCallback(
    (frame: StampFrame) => {
      setSelectedFrame(frame);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    },
    [],
  );

  const capturePreview = useCallback(async (): Promise<string> => {
    if (viewShotRef.current?.capture) {
      return await viewShotRef.current.capture();
    }
    return photoUri;
  }, [photoUri]);

  const handleSave = useCallback(async () => {
    try {
      const capturedUri = await capturePreview();
      const saved = await saveStampToLibrary(capturedUri);
      if (!saved) {
        Alert.alert(t("common.error"), t("fanStamp.saveFailed"));
        return;
      }

      await onSave(capturedUri);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onComplete?.();
    } catch {
      Alert.alert(t("common.error"), t("fanStamp.saveFailed"));
    }
  }, [capturePreview, onSave, t]);

  const handleShareInstagram = useCallback(async () => {
    try {
      const capturedUri = await capturePreview();
      await shareToInstagramStory(capturedUri, brandColor);
    } catch {
      Alert.alert(t("common.error"), t("fanStamp.shareFailed"));
    }
  }, [brandColor, capturePreview, t]);

  const handleShareKakao = useCallback(async () => {
    try {
      const capturedUri = await capturePreview();
      await shareToKakao(capturedUri);
    } catch {
      Alert.alert(t("common.error"), t("fanStamp.shareFailed"));
    }
  }, [capturePreview, t]);

  const borderColor =
    frameStyle.borderColor ?? brandColor;

  const backgroundColor =
    "backgroundColor" in frameStyle
      ? frameStyle.backgroundColor
      : colors.card;

  const previewContent = (
    <>
      {/* User Photo */}
      <Image
        source={{ uri: photoUri }}
        style={[
          StyleSheet.absoluteFill,
          selectedFrame === "vintage" && { opacity: 0.85 },
        ]}
        resizeMode="cover"
      />

      {/* Vintage sepia overlay */}
      {selectedFrame === "vintage" && (
        <View
          style={[
            StyleSheet.absoluteFill,
            { backgroundColor: "rgba(182, 145, 90, 0.25)" },
          ]}
        />
      )}

      {/* Neon glow border effect */}
      {selectedFrame === "neon" && (
        <View
          style={[
            StyleSheet.absoluteFill,
            {
              borderWidth: 2,
              borderColor: brandColor,
              borderRadius: frameStyle.borderRadius - frameStyle.borderWidth,
              shadowColor: brandColor,
              shadowOffset: { width: 0, height: 0 },
              shadowOpacity: 0.8,
              shadowRadius: 12,
              elevation: 8,
            },
          ]}
        />
      )}

      {/* Artist Signature Overlay (draggable) */}
      {assets?.artistSignature && (
        <View
          {...panResponder.panHandlers}
          style={[
            styles.signatureOverlay,
            { left: signaturePos.x, top: signaturePos.y },
          ]}
        >
          <Image
            source={{ uri: assets.artistSignature }}
            style={styles.signatureImage}
            resizeMode="contain"
          />
        </View>
      )}

      {/* Event Logo */}
      {assets?.eventLogo && (
        <View style={styles.logoContainer}>
          <Image
            source={{ uri: assets.eventLogo }}
            style={styles.logoImage}
            resizeMode="contain"
          />
        </View>
      )}

      {/* Event Info Overlay */}
      {frameStyle.showInfo && (
        <View style={styles.infoOverlay}>
          <View style={styles.infoGradient}>
            <Text
              style={[
                typography.h4,
                styles.infoTitle,
                { color: colors.primaryForeground },
              ]}
              numberOfLines={1}
            >
              {eventTitle}
            </Text>
            <Text
              style={[
                typography.bodySmall,
                styles.infoDate,
                { color: "rgba(255,255,255,0.85)" },
              ]}
            >
              {eventDate} · {venue}
            </Text>
            {seatInfo && (
              <Text
                style={[
                  typography.micro,
                  { color: "rgba(255,255,255,0.7)" },
                ]}
              >
                {seatInfo}
              </Text>
            )}
            {fanLevel != null && fanLevel > 0 && (
              <View
                style={[
                  styles.fanBadge,
                  { backgroundColor: brandColor },
                ]}
              >
                <Text
                  style={[
                    typography.micro,
                    { color: colors.primaryForeground, fontWeight: "700" },
                  ]}
                >
                  Lv.{fanLevel}
                </Text>
              </View>
            )}
          </View>
        </View>
      )}

      {/* Watermark */}
      {frameStyle.showWatermark && (
        <View
          style={[
            styles.watermark,
            !frameStyle.showInfo && styles.watermarkMinimal,
          ]}
        >
          <Text
            style={[
              typography.micro,
              {
                color: "rgba(255,255,255,0.5)",
                fontSize: 9,
              },
            ]}
          >
            {t("fanStamp.watermark")}
          </Text>
        </View>
      )}
    </>
  );

  return (
    <View style={[styles.container, { backgroundColor: colors.background }]}>
      {/* ── Preview Area (ViewShot if available, View fallback) ── */}
      {ViewShotComponent ? (
        <ViewShotComponent
          ref={viewShotRef}
          options={{ format: "png", quality: 1, result: "tmpfile" }}
          style={[
            styles.preview,
            {
              width: PREVIEW_SIZE,
              height: PREVIEW_SIZE,
              borderWidth: frameStyle.borderWidth,
              borderColor,
              borderRadius: frameStyle.borderRadius,
              backgroundColor,
              overflow: "hidden",
            },
          ]}
        >
          {previewContent}
        </ViewShotComponent>
      ) : (
        <View
          style={[
            styles.preview,
            {
              width: PREVIEW_SIZE,
              height: PREVIEW_SIZE,
              borderWidth: frameStyle.borderWidth,
              borderColor,
              borderRadius: frameStyle.borderRadius,
              backgroundColor,
              overflow: "hidden",
            },
          ]}
        >
          {previewContent}
        </View>
      )}

      {/* ── Frame Selector ── */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[
          styles.frameSelector,
          { gap: spacing.sm },
        ]}
        style={{ marginTop: spacing.lg }}
      >
        {FRAME_OPTIONS.map((frame) => {
          const isSelected = frame === selectedFrame;
          const label =
            frame === "default"
              ? t("fanStamp.frame.default")
              : frame === "neon"
                ? t("fanStamp.frame.neon")
                : frame === "vintage"
                  ? t("fanStamp.frame.vintage")
                  : t("fanStamp.frame.minimal");

          return (
            <Pressable
              key={frame}
              onPress={() => handleFrameSelect(frame)}
              style={[
                styles.framePill,
                {
                  backgroundColor: isSelected
                    ? colors.primary
                    : colors.surface,
                  borderColor: isSelected
                    ? colors.primary
                    : colors.border,
                  borderRadius: radius.full,
                },
              ]}
              accessibilityRole="button"
              accessibilityState={{ selected: isSelected }}
              accessibilityLabel={label}
            >
              <Text
                style={[
                  typography.bodySmall,
                  {
                    color: isSelected
                      ? colors.primaryForeground
                      : colors.foreground,
                    fontWeight: isSelected ? "600" : "400",
                  },
                ]}
              >
                {label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>

      {/* ── Action Buttons ── */}
      <View style={[styles.actionsRow, { marginTop: spacing.xl, gap: spacing.md }]}>
        {/* 저장 */}
        <Pressable
          onPress={handleSave}
          disabled={isSaving}
          style={[
            styles.actionButton,
            {
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
              opacity: isSaving ? 0.6 : 1,
            },
          ]}
          accessibilityRole="button"
          accessibilityLabel={t("fanStamp.save")}
          accessibilityState={{ disabled: isSaving }}
        >
          <Text style={styles.actionIcon}>💾</Text>
          <Text
            style={[
              typography.bodySmall,
              { color: colors.foreground, marginTop: 4 },
            ]}
          >
            {isSaving ? t("common.loading") : t("fanStamp.save")}
          </Text>
        </Pressable>

        {/* 인스타그램 */}
        <Pressable
          onPress={handleShareInstagram}
          style={[
            styles.actionButton,
            {
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
            },
          ]}
          accessibilityRole="button"
          accessibilityLabel={t("fanStamp.shareInsta")}
        >
          <Text style={styles.actionIcon}>📸</Text>
          <Text
            style={[
              typography.bodySmall,
              { color: colors.foreground, marginTop: 4 },
            ]}
          >
            {t("fanStamp.shareInsta")}
          </Text>
        </Pressable>

        {/* 카카오톡 */}
        <Pressable
          onPress={handleShareKakao}
          style={[
            styles.actionButton,
            {
              backgroundColor: colors.surface,
              borderRadius: radius.lg,
            },
          ]}
          accessibilityRole="button"
          accessibilityLabel={t("fanStamp.shareKakao")}
        >
          <Text style={styles.actionIcon}>💬</Text>
          <Text
            style={[
              typography.bodySmall,
              { color: colors.foreground, marginTop: 4 },
            ]}
          >
            {t("fanStamp.shareKakao")}
          </Text>
        </Pressable>
      </View>

      {/* XP 획득 알림 */}
      <View
        style={[
          styles.xpBanner,
          {
            backgroundColor: colors.fairGlow,
            borderRadius: radius.md,
            marginTop: spacing.lg,
          },
        ]}
      >
        <Text style={[typography.bodySmall, { color: colors.fair, fontWeight: "600" }]}>
          {t("fanStamp.xpEarned")}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    paddingHorizontal: 24,
  },
  preview: {
    position: "relative",
  },
  signatureOverlay: {
    position: "absolute",
    width: 80,
    height: 80,
    zIndex: 10,
  },
  signatureImage: {
    width: 80,
    height: 80,
  },
  logoContainer: {
    position: "absolute",
    top: 12,
    left: 12,
    width: 40,
    height: 40,
  },
  logoImage: {
    width: 40,
    height: 40,
  },
  infoOverlay: {
    position: "absolute",
    bottom: 0,
    left: 0,
    right: 0,
  },
  infoGradient: {
    backgroundColor: "rgba(0,0,0,0.55)",
    paddingHorizontal: 16,
    paddingVertical: 14,
    paddingBottom: 24,
  },
  infoTitle: {
    marginBottom: 2,
  },
  infoDate: {
    marginBottom: 4,
  },
  fanBadge: {
    alignSelf: "flex-start",
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 8,
    marginTop: 6,
  },
  watermark: {
    position: "absolute",
    bottom: 6,
    alignSelf: "center",
  },
  watermarkMinimal: {
    bottom: 8,
    right: 8,
    alignSelf: undefined,
  },
  frameSelector: {
    paddingHorizontal: 4,
    alignItems: "center",
  },
  framePill: {
    paddingHorizontal: 20,
    paddingVertical: 10,
    borderWidth: 1.5,
    minHeight: 44, // Apple HIG 터치 타겟
  },
  actionsRow: {
    flexDirection: "row",
    justifyContent: "center",
  },
  actionButton: {
    alignItems: "center",
    justifyContent: "center",
    paddingVertical: 14,
    paddingHorizontal: 20,
    minWidth: 88,
    minHeight: 44,
  },
  actionIcon: {
    fontSize: 24,
  },
  xpBanner: {
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignItems: "center",
  },
});
