/**
 * 라이브 로그 화면 — 공연 중/후 실시간 기록
 * 피처플래그: LIVE_LOG
 */
import { useState, useCallback } from "react";
import { View, Text, ScrollView, TextInput, TouchableOpacity, StyleSheet, KeyboardAvoidingView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, { FadeIn } from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Stack, useLocalSearchParams } from "expo-router";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { typography, spacing, radius } from "@/config/theme";
import { isFeatureEnabled } from "@/config/features";
import { EmptyState } from "@/components/common/EmptyState";
import { SetlistTracker } from "@/components/livelog/SetlistTracker";
import { LiveLogEntryCard } from "@/components/livelog/LiveLogEntry";
import * as haptics from "@/lib/haptics";
import type { LiveLogEntry, SetlistItem } from "@/types/livelog";

// Mock setlist
const MOCK_SETLIST: SetlistItem[] = [
  { order: 1, title: "ELEVEN", is_encore: false },
  { order: 2, title: "LOVE DIVE", is_encore: false },
  { order: 3, title: "After LIKE", is_encore: false },
  { order: 4, title: "Kitsch", is_encore: false },
  { order: 5, title: "I AM", is_encore: false },
  { order: 6, title: "Baddie", is_encore: false },
  { order: 7, title: "HEYA", is_encore: true },
  { order: 8, title: "Accendio", is_encore: true },
];

const MOCK_ENTRIES: LiveLogEntry[] = [
  {
    id: "le-1",
    event_id: "hm-1",
    type: "note",
    timestamp: new Date().toISOString(),
    content: "공연장 도착! 분위기 최고",
  },
  {
    id: "le-2",
    event_id: "hm-1",
    type: "highlight",
    timestamp: new Date().toISOString(),
    content: "ELEVEN 시작! 레이저 조명 대박",
    song_title: "ELEVEN",
  },
];

export default function LiveLogScreen() {
  const { eventId } = useLocalSearchParams<{ eventId: string }>();
  const { colors } = useTheme();
  const { t } = useTranslation();

  const [currentSongIndex, setCurrentSongIndex] = useState(1);
  const [entries, setEntries] = useState<LiveLogEntry[]>(MOCK_ENTRIES);
  const [noteText, setNoteText] = useState("");

  if (!isFeatureEnabled("LIVE_LOG")) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: t("liveLog.title"), headerShown: true }} />
        <EmptyState
          icon="radio-outline"
          title={t("liveLog.comingSoon")}
          message={t("liveLog.comingSoonDesc")}
        />
      </SafeAreaView>
    );
  }

  const addNote = useCallback(() => {
    if (!noteText.trim()) return;
    haptics.lightImpact();
    const entry: LiveLogEntry = {
      id: `le-${Date.now()}`,
      event_id: eventId ?? "",
      type: "note",
      timestamp: new Date().toISOString(),
      content: noteText.trim(),
    };
    setEntries((prev) => [...prev, entry]);
    setNoteText("");
  }, [noteText, eventId]);

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: t("liveLog.title"), headerShown: true }} />
      <KeyboardAvoidingView
        style={styles.container}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
      >
        <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
          {/* 셋리스트 트래커 */}
          <Text style={[typography.h2, styles.sectionTitle, { color: colors.foreground }]}>
            {t("liveLog.setlist")}
          </Text>
          <View style={styles.section}>
            <SetlistTracker
              setlist={MOCK_SETLIST}
              currentIndex={currentSongIndex}
              onItemPress={setCurrentSongIndex}
            />
          </View>

          {/* 내 로그 */}
          <Text style={[typography.h2, styles.sectionTitle, { color: colors.foreground }]}>
            {t("liveLog.myLog")}
          </Text>
          <View style={styles.section}>
            {entries.map((entry) => (
              <Animated.View key={entry.id} entering={FadeIn.springify()}>
                <LiveLogEntryCard entry={entry} />
              </Animated.View>
            ))}
          </View>
        </ScrollView>

        {/* 메모 입력 */}
        <View style={[styles.inputBar, { borderTopColor: colors.border, backgroundColor: colors.background }]}>
          <TextInput
            value={noteText}
            onChangeText={setNoteText}
            placeholder={t("liveLog.notePlaceholder")}
            placeholderTextColor={colors.mutedForeground}
            style={[styles.input, { color: colors.foreground, backgroundColor: colors.secondary, borderColor: colors.border }]}
            returnKeyType="send"
            onSubmitEditing={addNote}
          />
          <TouchableOpacity
            onPress={addNote}
            disabled={!noteText.trim()}
            style={[styles.sendBtn, { backgroundColor: noteText.trim() ? colors.primary : colors.muted }]}
            accessibilityRole="button"
          >
            <Ionicons name="send" size={18} color={noteText.trim() ? colors.primaryForeground : colors.mutedForeground} />
          </TouchableOpacity>
        </View>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  scroll: { paddingBottom: 100 },
  sectionTitle: {
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
    paddingBottom: spacing.md,
  },
  section: {
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  inputBar: {
    flexDirection: "row",
    alignItems: "center",
    padding: spacing.md,
    borderTopWidth: 1,
    gap: spacing.sm,
  },
  input: {
    flex: 1,
    height: 44,
    paddingHorizontal: spacing.md,
    borderRadius: radius.xl,
    borderWidth: 1,
    ...typography.body,
  },
  sendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
  },
});
