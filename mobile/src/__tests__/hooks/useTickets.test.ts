/**
 * useTickets 훅 단위 테스트
 */
import { renderHook, waitFor } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import * as api from "@/config/api";

jest.mock("@/config/api", () => ({
  getMyTickets: jest.fn(),
  getTicket: jest.fn(),
  getTicketQr: jest.fn(),
  setAuthStateResetter: jest.fn(),
}));

const mockApi = api as jest.Mocked<typeof api>;

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
    },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      children,
    );
  };
}

const { useMyTickets, useTicket, useTicketQr, groupTicketsByDate } =
  require("@/hooks/useTickets") as typeof import("@/hooks/useTickets");
// AUDIT §5 P0: useMyTickets는 isGuest 가드가 추가됨 → 로그인 유저로 시뮬레이션
const { useAuthStore } = require("@/hooks/useAuth") as typeof import("@/hooks/useAuth");

const futureDate = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const pastDate = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

const mockTicket = {
  id: "ticket-1",
  event_id: "event-1",
  event_title: "Test Concert",
  event_date: futureDate,
  tier_name: "R석",
  status: "active",
  seat_number: "A-12",
};

const mockPastTicket = {
  ...mockTicket,
  id: "ticket-2",
  event_date: pastDate,
  status: "used",
};

describe("useTickets hooks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useAuthStore.setState({ user: null, isGuest: false, isLoading: false });
  });

  describe("useMyTickets", () => {
    it("내 티켓 목록 로드", async () => {
      mockApi.getMyTickets.mockResolvedValue([mockTicket] as never);

      const { result } = renderHook(() => useMyTickets(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toHaveLength(1);
    });

    it("skip/limit 파라미터 전달", async () => {
      mockApi.getMyTickets.mockResolvedValue([] as never);

      const { result } = renderHook(() => useMyTickets(10, 20), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockApi.getMyTickets).toHaveBeenCalledWith(10, 20);
    });
  });

  describe("useTicket", () => {
    it("티켓 상세 로드", async () => {
      mockApi.getTicket.mockResolvedValue(mockTicket as never);

      const { result } = renderHook(() => useTicket("ticket-1"), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toEqual(mockTicket);
    });

    it("빈 ID → 쿼리 비활성화", () => {
      const { result } = renderHook(() => useTicket(""), {
        wrapper: createWrapper(),
      });

      expect(result.current.fetchStatus).toBe("idle");
    });
  });

  describe("useTicketQr", () => {
    it("QR 데이터 로드", async () => {
      const mockQr = { ticket_id: "ticket-1", qr_data: "totp:abc", expires_in_seconds: 15 };
      mockApi.getTicketQr.mockResolvedValue(mockQr as never);

      const { result } = renderHook(() => useTicketQr("ticket-1"), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data?.qr_data).toBe("totp:abc");
    });

    it("enabled=false → 쿼리 비활성화", () => {
      const { result } = renderHook(() => useTicketQr("ticket-1", false), {
        wrapper: createWrapper(),
      });

      expect(result.current.fetchStatus).toBe("idle");
    });

    it("빈 ID → 쿼리 비활성화", () => {
      const { result } = renderHook(() => useTicketQr(""), {
        wrapper: createWrapper(),
      });

      expect(result.current.fetchStatus).toBe("idle");
    });
  });

  describe("groupTicketsByDate", () => {
    it("미래 이벤트 → upcoming, 과거 이벤트 → past", () => {
      const { upcoming, past } = groupTicketsByDate([mockTicket, mockPastTicket] as never);

      expect(upcoming).toHaveLength(1);
      expect(upcoming[0].id).toBe("ticket-1");
      expect(past).toHaveLength(1);
      expect(past[0].id).toBe("ticket-2");
    });

    it("빈 배열 → 빈 결과", () => {
      const { upcoming, past } = groupTicketsByDate([]);

      expect(upcoming).toHaveLength(0);
      expect(past).toHaveLength(0);
    });

    it("event_date 없는 티켓 → upcoming으로 분류", () => {
      const noDateTicket = { ...mockTicket, event_date: null };
      const { upcoming } = groupTicketsByDate([noDateTicket] as never);

      expect(upcoming).toHaveLength(1);
    });
  });
});
