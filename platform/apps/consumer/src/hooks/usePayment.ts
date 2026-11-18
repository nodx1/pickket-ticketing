"use client";

import { useState, useCallback, useRef } from "react";
import { currentLocale } from "@/lib/locale-path";
import {
  type PayMethod,
  type PaymentResponse,
} from "@/lib/toss";
import { useTossWidget } from "@/hooks/useTossWidget";
import { startPayment } from "@/lib/pay";
import {
  type NicePayMethod,
  DEFAULT_NICE_METHOD,
  getNiceMethods,
  isNiceCardOnly,
  isNicePayMethodSelectable,
} from "@/lib/nicepay-methods";

export type PaymentPhase =
  | "idle"
  | "confirming"
  | "processing"
  | "authorized"
  | "complete"
  | "error";

export interface OrderInfo {
  eventTitle: string;
  tierName: string;
  unitPrice: number;
  quantity: number;
  fees: { platformFee: number; organizerShare: number };
  totalAmount: number;
  useAuthCapture?: boolean;
}

const SESSION_KEY = "pickket_pending_order";

function getPersistedOrderFromSession(): {
  orderId: string | null;
  orderInfo: OrderInfo | null;
} {
  if (typeof window === "undefined") {
    return { orderId: null, orderInfo: null };
  }
  try {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (!saved) {
      return { orderId: null, orderInfo: null };
    }
    const parsed = JSON.parse(saved);
    if (parsed.orderId && parsed.orderInfo) {
      return {
        orderId: parsed.orderId,
        orderInfo: parsed.orderInfo as OrderInfo,
      };
    }
  } catch {
    // ignore parse errors
  }
  return { orderId: null, orderInfo: null };
}

