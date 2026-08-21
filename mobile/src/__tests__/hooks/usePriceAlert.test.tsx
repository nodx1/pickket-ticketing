/**
 * Phase E.2 — usePriceAlert 훅 테스트
 */
import React from "react";
import { renderHook, waitFor, act } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockCreatePriceAlert = jest.fn();
const mockGetMyPriceAlerts = jest.fn();
const mockDeletePriceAlert = jest.fn();

jest.mock("@/config/api", () => ({
  createPriceAlert: (...a: unknown[]) => mockCreatePriceAlert(...a),
  getMyPriceAlerts: (...a: unknown[]) => mockGetMyPriceAlerts(...a),
  deletePriceAlert: (...a: unknown[]) => mockDeletePriceAlert(...a),
  // useAuth.ts가 모듈 로드 시점에 호출 — mock 추가 필수
  setAuthStateResetter: jest.fn(),
}));

import {
  useCreatePriceAlert,
  useMyPriceAlerts,
  useDeletePriceAlert,
} from "@/hooks/usePriceAlert";
// AUDIT §5 P0: useMyPriceAlerts에 isGuest 가드 추가
import { useAuthStore } from "@/hooks/useAuth";

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  mockCreatePriceAlert.mockReset();
  mockGetMyPriceAlerts.mockReset();
  mockDeletePriceAlert.mockReset();
  useAuthStore.setState({ user: null, isGuest: false, isLoading: false });
});

describe("usePriceAlert hooks", () => {
  it("useMyPriceAlerts fetches list", async () => {
    mockGetMyPriceAlerts.mockResolvedValue([
      { id: "a1", user_id: "u1", event_id: "e1", tier_id: "t1", target_price: 50000, triggered: false, created_at: "2026-04-08" },
    ]);
    const { result } = renderHook(() => useMyPriceAlerts(), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toHaveLength(1);
  });

  it("useCreatePriceAlert sends input correctly", async () => {
    mockCreatePriceAlert.mockResolvedValue({
      id: "a1", user_id: "u1", event_id: "e1", tier_id: "t1", target_price: 50000, triggered: false, created_at: "2026-04-08",
    });
    const { result } = renderHook(() => useCreatePriceAlert(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync({ eventId: "e1", tierId: "t1", targetPrice: 50000 });
    });
    expect(mockCreatePriceAlert).toHaveBeenCalledWith("e1", "t1", 50000);
  });

  it("useDeletePriceAlert calls api", async () => {
    mockDeletePriceAlert.mockResolvedValue(undefined);
    const { result } = renderHook(() => useDeletePriceAlert(), { wrapper });
    await act(async () => {
      await result.current.mutateAsync("a1");
    });
    expect(mockDeletePriceAlert).toHaveBeenCalledWith("a1");
  });
});
