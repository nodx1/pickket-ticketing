"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { checkoutRedirectPath, resolveCheckoutRedirect } from "@/lib/checkout/resolve-redirect";
import { OFFLINE_PAYMENT_DEADLINE_TEXT, bankInfoFromEnv } from "@/lib/checkout/offline-payment";
import { readCheckoutJson } from "@/lib/checkout/read-json";
import { CheckoutTokenExpiredError, ORDER_NOT_REPLAYABLE } from "@/lib/checkout/token-expired";
import { useRouter } from "next/navigation";
import { Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { formatKRW } from "@/lib/format";
import { useCheckoutStore } from "@/lib/stores/checkoutStore";
import {
  renderTossWidget,
  mockRedirectToSuccess,
  isTossLive,
  type TossWidgetHandle,
} from "@/lib/payment/toss-client";
import {
  startNicePayment,
  type NicePayProviderParams,
} from "@/lib/payment/nice-client";
import {
  type NiceMethod,
  DEFAULT_NICE_METHOD,
  getNiceMethods,
  isNiceCardOnly,
} from "@/lib/payment/nice-methods";
import { NiceMethodSelector } from "./nice-method-selector";
import { CheckoutProgress } from "../../_components/checkout-progress";

interface CheckoutPaymentStepProps {
  eventSlug: string;
  eventId: string;
  eventTitle: string;
  /**
   * 나이스 결제수단 게이팅(C2) — 이벤트 allowed_pay_methods(대문자 코드 리스트).
   * NULL/미제공 → 전체 노출(현행 무변). ["CARD"] → 카드 고정(선택 UI 숨김).
   * 서버가 pay_method 를 강제하므로 프론트는 UX상 선택지만 제한한다.
   */
  allowedPayMethods?: readonly string[] | null;
  /**
   * 카드사 자동할인(T14) — `{ BC: { rate: 10 } }`. 없으면 null.
   * 고객이 이 카드사를 고르면 **주문 생성 시 서버가 할인코드를 붙여** 금액이 확정되고,
   * 결제창은 그 카드사 전용으로 열린다(SelectCardCode).
   * ⚠️ 할인율만 온다 — 할인코드는 서버만 안다.
   */
  cardDiscounts?: Record<string, { rate: number }> | null;
}

/** 카드사 코드 → 표시명. */
const CARD_LABELS: Record<string, string> = { BC: "비씨카드" };

/** 상위 결제 선택: 온라인 결제(PG) vs 무통장입금(수동확정). */
type PayChoice = "toss" | "bank_transfer";

/** 온라인 PG provider — 서버 응답(주문 initiate) 우선, 없으면 env 플래그 폴백. */
type PgProvider = "toss" | "nicepay";

/**
 * 온라인 PG provider 판정.
 * 1순위: 서버가 내려주는 provider(주문 initiate/prepare 응답의 provider 필드 — 주문별 라우팅, 결정 B).
 * 폴백: env `NEXT_PUBLIC_PAYMENT_PROVIDER`(신규주문 기본값). 그것도 없으면 toss(기존 동작 보존).
 * TODO(Phase1/v2): initiate 응답에 provider 필드가 실리면 서버값이 항상 우선됨 — 현재는 응답 미포함이라 env 폴백.
 */
function resolvePgProvider(serverProvider?: string): PgProvider {
  // 🔴 폴백 기본값 = nicepay (2026-07-28 대표 결정: 구형 나이스로만 간다).
  //    예전엔 "toss" 였다. 서버 응답(serverProvider)은 결제 **제출 시점**에만 오는데
  //    `envProvider = resolvePgProvider()` 는 인자 없이 호출돼 **화면 렌더 분기**에 쓰인다
  //    (결제수단 라디오·위젯 노출). 그래서 서버가 nicepay 를 내려도 **UI 는 Toss 로 그려지는**
  //    엇갈림이 있었다. env 미설정 prod 에서 실제로 그 상태였다.
  const raw = (serverProvider || process.env.NEXT_PUBLIC_PAYMENT_PROVIDER || "nicepay").toLowerCase();
  return raw === "nicepay" || raw === "nice" ? "nicepay" : "toss";
}

/**
 * 입금 계좌 안내 — `NEXT_PUBLIC_*` 은 빌드 시각에 고정되므로 **모듈 스코프에서 1회** 평가한다.
 * 컴포넌트 안에서 부르면 렌더마다 새 객체가 되어 deps 에 넣을 때 위험하다(위 루프 사고 계열).
 */
const bankInfo = bankInfoFromEnv();

export function CheckoutPaymentStep({ eventSlug, eventId, eventTitle, allowedPayMethods, cardDiscounts }: CheckoutPaymentStepProps) {
  const router = useRouter();
  const { selectedItems, buyerInfo, answers, selectedSeatIds, setOrder, discountAmount, promoCode, orderId, marketingConsent, ensureCheckoutToken, invalidateCheckoutToken } = useCheckoutStore();
  const submitLock = useRef(false); // 더블서밋/뒤로가기 재제출 방지 (P2-C13)
  const [payChoice, setPayChoice] = useState<PayChoice>("toss");
  // 카드사 자동할인(T14) — 고객이 고른 카드사. null = 미선택(할인 없음).
  // 🔴 표시금액은 여기서 깎아 **보여주기만** 한다. 실제 청구액은 주문 생성 시
  //    서버가 할인코드를 붙이고 **v2 가 재계산**한다(go 가 금액을 주장하지 않는다).
  const cardDiscountEntries = Object.entries(cardDiscounts ?? {}).filter(([, c]) => Number(c?.rate) > 0);
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const selectedCardRate = selectedCard ? Number(cardDiscounts?.[selectedCard]?.rate ?? 0) : 0;
  // 나이스페이 결제수단 선택(구형 — prepare 요청의 pay_method 로 서버 전달). env provider=nicepay 일 때만 노출.
  // 카드전용 게이팅(C2): 이벤트 allowed_pay_methods 주입. NULL → 전체(무변), ["CARD"] → 카드 고정(선택 UI 숨김).
  const niceMethods = getNiceMethods(allowedPayMethods);
  const niceCardOnly = isNiceCardOnly(allowedPayMethods);
  const [niceMethod, setNiceMethod] = useState<NiceMethod>(DEFAULT_NICE_METHOD);
  // 카드전용이면 CARD 강제(선택 무시), 아니면 사용자 선택값.
  // 🔴 카드사 자동할인을 고르면 **CARD 로 강제**한다. 이걸 빼면 "BC 10% 할인 + 간편결제"
  //    조합이 성립하고, 간편결제는 SelectCardCode 로 카드사를 제한하지 못하므로 다른 카드로
  //    승인된 뒤 T15 가 **승인취소**한다 — 고객은 결제됐다가 취소되는 경험을 한다.
  //    (VBANK·BANK·CELLPHONE 조합은 서버 가드가 400 으로 막지만, 화면에서 애초에 못 고르게
  //     하는 편이 맞다. 서버 가드는 클라 우회 대비 최종 방어선으로 남긴다.)
  const effectiveNiceMethod: NiceMethod = (niceCardOnly || selectedCard) ? "CARD" : niceMethod;
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [termsAgreed, setTermsAgreed] = useState(false);
  const widgetRef = useRef<TossWidgetHandle | null>(null);
  const [widgetReady, setWidgetReady] = useState(false);
  const tossLive = isTossLive();
  // 렌더 시점 provider 판정: 서버 per-order provider 는 initiate 후에야 알 수 있으므로,
  // 결제수단 UI(토스 위젯은 사전 렌더 필요)는 env 기본 provider 로 결정한다.
  // 실제 결제 분기는 handlePayment 에서 initiate 응답 provider(폴백=env)로 재판정.
  const envProvider = resolvePgProvider();

  const subtotalAmount = useMemo(
    () => selectedItems.reduce((sum, item) => sum + item.price * item.quantity, 0),
    [selectedItems],
  );
  // 🔴 표시 전용 카드사 할인 반영. 실제 청구액은 v2 가 할인코드로 재계산한다 —
  //    여기 값과 갈리면 v2 가 AMOUNT_MISMATCH 로 거절하므로 산식을 일치시켜야 한다
  //    (v2 `_compute_discount_amount`: gross × rate% , 소수 2자리 반올림).
  const cardDiscountAmount = selectedCardRate > 0
    ? Math.round((subtotalAmount * selectedCardRate) / 100)
    : 0;
  const totalAmount = Math.max(subtotalAmount - discountAmount - cardDiscountAmount, 0);
  const orderName = useMemo(() => {
    const first = selectedItems[0]?.name ?? eventTitle;
    return selectedItems.length > 1 ? `${first} 외 ${selectedItems.length - 1}건` : first;
  }, [selectedItems, eventTitle]);

  // 토스 결제위젯은 사전 렌더가 필요(나이스는 클릭 시 결제창 호출 — 사전 렌더 없음).
  const showWidget = totalAmount > 0 && payChoice === "toss" && envProvider === "toss" && tossLive;

  /**
   * 🔴 무한 렌더 루프 수정 (2026-07-30) — React #185 로 **결제 페이지가 열리지 않았다.**
   *
   * 종전 코드의 두 가지가 겹쳐 루프가 됐다:
   *   ① 이펙트 안에서 `useCheckoutStore.persist.rehydrate()` 호출
   *      → zustand 가 `set(stateFromStorage, true)` 를 **무조건** 실행하고,
   *        기본 `merge` 가 sessionStorage JSON 을 파싱하므로 `buyerInfo` 가 **새 객체**가 된다
   *        (`partialize` 가 buyerInfo 를 저장 대상에 포함).
   *   ② deps 에 그 **객체 `buyerInfo`** 를 넣음 → 매 렌더 변경 → 이펙트 재실행 → ①로
   *
   * `sessionStorage` 는 동기라 `set()` 이 이펙트 본문에서 바로 끝난다.
   * zustand `hydrationVersion` 가드는 호출이 **겹칠 때만** 작동하므로 이 루프를 막지 못한다.
   *
   * ⚠️ 루프를 끊는 것은 **② 하나만으로 충분하다.** ①과 ②가 겹쳐야 루프가 된다
   *    (원시값 deps 는 rehydrate 로 값이 바뀌지 않으므로 이펙트가 재실행되지 않는다).
   *    같은 리포의 `checkout-details-step.tsx` 가 ①을 유지한 채 ②만 피해 라이브에서
   *    루프 없이 동작해 왔다 — 그게 이 리포의 검증된 패턴이다.
   *
   * ## 🔴 1차 수정의 회귀 (2026-07-30, 브라우저 실측으로 발견)
   * ①을 지우고 **렌더 클로저 값**으로 판정하게 했더니 다른 결함이 생겼다:
   *   · `skipHydration: true` 라 **첫 렌더의 store 는 비어 있다.**
   *   · 자식 `CheckoutProgress` 가 부모보다 먼저 복원하지만, 부모 이펙트가 보는 것은
   *     **렌더1 시점의 낡은 클로저**다 ⟹ `itemCount === 0` 으로 오판.
   *   · 아래 once-guard 가 그 오판을 **영구 고정** ⟹ 장바구니로 튕기고 못 돌아온다.
   *   · 실측: 결제 URL 직접 진입/새로고침 **10/10 전부** 장바구니로 튕겼다.
   *     (에러 화면은 사라졌으므로 "오류 없음" 만 보면 통과로 오독된다.)
   *
   * ⟹ 판정은 **반드시 `getState()` 로 신선한 값**을 읽는다. 클로저 값을 쓰지 말 것.
   *    복원 보장도 자식 순서에 의존하지 않고 여기서 직접 확인한다.
   *
   * deps 는 **원시값만** 둔다(위 ②). 객체를 넣으면 루프가 재발한다.
   */
  const redirectedRef = useRef(false);
  useEffect(() => {
    // 판정은 한 번만 — 루프가 재발해도 리다이렉트가 반복되지 않게 하는 2차 방어.
    if (redirectedRef.current) return;
    // 자식이 먼저 복원하지만 그 전제(항상 마운트·순서)에 의존하지 않는다. 복원 전 판정은
    // 곧 오판이고, 위 once-guard 가 그것을 고정해 버린다.
    //
    // 🔴 **전제: persist 스토리지가 동기여야 한다.**
    //    `rehydrate()` 를 await 하지 않고 바로 아래에서 `getState()` 를 읽는다. 이는
    //    `checkoutStore` 가 `sessionStorage`(동기)를 쓰기 때문에 성립한다
    //    (`src/lib/stores/checkoutStore.ts` — `createJSONStorage(() => sessionStorage)`).
    //    ⚠️ 비동기 스토리지(IndexedDB·원격)로 바꾸면 복원 미완 상태에서 빈 값을 읽어
    //       **결제 진입이 장바구니로 튕기는 결함이 그대로 재발**한다. 그때는 이 이펙트를
    //       `onFinishHydration` 기반으로 다시 설계해야 한다.
    if (!useCheckoutStore.persist.hasHydrated()) {
      void useCheckoutStore.persist.rehydrate();
    }
    // 🔴 클로저(`selectedItems`/`buyerInfo`)가 아니라 스토어 최신값으로 판정한다.
    const s = useCheckoutStore.getState();
    const target = resolveCheckoutRedirect({
      orderId: s.orderId,
      itemCount: s.selectedItems.length,
      buyerName: s.buyerInfo.buyerName,
      buyerEmail: s.buyerInfo.buyerEmail,
      buyerPhone: s.buyerInfo.buyerPhone,
    });
    if (target) {
      redirectedRef.current = true;
      router.replace(checkoutRedirectPath(eventSlug, target));
    }
  }, [
    // 🔴 객체를 넣지 말 것. buyerInfo 를 넣으면 rehydrate 마다 참조가 바뀌어 루프가 된다.
    buyerInfo.buyerName,
    buyerInfo.buyerEmail,
    buyerInfo.buyerPhone,
    selectedItems.length,
    orderId,
    eventSlug,
    router,
  ]);

  // 토스 결제위젯 렌더 (라이브 전용). 컨테이너 마운트 후 1회 렌더.
  useEffect(() => {
    if (!showWidget) {
      widgetRef.current = null;
      setWidgetReady(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const handle = await renderTossWidget({
          amount: totalAmount,
          methodsSelector: "#toss-payment-methods",
          agreementSelector: "#toss-agreement",
        });
        if (!cancelled) {
          widgetRef.current = handle;
          setWidgetReady(true);
        }
      } catch (err: unknown) {
        if (!cancelled) setError(err instanceof Error ? err.message : "결제위젯을 불러오지 못했습니다");
      }
    })();
    return () => {
      cancelled = true;
    };
    // totalAmount 는 아래 별도 effect 로 setAmount — 여기 deps 에 넣으면 위젯 중복 렌더.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showWidget]);

  // 금액 변동 시 위젯에 반영.
  useEffect(() => {
    if (widgetRef.current) void widgetRef.current.setAmount(totalAmount);
  }, [totalAmount]);

  /**
   * 주문 생성(pending). orderId/shortId/provider(있으면) + 나이스 구형 provider_params 반환.
   * payMethod: 나이스 결제수단(구형 — 서버가 payForm.PayMethod 로 정규화 주입). 토스는 서버가 무시.
   *   provider=nicepay 이면 서버가 v2 prepare 로 provider_params(js_url + form: MID/Moid/Amt/
   *   EdiDate/SignData/GoodsName/ReturnURL/MallReserved/PayMethod)를 계산해 함께 내려준다.
   */
  /**
   * 🔴 토큰이 죽었으면 **한 번만** 버리고 다시 시도한다 (2026-08-08 실장애).
   *
   * 만료 주문을 가리키는 토큰은 기다린다고 살아나지 않는다. 버리고 새로 받으면 즉시 풀린다.
   *
   * ⚠️ **1회로 못박는다.** 무한 재시도는 실패할 때마다 v2 에 새 주문을 만들어 낸다 —
   *    대시보드가 유령 주문으로 덮이고, 최악의 경우 재고를 갉는다. 두 번째 실패는
   *    다른 원인이라는 뜻이므로 그대로 올린다.
   */
  async function initiateOrderWithTokenRecovery(
    payMethod?: string,
    offlinePayment?: boolean,
  ): ReturnType<typeof initiateOrder> {
    try {
      return await initiateOrder(payMethod, offlinePayment);
    } catch (err: unknown) {
      if (!(err instanceof CheckoutTokenExpiredError)) throw err;
      invalidateCheckoutToken(); // 다음 ensureCheckoutToken 이 새 토큰을 발급한다
      return await initiateOrder(payMethod, offlinePayment); // 🔴 딱 한 번
    }
  }

  async function initiateOrder(payMethod?: string, offlinePayment?: boolean): Promise<{
    orderId: string;
    shortId: string;
    provider?: string;
    providerParams?: NicePayProviderParams | null;
  }> {
    const res = await fetch("/api/checkout/initiate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        eventId,
        items: selectedItems.map((item) => ({ productId: item.productId, quantity: item.quantity })),
        buyerName: buyerInfo.buyerName,
        buyerEmail: buyerInfo.buyerEmail,
        buyerPhone: buyerInfo.buyerPhone,
        // 🔴 영수증 필드는 보내지 않는다 (2026-08-01) — 화면에서 걷어냈다.
        //    서버 zod 는 optional 이라 안 보내면 그만이고, 스키마는 그대로 둔다.
        answers,
        selectedSeatIds,
        finalAmount: totalAmount,
        promoCode: promoCode ?? undefined,
        marketingConsent, // §3-2: 체크아웃 마케팅 수신동의(기본 false)
        // 나이스 구형 결제수단 선택값 — 서버가 화이트리스트 정규화 후 payForm.PayMethod 로 주입.
        // 토스는 서버가 무시하므로 항상 전달해도 안전.
        payMethod: payMethod || undefined,
        // 🔴 무통장입금 선언 — 서버가 나이스 prepare 를 건너뛴다. 이걸 안 보내면 무통장
        //    주문에도 payment_id 가 박혀 **주최자 입금확정이 막힌다**(입금확정 게이트는
        //    PG 결제 여부로 카드 이탈 주문을 가른다).
        offlinePayment: offlinePayment || undefined,
        // 🔴 initiate 스키마가 **필수**로 요구하는데 여기서 보내지 않아 체크아웃이
        //    **전건 400** 이었다(감사 발견 — 이 경로가 E2E 로 한 번도 안 돌았다는 증거).
        //    체크아웃 진입 시 1회 생성된 durable 토큰을 재사용해야 재시도가 dedup 된다.
        idempotencyToken: ensureCheckoutToken(eventId),
        // 🔴 카드사 자동할인(T14) — **카드사 키만** 보낸다. 할인율·할인코드는 서버가
        //    이벤트 설정에서 해석한다(클라가 코드를 주장하면 임의 할인이 된다).
        cardDiscount: selectedCard || undefined,
        termsAgreedAt: termsAgreed ? new Date().toISOString() : undefined,
      }),
    });
    // 🔴 `res.json()` 을 직접 부르지 않는다 — HTML 응답이 오면 파서가
    //    `Unexpected token '<'` 로 터져 그 문구가 그대로 구매자 화면에 떴다(2026-07-30).
    const payload = await readCheckoutJson<{
      data?: {
        orderId?: string;
        shortId?: string;
        provider?: string;
        provider_params?: NicePayProviderParams | null;
      };
      error?: string;
      code?: string;
    }>(res, "checkout/initiate");
    const newOrderId = payload.data?.orderId;
    const shortId = payload.data?.shortId;
    if (!res.ok || !newOrderId || !shortId) {
      // 🔴 체크아웃 토큰이 죽었다 — 손님 잘못이 아니고 기다린다고 풀리지도 않는다.
      //    토큰은 localStorage 에 **영구** 저장되므로, 안 버리면 같은 브라우저에서
      //    **영영 결제가 안 된다**(2026-08-08 실장애).
      if (payload.code === ORDER_NOT_REPLAYABLE) {
        throw new CheckoutTokenExpiredError(
          payload.error ?? "이전 주문이 만료되었습니다. 새로 주문해 주세요.",
        );
      }
      throw new Error(payload.error ?? "주문 생성에 실패했습니다");
    }
    return {
      orderId: newOrderId,
      shortId,
      provider: payload.data?.provider,
      providerParams: payload.data?.provider_params,
    };
  }

  async function handlePayment() {
    if (submitLock.current || orderId) return; // 동기 락 + 완료주문 재제출 차단
    submitLock.current = true;
    setProcessing(true);
    setError(null);

    try {
      if (totalAmount > 0 && !termsAgreed) {
        throw new Error("전자금융거래·청약철회 동의 후 결제를 진행해주세요");
      }
      // 무료 이벤트 또는 무통장입금: PG 미경유 — 주문 생성 후 완료(무통장은 입금대기) 처리.
      if (totalAmount === 0 || payChoice === "bank_transfer") {
        const { orderId: newOrderId, shortId } = await initiateOrderWithTokenRecovery(
          undefined,
          payChoice === "bank_transfer",
        );
        const completeRes = await fetch("/api/checkout/complete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ orderId: newOrderId, paymentMethod: "bank_transfer" }),
        });
        const completePayload = await readCheckoutJson<{ error?: string }>(completeRes, "checkout/complete");
        if (!completeRes.ok) {
          throw new Error(completePayload.error ?? "결제 완료 처리에 실패했습니다");
        }
        setOrder(newOrderId, shortId);
        router.push(`/e/${eventSlug}/checkout/complete?orderId=${newOrderId}`);
        return;
      }

      // 온라인 결제: 주문 생성 후 provider 별 결제창 호출.
      // provider 판정 = 서버 응답 우선(주문별 라우팅) → 없으면 env 기본(resolvePgProvider 내부).
      // 나이스면 서버가 함께 내려준 provider_params(구형 payForm)를 consume.
      const { orderId: newOrderId, provider: serverProvider, providerParams } = await initiateOrderWithTokenRecovery(
        // 나이스 결제수단 선택값을 initiate 로 전달(카드전용도 CARD 명시). 서버가 prepare 에서 payForm.PayMethod 로 정규화 주입.
        envProvider === "nicepay" ? effectiveNiceMethod : undefined,
      );
      const provider = resolvePgProvider(serverProvider);
      const origin = window.location.origin;
      // 토스 착지는 이벤트-스코프. 나이스 착지는 v2 return 핸들러가 MallReserved='go' 를 읽어
      // go 전역 랜딩(NICEPAY_GO_SUCCESS_URL, /checkout/nice/success)으로 302 redirect(서버 소유).
      const successUrl = `${origin}/e/${eventSlug}/checkout/success`;
      const failUrl = `${origin}/e/${eventSlug}/checkout/fail`;

      if (provider === "nicepay") {
        // 나이스 구형: 승인·서명·리다이렉트 전부 v2 소유. 서버가 준 payForm(provider_params)을
        // goPay 로 제출만 한다(SignData/ReturnURL/MID/MallReserved 무변형).
        if (providerParams) {
          try {
            await startNicePayment(providerParams, {
              // 🔴 결제창 취소·인증실패는 **아래 catch 에 안 걸린다**.
              //    goPay 는 제어를 SDK 에 넘기고 즉시 반환하고, 취소는 그 뒤에 전역
              //    콜백으로 통지된다. 이 통지를 안 받으면 processing 모달이 영구 고착해
              //    **결제 버튼을 다시 못 누른다** — 손님은 결제를 포기한다.
              onCancel: () => {
                setProcessing(false);
                submitLock.current = false;
              },
            });
          } catch (err: unknown) {
            // goPay 이전 단계 오류(파라미터/SDK 로드) — 주문 pending 유지, 재시도 허용.
            setError(err instanceof Error ? err.message : "결제 처리에 실패했습니다");
            setProcessing(false);
            submitLock.current = false;
          }
        } else {
          throw new Error("나이스 결제창 파라미터가 없습니다. 잠시 후 다시 시도해주세요.");
        }
        return; // 정상 흐름은 여기 도달 전에 나이스 결제창으로 넘어감.
      }

      // 토스 온라인 결제: 결제위젯 requestPayment → successUrl 리다이렉트.
      if (tossLive) {
        const handle = widgetRef.current;
        if (!handle) {
          throw new Error("결제위젯이 아직 준비되지 않았습니다. 잠시 후 다시 시도해주세요.");
        }
        await handle.requestPayment({
          orderId: newOrderId,
          orderName,
          successUrl,
          failUrl,
          customerEmail: buyerInfo.buyerEmail,
          customerName: buyerInfo.buyerName,
          customerMobilePhone: buyerInfo.buyerPhone.replace(/[^0-9]/g, "") || undefined,
        });
      } else {
        // 데모/E2E(mock): 위젯 없이 successUrl 로 리다이렉트 → 서버 confirm(mock).
        mockRedirectToSuccess(newOrderId, totalAmount, successUrl);
      }
      // 정상 흐름은 여기 도달 전에 토스로 리다이렉트됨.
    } catch (err: unknown) {
      // 사용자가 결제창을 닫았거나(취소) 오류 — 주문은 pending 유지, 재시도 허용.
      setError(err instanceof Error ? err.message : "결제 처리에 실패했습니다");
      submitLock.current = false;
    } finally {
      setProcessing(false);
    }
  }

  const payDisabled = processing || (showWidget && !widgetReady);

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <CheckoutProgress current={3} />
      <div className="mx-auto mt-6 max-w-3xl">
        <Card className="border-border bg-card/95">
          <CardHeader>
            {/* 🔴 `CardTitle` 은 h3 라 이 페이지에 h1 이 하나도 없었다 (2026-07-31 실측).
                결제 3단계 전부 h3 로 시작해 화면낭독기가 문서 구조를 못 잡는다.
                제목 자체를 h1 으로 올린다 — 각 단계가 독립 페이지다. */}
            <CardTitle as="h1" className="text-3xl font-black tracking-[-0.04em] text-foreground">3단계 · 결제</CardTitle>
            <p className="text-sm text-muted-foreground">{eventTitle}</p>
          </CardHeader>
          <CardContent className="space-y-6">
            <div className="rounded-lg border border-border bg-muted p-5 space-y-3">
              <p className="text-sm font-semibold text-foreground">주문 내역</p>
              {selectedItems.map((item) => (
                <div key={item.productId} className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{item.name} × {item.quantity}</span>
                  <span className="text-foreground">{formatKRW(item.price * item.quantity)}</span>
                </div>
              ))}
              <div className="border-t border-border pt-3">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">소계</span>
                  <span className="text-foreground">{formatKRW(subtotalAmount)}</span>
                </div>
                {discountAmount > 0 ? (
                  <div className="flex items-center justify-between text-sm mt-1">
                    <span className="text-muted-foreground">프로모 할인</span>
                    <span className="text-success">−{formatKRW(discountAmount)}</span>
                  </div>
                ) : null}
                <div className="flex items-center justify-between text-sm text-muted-foreground mt-1">
                  <span>구매자 수수료</span>
                  <span>0원</span>
                </div>
              </div>
              <div className="border-t border-border pt-3 flex items-center justify-between">
                <span className="text-sm font-semibold text-foreground">총 결제금액</span>
                <span className="text-2xl font-black tracking-[-0.04em] text-foreground">{formatKRW(totalAmount)}</span>
              </div>
            </div>

            {totalAmount === 0 ? (
              <div className="rounded-lg border border-border bg-muted p-5 text-sm text-muted-foreground">
                무료 이벤트이므로 바로 예약이 완료됩니다.
              </div>
            ) : (
              <div className="space-y-4 rounded-lg border border-border bg-muted p-5">
                <p className="text-sm font-semibold text-foreground">결제 수단을 선택하세요</p>
                <RadioGroup
                  value={payChoice}
                  onValueChange={(value: PayChoice) => {
                    setPayChoice(value);
                    // 🔴 무통장입금엔 카드사가 없다. 해제하지 않으면 체크박스만 숨고
                    //    선택 상태는 남아 **카드를 안 냈는데 10% 할인**된 주문이 생성된다
                    //    (감사에서 실증된 순손실). 서버에도 같은 가드가 있다(이중 방어).
                    if (value !== "toss" && selectedCard) {
                      setSelectedCard(null);
                      invalidateCheckoutToken(); // 할인 해제 = 문맥 변경(위 주석 참조)
                    }
                  }}
                  className="space-y-3"
                >
                  <label className="flex items-center gap-3 text-sm text-muted-foreground">
                    <RadioGroupItem value="toss" />
                    {envProvider === "nicepay"
                      ? "카드 결제(나이스페이 · 카드·간편결제·계좌이체·가상계좌)"
                      : "토스페이먼츠(카드·간편결제·계좌이체·가상계좌)"}
                  </label>
                  {/*
                    🔴 입금 계좌 안내가 없으면 선택지를 아예 내린다 (2026-07-30 실측).
                       prod 는 NEXT_PUBLIC_BANK_* 가 빈 문자열이라 안내가 전부 빈칸으로
                       나갔다 — 돈 보낼 곳 없이 무통장을 팔고 있었다. env 를 채우면 다시 뜬다.
                  */}
                  {bankInfo.ok ? (
                    <label className="flex items-center gap-3 text-sm text-muted-foreground">
                      <RadioGroupItem value="bank_transfer" />
                      무통장입금(직접입금)
                    </label>
                  ) : null}
                </RadioGroup>

                {/*
                  🔴 T14: 카드사 자동할인 선택. 고르면 **주문 생성 시 서버가 할인코드를 붙여**
                     금액이 확정되고, 결제창이 그 카드사 전용으로 열린다(SelectCardCode).
                     · 표시금액은 여기서 미리 반영해 보여주지만 **청구액은 v2 가 재계산**한다.
                     · 무통장입금에는 적용하지 않는다(카드사 개념이 없다).
                     · 선택 해제 가능 — 할인을 원치 않는 고객이 다른 카드로 결제할 수 있어야 한다.
                */}
                {payChoice === "toss" && cardDiscountEntries.length > 0 ? (
                  <div className="mt-4 space-y-2 rounded-lg border border-primary/20 bg-primary/5 px-4 py-4">
                    <p className="text-sm font-semibold text-foreground">카드사 할인</p>
                    {cardDiscountEntries.map(([card, cfg]) => (
                      <label key={card} className="flex items-center gap-3 text-sm text-muted-foreground">
                        <input
                          type="checkbox"
                          className="size-4 accent-primary"
                          checked={selectedCard === card}
                          onChange={(e) => {
                            setSelectedCard(e.target.checked ? card : null);
                            // 🔴 할인 선택이 바뀌면 v2 주문 문맥 지문(할인코드·총액)이 달라진다.
                            //    토큰을 유지하면 external_order_id 가 그대로라 v2 가 409 로 막고
                            //    고객이 결제를 못 한다(장바구니 변경은 setSelectedItems 가 처리하지만
                            //    할인 선택은 장바구니 서명에 안 잡힌다).
                            invalidateCheckoutToken();
                          }}
                        />
                        {CARD_LABELS[card] ?? card}로 결제 ({cfg.rate}% 할인)
                      </label>
                    ))}
                    {selectedCard ? (
                      <p className="text-xs text-muted-foreground">
                        {CARD_LABELS[selectedCard] ?? selectedCard} 전용 결제창이 열립니다.
                        다른 카드로 결제하면 할인이 적용되지 않아 주문이 취소됩니다.
                      </p>
                    ) : null}
                  </div>
                ) : null}

                {payChoice === "toss" ? (
                  envProvider === "nicepay" ? (
                    niceCardOnly || selectedCard ? (
                      // 나이스 카드전용 게이팅(allowed=CARD): 선택 UI 없이 카드 고정 안내.
                      <div className="space-y-2 rounded-lg border border-primary/20 bg-primary/10 px-4 py-4 text-sm text-muted-foreground">
                        <p className="font-semibold text-foreground">신용·체크카드</p>
                        <p className="text-xs">
                          {selectedCard && !niceCardOnly
                            ? `${CARD_LABELS[selectedCard] ?? selectedCard} 할인을 선택하셨습니다. 카드 결제로 진행됩니다.`
                            : "이 상품은 카드 결제만 지원합니다. 결제 진행 버튼을 누르면 나이스페이 카드 결제창이 열립니다."}
                        </p>
                      </div>
                    ) : (
                      // 구형 나이스: live/mock 판정은 서버(prepare 가 provider_params 를 내리는지)가 소유하므로
                      // 결제수단 선택은 항상 노출한다(선택값은 prepare 의 pay_method 로 전달, mock 이면 서버가 무시).
                      <NiceMethodSelector
                        methods={niceMethods}
                        value={niceMethod}
                        onChange={setNiceMethod}
                      />
                    )
                  ) : tossLive ? (
                    <div className="space-y-3">
                      {/* 토스 결제위젯 렌더 컨테이너 */}
                      <div id="toss-payment-methods" />
                      <div id="toss-agreement" />
                      {!widgetReady ? (
                        <p className="text-xs text-muted-foreground">결제 수단을 불러오는 중…</p>
                      ) : null}
                    </div>
                  ) : (
                    <div className="rounded-lg border border-primary/20 bg-primary/10 px-4 py-4 text-sm text-muted-foreground">
                      데모 모드 — 실제 결제 없이 예약이 완료됩니다(토스 키 미설정).
                    </div>
                  )
                ) : (
                  <div className="rounded-lg border border-primary/20 bg-primary/10 px-4 py-4 text-sm text-muted-foreground">
                    <p className="font-semibold text-foreground">무통장입금 안내</p>
                    {/*
                      자리값 폴백을 쓰지 않는다 — 종전엔 `?? "123-456-789012"` 여서
                      값이 없으면 **남의 계좌번호처럼 보이는 문자열**이 노출될 수 있었다.
                      값이 없으면 위에서 선택지 자체가 안 뜨므로 여기는 항상 실값이다.
                    */}
                    <p className="mt-2">은행명: {bankInfo.ok ? bankInfo.info.bankName : "-"}</p>
                    <p>계좌번호: {bankInfo.ok ? bankInfo.info.account : "-"}</p>
                    <p>예금주: {bankInfo.ok ? bankInfo.info.holder : "-"}</p>
                    {/* 🔴 문구를 여기 하드코딩하지 말 것 — 서버 기한 계산과 같은 상수에서 온다. */}
                    <p className="mt-3">{OFFLINE_PAYMENT_DEADLINE_TEXT}</p>
                    <p>주의사항: 입금자명을 주문자명과 동일하게 해주세요. 입금 확인 후 티켓이 발급됩니다.</p>
                  </div>
                )}
              </div>
            )}

            {totalAmount > 0 && payChoice === "toss" ? (
              <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
                <Lock className="size-3.5" />
                {envProvider === "nicepay" ? "나이스페이" : "토스페이먼츠"} 보안 결제 — 256비트 SSL 암호화
              </div>
            ) : null}

            {totalAmount > 0 ? (
              <label className="flex items-start gap-3 rounded-lg border border-border bg-muted p-4 text-sm text-muted-foreground">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 shrink-0"
                  checked={termsAgreed}
                  onChange={(event) => setTermsAgreed(event.target.checked)}
                />
                <span>전자금융거래 이용약관과 결제 취소·청약철회 안내를 확인했습니다.</span>
              </label>
            ) : null}

            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}

            <div className="flex justify-end">
              <Button onClick={() => void handlePayment()} disabled={payDisabled}>
                {processing ? "처리 중..." : totalAmount === 0 ? "바로 완료" : payChoice === "bank_transfer" ? "예약 접수" : "결제 진행"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
