"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Loader2, AlertTriangle, ExternalLink, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { formatKRW } from "@pickket/lib";
import type { OrderInfo, PaymentPhase } from "@/hooks/usePayment";
import { TossWidgetContainers } from "./TossWidgetContainers";
import { NicePayMethodSelector } from "./NicePayMethodSelector";
import { NiceCardFixedNotice } from "./NiceCardFixedNotice";
import type { NicePayMethod } from "@/lib/nicepay-methods";

interface Props {
  open: boolean;
  phase: PaymentPhase;
  orderInfo: OrderInfo | null;
  agreed: boolean;
  widgetReady?: boolean;
  /** 나이스페이(env provider=nicepay) 결제수단 선택 노출 — 토스 위젯 대체. */
  showNiceMethods?: boolean;
  niceMethods?: readonly NicePayMethod[];
  niceMethod?: NicePayMethod;
  onNiceMethodChange?: (m: NicePayMethod) => void;
  /** 나이스 카드전용 게이팅(allowed=CARD): 선택 UI 숨김·카드 고정 안내. */
  niceCardOnly?: boolean;
  /** 결제 provider(브랜딩·처리중 안내 문구 동적화). 미지정이면 nice 게이팅으로 추론. */
  provider?: "toss" | "nicepay";
  /**
   * 나이스 processing 수동 탈출구(belt-and-suspenders): goPay 팝업이 닫혔는데 SDK 콜백이
   * 발화하지 않아도 사용자가 직접 취소할 수 있게 한다. 미지정이면 탈출 링크 미노출.
   */
  onCancelProcessing?: () => void;
  onAgreedChange: (v: boolean) => void;
  onConfirm: () => void;
  onClose: () => void;
}

