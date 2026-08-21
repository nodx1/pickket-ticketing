/**
 * useGroupBooking 단위 테스트 (Phase C.3)
 */
import React from "react";
import { renderHook, waitFor, act } from "@testing-library/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockCreate = jest.fn();
const mockJoin = jest.fn();
const mockGet = jest.fn();

jest.mock("@/config/api", () => ({
  createGroupOrder: (...args: unknown[]) => mockCreate(...args),
  joinGroupOrder: (...args: unknown[]) => mockJoin(...args),
  getGroupOrder: (...args: unknown[]) => mockGet(...args),
}));

import {
  useCreateGroupOrder,
  useJoinGroupOrder,
  useGroupOrder,
} from "@/hooks/useGroupBooking";

function wrapper() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("useGroupBooking", () => {
  beforeEach(() => {
    mockCreate.mockReset();
    mockJoin.mockReset();
    mockGet.mockReset();
  });

  it("createGroupOrder: 성공 시 데이터 반환", async () => {
    mockCreate.mockResolvedValue({
      id: "g1",
      capacity: 4,
      invite_url: "https://x/g1",
    });
    const { result } = renderHook(() => useCreateGroupOrder(), { wrapper: wrapper() });
    let data: unknown;
    await act(async () => {
      data = await result.current.mutateAsync({
        event_id: "e1",
        tier_id: "t1",
        capacity: 4,
      });
    });
    expect(data).toMatchObject({ id: "g1" });
    expect(mockCreate).toHaveBeenCalledWith({
      event_id: "e1",
      tier_id: "t1",
      capacity: 4,
    });
  });

  it("createGroupOrder: 백엔드 미구현 시 null 반환", async () => {
    mockCreate.mockResolvedValue(null);
    const { result } = renderHook(() => useCreateGroupOrder(), { wrapper: wrapper() });
    let data: unknown;
    await act(async () => {
      data = await result.current.mutateAsync({
        event_id: "e1",
        tier_id: "t1",
        capacity: 2,
      });
    });
    expect(data).toBeNull();
  });

  it("joinGroupOrder: groupId 전달", async () => {
    mockJoin.mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useJoinGroupOrder(), { wrapper: wrapper() });
    await act(async () => {
      await result.current.mutateAsync("g1");
    });
    expect(mockJoin).toHaveBeenCalledWith("g1");
  });

  it("useGroupOrder: groupId 없으면 비활성", async () => {
    const { result } = renderHook(() => useGroupOrder(undefined), { wrapper: wrapper() });
    expect(result.current.isFetching).toBe(false);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("useGroupOrder: groupId 있으면 fetch", async () => {
    mockGet.mockResolvedValue({ id: "g1", capacity: 4 });
    const { result } = renderHook(() => useGroupOrder("g1"), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(mockGet).toHaveBeenCalledWith("g1");
  });
});
