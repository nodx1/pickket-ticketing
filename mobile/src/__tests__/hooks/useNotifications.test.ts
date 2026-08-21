/**
 * useNotifications 훅 단위 테스트
 */
import { renderHook, waitFor } from "@testing-library/react-native";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as api from "@/config/api";
import { useAuthStore } from "@/hooks/useAuth";

jest.mock("@/config/api", () => ({
  getNotifications: jest.fn(),
  getUnreadNotificationCount: jest.fn(),
  markNotificationRead: jest.fn(),
  markAllNotificationsRead: jest.fn(),
  getNotificationPreferences: jest.fn(),
  updateNotificationPreferences: jest.fn(),
}));

jest.mock("@/hooks/useAuth", () => ({
  useAuthStore: jest.fn(),
}));

const mockApi = api as jest.Mocked<typeof api>;
const mockUseAuthStore = useAuthStore as unknown as jest.Mock;

import {
  useNotifications,
  useUnreadCount,
  useMarkRead,
  useMarkAllRead,
  useNotificationPreferences,
  useUpdateNotificationPreferences,
} from "@/hooks/useNotifications";

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
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

describe("useNotifications", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("useNotifications (목록)", () => {
    it("게스트 유저는 쿼리 비활성화", () => {
      mockUseAuthStore.mockImplementation((selector: (state: { isGuest: boolean }) => boolean) =>
        selector({ isGuest: true }),
      );

      const { result } = renderHook(() => useNotifications(), {
        wrapper: createWrapper(),
      });

      expect(result.current.fetchStatus).toBe("idle");
      expect(mockApi.getNotifications).not.toHaveBeenCalled();
    });

    it("인증 유저는 알림 목록 조회", async () => {
      mockUseAuthStore.mockImplementation((selector: (state: { isGuest: boolean }) => boolean) =>
        selector({ isGuest: false }),
      );
      mockApi.getNotifications.mockResolvedValue([
        { id: "n1", message: "테스트 알림" },
      ] as never);

      const { result } = renderHook(() => useNotifications(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockApi.getNotifications).toHaveBeenCalled();
    });
  });

  describe("useUnreadCount", () => {
    it("게스트 유저는 쿼리 비활성화", () => {
      mockUseAuthStore.mockImplementation((selector: (state: { isGuest: boolean }) => boolean) =>
        selector({ isGuest: true }),
      );

      const { result } = renderHook(() => useUnreadCount(), {
        wrapper: createWrapper(),
      });

      expect(result.current.fetchStatus).toBe("idle");
    });

    it("인증 유저는 미읽 수 조회", async () => {
      mockUseAuthStore.mockImplementation((selector: (state: { isGuest: boolean }) => boolean) =>
        selector({ isGuest: false }),
      );
      mockApi.getUnreadNotificationCount.mockResolvedValue(5 as never);

      const { result } = renderHook(() => useUnreadCount(), {
        wrapper: createWrapper(),
      });

      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(result.current.data).toBe(5);
    });
  });

  describe("useMarkRead", () => {
    it("읽음 처리 mutation 호출", async () => {
      mockUseAuthStore.mockImplementation((selector: (state: { isGuest: boolean }) => boolean) =>
        selector({ isGuest: false }),
      );
      mockApi.markNotificationRead.mockResolvedValue(undefined as never);

      const { result } = renderHook(() => useMarkRead(), {
        wrapper: createWrapper(),
      });

      result.current.mutate("n1");
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockApi.markNotificationRead).toHaveBeenCalledWith("n1");
    });
  });

  describe("useMarkAllRead", () => {
    it("전체 읽음 처리 mutation 호출", async () => {
      mockUseAuthStore.mockImplementation((selector: (state: { isGuest: boolean }) => boolean) =>
        selector({ isGuest: false }),
      );
      mockApi.markAllNotificationsRead.mockResolvedValue(undefined as never);

      const { result } = renderHook(() => useMarkAllRead(), {
        wrapper: createWrapper(),
      });

      result.current.mutate();
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockApi.markAllNotificationsRead).toHaveBeenCalled();
    });
  });

  describe("useNotificationPreferences", () => {
    it("게스트 유저는 쿼리 비활성화", () => {
      mockUseAuthStore.mockImplementation((selector: (state: { isGuest: boolean }) => boolean) =>
        selector({ isGuest: true }),
      );

      const { result } = renderHook(() => useNotificationPreferences(), {
        wrapper: createWrapper(),
      });

      expect(result.current.fetchStatus).toBe("idle");
    });
  });

  describe("useUpdateNotificationPreferences", () => {
    it("설정 업데이트 mutation 호출", async () => {
      mockUseAuthStore.mockImplementation((selector: (state: { isGuest: boolean }) => boolean) =>
        selector({ isGuest: false }),
      );
      const updatedPrefs = { push_enabled: false };
      mockApi.updateNotificationPreferences.mockResolvedValue(updatedPrefs as never);

      const { result } = renderHook(() => useUpdateNotificationPreferences(), {
        wrapper: createWrapper(),
      });

      result.current.mutate({ push_enabled: false });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(mockApi.updateNotificationPreferences).toHaveBeenCalledWith({
        push_enabled: false,
      });
    });
  });
});