export default function OrderConfirmationModal({
  open,
  phase,
  orderInfo,
  agreed,
  widgetReady,
  showNiceMethods,
  niceMethods,
  niceMethod,
  onNiceMethodChange,
  niceCardOnly,
  provider,
  onCancelProcessing,
  onAgreedChange,
  onConfirm,
  onClose,
}: Props) {
  const t = useTranslations("payment.orderConfirmationModal");
  const tp = useTranslations("payment");
  const isProcessing = phase === "processing";
  // provider 판정: 명시값 우선, 없으면 나이스 게이팅(수단선택/카드고정)으로 추론.
  const isNiceProvider =
    provider === "nicepay" || (!provider && (!!showNiceMethods || !!niceCardOnly));
  const pgLabel = isNiceProvider ? tp("pgNice") : tp("pgToss");

  useEffect(() => {
    if (!open || isProcessing) return;
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [open, isProcessing, onClose]);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  if (!open || !orderInfo || typeof window === "undefined") return null;

  return createPortal(
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 99999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
      }}
    >
      {/* 오버레이 — 실수로 닫히는 것 방지. X 버튼/ESC 로만 닫기 */}
      <div
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(0,0,0,0.5)",
        }}
      />

      {/* 모달 패널 */}
      <div
        role="dialog"
        aria-modal="true"
        style={{
          position: "relative",
          zIndex: 1,
          width: "100%",
          maxWidth: 448,
          maxHeight: "90vh",
          overflowY: "auto",
          backgroundColor: "var(--background, #fff)",
          border: "1px solid var(--border, #e5e7eb)",
          borderRadius: 12,
          boxShadow: "0 25px 50px -12px rgba(0,0,0,0.25)",
        }}
      >
        {/* 헤더 */}
        <div className="flex items-center justify-between p-6 pb-2">
          <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
          {!isProcessing && (
            <button
              onClick={onClose}
              className="rounded-sm opacity-70 hover:opacity-100 transition-opacity"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>

        <div className="px-6 pb-6 space-y-4">
          {/* 상품 정보 */}
          <div className="rounded-xl bg-muted p-4 space-y-2">
            <Row label={t("rowProduct")} value={orderInfo.eventTitle} />
            <Row label={t("rowTier")} value={orderInfo.tierName} />
            <Row label={t("rowQuantity")} value={t("quantityValue", { n: orderInfo.quantity })} />
            <hr className="border-border" />
            <Row label={t("rowUnitPrice")} value={formatKRW(orderInfo.unitPrice)} tabular />
            <Row
              label={t("rowSubtotal")}
              value={formatKRW(orderInfo.unitPrice * orderInfo.quantity)}
              tabular
              suffix={t("vatIncluded")}
            />
            {orderInfo.fees.platformFee > 0 && (
              <Row
                label={t("rowPlatformFee")}
                value={`-${formatKRW(orderInfo.fees.platformFee)}`}
                tabular
                muted
              />
            )}
            {orderInfo.fees.organizerShare > 0 && (
              <Row
                label={t("rowOrganizerShare")}
                value={`-${formatKRW(orderInfo.fees.organizerShare)}`}
                tabular
              />
            )}
            <hr className="border-border" />
            <div className="flex justify-between">
              <span className="font-semibold text-foreground">
                {t("totalAmount")}
              </span>
              <span className="text-lg font-bold font-tabular text-primary">
                {formatKRW(orderInfo.totalAmount)}
              </span>
            </div>
          </div>

          {/* 결제수단 */}
          <div>
            <p className="text-sm font-semibold text-foreground mb-2">
              {t("paymentMethod")}
            </p>
            {showNiceMethods && niceMethods && niceMethod && onNiceMethodChange ? (
              // 나이스페이(구형): 결제수단 선택 → prepare 의 pay_method 로 전달.
              <div className="space-y-2">
                <NicePayMethodSelector
                  methods={niceMethods}
                  value={niceMethod}
                  onChange={onNiceMethodChange}
                  disabled={isProcessing}
                />
                <p className="text-xs text-muted-foreground">
                  {t("niceMethodHint")}
                </p>
              </div>
            ) : niceCardOnly ? (
              // 나이스 카드전용 게이팅: 선택 UI 없이 카드 고정 안내(토스 위젯 미노출).
              <NiceCardFixedNotice />
            ) : (
              <TossWidgetContainers ready={widgetReady} />
            )}
          </div>

          {/* 청약철회 */}
          <div className="flex gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border-l-4 border-amber-400 dark:border-amber-600">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <p className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed">
              {t.rich("cancellationNotice", {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </p>
          </div>

          {/* 환불 정책 */}
          <div className="text-xs text-muted-foreground space-y-1">
            <p>{t("refundPolicy")}</p>
            <Link
              href="/refund-policy"
              target="_blank"
              className="inline-flex items-center gap-1 text-primary hover:underline font-medium"
            >
              {t("refundPolicyLink")} <ExternalLink className="h-3 w-3" />
            </Link>
          </div>

          {/* 동의 */}
          <label className="flex items-start gap-2.5 p-3 rounded-xl bg-muted cursor-pointer">
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => onAgreedChange(e.target.checked)}
              className="rounded accent-primary w-4 h-4 mt-0.5 shrink-0"
            />
            <span className="text-sm text-foreground leading-snug">
              {t("agreeLabel")}
            </span>
          </label>

          {/* 결제 버튼 */}
          <button
            onClick={onConfirm}
            disabled={!agreed || isProcessing}
            className="w-full h-12 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground text-base font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {isProcessing ? (
              <span className="flex items-center justify-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t("processingButton", { method: pgLabel })}
              </span>
            ) : (
              t("confirmButton", { amount: formatKRW(orderInfo.totalAmount) })
            )}
          </button>

          {/* 수동 탈출구(belt-and-suspenders) — 나이스 goPay 팝업 닫힘 시 SDK 콜백이 발화하지
              않아도 processing 고착을 사용자가 직접 탈출할 수 있게 한다. 주문은 pending 유지. */}
          {isProcessing && isNiceProvider && onCancelProcessing ? (
            <button
              type="button"
              onClick={onCancelProcessing}
              className="w-full text-center text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {t("cancelProcessing")}
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Row({
  label,
  value,
  tabular,
  muted,
  suffix,
}: {
  label: string;
  value: string;
  tabular?: boolean;
  muted?: boolean;
  suffix?: string;
}) {
  return (
    <div className="flex justify-between text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={`font-medium ${tabular ? "font-tabular" : ""} ${muted ? "text-muted-foreground" : "text-foreground"}`}
      >
        {value}
        {suffix && (
          <span className="text-2xs text-muted-foreground ml-1">{suffix}</span>
        )}
      </span>
    </div>
  );
}
