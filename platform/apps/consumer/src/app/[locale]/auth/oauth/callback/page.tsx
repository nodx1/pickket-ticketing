"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Ticket, Loader2 } from "lucide-react";
import { oauthCallback } from "@pickket/lib/api";
import { useAuthStore } from "@pickket/store";
import { sanitizeReturnUrl } from "@/lib/auth-redirect";
import { useTranslations } from "next-intl";

export default function OAuthCallbackPage() {
  const t = useTranslations("auth.oauthCallback");
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setAuth } = useAuthStore();
  const [error, setError] = useState<string | null>(null);
  const [timedOut, setTimedOut] = useState(false);

  useEffect(() => {
    const code = searchParams.get("code");
    const provider = searchParams.get("provider");
    const callbackState = searchParams.get("state");

    if (!code || !provider) {
      setError(t("invalidRequest"));
      return;
    }

    // SECURITY: validate state to prevent OAuth CSRF attacks.
    let storedState: string | null = null;
    try {
      storedState = sessionStorage.getItem("pickket_oauth_state");
      sessionStorage.removeItem("pickket_oauth_state");
    } catch {
      /* noop */
    }
    if (storedState && callbackState && storedState !== callbackState) {
      setError(t("stateMismatch"));
      return;
    }

    const timeout = setTimeout(() => setTimedOut(true), 15000);

    (async () => {
      try {
        const res = await oauthCallback(
          provider,
          code,
          callbackState ?? undefined,
        );
        clearTimeout(timeout);
        setAuth(res.user, "cookie");
        toast.success(t("loginSuccess"));
        let returnUrl = "/";
        try {
          const stored = sessionStorage.getItem("pickket_oauth_return_url");
          const safeReturnUrl = sanitizeReturnUrl(stored);
          if (safeReturnUrl) {
            returnUrl = safeReturnUrl;
          }
          sessionStorage.removeItem("pickket_oauth_return_url");
        } catch {
          /* noop */
        }
        router.push(returnUrl);
      } catch {
        clearTimeout(timeout);
        setError(t("loginFailed"));
      }
    })();

    return () => clearTimeout(timeout);
  }, [searchParams, setAuth, router]);

  if (error) {
    return (
      <div className="bg-background min-h-[80vh] flex items-center justify-center px-4">
        <div className="text-center space-y-4">
          <div className="inline-flex h-14 w-14 rounded-full bg-red-600/10 items-center justify-center">
            <Ticket className="h-7 w-7 text-red-600 dark:text-red-400" />
          </div>
          <h1 className="text-xl font-bold text-foreground">{error}</h1>
          <button
            type="button"
            onClick={() => router.push("/auth")}
            className="text-primary/70 hover:underline text-sm font-medium"
          >
            {t("backToLogin")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-background min-h-[80vh] flex items-center justify-center px-4">
      <div className="text-center space-y-4">
        <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary" />
        <p className="text-sm text-muted-foreground">{t("processing")}</p>
        {timedOut && (
          <div className="space-y-2 pt-2">
            <p className="text-xs text-muted-foreground">
              {t("takingLong")}
            </p>
            <button
              type="button"
              onClick={() => router.push("/auth")}
              className="text-sm font-medium text-primary/70 hover:underline"
            >
              {t("backToLogin")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
