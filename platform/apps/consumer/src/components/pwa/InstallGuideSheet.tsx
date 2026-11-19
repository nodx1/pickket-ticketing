"use client";

import { useTranslations } from "next-intl";
import { Copy, PlusSquare, Share } from "lucide-react";
import { toast } from "sonner";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@pickket/ui";
import type { PwaPlatform } from "@/lib/pwa";

/** iOS·인앱 브라우저처럼 설치 창을 띄울 수 없는 환경에서 홈 화면 추가 방법을 보여 준다. */
export function InstallGuideSheet({
  platform,
  open,
  onOpenChange,
}: {
  platform: PwaPlatform;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations("pwa");

  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      toast.success(t("copied"));
    } catch {
      /* 복사 실패 시 사용자가 주소창에서 직접 복사 */
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-2xl pb-[calc(env(safe-area-inset-bottom)+16px)]">
        <SheetHeader className="px-5 pt-5">
          <SheetTitle className="flex items-center gap-3 text-base">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/icons/icon-192.png" alt="" width={40} height={40} className="h-10 w-10 rounded-xl" />
            {t("guideTitle")}
          </SheetTitle>
          <SheetDescription className="sr-only">{t("bannerBody")}</SheetDescription>
        </SheetHeader>

        <div className="px-5">
          {platform === "inapp" ? (
            <div className="space-y-4">
              <p className="text-sm leading-relaxed text-muted-foreground">{t("guideInApp")}</p>
              <button
                type="button"
                onClick={copyLink}
                className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-primary text-sm font-semibold text-primary-foreground active:scale-[0.98]"
              >
                <Copy className="h-4 w-4" />
                {t("copyLink")}
              </button>
            </div>
          ) : platform === "ios" ? (
            <ol className="space-y-3">
              {[
                { icon: Share, text: t("guideIosStep1") },
                { icon: PlusSquare, text: t("guideIosStep2") },
                { icon: null, text: t("guideIosStep3") },
              ].map((s, i) => (
                <li key={i} className="flex items-start gap-3 rounded-xl bg-muted/60 p-3">
                  <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
                    {i + 1}
                  </span>
                  <span className="flex-1 pt-0.5 text-sm leading-relaxed">{s.text}</span>
                  {s.icon && <s.icon className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm leading-relaxed text-muted-foreground">{t("guideOther")}</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
