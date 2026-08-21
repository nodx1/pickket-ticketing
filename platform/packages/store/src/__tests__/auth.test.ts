/**
 * M-7: Zustand auth store unit tests.
 *
 * Tests cover:
 * 1. Initial state — null user and token
 * 2. setAuth — stores user and token
 * 3. logout — clears state
 * 4. Multiple setAuth calls — latest wins
 * 5. hydrate — no-op (session via httpOnly cookie)
 * 6. Isolation — store reset between tests
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock axios before importing the store
vi.mock("axios", () => ({
  default: {
    post: vi.fn().mockResolvedValue({}),
  },
}));

// Mock process.env
vi.stubEnv("NEXT_PUBLIC_API_URL", "http://localhost:8021");

import { useAuthStore } from "../auth";
import type { User } from "../auth";

const mockUser: User = {
  id: "usr_001",
  email: "test@pickket.kr",
  name: "Test User",
  is_organizer: false,
  is_verified: true,
  verification_level: 2,
  loyalty_score: 50,
};

const mockOrganizer: User = {
  id: "usr_002",
  email: "org@pickket.kr",
  name: "Organizer",
  is_organizer: true,
  is_verified: true,
  verification_level: 3,
  loyalty_score: 80,
  is_admin: false,
};

describe("useAuthStore", () => {
  beforeEach(() => {
    // Reset store state between tests
    useAuthStore.setState({ user: null, token: null });
    vi.clearAllMocks();
  });

  it("has null initial state", () => {
    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.token).toBeNull();
  });

  it("setAuth stores user and token", () => {
    useAuthStore.getState().setAuth(mockUser, "access_token_123");

    const state = useAuthStore.getState();
    expect(state.user).toEqual(mockUser);
    expect(state.token).toBe("access_token_123");
  });

  it("logout clears user and token", async () => {
    // Set up authenticated state
    useAuthStore.getState().setAuth(mockUser, "token_abc");
    expect(useAuthStore.getState().user).not.toBeNull();

    // Logout
    useAuthStore.getState().logout();

    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.token).toBeNull();
  });

  it("logout calls POST /auth/logout", async () => {
    const axios = await import("axios");
    const postSpy = axios.default.post as ReturnType<typeof vi.fn>;

    useAuthStore.getState().setAuth(mockUser, "token_xyz");
    useAuthStore.getState().logout();

    expect(postSpy).toHaveBeenCalledWith(
      expect.stringContaining("/api/v1/auth/logout"),
      {},
      { withCredentials: true },
    );
  });

  it("multiple setAuth calls — latest wins", () => {
    useAuthStore.getState().setAuth(mockUser, "token_1");
    useAuthStore.getState().setAuth(mockOrganizer, "token_2");

    const state = useAuthStore.getState();
    expect(state.user?.id).toBe("usr_002");
    expect(state.user?.is_organizer).toBe(true);
    expect(state.token).toBe("token_2");
  });

  it("hydrate is callable (no-op)", () => {
    useAuthStore.getState().setAuth(mockUser, "token_hydrate");
    useAuthStore.getState().hydrate();

    // State should remain unchanged after hydrate
    const state = useAuthStore.getState();
    expect(state.user).toEqual(mockUser);
    expect(state.token).toBe("token_hydrate");
  });

  it("store is isolated between tests (reset in beforeEach)", () => {
    // This test relies on beforeEach resetting state
    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.token).toBeNull();
  });

  it("user with fanclub memberships is stored correctly", () => {
    const fanUser: User = {
      ...mockUser,
      fanclub_memberships: [
        {
          id: "fm_001",
          fanclub_id: "fc_001",
          fanclub_name: "BTS ARMY",
          artist_name: "BTS",
          tier: "gold",
          status: "active",
          joined_at: "2026-01-15T00:00:00Z",
        },
      ],
    };

    useAuthStore.getState().setAuth(fanUser, "fan_token");

    const state = useAuthStore.getState();
    expect(state.user?.fanclub_memberships).toHaveLength(1);
    expect(state.user?.fanclub_memberships?.[0].fanclub_name).toBe("BTS ARMY");
  });
});
