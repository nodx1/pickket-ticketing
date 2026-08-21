"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserPlus, Loader2, LogIn, AlertTriangle } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@pickket/ui";
import {
  issueGuestClaimToken,
  claimGuestOrder,
} from "@pickket/lib/api";
import { useAuthStore } from "@pickket/store";
import { useAuthReady } from "@/providers/AuthProvider";

interface GuestClaimPanelProps {
  locale: string;
  orderId: string;
  viewToken: string;
  checkedIn: boolean;
}

/**
 * 게스트 → 회원 승격 UI.
 *   - 비로그인: 로그인 유도(현 페이지로 복귀). claim 실행은 회원 세션이 필수.
 *   - 로그인: issueGuestClaimToken(view) → claimGuestOrder(claim 토큰 + 쿠키 세션).
 * 체크인된 티켓이 있으면 승격 불가(서버 §6.3 방어). 승격 후 마이페이지로 이동.
 */
export function GuestClaimPanel({
  locale,
  orderId,
  viewToken,
  checkedIn,
}: GuestClaimPanelProps) {
  const t = useTranslations("guest.claim");
  const router = useRouter();
  const { user } = useAuthStore();
  const ready = useAuthReady();
  const [submitting, setSubmitting] = useState(false);

  const goLogin = useCallback(() => {
    const returnUrl = `/${locale}/guests/orders/${orderId}`;
    router.push(`/${locale}/auth?callbackUrl=${encodeURIComponent(returnUrl)}`);
  }, [locale, orderId, router]);

  const handleClaim = useCallback(async () => {
    setSubmitting(true);
    try {
      // 1) claim 매직링크 토큰 발급(view 소유증명).
      const tokenRes = await issueGuestClaimToken(orderId, viewToken);
      // 2) 승격 실행(claim 토큰 + 회원 세션 쿠키). 대상 회원은 서버가 세션으로 강제.
      const res = await claimGuestOrder(orderId, {
        claim_token: tokenRes.data.raw_token,
      });
      toast.success(t("success", { count: res.data.tickets_claimed }));
      router.push(`/${locale}/mypage?tab=tickets`);
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail || t("error");
      toast.error(detail);
    } finally {
      setSubmitting(false);
    }
  }, [orderId, viewToken, locale, router, t]);

  return (
    <div className="rounded-2xl bg-card border border-border p-5 shadow-sm space-y-3">
      <p className="text-sm font-semibold text-content-default flex items-center gap-2">
        <UserPlus className="h-4 w-4 text-primary" />
        {t("title")}
      </p>
      <p className="text-xs text-content-muted">{t("description")}</p>

      {checkedIn ? (
        <div className="rounded-xl bg-amber-600/10 border border-amber-600/20 p-3 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
          <p className="text-xs text-amber-600 dark:text-amber-400">{t("checkedInBlocked")}</p>
        </div>
      ) : !ready ? (
        <div className="h-9 rounded-full bg-muted animate-pulse" />
      ) : user ? (
        <Button
          onClick={() => void handleClaim()}
          disabled={submitting}
          className="rounded-full bg-primary hover:brightness-110 text-white"
        >
          {submitting ? (
            <span className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t("processing")}
            </span>
          ) : (
            <span className="flex items-center gap-2">
              <UserPlus className="h-4 w-4" />
              {t("ctaLoggedIn")}
            </span>
          )}
        </Button>
      ) : (
        <div className="space-y-2">
          <p className="text-xs text-content-muted">{t("loginRequired")}</p>
          <Button
            variant="outline"
            onClick={goLogin}
            className="rounded-full"
          >
            <LogIn className="h-4 w-4 mr-2" />
            {t("ctaLogin")}
          </Button>
        </div>
      )}
    </div>
  );
}
