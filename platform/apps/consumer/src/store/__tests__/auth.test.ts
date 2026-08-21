import { describe, it, expect, beforeEach, vi } from "vitest";
import { useAuthStore } from "@pickket/store";

// Mock axios to prevent real HTTP calls
vi.mock("axios", () => ({
  default: {
    post: vi.fn().mockResolvedValue({}),
  },
}));

const mockUser = {
  id: "user-123",
  email: "test@pickket.io",
  name: "테스트 유저",
  phone: "010-1234-5678",
  is_organizer: false,
  is_verified: true,
  verification_level: 2,
  loyalty_score: 85,
  history_score: 70,
  is_fanclub_member: true,
  no_show_rate: 0.02,
  cancel_rate: 0.05,
  dispute_rate: 0.0,
  fan_points: 1200,
  social_points: 350,
};

const AUTH_STORAGE_KEYS = [
  "pickket_token",
  "pickket_user",
  "auth_token",
  "auth_user",
];

function expectNoPersistedAuth() {
  for (const key of AUTH_STORAGE_KEYS) {
    expect(window.sessionStorage.getItem(key)).toBeNull();
  }
}

describe("useAuthStore", () => {
  beforeEach(() => {
    // Reset the store to initial state before each test
    useAuthStore.setState({ user: null, token: null });
    // Clear sessionStorage
    window.sessionStorage.clear();
  });

  describe("initial state", () => {
    it("starts with null user and token", () => {
      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.token).toBeNull();
    });
  });

  describe("setAuth", () => {
    it("sets user and token in store", () => {
      useAuthStore.getState().setAuth(mockUser, "test-token-abc");

      const state = useAuthStore.getState();
      expect(state.user).toEqual(mockUser);
      expect(state.token).toBe("test-token-abc");
    });

    it("does not persist auth data to sessionStorage", () => {
      useAuthStore.getState().setAuth(mockUser, "test-token-abc");
      expectNoPersistedAuth();
    });

    // sessionStorage 정리는 store 책임이 아님 — store는 sessionStorage를 읽거나 쓰지 않음.
    // (httpOnly 쿠키 기반 인증으로 전환; localStorage/sessionStorage 잔존 여부는 테스트 범위 외)

    it("overwrites previous auth data", () => {
      useAuthStore.getState().setAuth(mockUser, "token-1");

      const updatedUser = { ...mockUser, name: "업데이트 유저" };
      useAuthStore.getState().setAuth(updatedUser, "token-2");

      const state = useAuthStore.getState();
      expect(state.user?.name).toBe("업데이트 유저");
      expect(state.token).toBe("token-2");
    });
  });

  describe("logout", () => {
    it("clears user and token from store", () => {
      useAuthStore.getState().setAuth(mockUser, "test-token");
      useAuthStore.getState().logout();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.token).toBeNull();
    });

    // sessionStorage 정리는 store 책임이 아님 — 이 동작은 폐기됨
  });

  describe("hydrate", () => {
    it("does not restore state from sessionStorage (no-op hydrate)", () => {
      window.sessionStorage.setItem("pickket_token", "persisted-token");
      window.sessionStorage.setItem("pickket_user", JSON.stringify(mockUser));

      useAuthStore.getState().hydrate();

      // store는 sessionStorage를 읽지 않음 — state는 여전히 null
      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.token).toBeNull();
    });

    it("does nothing when sessionStorage is empty", () => {
      useAuthStore.getState().hydrate();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.token).toBeNull();
    });
  });

  describe("full lifecycle", () => {
    it("requires a fresh refresh-cookie bootstrap after page reload", () => {
      useAuthStore.getState().setAuth(mockUser, "lifecycle-token");
      expect(useAuthStore.getState().user?.name).toBe("테스트 유저");

      useAuthStore.setState({ user: null, token: null });
      expect(useAuthStore.getState().user).toBeNull();

      useAuthStore.getState().hydrate();
      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().token).toBeNull();

      useAuthStore.getState().logout();
      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().token).toBeNull();
      expectNoPersistedAuth();
    });
  });

  describe("user properties", () => {
    it("stores organizer flag", () => {
      const organizerUser = { ...mockUser, is_organizer: true };
      useAuthStore.getState().setAuth(organizerUser, "org-token");
      expect(useAuthStore.getState().user?.is_organizer).toBe(true);
    });

    it("stores verification level", () => {
      const verifiedUser = { ...mockUser, verification_level: 3 };
      useAuthStore.getState().setAuth(verifiedUser, "ver-token");
      expect(useAuthStore.getState().user?.verification_level).toBe(3);
    });

    it("stores fan_points", () => {
      useAuthStore.getState().setAuth(mockUser, "token");
      expect(useAuthStore.getState().user?.fan_points).toBe(1200);
    });

    it("stores social_points", () => {
      useAuthStore.getState().setAuth(mockUser, "token");
      expect(useAuthStore.getState().user?.social_points).toBe(350);
    });

    it("stores loyalty and history scores", () => {
      useAuthStore.getState().setAuth(mockUser, "token");
      const user = useAuthStore.getState().user;
      expect(user?.loyalty_score).toBe(85);
      expect(user?.history_score).toBe(70);
    });

    it("stores no_show, cancel, dispute rates", () => {
      useAuthStore.getState().setAuth(mockUser, "token");
      const user = useAuthStore.getState().user;
      expect(user?.no_show_rate).toBe(0.02);
      expect(user?.cancel_rate).toBe(0.05);
      expect(user?.dispute_rate).toBe(0.0);
    });
  });

  describe("optional user fields", () => {
    it("supports user with avatar_url", () => {
      const userWithAvatar = {
        ...mockUser,
        avatar_url: "https://img.test/avatar.jpg",
      };
      useAuthStore.getState().setAuth(userWithAvatar, "token");
      expect(useAuthStore.getState().user?.avatar_url).toBe(
        "https://img.test/avatar.jpg",
      );
    });

    it("supports user with bio", () => {
      const userWithBio = { ...mockUser, bio: "BTS ARMY" };
      useAuthStore.getState().setAuth(userWithBio, "token");
      expect(useAuthStore.getState().user?.bio).toBe("BTS ARMY");
    });

    it("supports user with preferred_language", () => {
      const userWithLang = { ...mockUser, preferred_language: "ko" };
      useAuthStore.getState().setAuth(userWithLang, "token");
      expect(useAuthStore.getState().user?.preferred_language).toBe("ko");
    });

    it("supports user with fanclub_memberships", () => {
      const userWithFanclub = {
        ...mockUser,
        fanclub_memberships: [
          {
            id: "fm-1",
            fanclub_id: "fc-1",
            fanclub_name: "ARMY",
            artist_name: "BTS",
            tier: "premium",
            status: "active",
          },
        ],
      };
      useAuthStore.getState().setAuth(userWithFanclub, "token");
      const memberships = useAuthStore.getState().user?.fanclub_memberships;
      expect(memberships).toHaveLength(1);
      expect(memberships?.[0].fanclub_name).toBe("ARMY");
      expect(memberships?.[0].tier).toBe("premium");
    });
  });

  describe("concurrent state updates", () => {
    it("handles rapid setAuth calls", () => {
      const users = Array.from({ length: 10 }, (_, i) => ({
        ...mockUser,
        name: `유저-${i}`,
        id: `user-${i}`,
      }));

      users.forEach((user, i) => {
        useAuthStore.getState().setAuth(user, `token-${i}`);
      });

      const lastUser = useAuthStore.getState().user;
      expect(lastUser?.name).toBe("유저-9");
      expect(useAuthStore.getState().token).toBe("token-9");
    });

    it("handles setAuth followed by immediate logout", () => {
      useAuthStore.getState().setAuth(mockUser, "temp-token");
      useAuthStore.getState().logout();

      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().token).toBeNull();
      expectNoPersistedAuth();
    });
  });
});
