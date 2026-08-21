import { useRef, useCallback } from "react";
import { View, Text, TextInput, TouchableOpacity, StyleSheet } from "react-native";
import { useTranslation } from "react-i18next";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import { useVoiceInput } from "@/hooks/useVoiceInput";
import { selectionFeedback, success as hapticSuccess } from "@/lib/haptics";

interface Props {
  value: string;
  onChangeText: (text: string) => void;
  onSubmit?: () => void;
  onFilterPress?: () => void;
  autoFocus?: boolean;
}

export function SearchBar({ value, onChangeText, onSubmit, onFilterPress, autoFocus }: Props) {
  const { t, i18n } = useTranslation();
  const { colors } = useTheme();
  const inputRef = useRef<TextInput>(null);

  const voice = useVoiceInput({
    lang: i18n.language === "en" ? "en-US" : "ko-KR",
    onFinalResult: (text) => {
      onChangeText(text);
      hapticSuccess();
      onSubmit?.();
    },
  });

  const handleClear = useCallback(() => {
    onChangeText("");
    inputRef.current?.focus();
  }, [onChangeText]);

  const handleMicPressIn = useCallback(() => {
    selectionFeedback();
    voice.start();
  }, [voice]);

  const handleMicPressOut = useCallback(() => {
    voice.stop();
  }, [voice]);

  return (
    <View style={[styles.container, { backgroundColor: colors.surface, borderColor: colors.border }]}>
      <TextInput
        ref={inputRef}
        testID="search-input"
        style={[styles.input, typography.body, { color: colors.foreground }]}
        placeholder={t("search.placeholder")}
        placeholderTextColor={colors.mutedForeground}
        value={value}
        onChangeText={onChangeText}
        onSubmitEditing={onSubmit}
        returnKeyType="search"
        autoFocus={autoFocus}
        autoCorrect={false}
        autoCapitalize="none"
      />
      {value.length > 0 && (
        <TouchableOpacity
          onPress={handleClear}
          accessibilityLabel={t("common.close")}
          style={styles.clearTouchable}
        >
          <View style={[styles.clearBtn, { backgroundColor: colors.muted }]}>
            <Text style={[styles.clearText, { color: colors.mutedForeground }]}>✕</Text>
          </View>
        </TouchableOpacity>
      )}
      {voice.available && (
        <TouchableOpacity
          onPressIn={handleMicPressIn}
          onPressOut={handleMicPressOut}
          hitSlop={8}
          accessibilityLabel={t("voice.listening")}
          accessibilityRole="button"
          style={[
            styles.micBtn,
            {
              backgroundColor: voice.isListening ? colors.primary : colors.muted,
            },
          ]}
        >
          <Text
            style={[
              styles.micIcon,
              { color: voice.isListening ? colors.primaryForeground : colors.foreground },
            ]}
          >
            🎤
          </Text>
        </TouchableOpacity>
      )}
      {onFilterPress && (
        <TouchableOpacity
          onPress={onFilterPress}
          style={[styles.filterBtn, { backgroundColor: colors.primary }]}
          accessibilityLabel={t("search.filter")}
          accessibilityRole="button"
        >
          <Text style={[styles.filterIcon, { color: colors.primaryForeground }]}>☰</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    height: 48,
  },
  input: {
    flex: 1,
    height: "100%",
    paddingVertical: 0,
  },
  clearTouchable: {
    minWidth: 44,
    minHeight: 44,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: spacing.sm,
  },
  clearBtn: {
    width: 20,
    height: 20,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
  },
  clearText: {
    fontSize: 11,
    fontWeight: "700",
  },
  filterBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: spacing.sm,
  },
  filterIcon: {
    fontSize: 16,
  },
  micBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    marginLeft: spacing.sm,
  },
  micIcon: {
    fontSize: 16,
  },
});
