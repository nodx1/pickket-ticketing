/**
 * AIChatMessage — 대화형 Discover 채팅 버블 (Phase B.2)
 *
 * role=user: 우측 정렬, primary 배경
 * role=ai: 좌측 정렬, surface 배경 + 이벤트 카드 그리드 포함
 */
import { View, Text, StyleSheet, ScrollView, Pressable } from "react-native";
import { Image } from "expo-image";
import { useRouter } from "expo-router";
import { useTheme } from "@/hooks/useTheme";
import { typography, spacing, radius } from "@/config/theme";
import type { Event } from "@/config/api";
import { trackClick } from "@/lib/analytics";
import { resolveEventImage } from "@/lib/format";
import { BookingActionCard } from "./BookingActionCard";
import { InlineBookingCard } from "./InlineBookingCard";
import { isFeatureEnabled } from "@/config/features";

export type ChatRole = "user" | "ai";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  events?: Event[];
  intent?: Record<string, unknown>;
}

interface Props {
  message: ChatMessage;
}

export function AIChatMessage({ message }: Props) {
  const { colors } = useTheme();
  const router = useRouter();

  if (message.role === "user") {
    return (
      <View style={[styles.row, { justifyContent: "flex-end" }]}>
        <View
          style={[
            styles.bubble,
            styles.userBubble,
            { backgroundColor: colors.primary },
          ]}
        >
          <Text style={[typography.body, { color: colors.primaryForeground }]}>
            {message.text}
          </Text>
        </View>
      </View>
    );
  }

  const handleEventPress = (eventId: string) => {
    trackClick("event", eventId);
    router.push(`/event/${eventId}`);
  };

  return (
    <View style={styles.row}>
      <View
        style={[
          styles.bubble,
          styles.aiBubble,
          { backgroundColor: colors.surface, borderColor: colors.border },
        ]}
      >
        <Text style={[typography.body, { color: colors.foreground }]}>
          {message.text}
        </Text>

        {message.intent && Object.keys(message.intent).length > 0 && (
          <View style={styles.intent}>
            {Object.entries(message.intent).map(([key, value]) =>
              value ? (
                <Text
                  key={key}
                  style={[typography.micro, { color: colors.mutedForeground }]}
                >
                  <Text style={{ fontWeight: "600" }}>{key}: </Text>
                  {String(value)}
                </Text>
              ) : null,
            )}
          </View>
        )}

        {message.events && message.events.length > 0 && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={styles.events}
            contentContainerStyle={styles.eventsContent}
          >
            {message.events.map((event) => (
              <Pressable
                key={event.id}
                style={[
                  styles.eventCard,
                  { backgroundColor: colors.background, borderColor: colors.border },
                ]}
                onPress={() => handleEventPress(event.id)}
                accessibilityLabel={event.title}
                accessibilityRole="button"
              >
                <Image
                  source={{ uri: resolveEventImage(event) }}
                  style={styles.eventImage}
                  contentFit="cover"
                />
                <Text
                  style={[typography.bodySmall, styles.eventTitle, { color: colors.foreground }]}
                  numberOfLines={2}
                >
                  {event.title}
                </Text>
                {event.recommendation_reason && (
                  <Text
                    style={[typography.micro, { color: colors.mutedForeground, fontStyle: "italic" }]}
                    numberOfLines={2}
                  >
                    {event.recommendation_reason}
                  </Text>
                )}
              </Pressable>
            ))}
          </ScrollView>
        )}

        {/* 챗 예매 CTA — Phase 2(인라인) 또는 Phase 1(딥링크) */}
        {isFeatureEnabled("CHAT_FAB") &&
          message.events &&
          message.events.length > 0 &&
          (() => {
            const bookable = message.events.find(
              (e) => !e.is_sold_out,
            );
            if (!bookable) return null;
            // Phase 2 인라인 예매가 켜져 있으면 티어 선택까지 챗 내에서 처리
            if (isFeatureEnabled("CHAT_INLINE_BOOKING")) {
              return <InlineBookingCard event={bookable} />;
            }
            return <BookingActionCard event={bookable} />;
          })()}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    marginBottom: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  bubble: {
    maxWidth: "85%",
    padding: spacing.md,
    borderRadius: radius.lg,
  },
  userBubble: {
    borderBottomRightRadius: radius.sm,
  },
  aiBubble: {
    borderBottomLeftRadius: radius.sm,
    borderWidth: 1,
  },
  intent: {
    marginTop: spacing.sm,
    gap: 2,
  },
  events: {
    marginTop: spacing.md,
  },
  eventsContent: {
    gap: spacing.sm,
    paddingRight: spacing.sm,
  },
  eventCard: {
    width: 140,
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: "hidden",
    padding: spacing.sm,
  },
  eventImage: {
    width: "100%",
    height: 80,
    borderRadius: radius.sm,
    marginBottom: spacing.xs,
  },
  eventTitle: {
    fontWeight: "600",
    marginBottom: 2,
  },
});
