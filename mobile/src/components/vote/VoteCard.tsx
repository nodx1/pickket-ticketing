/**
 * VoteCard — 데일리 투표 카드
 * 디자인 정책: radius.xl(16), 44pt 터치, spring 애니메이션
 * 피처플래그: DAILY_VOTE
 */
import { useCallback,  } from "react";
import { View, Text, TouchableOpacity, StyleSheet } from "react-native";
import Animated, { FadeIn } from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import * as haptics from "@/lib/haptics";

import type { DailyVote } from "@/types/vote";
interface Props {
  vote: DailyVote;
  onVote: (voteId: string, optionId: string) => void;
}

export function VoteCard({ vote, onVote }: Props) {
  const { colors } = useTheme();
  const hasVoted = !!vote.user_voted_id;

  const handleVote = useCallback(
    (optionId: string) => {
      if (hasVoted) return;
      haptics.impactFeedback();
      onVote(vote.id, optionId);
    },
    [vote.id, hasVoted, onVote],
  );

  return (
    <Animated.View entering={FadeIn.springify()}>
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <Text style={[typography.h3, { color: colors.foreground }]}>
          {vote.question}
        </Text>

        <View style={styles.options}>
          {vote.options.map((option) => {
            const isSelected = option.id === vote.user_voted_id;
            const pct = vote.total_votes > 0 ? Math.round((option.vote_count / vote.total_votes) * 100) : 0;

            return (
              <TouchableOpacity
                key={option.id}
                onPress={() => handleVote(option.id)}
                disabled={hasVoted}
                style={[
                  styles.optionBtn,
                  {
                    borderColor: isSelected ? colors.primary : colors.border,
                    backgroundColor: isSelected ? colors.primary + "10" : colors.background,
                  },
                ]}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={option.label}
              >
                <Text style={[typography.body, { color: colors.foreground, flex: 1 }]}>
                  {option.label}
                </Text>
                {hasVoted && (
                  <Text style={[typography.h5, { color: isSelected ? colors.primary : colors.mutedForeground }]}>
                    {pct}%
                  </Text>
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* XP 보상 표시 */}
        <View style={styles.footer}>
          <Ionicons name="star" size={14} color={colors.warning} />
          <Text style={[typography.bodySmall, { color: colors.mutedForeground, marginLeft: 4 }]}>
            +{vote.xp_reward}XP
          </Text>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  card: {
    padding: spacing.lg,
    borderRadius: radius.xl,
    borderWidth: 1,
  },
  options: {
    marginTop: spacing.md,
    gap: spacing.sm,
  },
  optionBtn: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    minHeight: 44,
    borderRadius: radius.xl,
    borderWidth: 1,
  },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    marginTop: spacing.md,
  },
});
