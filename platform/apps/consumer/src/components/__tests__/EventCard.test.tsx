import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// --- Mocks ---
vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("next/image", () => ({
  default: ({ src, alt }: any) => <img src={src} alt={alt} />,
}));

vi.mock("motion/react", () => ({
  motion: {
    div: ({
      children,
      whileHover: _whileHover,
      whileTap: _whileTap,
      ...props
    }: any) => <div {...props}>{children}</div>,
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => {
    return (key: string, params?: Record<string, any>) => {
      const msgs: Record<string, string> = {
        viewTickets: "티켓 보기",
        timeLeft: `${params?.time} 남음`,
        daysHours: `${params?.days}일 ${params?.hours}시간`,
        hoursMinutes: `${params?.hours}시간 ${params?.minutes}분`,
        competitionRate: `경쟁률 ${params?.percent}%`,
        highDemand: "경쟁 치열",
        from: "부터",
        transparentPrice: "투명가격",
        addFavorite: "좋아요 추가",
        removeFavorite: "좋아요 해제",
        conductor: "지휘",
        leadCast: "주연",
      };
      return msgs[key] || key;
    };
  },
  useLocale: () => "ko",
}));

vi.mock("@pickket/store", () => ({
  useAuthStore: vi.fn(),
}));

vi.mock("@pickket/lib/api", () => ({
  toggleFavorite: vi.fn(),
  getEvent: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    prefetchQuery: vi.fn(),
  }),
}));

vi.mock("@/components/ui/DemandBadge", () => ({
  default: ({ bidCount, totalSeats }: any) => (
    <span data-testid="demand-badge">
      {bidCount}/{totalSeats}
    </span>
  ),
}));

import EventCard from "../event/EventCard";
import { useAuthStore } from "@pickket/store";
import { toggleFavorite } from "@pickket/lib/api";

const mockUseAuthStore = vi.mocked(useAuthStore) as any;
const mockToggleFavorite = vi.mocked(toggleFavorite);

const baseEvent = {
  id: "event-1",
  title: "BTS 월드투어 서울 콘서트",
  category: "concert",
  status: "bidding_open",
  venue: "올림픽체조경기장",
  location_city: "서울",
  event_date: "2026-04-15T19:00:00+09:00",
  min_price: 99000,
  currency: "KRW",
  bid_count: 500,
  total_seats: 300,
  bidding_closes_at: new Date(Date.now() + 3600000).toISOString(), // 1 hour from now
  image_url: null,
  is_free: false,
  is_public_sector: false,
  home_team: null,
  away_team: null,
  match_status: null,
  sub_category: null,
  artist_name: null,
  subject_name: null,
  program_data: null,
  event_date_end: null,
} as any;

