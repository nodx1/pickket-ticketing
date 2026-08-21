/**
 * API Configuration Injection — adapter pattern for platform-agnostic API client.
 *
 * Web apps call `configureApi()` during bootstrap to wire up the auth token
 * getter and base URL.  If nobody calls `configureApi()`, a safe fallback is
 * returned (reads `process.env.NEXT_PUBLIC_API_URL` when available).
 *
 * Mobile (Expo/RN) will later supply its own config via `configureApi()`.
 */

import { API_URL } from "./env";

export interface ApiConfig {
  baseURL: string;
  getToken: () => string | null;
  onTokenExpired?: () => void;
}

let _config: ApiConfig | null = null;

export function configureApi(config: ApiConfig): void {
  _config = config;
}

export function getApiConfig(): ApiConfig {
  if (!_config) {
    // Fallback for backward compatibility — uses centralized env
    return {
      baseURL: API_URL,
      getToken: () => null,
    };
  }
  return _config;
}
