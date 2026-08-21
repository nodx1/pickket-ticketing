import axios from "axios";
import { create } from "zustand";

const LOCALHOST = "localhost";
const warnedKeys = new Set<string>();
const strictBuildEnv =
  typeof window === "undefined" && process.env.NODE_ENV === "production";

function localOrigin(port: number): string {
  return `http://${LOCALHOST}:${port}`;
}

function normalizeUrl(
  name: string,
  value: string | undefined,
  fallback: string,
): string {
  const resolved = value?.trim() || fallback;
  if (
    typeof window === "undefined" &&
    process.env.NODE_ENV === "production" &&
    resolved.includes(LOCALHOST) &&
    !warnedKeys.has(name)
  ) {
    warnedKeys.add(name);
    const message =
      `[pickket] CRITICAL: Production build contains localhost URL in ${name}: ${resolved}. ` +
      "NEXT_PUBLIC_API_URL must be set at BUILD TIME via Docker --build-arg.";
    if (strictBuildEnv) {
      throw new Error(message);
    }
    console.error(message);
  }
  return resolved.endsWith("/") ? resolved.slice(0, -1) : resolved;
}

function resolveApiBase(): string {
  return normalizeUrl(
    "NEXT_PUBLIC_API_URL",
    process.env.NEXT_PUBLIC_API_URL,
    localOrigin(8021),
  );
}

const API_BASE = resolveApiBase();

export interface User {
  id: string;
  email: string;
  name: string;
  phone?: string;
  is_organizer: boolean;
  is_admin?: boolean;
  is_verified: boolean;
  verification_level: number;
  loyalty_score: number;
  history_score?: number;
  is_fanclub_member?: boolean;
  no_show_rate?: number;
  cancel_rate?: number;
  dispute_rate?: number;
  fan_points?: number;
  social_points?: number;
  admin_role?: string | null;
  avatar_url?: string;
  bio?: string;
  preferred_language?: string;
  timezone?: string;
  fanclub_memberships?: Array<{
    id: string;
    fanclub_id: string;
    fanclub_name: string;
    artist_name: string;
    logo_url?: string;
    tier: string;
    status: string;
    expires_at?: string;
    joined_at?: string;
  }>;
}

interface AuthState {
  user: User | null;
  token: string | null;
  setAuth: (user: User, token: string) => void;
  logout: () => void;
  hydrate: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: null,
  setAuth: (user, token) => {
    set({ user, token });
  },
  logout: () => {
    void axios
      .post(`${API_BASE}/api/v1/auth/logout`, {}, { withCredentials: true })
      .catch(() => {});
    set({ user: null, token: null });
  },
  hydrate: () => {
    // No-op: session is restored via httpOnly cookie refresh
  },
}));
