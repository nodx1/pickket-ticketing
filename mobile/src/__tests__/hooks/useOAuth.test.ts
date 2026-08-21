/**
 * useOAuth 단위 테스트
 *
 * 핵심: 백엔드 OAuth 콜백이 관리자(is_mfa_required)에게
 * `{ mfa_required: true, mfa_token, access_token: "" }`를 반환할 때
 * 빈 토큰을 저장하거나 가짜 로그인 성공으로 처리하지 않는다(401 루프 차단).
 */
import { act, renderHook } from "@testing-library/react-native";
import * as WebBrowser from "expo-web-browser";
import { useOAuth } from "@/hooks/useOAuth";
import { useAuthStore } from "@/hooks/useAuth";
import { storage } from "@/lib/storage";
import * as api from "@/config/api";

jest.mock("expo-web-browser", () => ({
  maybeCompleteAuthSession: jest.fn(),
  openAuthSessionAsync: jest.fn(),
}));

jest.mock("expo-apple-authentication", () => ({
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  signInAsync: jest.fn(),
}));

jest.mock("expo-auth-session", () => ({
  makeRedirectUri: jest.fn(() => "pickket://auth/callback"),
}));

jest.mock("@/lib/storage", () => ({
  storage: {
    setAccessToken: jest.fn(),
    setRefreshToken: jest.fn(),
  },
}));

jest.mock("@/config/api", () => ({
  getOAuthRedirectUrl: jest.fn(),
  oauthCallback: jest.fn(),
  // useOAuth → useAuth(useAuthStore) import 체인이 모듈 로드 시 호출
  login: jest.fn(),
  register: jest.fn(),
  logout: jest.fn(),
  getCurrentUser: jest.fn(),
  updateProfile: jest.fn(),
  deleteAccount: jest.fn(),
  setAuthStateResetter: jest.fn(),
}));

const mockBrowser = WebBrowser as jest.Mocked<typeof WebBrowser>;
const mockStorage = storage as jest.Mocked<typeof storage>;
const mockApi = api as jest.Mocked<typeof api>;

const mockUser = {
  id: "admin-id",
  email: "admin@pickket.kr",
  name: "admin",
  is_verified: true,
  is_organizer: false,
  verification_level: 0,
  loyalty_score: 0.5,
  preferred_language: "ko",
  timezone: "Asia/Seoul",
  created_at: "2026-04-05T00:00:00Z",
};

/** kakao 등 web-browser 경로의 성공 redirect를 시뮬레이트 */
function primeBrowserFlow() {
  mockApi.getOAuthRedirectUrl.mockResolvedValue({
    authorization_url: "https://kauth.kakao.com/oauth/authorize",
    state: "state-123",
  } as never);
  mockBrowser.openAuthSessionAsync.mockResolvedValue({
    type: "success",
    url: "pickket://auth/callback?code=auth-code&state=state-123",
  } as never);
}

describe("useOAuth", () => {
  beforeEach(() => {
    useAuthStore.setState({ user: null, isLoading: false, isGuest: true });
    jest.clearAllMocks();
  });

  it("일반 사용자(정상 토큰) → 토큰 저장 + 로그인 성공 (회귀 가드)", async () => {
    primeBrowserFlow();
    mockApi.oauthCallback.mockResolvedValue({
      access_token: "valid-token",
      refresh_token: "refresh-token",
      user: mockUser,
    } as never);

    const { result } = renderHook(() => useOAuth());
    await act(async () => {
      await result.current.login("kakao");
    });

    expect(mockStorage.setAccessToken).toHaveBeenCalledWith("valid-token");
    expect(mockStorage.setRefreshToken).toHaveBeenCalledWith("refresh-token");
    expect(useAuthStore.getState().user).toEqual(mockUser);
    expect(useAuthStore.getState().isGuest).toBe(false);
  });

  it("mfa_required 응답 → 토큰 저장·로그인 성공 안 함 + 에러 surface", async () => {
    primeBrowserFlow();
    mockApi.oauthCallback.mockResolvedValue({
      access_token: "",
      refresh_token: null,
      user: mockUser,
      mfa_required: true,
      mfa_token: "mfa-token-abc",
    } as never);

    const { result } = renderHook(() => useOAuth());
    await act(async () => {
      await expect(result.current.login("kakao")).rejects.toThrow();
    });

    // 빈/가짜 토큰을 저장하지 않는다 → 401 루프 차단
    expect(mockStorage.setAccessToken).not.toHaveBeenCalled();
    expect(mockStorage.setRefreshToken).not.toHaveBeenCalled();
    // 로그인 성공으로 오인하지 않는다
    expect(useAuthStore.getState().user).toBeNull();
    expect(useAuthStore.getState().isGuest).toBe(true);
    expect(result.current.error).toContain("2단계 인증");
  });

  it("mfa_required 플래그 없이 빈 access_token만 와도 가드 발동", async () => {
    primeBrowserFlow();
    mockApi.oauthCallback.mockResolvedValue({
      access_token: "",
      refresh_token: null,
      user: mockUser,
    } as never);

    const { result } = renderHook(() => useOAuth());
    await act(async () => {
      await expect(result.current.login("kakao")).rejects.toThrow();
    });

    expect(mockStorage.setAccessToken).not.toHaveBeenCalled();
    expect(useAuthStore.getState().isGuest).toBe(true);
  });
});
