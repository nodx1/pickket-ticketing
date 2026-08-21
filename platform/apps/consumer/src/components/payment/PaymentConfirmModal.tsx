"use client";

import { createPortal } from "react-dom";
import Link from "next/link";
import { Loader2, AlertTriangle, ExternalLink, X } from "lucide-react";
import { formatKRW } from "@pickket/lib";
import { PAY_METHOD_LABELS, type PayMethod } from "@/lib/toss";
import type { OrderInfo } from "@/hooks/usePayment";
import { TossWidgetContainers } from "./TossWidgetContainers";
import { NicePayMethodSelector } from "./NicePayMethodSelector";
import { NiceCardFixedNotice } from "./NiceCardFixedNotice";
import type { NicePayMethod } from "@/lib/nicepay-methods";
import { useTranslations } from "next-intl";

interface PaymentConfirmModalProps {
  open: boolean;
  orderInfo: OrderInfo;
  payMethod: PayMethod;
  agreed: boolean;
  paying: boolean;
  widgetReady?: boolean;
  /** 결제위젯 렌더 실패(라이브) — 재시도 UI 노출용 */
  widgetError?: boolean;
  /** 위젯 렌더 재시도 */
  onReloadWidget?: () => void;
  /** 결제 진행 불가(예: 라이브인데 위젯 미준비) — 결제 버튼 비활성 */
  payDisabled?: boolean;
  /**
   * 나이스페이 결제수단 선택 노출(env provider=nicepay). true 면 토스 위젯 대신
   * NicePayMethodSelector 를 렌더한다. false/미지정=토스 위젯(기존 동작).
   */
  showNiceMethods?: boolean;
  /** 노출할 나이스 결제수단 목록(카드전용 게이팅 시 [CARD]). */
  niceMethods?: readonly NicePayMethod[];
  /** 현재 선택된 나이스 결제수단. */
  niceMethod?: NicePayMethod;
  onNiceMethodChange?: (method: NicePayMethod) => void;
  /** 나이스 카드전용 게이팅(allowed=CARD): 선택 UI 숨김·카드 고정 안내. */
  niceCardOnly?: boolean;
  /** 결제 provider(브랜딩·처리중 안내 문구 동적화). 미지정이면 nice 게이팅으로 추론. */
  provider?: "toss" | "nicepay";
  /**
   * 나이스 processing(paying) 수동 탈출구(belt-and-suspenders): goPay 팝업이 닫혔는데 SDK
   * 콜백이 발화하지 않아도 사용자가 직접 취소할 수 있게 한다. 미지정이면 탈출 링크 미노출.
   */
  onCancelProcessing?: () => void;
  onAgreedChange: (agreed: boolean) => void;
  onConfirm: () => void;
  onClose: () => void;
}

