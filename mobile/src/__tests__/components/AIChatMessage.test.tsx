/**
 * AIChatMessage / RefinementChips 단위 테스트 (Phase B.2)
 */
import React from "react";
import { render, fireEvent } from "@testing-library/react-native";

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn() }),
}));

jest.mock("expo-image", () => {
  const { View } = jest.requireActual("react-native");
  return { Image: View };
});

jest.mock("@expo/vector-icons/Ionicons", () => {
  const { View } = jest.requireActual("react-native");
  return { __esModule: true, default: View };
});

jest.mock("@/config/api", () => ({
  __esModule: true,
  api: { get: jest.fn(), post: jest.fn() },
  getEventDetail: jest.fn(),
  searchEvents: jest.fn(),
  getFeaturedEvents: jest.fn(),
  getTrendingEvents: jest.fn(),
  getSimilarEvents: jest.fn(),
  toggleFavorite: jest.fn(),
  checkFavorite: jest.fn(),
}));

jest.mock("@/lib/analytics", () => ({
  trackClick: jest.fn(),
  trackFavorite: jest.fn(),
  trackShare: jest.fn(),
  trackSearch: jest.fn(),
  trackScreenView: jest.fn(),
}));

import { AIChatMessage, type ChatMessage } from "@/components/discover/AIChatMessage";
import { RefinementChips } from "@/components/discover/RefinementChips";

describe("AIChatMessage", () => {
  it("user 역할은 텍스트만 렌더", () => {
    const msg: ChatMessage = { id: "1", role: "user", text: "재즈 공연" };
    const { getByText } = render(<AIChatMessage message={msg} />);
    expect(getByText("재즈 공연")).toBeTruthy();
  });

  it("ai 역할은 텍스트 + intent + 이벤트 카드 렌더", () => {
    const msg: ChatMessage = {
      id: "2",
      role: "ai",
      text: "3개 찾았어요",
      intent: { genre: "jazz", budget: 50000 },
      events: [
        {
          id: "e1",
          title: "재즈 콘서트 A",
          event_date: "2026-05-01",
          venue: "블루노트",
          image_url: "https://example.com/a.jpg",
          recommendation_reason: "당신이 즐겨찾기한 장르",
        } as never,
      ],
    };
    const { getByText, getAllByText } = render(<AIChatMessage message={msg} />);
    expect(getByText("3개 찾았어요")).toBeTruthy();
    expect(getByText(/genre/)).toBeTruthy();
    // 매진이 아닌 이벤트는 목록 카드 + 예매 CTA(BookingActionCard) 양쪽에 노출됨
    expect(getAllByText("재즈 콘서트 A").length).toBeGreaterThanOrEqual(1);
    expect(getByText("당신이 즐겨찾기한 장르")).toBeTruthy();
  });
});

describe("RefinementChips", () => {
  it("칩 탭 시 onPress 호출", () => {
    const onPress = jest.fn();
    const chips = [
      { id: "c1", label: "더 저렴하게", append: "저렴" },
      { id: "c2", label: "주말에", append: "주말" },
    ];
    const { getByLabelText } = render(<RefinementChips chips={chips} onPress={onPress} />);
    fireEvent.press(getByLabelText("더 저렴하게"));
    expect(onPress).toHaveBeenCalledWith(chips[0]);
  });

  it("빈 배열은 null 반환", () => {
    const { toJSON } = render(<RefinementChips chips={[]} onPress={jest.fn()} />);
    expect(toJSON()).toBeNull();
  });
});