export function usePayment(
  // 토스 리다이렉트 모델: 성공 후처리는 success 페이지→주문상세에서 수행되어 이 콜백은
  // 더 이상 호출되지 않는다(시그니처 하위호환 유지).
  _onPaymentSuccess?: (result: PaymentResponse) => void | Promise<void>,
  // 나이스 결제수단 게이팅(C2). 이벤트의 allowed_pay_methods(대문자 코드 리스트).
  // NULL/미제공 → 전체 노출(현행 무변). ["CARD"] → 카드 고정(선택 UI 숨김).
  allowedPayMethods?: readonly string[] | null,
) {
  const [phase, setPhase] = useState<PaymentPhase>("idle");
  const [orderInfo, setOrderInfo] = useState<OrderInfo | null>(
    () => getPersistedOrderFromSession().orderInfo,
  );
  const [selectedPayMethod, setSelectedPayMethod] = useState<PayMethod>("card");
  // 나이스페이(구형) 결제수단 — env provider=nicepay 일 때 활성.
  // 이벤트 allowed_pay_methods 로 노출 수단 제한(카드전용이면 선택 UI 숨김·카드 고정).
  const niceProviderActive = isNicePayMethodSelectable();
  const niceMethods = getNiceMethods(allowedPayMethods);
  const niceCardOnly = isNiceCardOnly(allowedPayMethods);
  // 카드전용(허용=CARD 하나)이면 선택 UI 를 숨기고 카드로 고정 표시한다.
  const showNiceMethods = niceProviderActive && !niceCardOnly;
  // 카드전용이면 CARD 로 강제(선택 상태 무시), 아니면 사용자 선택값.
  const [niceMethod, setNiceMethod] = useState<NicePayMethod>(DEFAULT_NICE_METHOD);
  const effectiveNiceMethod: NicePayMethod = niceCardOnly ? "CARD" : niceMethod;
  const [agreed, setAgreed] = useState(false);
  const [paymentResult, setPaymentResult] = useState<PaymentResponse | null>(
    null,
  );
  const [authorizationId, setAuthorizationId] = useState<string | null>(null);
  const [orderId, setOrderId] = useState<string | null>(
    () => getPersistedOrderFromSession().orderId,
  );
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const isLockedRef = useRef(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // 결제 확인 단계에서 토스 결제위젯 렌더(모달이 컨테이너 divs 제공).
  const { widgetRef, ready: widgetReady } = useTossWidget(
    orderInfo?.totalAmount ?? 0,
    phase === "confirming",
  );

  const persistOrder = useCallback((id: string, info: OrderInfo) => {
    try {
      sessionStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ orderId: id, orderInfo: info }),
      );
    } catch {
      // storage full or unavailable
    }
  }, []);

  const clearPersistedOrder = useCallback(() => {
    try {
      sessionStorage.removeItem(SESSION_KEY);
    } catch {
      // ignore
    }
  }, []);

  const openConfirmation = useCallback(
    // serverOrderId: 실제 서버 주문 id(purchaseTicket 응답). 이 값으로 prepare 하고 SDK 에
    // 서버 발급 payment_id 를 넘겨야 웹훅이 주문을 확정한다. (감사 P0-D)
    (info: OrderInfo, serverOrderId: string) => {
      setOrderId(serverOrderId);
      setOrderInfo(info);
      setAgreed(false);
      setSelectedPayMethod("card");
      setNiceMethod(DEFAULT_NICE_METHOD);
      setPaymentResult(null);
      setAuthorizationId(null);
      setErrorMessage(null);
      isLockedRef.current = false;
      setPhase("confirming");
      persistOrder(serverOrderId, info);
    },
    [persistOrder],
  );

  const executePayment = useCallback(async () => {
    if (!orderInfo || !orderId || !agreed) return;
    if (isLockedRef.current) return;
    isLockedRef.current = true;

    setPhase("processing");
    setErrorMessage(null);

    try {
      // provider(토스/나이스) 분기는 공통 startPayment 로 위임(3중복제 공통화).
      const locale = currentLocale();
      const origin = typeof window !== "undefined" ? window.location.origin : "";
      const successUrl = `${origin}/${locale}/payment/success?order=${encodeURIComponent(orderId)}`;
      const failUrl = `${origin}/${locale}/payment/fail?order=${encodeURIComponent(orderId)}`;
      clearPersistedOrder();
      await startPayment({
        orderId,
        orderName: `${orderInfo.eventTitle} - ${orderInfo.tierName}`,
        amount: orderInfo.totalAmount,
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
      // 사용자가 결제창을 닫았거나(취소) 오류 — 주문은 pending 유지, 재시도 허용.
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
    orderInfo,
    orderId,
    agreed,
    clearPersistedOrder,
    widgetRef,
    niceProviderActive,
    effectiveNiceMethod,
  ]);

  const retryPayment = useCallback(() => {
    setErrorMessage(null);
    setPhase("confirming");
    isLockedRef.current = false;
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
    setAuthorizationId(null);
    isLockedRef.current = false;
  }, []);

  const reset = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setPhase("idle");
    setOrderInfo(null);
    setAgreed(false);
    setPaymentResult(null);
    setAuthorizationId(null);
    setOrderId(null);
    setNiceMethod(DEFAULT_NICE_METHOD);
    setErrorMessage(null);
    isLockedRef.current = false;
    clearPersistedOrder();
  }, [clearPersistedOrder]);

  return {
    phase,
    orderInfo,
    selectedPayMethod,
    agreed,
    paymentResult,
    authorizationId,
    orderId,
    errorMessage,
    setSelectedPayMethod,
    setAgreed,
    openConfirmation,
    executePayment,
    retryPayment,
    cancelProcessing,
    closeModal,
    reset,
    widgetReady,
    // 결제 provider(모달 브랜딩·처리중 문구·탈출구 게이팅). env 기준 판정.
    provider: (niceProviderActive ? "nicepay" : "toss") as "toss" | "nicepay",
    // 나이스페이 결제수단 선택(env provider=nicepay + 카드전용 아닐 때만 UI 노출).
    showNiceMethods,
    niceMethods,
    niceMethod,
    setNiceMethod,
    // 카드전용 게이팅(allowed=CARD): 선택 UI 대신 '카드 고정' 안내 표시용.
    niceCardOnly: niceProviderActive && niceCardOnly,
  };
}