export default function PaymentConfirmModal({
  open,
  orderInfo,
  payMethod,
  agreed,
  paying,
  widgetReady,
  widgetError,
  onReloadWidget,
  payDisabled,
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
}: PaymentConfirmModalProps) {
  const t = useTranslations("payment");
  // provider 판정: 명시값 우선, 없으면 나이스 게이팅(수단선택/카드고정)으로 추론.
  const isNiceProvider =
    provider === "nicepay" || (!provider && (!!showNiceMethods || !!niceCardOnly));
  const pgLabel = isNiceProvider ? t("pgNice") : t("pgToss");
  if (!open || typeof window === "undefined") return null;

  return createPortal(
    <div
      id="pickket-payment-modal"
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
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          backgroundColor: "rgba(0,0,0,0.5)",
        }}
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="payment-confirm-title"
        aria-describedby="payment-confirm-summary"
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
        <div className="flex items-center justify-between p-6 pb-2">
          <h2
            id="payment-confirm-title"
            className="text-lg font-semibold text-foreground"
          >
            {t("confirm_title")}
          </h2>
          {!paying && (
            <button
              onClick={onClose}
              aria-label={t("close")}
              className="opacity-70 hover:opacity-100"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="px-6 pb-6 space-y-4">
          {/* 상품 정보 */}
          <div
            id="payment-confirm-summary"
            className="rounded-xl bg-muted p-4 space-y-2 text-sm"
          >
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("product")}</span>
              <span className="font-medium text-foreground">
                {orderInfo.eventTitle}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("tier")}</span>
              <span className="font-medium text-foreground">
                {orderInfo.tierName}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("quantity")}</span>
              <span className="font-medium text-foreground">
                {t("quantity_value").replace(
                  "{count}",
                  String(orderInfo.quantity),
                )}
              </span>
            </div>
            <hr className="border-border" />
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("unit_price")}</span>
              <span className="font-tabular text-foreground">
                {formatKRW(orderInfo.unitPrice)}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("subtotal")}</span>
              <span className="font-tabular text-foreground">
                {formatKRW(orderInfo.unitPrice * orderInfo.quantity)}
                <span className="text-2xs text-muted-foreground ml-1">
                  {t("vat_included")}
                </span>
              </span>
            </div>
            <hr className="border-border" />
            <div className="flex justify-between">
              <span className="font-semibold text-foreground">
                {t("total_amount")}
              </span>
              <span className="text-lg font-bold font-tabular text-primary">
                {formatKRW(orderInfo.totalAmount)}
              </span>
            </div>
          </div>

          {/* 결제수단 — 토스 결제위젯 */}
          <div>
            <p
              id="payment-method-heading"
              className="text-sm font-semibold text-foreground mb-2"
            >
              {t("pay_method")}
            </p>
            {showNiceMethods && niceMethods && niceMethod && onNiceMethodChange ? (
              // 나이스페이(구형): 결제수단 선택 → prepare 의 pay_method 로 전달.
              <div className="space-y-2">
                <NicePayMethodSelector
                  methods={niceMethods}
                  value={niceMethod}
                  onChange={onNiceMethodChange}
                  disabled={paying}
                />
                <p className="text-xs text-muted-foreground">
                  {t("nice_method_hint")}
                </p>
              </div>
            ) : niceCardOnly ? (
              // 나이스 카드전용 게이팅: 선택 UI 없이 카드 고정 안내(토스 위젯 미노출).
              <NiceCardFixedNotice />
            ) : widgetError ? (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm">
                <p className="flex items-center gap-2 font-medium text-destructive">
                  <AlertTriangle className="h-4 w-4 shrink-0" />
                  {t("widget_load_failed")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{t("widget_load_failed_hint")}</p>
                {onReloadWidget ? (
                  <button
                    type="button"
                    onClick={onReloadWidget}
                    className="mt-3 rounded-lg border border-border bg-background px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted"
                  >
                    {t("retry")}
                  </button>
                ) : null}
              </div>
            ) : (
              <TossWidgetContainers ready={widgetReady} />
            )}
          </div>

          {/* 청약철회 */}
          <div className="flex gap-2 p-3 rounded-lg bg-amber-50 dark:bg-amber-950/30 border-l-4 border-amber-400 dark:border-amber-600">
            <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" />
            <p
              className="text-xs text-amber-800 dark:text-amber-300 leading-relaxed"
              dangerouslySetInnerHTML={{ __html: t("withdrawal_notice") }}
            />
          </div>

          {/* 환불 */}
          <div className="text-xs text-muted-foreground space-y-1">
            <p>{t("refund_info")}</p>
            <Link
              href="/refund-policy"
              target="_blank"
              className="inline-flex items-center gap-1 text-primary hover:underline font-medium"
            >
              {t("view_refund_policy")} <ExternalLink className="h-3 w-3" />
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
              {t("agree_order")}
            </span>
          </label>

          {/* 결제 버튼 */}
          <button
            onClick={onConfirm}
            disabled={!agreed || paying || payDisabled}
            aria-describedby="payment-confirm-summary"
            aria-busy={paying}
            aria-label={`${formatKRW(orderInfo.totalAmount)} (${PAY_METHOD_LABELS[payMethod]})`}
            className="w-full h-12 rounded-full bg-primary hover:bg-primary/90 text-primary-foreground text-base font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {paying ? (
              <span
                className="flex items-center justify-center gap-2"
                role="status"
                aria-live="assertive"
              >
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {t("paying_with").replace(
                  "{method}",
                  isNiceProvider ? pgLabel : PAY_METHOD_LABELS[payMethod],
                )}
              </span>
            ) : (
              t("pay_button").replace("{amount}", formatKRW(orderInfo.totalAmount))
            )}
          </button>

          {/* 수동 탈출구(belt-and-suspenders) — 나이스 goPay 팝업 닫힘 시 SDK 콜백이 발화하지
              않아도 paying 고착을 사용자가 직접 탈출할 수 있게 한다. 주문은 pending 유지. */}
          {paying && isNiceProvider && onCancelProcessing ? (
            <button
              type="button"
              onClick={onCancelProcessing}
              className="w-full text-center text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {t("cancel_processing")}
            </button>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
