/* ── 결제 개시 공통 헬퍼 (consumer) ─────────────────────────────────────────
 *
 * BookingPageClient · usePayment · useOrderPayment 3곳이 동일하게 복제하던
 * "prepare → provider 분기 → 결제창 호출" 흐름을 단일 지점으로 추출한다.
 *
 * provider 판정: v2 prepare 응답의 `provider`(`prepared.data.provider`)를 읽어
 *   - "nicepay"  → 나이스 구형 결제창(startNicePayment, goPay 폼 POST). 서버가 내려준
 *                  provider_params(js_url + form: MID/SignData/ReturnURL...)를 그대로 소비.
 *   - 그 외/미지정 → 토스 결제위젯(기존 경로, 폴백 포함).
 * 미지정/알 수 없는 값이면 토스로 폴백해 회귀를 막는다(가산적 분기).
 *
 * 성공 경로는 모두 브라우저 리다이렉트로 끝나므로(토스 successUrl / 나이스 ReturnURL→v2→consumer redirect)
 * 정상 흐름에서 이 함수는 반환 전에 페이지를 떠난다. 오류는 throw 로 상위에 위임.
 */

"use client";

import { prepareOrderPayment, type PaymentPrepareResponse } from "@pickket/lib/api";
import { isTossLive, mockRedirectToSuccess, requestDirectTossPayment, type TossWidgetHandle } from "@/lib/toss";
import { startNicePayment } from "@/lib/nice";

/** provider 리터럴(v2 prepare.provider). 미지정/미상은 **나이스** 폴백. */
export type PaymentProvider = "toss" | "nicepay" | "toss_direct";

export function resolveProvider(raw: string | null | undefined): PaymentProvider {
  // 과업 WP7: 주최사 PG 직결(무경유) — 결제창을 주최사 상점 키로 띄운다.
  if (raw === "toss_direct") return "toss_direct";
  // 🔴 폴백 "toss" → "nicepay" (2026-07-28 대표 결정: 나이스 **구형/정규**로만 간다. 토스는 dormant(기존 주문 라우팅용).)
  //    v2 prepare 가 provider 를 내리므로 보통은 이 폴백을 타지 않지만,
  //    타는 순간 결제창이 통째로 다른 PG 로 열리므로 기본값이 결정된 PG 여야 한다.
  return raw === "toss" ? "toss" : "nicepay";
}

export interface StartPaymentParams {
  /** v2 주문 UUID — prepare 대상. (payment_id 아님) */
  orderId: string;
  /** 결제창 상품명(토스 orderName / 나이스 goodsName). */
  orderName: string;
  /** 표시·mock 금액. 서버가 confirm 시 재검증하므로 신뢰경계 아님. */
  amount: number;
  successUrl: string;
  failUrl: string;
  /** 토스 라이브 시 필수 — 미리 렌더된 위젯 핸들(useTossWidget widgetRef.current). */
  tossWidget?: TossWidgetHandle | null;
  buyer?: {
    name?: string;
    email?: string;
    tel?: string;
  };
  /**
   * 나이스페이 결제수단(CARD·BANK·VBANK·CELLPHONE·EASYPAY). 선택.
   * 기본 prepare 사용 시 서버 prepare 요청의 pay_method 로 전달된다(토스는 무시).
   * 게스트처럼 `prepare` 를 주입하는 경우, 주입한 prepare 가 직접 pay_method 를 실어야 한다.
   */
  payMethod?: string;
  /**
   * 나이스 결제창 인증 오류(사용자 취소·창닫힘 포함) 콜백.
   * 나이스는 SDK 가 예외를 throw 하지 않고 fnError 로 통지하므로 별도 전달이 필요하다.
   */
  onNiceError?: (message: string) => void;
  /**
   * 나이스 goPay **팝업 닫힘/취소** 콜백(PC 결제창 X·SDK fnError). goPay 는 예외를 throw 하지
   * 않고 즉시 반환하므로, 팝업이 닫히면 이 콜백이 processing/paying 고착 탈출의 유일 경로다.
   * onCancel 은 paying/processing 상태만 해제하고 **주문은 pending 유지**(재시도 허용).
   */
  onNiceCancel?: (message?: string) => void;
  /**
   * prepare 위임(선택). 미지정이면 회원 prepareOrderPayment(orderId).
   * 게스트는 view 토큰 소유증명이 필요하므로 prepareGuestPayment 를 주입한다.
   * 응답 계약은 동형(PaymentPrepareResponse) — 이후 provider 분기·결제창 호출은 완전 공유.
   */
  prepare?: (orderId: string) => Promise<{ data: PaymentPrepareResponse }>;
}

