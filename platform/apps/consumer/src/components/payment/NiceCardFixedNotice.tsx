"use client";

import { CreditCard } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * 나이스 카드전용 게이팅(이벤트 allowed_pay_methods=["CARD"]) 안내.
 * 결제수단 선택 UI 대신 '카드 결제 고정'을 표시한다(선택지 없음 — 서버가 CARD 강제).
 * 라이트/다크 공용 시맨틱 토큰만 사용(하드코드 색상 금지).
 */
export function NiceCardFixedNotice() {
  const t = useTranslations("payment");
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2.5 rounded-xl border border-primary bg-primary/5 p-3 text-sm">
        <CreditCard className="size-4 shrink-0 text-primary" />
        <span className="font-medium text-foreground">
          {t("niceCardOnlyLabel")}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">{t("niceCardOnlyHint")}</p>
    </div>
  );
}
