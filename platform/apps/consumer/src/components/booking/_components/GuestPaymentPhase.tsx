"use client";

import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { Button } from "@pickket/ui";
import { formatKRW } from "@pickket/lib";
import { isTossLive } from "@/lib/toss";
import { TossWidgetContainers } from "@/components/payment/TossWidgetContainers";
import { NicePayMethodSelector } from "@/components/payment/NicePayMethodSelector";
import { NiceCardFixedNotice } from "@/components/payment/NiceCardFixedNotice";
import type { NicePayMethod } from "@/lib/nicepay-methods";

interface GuestPaymentPhaseProps {
  eventTitle: string;
  tierName: string;
  quantity: number;
  totalAmount: number;
  widgetReady: boolean;
  agreedPay: boolean;
  paying: boolean;
  payDisabled: boolean;
  error: string | null;
  /** 나이스페이(env provider=nicepay) 결제수단 선택 노출 — 토스 위젯 대체. */
  showNiceMethods?: boolean;
  niceMethods?: readonly NicePayMethod[];
  niceMethod?: NicePayMethod;
  onNiceMethodChange?: (m: NicePayMethod) => void;
  /** 나이스 카드전용 게이팅(allowed=CARD): 선택 UI 숨김·카드 고정 안내. */
  niceCardOnly?: boolean;
  /** 결제 provider(나이스면 processing 수동 탈출구 노출). 미지정이면 nice 게이팅으로 추론. */
  provider?: "toss" | "nicepay";
  /**
   * 나이스 processing(paying) 수동 탈출구(belt-and-suspenders): goPay 팝업이 닫혔는데 SDK
   * 콜백이 발화하지 않아도 사용자가 직접 취소할 수 있게 한다. 미지정이면 링크 미노출.
   */
  onCancelProcessing?: () => void;
  onAgreedChange: (v: boolean) => void;
  onPay: () => void;
  onBack: () => void;
}

/**
 * 게스트 유료 PG 결제 단계(payment phase).
 * 회원 PaymentConfirmModal 과 동형: 주문요약 + 토스 결제위젯(라이브)/나이스·mock 안내 +
 * 결제 동의 + 결제버튼. 결제개시(prepare→결제창)는 상위 handlePay 에 위임.
 */
export function GuestPaymentPhase({
  eventTitle,
  tierName,
  quantity,
  totalAmount,
  widgetReady,
  agreedPay,
  paying,
  payDisabled,
  error,
  showNiceMethods,
  niceMethods,
  niceMethod,
  onNiceMethodChange,
  niceCardOnly,
  provider,
  onCancelProcessing,
  onAgreedChange,
  onPay,
  onBack,
}: GuestPaymentPhaseProps) {
  const t = useTranslations("guest.checkout");
  const isNiceProvider =
    provider === "nicepay" || (!provider && (!!showNiceMethods || !!niceCardOnly));

  return (
    <div className="space-y-4 pt-2">
      <div>
        <p className="font-semibold text-foreground">{t("payTitle")}</p>
        <p className="mt-0.5 text-sm text-muted-foreground">{t("payHint")}</p>
      </div>

      {/* 주문 요약 */}
      <div className="rounded-xl bg-muted/60 border border-border p-3 space-y-1.5">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">{eventTitle}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">
            {tierName} × {quantity}
          </span>
          <span className="font-semibold text-foreground font-tabular">
            {formatKRW(totalAmount)}
          </span>
        </div>
      </div>

      {/* 결제수단 — 나이스 선택(구형) / 토스 결제위젯(라이브)·mock 안내 */}
      {showNiceMethods && niceMethods && niceMethod && onNiceMethodChange ? (
        <div className="space-y-2">
          <NicePayMethodSelector
            methods={niceMethods}
            value={niceMethod}
            onChange={onNiceMethodChange}
            disabled={paying}
          />
          <p className="text-xs text-muted-foreground">{t("niceMethodHint")}</p>
        </div>
      ) : niceCardOnly ? (
        // 나이스 카드전용 게이팅: 선택 UI 없이 카드 고정 안내(토스 위젯 미노출).
        <NiceCardFixedNotice />
      ) : (
        <TossWidgetContainers ready={widgetReady} />
      )}

      {/* 결제 동의 */}
      <label className="flex items-start gap-2.5 cursor-pointer select-none rounded-xl bg-muted/60 border border-border p-3">
        <input
          type="checkbox"
          checked={agreedPay}
          onChange={(e) => onAgreedChange(e.target.checked)}
          className="mt-0.5 size-4 rounded border-border text-primary focus:ring-primary/30"
        />
        <span className="text-sm text-foreground leading-snug">
          {t("agreePay")}
        </span>
      </label>

      {error && (
        <p className="text-sm text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}

      <Button
        type="button"
        onClick={onPay}
        disabled={payDisabled}
        className="w-full rounded-full bg-primary hover:brightness-110 text-white h-11 text-base"
      >
        {paying ? (
          <span className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("processing")}
          </span>
        ) : isTossLive() && !widgetReady ? (
          <span className="flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("widgetLoading")}
          </span>
        ) : (
          t("ctaPayNow", { amount: formatKRW(totalAmount) })
        )}
      </Button>

      <button
        type="button"
        onClick={onBack}
        disabled={paying}
        className="w-full text-center text-sm text-muted-foreground hover:text-foreground disabled:opacity-50"
      >
        {t("back")}
      </button>

      {/* 수동 탈출구(belt-and-suspenders) — 나이스 goPay 팝업 닫힘 시 SDK 콜백이 발화하지
          않아도 paying 고착을 사용자가 직접 탈출할 수 있게 한다. 주문은 pending 유지. */}
      {paying && isNiceProvider && onCancelProcessing ? (
        <button
          type="button"
          onClick={onCancelProcessing}
          className="w-full text-center text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          {t("cancelProcessing")}
        </button>
      ) : null}
    </div>
  );
}