/**
 * 결제 개시 — prepare 후 provider 에 맞는 결제창을 호출한다.
 * 반환값 없음(성공 경로는 리다이렉트로 종료). prepare 실패·토스 위젯 부재는 throw.
 */
export async function startPayment(params: StartPaymentParams): Promise<void> {
  // 1) 서버 prepare 로 payment_id 발급. 재시도해도 같은 attempt → 같은 payment_id →
  //    PG 멱등으로 이중청구 방지. (감사 P0-D)
  //    회원=prepareOrderPayment, 게스트=prepareGuestPayment(view 토큰) — 응답 동형.
  const prepared = await (params.prepare
    ? params.prepare(params.orderId)
    : prepareOrderPayment(
        params.orderId,
        // 나이스 결제수단 선택값을 prepare 로 전달(서버가 form.PayMethod 로 정규화 주입).
        // 토스는 서버가 무시하므로 항상 전달해도 안전(클라 무검증 — 서버 화이트리스트).
        params.payMethod ? { pay_method: params.payMethod } : undefined,
      ));
  const paymentId = prepared.data.payment_id;
  const provider = resolveProvider(prepared.data.provider);

  if (provider === "nicepay") {
    // 2-N) 나이스 구형 결제창 — 서버가 내려준 provider_params(js_url + form)를 그대로 goPay 로 제출.
    //      SignData/ReturnURL/MID 등은 서버 생성값 → 무변형. 인증결과는 나이스가 ReturnURL(v2)로 POST.
    // provider_params 누락(구형인데 서버 미제공)은 조용히 넘기지 않고 명확한 에러(감사: 조용한 실패 금지).
    const providerParams = prepared.data.provider_params;
    if (!providerParams) {
      throw new Error(
        "나이스 결제창 정보를 받지 못했습니다. 잠시 후 다시 시도해주세요.",
      );
    }
    try {
      await startNicePayment(providerParams, {
        // 팝업 닫힘/취소는 예외가 아니라 SDK 전역콜백으로 도착 — processing 고착 탈출.
        onCancel: params.onNiceCancel,
      });
    } catch (err) {
      // goPay 이전 단계 오류(파라미터/SDK 로드)는 onNiceError 로도 통지 후 재-throw(상위 catch 정합).
      const message =
        err instanceof Error ? err.message : "결제 처리에 실패했습니다";
      params.onNiceError?.(message);
      throw err;
    }
    return;
  }

  // 2-D) 주최사 PG 직결 — 서버가 내려준 주최사 클라이언트 키로 토스 표준 결제창.
  //      성공 리다이렉트·confirm 은 기존 토스 success 경로 그대로(서버가 주문의 pg_provider 로 직결 게이트웨이 라우팅).
  if (provider === "toss_direct") {
    const clientKey = (prepared.data.provider_params as { clientKey?: string } | null)?.clientKey;
    if (!clientKey) {
      throw new Error("주최사 결제 정보를 받지 못했습니다. 잠시 후 다시 시도해주세요.");
    }
    await requestDirectTossPayment({
      clientKey,
      orderId: paymentId,
      orderName: params.orderName,
      amount: params.amount,
      successUrl: params.successUrl,
      failUrl: params.failUrl,
      customerEmail: params.buyer?.email,
      customerName: params.buyer?.name,
      customerMobilePhone: params.buyer?.tel,
    });
    return;
  }

  // 2-T) 토스 결제위젯(기존 경로) — 성공 시 successUrl 리다이렉트, 확정은 success 페이지.
  if (isTossLive()) {
    if (!params.tossWidget) {
      throw new Error("결제 수단을 불러오는 중입니다. 잠시 후 다시 시도해주세요.");
    }
    await params.tossWidget.requestPayment({
      orderId: paymentId,
      orderName: params.orderName,
      successUrl: params.successUrl,
      failUrl: params.failUrl,
      ...(params.buyer?.email ? { customerEmail: params.buyer.email } : {}),
      ...(params.buyer?.name ? { customerName: params.buyer.name } : {}),
      ...(params.buyer?.tel ? { customerMobilePhone: params.buyer.tel } : {}),
    });
  } else {
    mockRedirectToSuccess(paymentId, params.amount, params.successUrl);
  }
}