describe("EventCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuthStore.mockReturnValue({ user: null });
  });

  it("renders event title", () => {
    render(<EventCard event={baseEvent} />);
    expect(screen.getByText("BTS 월드투어 서울 콘서트")).toBeInTheDocument();
  });

  it("renders venue and city", () => {
    render(<EventCard event={baseEvent} />);
    expect(screen.getByText(/올림픽체조경기장/)).toBeInTheDocument();
  });

  it("links to the event detail page", () => {
    render(<EventCard event={baseEvent} />);
    const link = screen.getByRole("link");
    expect(link).toHaveAttribute("href", "/events/event-1");
  });

  it("does not render price on card (moved to detail page)", () => {
    // 가격 표시는 상세 페이지로 이동됨 — 카드에서는 표시하지 않음 (P3 리팩토링)
    render(<EventCard event={baseEvent} />);
    // 99,000 텍스트가 없어야 함
    expect(screen.queryByText(/99,000/)).not.toBeInTheDocument();
  });

  it("renders DemandBadge with bid count and total seats", () => {
    render(<EventCard event={baseEvent} />);
    expect(screen.getByTestId("demand-badge")).toHaveTextContent("500/300");
  });

  it("shows bid count", () => {
    render(<EventCard event={baseEvent} />);
    expect(screen.getByText("500")).toBeInTheDocument();
  });

  it("renders competition rate bar", () => {
    render(<EventCard event={baseEvent} />);
    expect(screen.getByText(/경쟁률/)).toBeInTheDocument();
  });

  it("shows status badge", () => {
    render(<EventCard event={baseEvent} />);
    // getStatusLabel("bidding_open") => "응모중"
    expect(screen.getByText("응모중")).toBeInTheDocument();
  });

  describe("free event", () => {
    // 가격 섹션(무료 표시 포함)은 카드에서 제거됨 — 상세 페이지에서 등급별 가격 표시
    it("renders without error for free event (is_free=true)", () => {
      const { container } = render(<EventCard event={{ ...baseEvent, is_free: true }} />);
      expect(container.querySelector("a")).toBeInTheDocument();
      // "무료" 텍스트는 카드에 표시되지 않음
      expect(screen.queryByText("무료")).not.toBeInTheDocument();
    });

    it("renders without error for public sector with min_price=0", () => {
      const { container } = render(
        <EventCard
          event={{ ...baseEvent, min_price: 0, is_public_sector: true }}
        />,
      );
      expect(container.querySelector("a")).toBeInTheDocument();
      // "무료" 텍스트는 카드에 표시되지 않음
      expect(screen.queryByText("무료")).not.toBeInTheDocument();
    });
  });

  describe("public sector badge", () => {
    it("shows 공공 badge for public sector events", () => {
      render(<EventCard event={{ ...baseEvent, is_public_sector: true }} />);
      expect(screen.getByText("공공")).toBeInTheDocument();
    });

    it("does not show 공공 badge for non-public events", () => {
      render(<EventCard event={baseEvent} />);
      expect(screen.queryByText("공공")).not.toBeInTheDocument();
    });
  });

  describe("sports category", () => {
    it("renders team vs team format", () => {
      const sportsEvent = {
        ...baseEvent,
        category: "sports",
        home_team: "LG 트윈스",
        away_team: "삼성 라이온즈",
      };
      render(<EventCard event={sportsEvent} />);
      expect(screen.getByText("LG 트윈스")).toBeInTheDocument();
      expect(screen.getByText("vs")).toBeInTheDocument();
      expect(screen.getByText("삼성 라이온즈")).toBeInTheDocument();
    });

    it("shows LIVE badge for live matches", () => {
      const sportsEvent = {
        ...baseEvent,
        category: "sports",
        home_team: "팀A",
        away_team: "팀B",
        match_status: "live",
      };
      render(<EventCard event={sportsEvent} />);
      expect(screen.getByText("LIVE")).toBeInTheDocument();
    });
  });

  describe("classical category", () => {
    it("shows conductor name", () => {
      const classicalEvent = {
        ...baseEvent,
        category: "classical",
        artist_name: "정명훈",
      };
      render(<EventCard event={classicalEvent} />);
      expect(screen.getByText("정명훈")).toBeInTheDocument();
    });
  });

  describe("favorite button", () => {
    it("does not show heart when not logged in", () => {
      mockUseAuthStore.mockReturnValue({ user: null });
      render(<EventCard event={baseEvent} />);
      expect(screen.queryByLabelText("좋아요 추가")).not.toBeInTheDocument();
    });

    it("shows heart button when logged in", () => {
      mockUseAuthStore.mockReturnValue({ user: { id: "user-1" } });
      render(<EventCard event={baseEvent} />);
      expect(screen.getByLabelText("좋아요 추가")).toBeInTheDocument();
    });

    it("calls toggleFavorite on click", async () => {
      mockUseAuthStore.mockReturnValue({ user: { id: "user-1" } });
      mockToggleFavorite.mockResolvedValueOnce({
        data: { is_favorited: true },
      } as any);

      render(<EventCard event={baseEvent} />);
      fireEvent.click(screen.getByLabelText("좋아요 추가"));

      await waitFor(() => {
        expect(mockToggleFavorite).toHaveBeenCalledWith("event-1");
      });
    });
  });

  describe("high competition", () => {
    it("shows high demand label when competition >= 80%", () => {
      const hotEvent = { ...baseEvent, bid_count: 800, total_seats: 100 };
      render(<EventCard event={hotEvent} />);
      expect(screen.getByText("경쟁 치열")).toBeInTheDocument();
    });
  });

  describe("image rendering", () => {
    it("shows gradient placeholder when no image_url", () => {
      render(<EventCard event={baseEvent} />);
      // First char of title as placeholder
      expect(screen.getByText("B")).toBeInTheDocument();
    });

    it("shows image when image_url is provided", () => {
      render(
        <EventCard
          event={{ ...baseEvent, image_url: "https://img.test/bts.jpg" }}
        />,
      );
      const img = screen.getByAltText("BTS 월드투어 서울 콘서트");
      expect(img).toHaveAttribute("src", "https://img.test/bts.jpg");
    });
  });
});
