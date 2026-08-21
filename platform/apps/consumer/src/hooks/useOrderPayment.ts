"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  type PayMethod,
} from "@/lib/toss";
import { useTossWidget } from "@/hooks/useTossWidget";
import { startPayment as runPayment } from "@/lib/pay";
import { type OrderDetail } from "@pickket/lib/api";
import {
  type NicePayMethod,
  DEFAULT_NICE_METHOD,
  getNiceMethods,
  isNiceCardOnly,
  isNicePayMethodSelectable,
} from "@/lib/nicepay-methods";

export type OrderPaymentPhase =
  | "idle"
  | "confirming"
  | "processing"
  | "complete"
  | "error";

export interface UseOrderPaymentReturn {
  phase: OrderPaymentPhase;
  selectedPayMethod: PayMethod;
  agreed: boolean;
  errorMessage: string | null;
  setSelectedPayMethod: (m: PayMethod) => void;
  setAgreed: (v: boolean) => void;
  startPayment: (order: OrderDetail, eventTitle: string) => void;
  executePayment: () => Promise<void>;
  retryPayment: () => void;
  /** 수동 탈출구(나이스 goPay 팝업 닫힘 시 SDK 콜백 미발화 대비). paying/phase 리셋·주문 pending 유지. */
  cancelProcessing: () => void;
  closeModal: () => void;
  /** 결제 provider(모달 브랜딩·처리중 문구·탈출구 게이팅). env 기준 판정. */
  provider: "toss" | "nicepay";
  activeOrder: OrderDetail | null;
  activeEventTitle: string;
  widgetReady: boolean;
  /** 나이스페이 결제수단 선택(env provider=nicepay 일 때만 UI 노출). */
  showNiceMethods: boolean;
  niceMethods: readonly NicePayMethod[];
  niceMethod: NicePayMethod;
  setNiceMethod: (m: NicePayMethod) => void;
  /** 카드전용 게이팅(allowed=CARD): 선택 UI 대신 '카드 고정' 안내 표시용. */
  niceCardOnly: boolean;
}

