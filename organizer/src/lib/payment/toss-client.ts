"use client";

/**
 * 토스페이먼츠 V2 결제위젯(Payment Widget) 클라이언트 래퍼.
 *
 * SDK 는 CDN(https://js.tosspayments.com/v2/standard)에서 로드한다(npm 의존 없음).
 * clientKey 는 공개키(NEXT_PUBLIC_TOSS_CLIENT_KEY, `test_gck_*`/`live_gck_*` = 결제위젯 키).
 *
 * 결제위젯: 토스가 결제수단 UI(카드·간편결제·계좌이체·가상계좌)를 DOM 컨테이너에 렌더한다.
 *   renderTossWidget() → setAmount + renderPaymentMethods + renderAgreement
 *   → requestPayment() 시 성공하면 successUrl 로 리다이렉트(확정은 success 페이지가 처리).
 *
 * clientKey 미설정(로컬/데모/E2E)에서는 mock: 위젯 없이 successUrl 로 바로 리다이렉트.
 */

const TOSS_SDK_URL = "https://js.tosspayments.com/v2/standard";
const CLIENT_KEY = process.env.NEXT_PUBLIC_TOSS_CLIENT_KEY ?? "";

export interface RequestWidgetPaymentParams {
  orderId: string; // 우리 주문 식별자(토스 orderId, 6~64자)
  orderName: string;
  successUrl: string;
  failUrl: string;
  customerEmail?: string;
  customerName?: string;
  customerMobilePhone?: string;
}

/** 렌더된 위젯 핸들 — 금액 갱신·결제요청. */
export interface TossWidgetHandle {
  setAmount(value: number): Promise<void>;
  requestPayment(params: RequestWidgetPaymentParams): Promise<void>;
}

interface TossWidgetsInstance {
  setAmount(amount: { currency: string; value: number }): Promise<void>;
  renderPaymentMethods(opts: { selector: string; variantKey?: string }): Promise<unknown>;
  renderAgreement(opts: { selector: string; variantKey?: string }): Promise<unknown>;
  requestPayment(params: Record<string, unknown>): Promise<void>;
}
interface TossPaymentsInstance {
  widgets(options: { customerKey: string }): TossWidgetsInstance;
}
type TossPaymentsFactory = (clientKey: string) => TossPaymentsInstance;

declare global {
  interface Window {
    TossPayments?: TossPaymentsFactory;
  }
}

/** 실 PG(토스) 라이브 여부 — clientKey 존재로 판단. */
export function isTossLive(): boolean {
  return Boolean(CLIENT_KEY);
}

let sdkPromise: Promise<void> | null = null;

function loadTossSdk(): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("토스 SDK 는 브라우저에서만 로드할 수 있습니다"));
  }
  if (window.TossPayments) return Promise.resolve();
  if (!sdkPromise) {
    sdkPromise = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${TOSS_SDK_URL}"]`);
      if (existing) {
        existing.addEventListener("load", () => resolve());
        existing.addEventListener("error", () => reject(new Error("토스 SDK 로드 실패")));
        return;
      }
      const script = document.createElement("script");
      script.src = TOSS_SDK_URL;
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => {
        sdkPromise = null;
        reject(new Error("토스 SDK 로드 실패"));
      };
      document.head.appendChild(script);
    });
  }
  return sdkPromise;
}

function guestCustomerKey(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `guest_${Date.now()}`;
}

/**
 * 결제위젯을 DOM 에 렌더하고 핸들을 반환한다(라이브 전용 — CLIENT_KEY 필요).
 * mock 모드에서는 호출하지 말 것(isTossLive()=false).
 */
export async function renderTossWidget(opts: {
  amount: number;
  methodsSelector: string;
  agreementSelector: string;
  customerKey?: string;
}): Promise<TossWidgetHandle> {
  await loadTossSdk();
  const factory = window.TossPayments;
  if (!factory) throw new Error("토스 SDK 를 사용할 수 없습니다");

  const tossPayments = factory(CLIENT_KEY);
  const widgets = tossPayments.widgets({ customerKey: opts.customerKey ?? guestCustomerKey() });
  await widgets.setAmount({ currency: "KRW", value: opts.amount });
  await widgets.renderPaymentMethods({ selector: opts.methodsSelector, variantKey: "DEFAULT" });
  await widgets.renderAgreement({ selector: opts.agreementSelector, variantKey: "AGREEMENT" });

  return {
    setAmount: (value: number) => widgets.setAmount({ currency: "KRW", value }),
    requestPayment: (params: RequestWidgetPaymentParams) =>
      widgets.requestPayment({
        orderId: params.orderId,
        orderName: params.orderName,
        successUrl: params.successUrl,
        failUrl: params.failUrl,
        ...(params.customerEmail ? { customerEmail: params.customerEmail } : {}),
        ...(params.customerName ? { customerName: params.customerName } : {}),
        ...(params.customerMobilePhone ? { customerMobilePhone: params.customerMobilePhone } : {}),
      }),
  };
}

/**
 * mock 리다이렉트 — clientKey 미설정(데모/E2E)에서 위젯 없이 successUrl 로 리다이렉트해
 * 서버 confirm(mock) 경로를 태운다. (실 PG 승인 없음)
 */
export function mockRedirectToSuccess(orderId: string, amount: number, successUrl: string): void {
  // 🔴 프로덕션에서 이 경로가 열리면 **무료 발권**이다 — 결제창 없이 success 로 착지해
  //    서버 confirm(mock)까지 흘러간다. 나이스 쪽(nice.ts / nice-client.ts)에는 같은 가드가
  //    있는데 토스 쪽만 비어 있었다(구형 전환 재검수에서 발견).
  //    토스는 dormant 지만 PAYMENT_PROVIDER=toss 로 되돌리는 순간 노출되므로 함께 막는다.
  if (
    process.env.NODE_ENV === "production" &&
    process.env.NEXT_PUBLIC_ALLOW_PAYMENT_MOCK !== "1"
  ) {
    throw new Error("결제 설정이 완료되지 않았습니다(토스 clientKey 미설정). 관리자에게 문의해주세요.");
  }
  const url = new URL(successUrl);
  url.searchParams.set("paymentKey", `mock_${orderId}`);
  url.searchParams.set("orderId", orderId);
  url.searchParams.set("amount", String(amount));
  window.location.assign(url.toString());
}
