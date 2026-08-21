/**
 * DiscoverCard 단위 테스트 (Phase A.3)
 *
 * 검증:
 * 1. 제목/장소/CTA 렌더
 * 2. CTA 탭 → router.push
 * 3. 즐겨찾기 버튼 → toggleFavorite.mutate 호출
 * 4. 공유 버튼 → shareEvent 호출
 */
import React from "react";
import { render, fireEvent } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockMutate = jest.fn();
const mockPush = jest.fn();
const mockShareEvent = jest.fn();
const mockTrackFavorite = jest.fn();
const mockTrackShare = jest.fn();
const mockTrackClick = jest.fn();

jest.mock("@/hooks/useEvents", () => ({
  useToggleFavorite: () => ({ mutate: mockMutate, isPending: false }),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: mockPush }),
}));

jest.mock("@/lib/sharing", () => ({
  shareEvent: (...args: unknown[]) => mockShareEvent(...args),
}));

jest.mock("@/lib/analytics", () => ({
  trackFavorite: (...args: unknown[]) => mockTrackFavorite(...args),
  trackShare: (...args: unknown[]) => mockTrackShare(...args),
  trackClick: (...args: unknown[]) => mockTrackClick(...args),
}));

jest.mock("@/lib/haptics", () => ({
  success: jest.fn(),
  light: jest.fn(),
}));

jest.mock("expo-image", () => ({
  Image: "Image",
}));

jest.mock("@expo/vector-icons/Ionicons", () => {
  const { Text } = require("react-native");
  return function MockIonicons({ name }: { name: string }) {
    return <Text>{name}</Text>;
  };
});

jest.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: jest.fn() },
}));

import { DiscoverCard } from "@/components/discover/DiscoverCard";
import type { Event } from "@/config/api";

const mockEvent: Event = {
  id: "evt-1",
  title: "NewJeans 월드 투어",
  event_date: "2030-09-29T19:00:00Z",
  status: "on_sale",
  venue: "올림픽공원",
  image_url: "https://example.com/img.jpg",
  recommendation_reason: "당신이 본 K-pop 공연과 비슷해요",
};

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>{ui}</QueryClientProvider>,
  );
}

describe("DiscoverCard", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("제목/장소/CTA/추천이유 렌더", () => {
    const { getByText } = wrap(<DiscoverCard event={mockEvent} />);
    expect(getByText("NewJeans 월드 투어")).toBeTruthy();
    expect(getByText(/올림픽공원/)).toBeTruthy();
    expect(getByText("당신이 본 K-pop 공연과 비슷해요")).toBeTruthy();
  });

  it("CTA 탭 시 router.push 호출 + click 트래킹", () => {
    const { getByLabelText } = wrap(<DiscoverCard event={mockEvent} />);
    fireEvent.press(getByLabelText("discover.going"));
    expect(mockPush).toHaveBeenCalledWith("/event/evt-1");
    expect(mockTrackClick).toHaveBeenCalledWith("event", "evt-1");
  });

  it("즐겨찾기 버튼 → toggleFavorite.mutate + analytics", () => {
    const { getByLabelText } = wrap(<DiscoverCard event={mockEvent} />);
    fireEvent.press(getByLabelText("favorite"));
    expect(mockMutate).toHaveBeenCalledWith("evt-1");
    expect(mockTrackFavorite).toHaveBeenCalledWith("evt-1");
  });

  it("공유 버튼 → shareEvent + analytics", () => {
    const { getByLabelText } = wrap(<DiscoverCard event={mockEvent} />);
    fireEvent.press(getByLabelText("share"));
    expect(mockShareEvent).toHaveBeenCalledWith({
      eventId: "evt-1",
      title: "NewJeans 월드 투어",
      date: "2030-09-29T19:00:00Z",
      venue: "올림픽공원",
    });
    expect(mockTrackShare).toHaveBeenCalledWith("evt-1", "discover_card");
  });
});
