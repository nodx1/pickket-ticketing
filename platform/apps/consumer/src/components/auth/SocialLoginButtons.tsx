"use client";

import { getOAuthRedirectUrl } from "@pickket/lib/api";
import { sanitizeReturnUrl } from "@/lib/auth-redirect";
import { useTranslations } from "next-intl";

const ALLOWED_OAUTH_ORIGINS = [
  "https://kauth.kakao.com",
  "https://accounts.google.com",
  "https://nid.naver.com",
  process.env.NEXT_PUBLIC_API_URL,
  process.env.NEXT_PUBLIC_BASE_URL,
].filter(Boolean);

interface SocialLoginButtonsProps {
  className?: string;
  returnUrl?: string | null;
  onBeforeRedirect?: () => void;
}

export default function SocialLoginButtons({
  className,
  returnUrl,
  onBeforeRedirect,
}: SocialLoginButtonsProps) {
  const t = useTranslations("auth");
  const handleSocialLogin = async (provider: string) => {
    try {
      // Persist returnUrl for OAuth redirect chain
      const safeReturnUrl = sanitizeReturnUrl(returnUrl);
      if (safeReturnUrl) {
        try {
          sessionStorage.setItem("pickket_oauth_return_url", safeReturnUrl);
        } catch {
          /* noop */
        }
      }
      const data = await getOAuthRedirectUrl(provider);
      try {
        const url = new URL(data.redirect_url);
        if (
          !ALLOWED_OAUTH_ORIGINS.some(
            (o) => o && url.origin === new URL(o).origin,
          )
        ) {
          console.error("Invalid OAuth redirect origin:", url.origin);
          return;
        }
        // SECURITY: persist state parameter for CSRF validation in callback page.
        if (data.state) {
          try {
            sessionStorage.setItem("pickket_oauth_state", data.state);
          } catch {
            /* noop */
          }
        }
        onBeforeRedirect?.();
        window.location.href = data.redirect_url;
      } catch {
        console.error("Invalid redirect URL");
      }
    } catch {
      // Silent fail -- user can retry
    }
  };

  return (
    <div className={className}>
      {/* Divider */}
      <div className="flex items-center gap-3 my-4">
        <div className="h-px flex-1 bg-border" />
        <span className="text-xs text-muted-foreground font-medium">
          {t("social_login")}
        </span>
        <div className="h-px flex-1 bg-border" />
      </div>

      <div className="flex flex-col gap-2.5">
        {/* Kakao */}
        <button
          type="button"
          onClick={() => handleSocialLogin("kakao")}
          className="flex items-center justify-center gap-2.5 w-full h-11 rounded-full text-sm font-medium transition-all duration-200 hover:opacity-90"
          style={{ backgroundColor: "#FEE500", color: "#191919" }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path
              d="M9 1.5C4.86 1.5 1.5 4.14 1.5 7.38C1.5 9.42 2.88 11.22 4.92 12.24L4.14 15.18C4.08 15.36 4.32 15.48 4.44 15.36L7.86 13.08C8.22 13.14 8.58 13.14 9 13.14C13.14 13.14 16.5 10.56 16.5 7.32C16.5 4.14 13.14 1.5 9 1.5Z"
              fill="#191919"
            />
          </svg>
          <span>{t("social_kakao")}</span>
        </button>

        {/* Google */}
        <button
          type="button"
          onClick={() => handleSocialLogin("google")}
          className="flex items-center justify-center gap-2.5 w-full h-11 rounded-full text-sm font-medium transition-all duration-200 border border-border bg-white text-gray-700 hover:bg-gray-50 dark:bg-gray-800 dark:text-gray-100 dark:border-gray-600 dark:hover:bg-gray-700"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path
              d="M17.64 9.2C17.64 8.57 17.58 7.95 17.48 7.36H9V10.85H13.84C13.64 11.97 13 12.92 12.05 13.56V15.82H14.96C16.66 14.25 17.64 11.95 17.64 9.2Z"
              fill="#4285F4"
            />
            <path
              d="M9 18C11.43 18 13.47 17.2 14.96 15.82L12.05 13.56C11.24 14.1 10.21 14.42 9 14.42C6.66 14.42 4.68 12.84 3.96 10.71H0.96V13.04C2.44 15.98 5.48 18 9 18Z"
              fill="#34A853"
            />
            <path
              d="M3.96 10.71C3.78 10.17 3.68 9.59 3.68 9C3.68 8.41 3.78 7.83 3.96 7.29V4.96H0.96C0.35 6.18 0 7.55 0 9C0 10.45 0.35 11.82 0.96 13.04L3.96 10.71Z"
              fill="#FBBC05"
            />
            <path
              d="M9 3.58C10.32 3.58 11.5 4.04 12.44 4.93L15.02 2.35C13.46 0.89 11.43 0 9 0C5.48 0 2.44 2.02 0.96 4.96L3.96 7.29C4.68 5.16 6.66 3.58 9 3.58Z"
              fill="#EA4335"
            />
          </svg>
          <span>{t("social_google")}</span>
        </button>

        {/* Naver */}
        <button
          type="button"
          onClick={() => handleSocialLogin("naver")}
          className="flex items-center justify-center gap-2.5 w-full h-11 rounded-full text-sm font-medium transition-all duration-200 hover:opacity-90"
          style={{ backgroundColor: "#03C75A", color: "#003A14" }}
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path
              d="M12.12 9.54L5.64 0H0V18H5.88V8.46L12.36 18H18V0H12.12V9.54Z"
              fill="#003A14"
            />
          </svg>
          <span>{t("social_naver")}</span>
        </button>
      </div>
    </div>
  );
}
