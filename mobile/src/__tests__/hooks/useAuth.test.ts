/**
 * useAuthStore 단위 테스트
 */
import { act } from "@testing-library/react-native";
import { useAuthStore } from "@/hooks/useAuth";
import { storage } from "@/lib/storage";
import * as api from "@/config/api";

// Mock modules
jest.mock("@/lib/storage", () => ({
  storage: {
    getAccessToken: jest.fn(),
    setAccessToken: jest.fn(),
    setRefreshToken: jest.fn(),
    clearAuth: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    remove: jest.fn(),
  },
}));

// 로그아웃 시 오프라인 QR 캐시 정리(P2-C20) — 단위 테스트에서는 no-op 모킹
jest.mock("@/lib/offline-tickets", () => ({
  clearOfflineQrCache: jest.fn(),
}));

jest.mock("@/config/api", () => ({
  login: jest.fn(),
  register: jest.fn(),
  logout: jest.fn(),
  getCurrentUser: jest.fn(),
  updateProfile: jest.fn(),
  deleteAccount: jest.fn(),
  setAuthStateResetter: jest.fn(),
}));

const mockStorage = storage as jest.Mocked<typeof storage>;
const mockApi = api as jest.Mocked<typeof api>;

const mockUser = {
  id: "test-user-id",
  email: "test@pickket.kr",
  name: "testuser",
  is_verified: false,
  is_organizer: false,
  verification_level: 0,
  loyalty_score: 0.5,
  preferred_language: "ko",
  timezone: "Asia/Seoul",
  created_at: "2026-04-05T00:00:00Z",
};

describe("useAuthStore", () => {
  beforeEach(() => {
    // Reset store state
    useAuthStore.setState({
      user: null,
      isLoading: true,
      isGuest: true,
    });
    jest.clearAllMocks();
  });

  describe("hydrate", () => {
    it("토큰 없으면 게스트 상태 유지", async () => {
      mockStorage.getAccessToken.mockResolvedValue(null);

      await act(async () => {
        await useAuthStore.getState().hydrate();
      });

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.isGuest).toBe(true);
      expect(state.isLoading).toBe(false);
    });

    it("유효한 토큰 → 유저 복원", async () => {
      mockStorage.getAccessToken.mockResolvedValue("valid-token");
      mockApi.getCurrentUser.mockResolvedValue(mockUser as never);

      await act(async () => {
        await useAuthStore.getState().hydrate();
      });

      const state = useAuthStore.getState();
      expect(state.user).toEqual(mockUser);
      expect(state.isGuest).toBe(false);
      expect(state.isLoading).toBe(false);
    });

    it("만료 토큰 → 정리 후 게스트", async () => {
      mockStorage.getAccessToken.mockResolvedValue("expired-token");
      mockApi.getCurrentUser.mockRejectedValue(new Error("Unauthorized"));

      await act(async () => {
        await useAuthStore.getState().hydrate();
      });

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.isGuest).toBe(true);
      expect(mockStorage.clearAuth).toHaveBeenCalled();
    });
  });

  describe("login", () => {
    it("로그인 성공 → 유저 설정 + 토큰 저장", async () => {
      mockApi.login.mockResolvedValue({
        access_token: "new-token",
        refresh_token: "refresh-token",
        user: mockUser,
      } as never);

      await act(async () => {
        await useAuthStore.getState().login("test@pickket.kr", "Test1234A");
      });

      const state = useAuthStore.getState();
      expect(state.user).toEqual(mockUser);
      expect(state.isGuest).toBe(false);
      expect(mockStorage.setAccessToken).toHaveBeenCalledWith("new-token");
      expect(mockStorage.setRefreshToken).toHaveBeenCalledWith("refresh-token");
    });

    it("로그인 실패 → 에러 throw", async () => {
      mockApi.login.mockRejectedValue(new Error("Invalid Credentials"));

      await expect(
        useAuthStore.getState().login("wrong@email.com", "wrong"),
      ).rejects.toThrow("Invalid Credentials");
    });
  });

  describe("register", () => {
    it("회원가입 성공 → 유저 설정", async () => {
      mockApi.register.mockResolvedValue({
        access_token: "new-token",
        refresh_token: null,
        user: mockUser,
      } as never);

      await act(async () => {
        await useAuthStore.getState().register({
          email: "new@pickket.kr",
          password: "New1234A",
          name: "newuser",
        });
      });

      const state = useAuthStore.getState();
      expect(state.user).toEqual(mockUser);
      expect(state.isGuest).toBe(false);
      expect(mockStorage.setAccessToken).toHaveBeenCalledWith("new-token");
      // refresh_token이 null이면 저장하지 않음
      expect(mockStorage.setRefreshToken).not.toHaveBeenCalled();
    });
  });

  describe("logout", () => {
    it("로그아웃 → 게스트 상태", async () => {
      useAuthStore.setState({ user: mockUser, isGuest: false });

      await act(async () => {
        await useAuthStore.getState().logout();
      });

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.isGuest).toBe(true);
    });
  });
});
