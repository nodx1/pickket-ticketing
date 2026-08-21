/**
 * OAuth 소셜 로그인 훅
 *
 * 플로우:
 * 1. 백엔드에서 OAuth authorization URL 획득
 * 2. expo-web-browser로 브라우저 열기
 * 3. 사용자 인증 후 redirect → 앱으로 code 수신
 * 4. 백엔드 callback API로 code 전송 → JWT 토큰 수신
 */
import { useState, useCallback } from "react";
import * as WebBrowser from "expo-web-browser";
import * as AppleAuthentication from "expo-apple-authentication";
import { makeRedirectUri } from "expo-auth-session";
import {
  getOAuthRedirectUrl,
  oauthCallback,
  type OAuthProvider,
  type OAuthCallbackResponse,
} from "@/config/api";
import { storage } from "@/lib/storage";
import { useAuthStore } from "./useAuth";

// expo-web-browser warm up (Android 성능 개선)
WebBrowser.maybeCompleteAuthSession();

const redirectUri = makeRedirectUri({
  scheme: "pickket",
  path: "auth/callback",
});

export function useOAuth() {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async (provider: OAuthProvider) => {
    setIsLoading(true);
    setError(null);

    try {
      let data: OAuthCallbackResponse;

      if (provider === "apple") {
        // Apple Sign-In (iOS 네이티브 — Guideline 4.8 필수)
        const credential = await AppleAuthentication.signInAsync({
          requestedScopes: [
            AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
            AppleAuthentication.AppleAuthenticationScope.EMAIL,
          ],
        });

        if (!credential.identityToken) {
          throw new Error("Apple identity token not received");
        }

        // 백엔드에 identityToken 전달 → JWT 교환
        data = await oauthCallback("apple", credential.identityToken);
      } else {
        // 기존 OAuth 플로우 (Kakao, Google, Naver)
        // 1. 백엔드에서 OAuth 인증 URL 획득
        const { authorization_url, state } = await getOAuthRedirectUrl(provider, redirectUri);

        // 2. 브라우저에서 OAuth 인증 진행
        const result = await WebBrowser.openAuthSessionAsync(
          authorization_url,
          redirectUri,
        );

        if (result.type !== "success") {
          // 사용자 취소 또는 브라우저 종료
          setIsLoading(false);
          return;
        }

        // 3. redirect URL에서 code + state 추출 및 CSRF 검증
        const url = new URL(result.url);
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");

        if (!code) {
          throw new Error("Authorization code not received");
        }

        // AUDIT §3 P1: CSRF 방지 — state가 비어있으면 fail-close (skip 금지)
        if (!state || !returnedState) {
          throw new Error("OAuth state missing — CSRF verification failed");
        }
        if (returnedState !== state) {
          throw new Error("OAuth state mismatch — possible CSRF attack");
        }

        // 4. 백엔드 callback으로 토큰 교환
        data = await oauthCallback(provider, code, state);
      }

      // 5. MFA 가드 — 백엔드는 관리자(is_mfa_required) 계정에
      //    `{ mfa_required: true, mfa_token, access_token: "" }`를 반환한다.
      //    모바일에는 MFA 검증 플로우가 없으므로(비번 경로의 빈-토큰 가드와 동일하게)
      //    빈 토큰 저장 + 가짜 로그인 성공을 막고 명시적 에러로 surface한다.
      //    이를 누락하면 빈 access_token이 저장되어 이후 인증 호출이 401 루프에 빠진다.
      if (data.mfa_required || !data.access_token) {
        throw new Error(
          "관리자 계정은 2단계 인증이 필요합니다. 웹에서 로그인해 주세요.",
        );
      }

      // 6. 토큰 저장 + 상태 업데이트 (일반 사용자 — 기존과 동일)
      await storage.setAccessToken(data.access_token);
      if (data.refresh_token) {
        await storage.setRefreshToken(data.refresh_token);
      }

      useAuthStore.setState({ user: data.user, isGuest: false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "OAuth login failed";
      if (__DEV__) console.warn(`[OAuth] ${provider} login failed:`, message);
      setError(message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return { login, isLoading, error };
}
