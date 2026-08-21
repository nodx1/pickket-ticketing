/**
 * 데일리 퀴즈 화면
 * 피처플래그: DAILY_QUIZ
 */
import { useCallback, useState } from "react";
import { View, Text, TouchableOpacity, ScrollView, StyleSheet } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import Animated, { FadeIn } from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { Stack } from "expo-router";
import { useTheme } from "@/hooks/useTheme";
import { useTranslation } from "react-i18next";
import { typography, spacing, radius } from "@/config/theme";
import { isFeatureEnabled } from "@/config/features";
import { EmptyState } from "@/components/common/EmptyState";
import * as haptics from "@/lib/haptics";
import type { QuizQuestion } from "@/types/vote";

const MOCK_QUESTIONS: QuizQuestion[] = [
  {
    id: "q-1",
    question: "IVE의 데뷔곡 제목은?",
    options: ["ELEVEN", "LOVE DIVE", "After LIKE", "I AM"],
    correct_index: 0,
    explanation: "IVE는 2021년 12월 1일 'ELEVEN'으로 데뷔했습니다.",
    xp_reward: 5,
    category: "kpop",
  },
  {
    id: "q-2",
    question: "2026년 KSPO DOME에서 가장 많은 공연을 한 아티스트는?",
    options: ["BTS", "SEVENTEEN", "IVE", "aespa"],
    correct_index: 2,
    explanation: "IVE가 2026년 KSPO DOME에서 총 6회 공연을 진행했습니다.",
    xp_reward: 10,
    category: "trivia",
  },
];

export default function QuizScreen() {
  const { colors } = useTheme();
  const { t } = useTranslation();
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selectedAnswer, setSelectedAnswer] = useState<number | null>(null);
  const [score, setScore] = useState(0);

  if (!isFeatureEnabled("DAILY_QUIZ")) {
    return (
      <SafeAreaView testID="quiz.screen" style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: t("quiz.title"), headerShown: true }} />
        <EmptyState testID="quiz.comingSoon" icon="help-circle-outline" title={t("quiz.comingSoon")} message={t("quiz.comingSoonDesc")} />
      </SafeAreaView>
    );
  }

  const question = MOCK_QUESTIONS[currentIndex];
  const isAnswered = selectedAnswer !== null;
  const isCorrect = selectedAnswer === question?.correct_index;
  const isFinished = currentIndex >= MOCK_QUESTIONS.length;

  const handleAnswer = useCallback(
    (index: number) => {
      if (isAnswered || !question) return;
      setSelectedAnswer(index);
      if (index === question.correct_index) {
        haptics.successFeedback();
        setScore((s) => s + question.xp_reward);
      } else {
        haptics.error();
      }
    },
    [isAnswered, question],
  );

  const handleNext = useCallback(() => {
    haptics.lightImpact();
    setSelectedAnswer(null);
    setCurrentIndex((i) => i + 1);
  }, []);

  if (isFinished) {
    return (
      <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
        <Stack.Screen options={{ title: t("quiz.title"), headerShown: true }} />
        <View style={styles.center}>
          <Ionicons name="trophy" size={64} color={colors.warning} />
          <Text style={[typography.h1, { color: colors.foreground, marginTop: spacing.xl }]}>
            +{score}XP
          </Text>
          <Text style={[typography.body, { color: colors.mutedForeground, marginTop: spacing.sm }]}>
            {t("fanScore.completed")}
          </Text>
        </View>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={[styles.container, { backgroundColor: colors.background }]}>
      <Stack.Screen options={{ title: `${t("quiz.daily")} (${currentIndex + 1}/${MOCK_QUESTIONS.length})`, headerShown: true }} />

      <ScrollView contentContainerStyle={styles.scroll}>
        <Animated.View key={question.id} entering={FadeIn.springify()}>
          <Text style={[typography.h2, { color: colors.foreground }]}>
            {question.question}
          </Text>

          <View style={styles.options}>
            {question.options.map((option, index) => {
              const isSelected = index === selectedAnswer;
              const isCorrectOption = index === question.correct_index;
              let bgColor: string = colors.background;
              let borderColor: string = colors.border;

              if (isAnswered) {
                if (isCorrectOption) {
                  bgColor = colors.success + "20";
                  borderColor = colors.success;
                } else if (isSelected && !isCorrect) {
                  bgColor = colors.destructive + "20";
                  borderColor = colors.destructive;
                }
              } else if (isSelected) {
                borderColor = colors.primary;
              }

              return (
                <TouchableOpacity
                  key={index}
                  onPress={() => handleAnswer(index)}
                  disabled={isAnswered}
                  style={[styles.optionBtn, { backgroundColor: bgColor, borderColor }]}
                  accessibilityRole="radio"
                >
                  <Text style={[typography.body, { color: colors.foreground }]}>{option}</Text>
                </TouchableOpacity>
              );
            })}
          </View>

          {/* 설명 (답변 후) */}
          {isAnswered && (
            <Animated.View entering={FadeIn.springify()} style={[styles.explanation, { backgroundColor: colors.secondary }]}>
              <Text style={[typography.bodySmall, { color: colors.foreground }]}>
                {question.explanation}
              </Text>
              <TouchableOpacity
                onPress={handleNext}
                style={[styles.nextBtn, { backgroundColor: colors.primary }]}
                accessibilityRole="button"
              >
                <Text style={[typography.h5, { color: colors.primaryForeground }]}>
                  {t("common.next")}
                </Text>
              </TouchableOpacity>
            </Animated.View>
          )}
        </Animated.View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: "center", justifyContent: "center" },
  scroll: { padding: spacing.xl },
  options: { marginTop: spacing.xl, gap: spacing.sm },
  optionBtn: {
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    justifyContent: "center",
    borderRadius: radius.xl,
    borderWidth: 1,
  },
  explanation: {
    marginTop: spacing.xl,
    padding: spacing.lg,
    borderRadius: radius.xl,
  },
  nextBtn: {
    height: 44,
    borderRadius: radius.xl,
    alignItems: "center",
    justifyContent: "center",
    marginTop: spacing.md,
  },
});
