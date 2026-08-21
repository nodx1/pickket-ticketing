/**
 * EventCard 시각 회귀 + perf budget (T5)
 *
 * 1. variant별 렌더 트리 동결
 * 2. perf budget — 단일 렌더 < 50ms (CI 환경 지터 고려해 여유있게)
 */
import React from "react";
import { render } from "@testing-library/react-native";

jest.mock("expo-image", () => {
  const { View } = require("react-native");
  return { Image: (props: { testID?: string }) => <View testID={props.testID} /> };
});

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: "ko" } }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

jest.mock("@/lib/format", () => ({
  formatKRW: (n: number) => `₩${n.toLocaleString()}`,
  formatEventDate: (d: string) => new Date(d).toISOString().slice(0, 10),
  formatRelativeTime: (_d: string) => "1일 전",
  formatPriceRange: (min: number, max: number) => `₩${min} ~ ₩${max}`,
  formatShortDate: (d: string) => new Date(d).toISOString().slice(0, 10),
  resolveEventImage: (e: { image_url?: string }) => e.image_url ?? "",
}));

jest.mock("@/components/event/FriendsInterested", () => {
  const { View } = require("react-native");
  return { FriendsInterested: () => <View testID="friends-mock" /> };
});

jest.mock("@/hooks/useTheme", () => ({
  useTheme: () => ({
    colors: {
      primary: "#1E2A78",
      background: "#FFFFFF",
      foreground: "#1A1D2E",
      mutedForeground: "#6B7280",
      muted: "#F3F4F6",
      border: "#E5E7EB",
      card: "#FFFFFF",
      violet: "#4A5BC4",
      cyan: "#00C9A7",
    },
  }),
}));

jest.mock("@/hooks/useEvents", () => ({
  useToggleFavorite: () => ({ mutate: jest.fn(), isPending: false }),
}));

jest.mock("@/lib/sharing", () => ({ shareEvent: jest.fn() }));
jest.mock("@/lib/analytics", () => ({
  trackFavorite: jest.fn(),
  trackShare: jest.fn(),
  trackClick: jest.fn(),
  trackEventView: jest.fn(),
}));
jest.mock("@/lib/haptics", () => ({
  success: jest.fn(),
  error: jest.fn(),
  light: jest.fn(),
}));

jest.mock("@expo/vector-icons", () => {
  const { Text } = require("react-native");
  const MockIcon = ({ name }: { name: string }) => <Text>{name}</Text>;
  return { Ionicons: MockIcon, MaterialIcons: MockIcon, FontAwesome: MockIcon };
});

jest.mock("@expo/vector-icons/Ionicons", () => {
  const { Text } = require("react-native");
  return function MockIonicons({ name }: { name: string }) {
    return <Text>{name}</Text>;
  };
});

jest.mock("expo-linear-gradient", () => {
  const { View } = require("react-native");
  return { LinearGradient: (props: { children?: React.ReactNode }) => <View>{props.children}</View> };
});

import { EventCard } from "@/components/event/EventCard";
import type { Event } from "@/config/api";

const event: Event = {
  id: "evt-1",
  title: "Test Event",
  start_at: "2026-05-01T10:00:00Z",
  venue_name: "Hall A",
  category: "concert",
  min_price: 50000,
  max_price: 120000,
  image_url: "https://example.com/img.jpg",
  status: "open",
  is_favorited: false,
  available_count: 100,
} as unknown as Event;

describe("EventCard snapshot + perf", () => {
  it("large variant snapshot", () => {
    const tree = render(<EventCard event={event} variant="large" />).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("compact variant snapshot", () => {
    const tree = render(<EventCard event={event} variant="compact" />).toJSON();
    expect(tree).toMatchSnapshot();
  });

  it("perf budget — 100회 렌더 < 1500ms", () => {
    const start = performance.now();
    for (let i = 0; i < 100; i++) {
      render(<EventCard event={event} variant="compact" />).unmount();
    }
    const elapsed = performance.now() - start;
    // CI 지터 여유 + Hermes JIT warmup
    expect(elapsed).toBeLessThan(1500);
  });
});
