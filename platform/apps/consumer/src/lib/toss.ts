/* ── TossPayments V2 결제위젯(Payment Widget) 연동 (consumer) ─────────────
 *
 * SDK 는 CDN(https://js.tosspayments.com/v2/standard)에서 로드한다(npm 의존 없음).
 * 결제위젯: 토스가 결제수단 UI(카드·간편결제·계좌이체·가상계좌)를 DOM 컨테이너에 렌더.
 *   renderTossWidget() → setAmount + renderPaymentMethods + renderAgreement
 *   → requestPayment() 시 성공하면 successUrl 로 리다이렉트 → success 페이지가 confirm.
 *
 * clientKey(NEXT_PUBLIC_TOSS_CLIENT_KEY, `test_gck_*`/`live_gck_*` = 결제위젯 키) 미설정 시
 * mock: 위젯 없이 successUrl 로 리다이렉트.
 */

const TOSS_SDK_URL = "https://js.tosspayments.com/v2/standard";
const CLIENT_KEY = process.env.NEXT_PUBLIC_TOSS_CLIENT_KEY || "";

// ── 레거시 표시용 타입(완료/확인 모달 호환) ────────────────────────────
// 결제수단 선택은 이제 토스 위젯이 담당하므로 실제 분기엔 쓰이지 않는다.
export type PayMethod = "card" | "transfer" | "virtual_account";
export const PAY_METHOD_LABELS: Record<PayMethod, string> = {
  card: "카드 · 간편결제",
  transfer: "계좌이체",
  virtual_account: "가상계좌",
};
export const PAY_METHOD_COLORS: Record<PayMethod, string> = {
  card: "#0a0a0a",
  transfer: "#0064FF",
  virtual_account: "#666666",
};

/** 결제 결과(레거시 완료모달 호환용 타입). */
export interface PaymentResponse {
  success: boolean;
  paymentId: string;
  orderId: string;
  amount: number;
  payMethod: PayMethod;
  paidAt: string;
  receiptUrl?: string;
}

export interface RequestWidgetPaymentParams {
  /** 서버 prepare 가 발급한 payment_id (`ord_{uuid}_aN`) — 토스 orderId 로 사용. */
  orderId: string;
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
interface TossPaymentWindow {
  requestPayment(params: Record<string, unknown>): Promise<void>;
}
interface TossPaymentsInstance {
  widgets(options: { customerKey: string }): TossWidgetsInstance;
  payment(options: { customerKey: string }): TossPaymentWindow;
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

/** 결제위젯을 DOM 에 렌더하고 핸들을 반환한다(라이브 전용 — CLIENT_KEY 필요). */
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
 * mock 리다이렉트 — clientKey 미설정(데모/E2E)에서 위젯 없이 successUrl 로 리다이렉트.
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


/**
 * 과업 WP7 — 주최사 PG 직결(무경유) 결제창.
 *
 * 결제위젯(플랫폼 키로 미리 렌더)과 달리 **주최사의 클라이언트 키**는 서버 prepare 응답
 * (provider_params.clientKey)으로만 알 수 있다. 그래서 위젯이 아니라 토스 표준 결제창
 * (`payment().requestPayment`)을 그 키로 띄운다 — API 개별 연동 키(ck/sk) 전용.
 * 결제 대금은 주최사 상점으로 바로 들어가고, 승인(confirm)은 서버가 주최사 시크릿 키로 한다.
 */
export async function requestDirectTossPayment(opts: {
  clientKey: string;
  orderId: string;
  orderName: string;
  amount: number;
  successUrl: string;
  failUrl: string;
  customerEmail?: string;
  customerName?: string;
  customerMobilePhone?: string;
}): Promise<void> {
  await loadTossSdk();
  const factory = window.TossPayments;
  if (!factory) throw new Error("토스 SDK 를 사용할 수 없습니다");
  const payment = factory(opts.clientKey).payment({ customerKey: guestCustomerKey() });
  await payment.requestPayment({
    method: "CARD",
    amount: { currency: "KRW", value: opts.amount },
    orderId: opts.orderId,
    orderName: opts.orderName,
    successUrl: opts.successUrl,
    failUrl: opts.failUrl,
    ...(opts.customerEmail ? { customerEmail: opts.customerEmail } : {}),
    ...(opts.customerName ? { customerName: opts.customerName } : {}),
    ...(opts.customerMobilePhone ? { customerMobilePhone: opts.customerMobilePhone.replace(/\D/g, "") } : {}),
  });
}