export function useOrderPayment(
  // 토스 리다이렉트 모델: 성공 후처리는 success 페이지→주문상세에서 수행(콜백 미사용, 하위호환).
  _onSuccess?: () => void | Promise<void>,
  // 나이스 결제수단 게이팅(C2). 주문의 이벤트 allowed_pay_methods(대문자 코드 리스트).
  // NULL/미제공 → 전체 노출(현행 무변). ["CARD"] → 카드 고정(선택 UI 숨김).
  allowedPayMethods?: readonly string[] | null,
): UseOrderPaymentReturn {
  const router = useRouter();
  const [phase, setPhase] = useState<OrderPaymentPhase>("idle");
  const [selectedPayMethod, setSelectedPayMethod] = useState<PayMethod>("card");
  const niceProviderActive = isNicePayMethodSelectable();
  const niceMethods = getNiceMethods(allowedPayMethods);
  const niceCardOnly = isNiceCardOnly(allowedPayMethods);
  // 카드전용(허용=CARD 하나)이면 선택 UI 숨기고 카드 고정.
  const showNiceMethods = niceProviderActive && !niceCardOnly;
  const [niceMethod, setNiceMethod] = useState<NicePayMethod>(DEFAULT_NICE_METHOD);
  const effectiveNiceMethod: NicePayMethod = niceCardOnly ? "CARD" : niceMethod;
  const [agreed, setAgreed] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeOrder, setActiveOrder] = useState<OrderDetail | null>(null);
  const [activeEventTitle, setActiveEventTitle] = useState("");
  const isLockedRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { widgetRef, ready: widgetReady } = useTossWidget(
    activeOrder?.total_amount ?? 0,
    phase === "confirming",
  );

  const startPayment = useCallback((order: OrderDetail, eventTitle: string) => {
    setActiveOrder(order);
    setActiveEventTitle(eventTitle);
    setAgreed(false);
    setSelectedPayMethod("card");
    setNiceMethod(DEFAULT_NICE_METHOD);
    setErrorMessage(null);
    isLockedRef.current = false;
    setPhase("confirming");
  }, []);

  const executePayment = useCallback(async () => {
    if (!activeOrder || !agreed) return;
    if (isLockedRef.current) return;
    isLockedRef.current = true;

    setPhase("processing");
    setErrorMessage(null);

    try {
      // provider(토스/나이스) 분기는 공통 startPayment 로 위임(3중복제 공통화).
      const locale =
        (typeof window !== "undefined" && window.location.pathname.split("/")[1]) || "ko";
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const successUrl = `${origin}/${locale}/payment/success?order=${encodeURIComponent(activeOrder.id)}`;
      const failUrl = `${origin}/${locale}/payment/fail?order=${encodeURIComponent(activeOrder.id)}`;
      await runPayment({
        orderId: activeOrder.id,
        orderName: activeEventTitle,
        amount: activeOrder.total_amount,
        successUrl,
        failUrl,
        tossWidget: widgetRef.current,
        // 나이스 provider 활성 시 pay_method 전달(카드전용도 CARD 명시). 토스는 undefined.
        payMethod: niceProviderActive ? effectiveNiceMethod : undefined,
        onNiceError: (message) => {
          setErrorMessage(message);
          setPhase("error");
          isLockedRef.current = false;
        },
        // 나이스 goPay 팝업 닫힘/취소 → processing 고착 탈출. 주문은 pending 유지(재시도 허용).
        onNiceCancel: (message) => {
          setErrorMessage(message ?? "결제가 취소되었습니다. 다시 시도해주세요.");
          setPhase("error");
          isLockedRef.current = false;
        },
      });
      // 정상 경로는 여기 도달 전에 결제창으로 리다이렉트됨.
    } catch (err: unknown) {
      const message =
        err instanceof Error
          ? err.message
          : (err as { response?: { data?: { detail?: string } } })?.response
              ?.data?.detail || "결제에 실패했습니다. 다시 시도해주세요.";
      setErrorMessage(message);
      setPhase("error");
      isLockedRef.current = false;
    }
  }, [
    activeOrder,
    agreed,
    activeEventTitle,
    widgetRef,
    niceProviderActive,
    effectiveNiceMethod,
  ]);

  const retryPayment = useCallback(() => {
    setErrorMessage(null);
    isLockedRef.current = false;
    setPhase("confirming");
  }, []);

  // 수동 탈출구(belt-and-suspenders): 나이스 goPay 팝업이 닫혔는데 SDK 콜백이 발화하지 않아도
  // 사용자가 processing 모달을 직접 취소할 수 있게 한다. 주문은 pending 유지(재시도 허용).
  const cancelProcessing = useCallback(() => {
    setErrorMessage("결제를 취소했습니다. 다시 시도할 수 있습니다.");
    setPhase("error");
    isLockedRef.current = false;
  }, []);

  const closeModal = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setPhase("idle");
    setErrorMessage(null);
    isLockedRef.current = false;
    if (phase === "complete") {
      router.refresh();
    }
  }, [phase, router]);

  return {
    phase,
    selectedPayMethod,
    agreed,
    errorMessage,
    setSelectedPayMethod,
    setAgreed,
    startPayment,
    executePayment,
    retryPayment,
    cancelProcessing,
    closeModal,
    // 결제 provider(모달 브랜딩·처리중 문구·탈출구 게이팅). env 기준 판정.
    provider: (niceProviderActive ? "nicepay" : "toss") as "toss" | "nicepay",
    activeOrder,
    activeEventTitle,
    widgetReady,
    showNiceMethods,
    niceMethods,
    niceMethod,
    setNiceMethod,
    niceCardOnly: niceProviderActive && niceCardOnly,
  };
}
