"use client";

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface CheckoutItem {
  productId: string;
  name: string;
  price: number;
  quantity: number;
}

export interface BuyerInfo {
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string;
}

interface CheckoutStoreState {
  selectedItems: CheckoutItem[];
  buyerInfo: BuyerInfo;
  answers: Record<string, string | string[]>;
  selectedSeatIds: string[];
  orderId: string | null;
  orderNumber: string | null;
  promoCode: string | null;
  discountAmount: number;
  marketingConsent: boolean; // §3-2: 마케팅 수신동의(기본 미체크)
  /**
   * 레벨2 재감사 P1 — createOrder retry idempotency(호출자 durable key).
   * 체크아웃 **진입 시 1회 생성**(crypto.randomUUID)해 세션스토리지에 보존하는 안정 토큰.
   * initiate 요청 본문(idempotencyToken)으로 전송 → 같은 체크아웃의 재시도(네트워크 오류·더블클릭·
   * 새로고침 재진입)는 같은 토큰 → 같은 external_order_id → v2 dedup 이 중복 주문/좌석hold 흡수.
   *
   * 레벨2 재감사3차 P1 — **문맥 결속**: 토큰은 (이벤트 + 장바구니 상품/수량)에 묶인다.
   *  - 이벤트가 바뀌면(다른 행사 체크아웃 진입) `ensureCheckoutToken(eventId)` 이 컨텍스트를
   *    리셋하고 새 토큰을 발급한다(전역 단일 sessionStorage 키의 크로스-이벤트 오염 차단).
   *  - 상품/수량이 바뀌면 `setSelectedItems` 가 토큰을 무효화해 다음 `ensureCheckoutToken` 이
   *    새 토큰을 발급한다. → 이전 주문 시도(다른 event/티켓/금액)의 external_order_id 를
   *    재사용해 **잘못된 event/티켓/금액 조합**이 반환되던 결함 차단(v2 fingerprint 와 이중 방어).
   */
  checkoutToken: string | null;
  /**
   * 현재 checkoutToken/장바구니가 결속된 이벤트 id. 전역 sessionStorage 키를 이벤트별로
   * 논리 분리하기 위한 앵커 — 다른 이벤트 진입 시 컨텍스트 전체를 리셋한다(토큰 재발급).
   */
  eventId: string | null;
  /**
   * checkoutToken 이 결속된 장바구니 서명(상품id:수량 정렬 조인). 상품/수량이 바뀌면 값이 달라져
   * setSelectedItems 가 토큰을 무효화한다.
   */
  itemsSignature: string | null;
  step: number;
  setSelectedItems: (items: CheckoutItem[]) => void;
  /**
   * 체크아웃 durable 토큰 확보. eventId 를 넘기면 **문맥 결속**:
   *  - 저장된 eventId 와 다르면(다른 행사) 컨텍스트를 리셋하고 새 토큰 발급.
   *  - 토큰이 없거나(초기/무효화 후) 발급이 필요하면 새로 생성하고 현재 장바구니 서명에 결속.
   * eventId 미전달(레거시/딥링크)이면 기존 토큰을 유지하되 없으면 생성.
   */
  ensureCheckoutToken: (eventId?: string) => string;
  /**
   * 🔴 토큰을 버려 다음 `ensureCheckoutToken` 이 새 토큰을 발급하게 한다.
   *
   * 카드사 자동할인 선택을 바꾸면 v2 `_order_context_fingerprint`(할인코드·총액 포함)가
   * 달라지는데 external_order_id 는 토큰에서 결정적으로 파생돼 그대로다 → v2 가 **409** 로
   * 막는다(옛 문맥의 주문 재생 방지 장치가 정상 동작한 결과다). 상품/수량 변경은
   * `setSelectedItems` 가 같은 처리를 하지만 할인 선택은 장바구니 서명에 안 잡힌다.
   */
  invalidateCheckoutToken: () => void;
  /**
   * 이벤트 문맥 확립(티켓선택 진입 시). 저장된 eventId 와 다르면 컨텍스트 전체를 리셋해
   * 이전 행사의 장바구니/구매자정보/토큰이 새 행사로 새지 않게 한다(전역 sessionStorage 키
   * 이벤트별 논리 분리). 같은 이벤트면 no-op(새로고침·단계이동 시 상태 보존).
   */
  resetForEvent: (eventId: string) => void;
  setBuyerInfo: (buyerInfo: Partial<BuyerInfo>) => void;
  setMarketingConsent: (v: boolean) => void;
  setAnswer: (questionId: string, value: string | string[]) => void;
  setSelectedSeatIds: (seatIds: string[]) => void;
  setOrder: (orderId: string, orderNumber: string) => void;
  setPromo: (promoCode: string | null, discountAmount: number) => void;
  nextStep: () => void;
  prevStep: () => void;
  reset: () => void;
}

const initialBuyerInfo: BuyerInfo = {
  buyerName: "",
  buyerEmail: "",
  buyerPhone: "",
};

/**
 * 장바구니 서명 — 상품id·수량만으로 결정적 문자열(순서 무관). checkoutToken 결속에 사용한다.
 * 가격/이름은 이벤트 상품 카탈로그에서 파생되므로 서명에서 제외(상품/수량 변경만이 새 주문 문맥).
 */
function computeItemsSignature(items: CheckoutItem[]): string {
  return items
    .map((it) => `${it.productId}:${it.quantity}`)
    .sort()
    .join("|");
}

export const useCheckoutStore = create<CheckoutStoreState>()(
  persist(
    (set, get) => ({
      selectedItems: [],
      buyerInfo: initialBuyerInfo,
      answers: {},
      selectedSeatIds: [],
      orderId: null,
      orderNumber: null,
      promoCode: null,
      discountAmount: 0,
      marketingConsent: false,
      checkoutToken: null,
      eventId: null,
      itemsSignature: null,
      step: 1,
      setSelectedItems(items) {
        // 레벨2 재감사3차 P1 — 상품/수량이 바뀌면 checkoutToken 을 무효화(문맥 결속).
        // 다음 ensureCheckoutToken 이 새 토큰을 발급 → 이전 주문 시도의 external_order_id
        // 재사용(잘못된 티켓/금액 조합 재생)을 원천 차단. 같은 서명(동일 상품/수량)이면 유지.
        const nextSignature = computeItemsSignature(items);
        set((state) => {
          const changed =
            state.itemsSignature !== null && state.itemsSignature !== nextSignature;
          return {
            selectedItems: items,
            itemsSignature: nextSignature,
            checkoutToken: changed ? null : state.checkoutToken,
          };
        });
      },
      ensureCheckoutToken(eventId) {
        const state = get();
        // 이벤트 문맥 변경(다른 행사 체크아웃) → 전역 스토어 오염 차단: 컨텍스트 전체 리셋 후 새 토큰.
        if (eventId !== undefined && state.eventId !== null && state.eventId !== eventId) {
          const token = crypto.randomUUID();
          set({
            selectedItems: [],
            buyerInfo: initialBuyerInfo,
            answers: {},
            selectedSeatIds: [],
            orderId: null,
            orderNumber: null,
            promoCode: null,
            discountAmount: 0,
            marketingConsent: false,
            checkoutToken: token,
            eventId,
            itemsSignature: computeItemsSignature([]),
            step: 1,
          });
          return token;
        }
        const existing = state.checkoutToken;
        if (existing) {
          // eventId 앵커가 비어 있으면(레거시 지속 데이터) 현재 이벤트로 결속만 채운다.
          if (eventId !== undefined && state.eventId === null) {
            set({ eventId });
          }
          return existing;
        }
        // crypto.randomUUID — 브라우저(https/localhost) 표준. 체크아웃당 1회 안정 토큰.
        const token = crypto.randomUUID();
        set({
          checkoutToken: token,
          ...(eventId !== undefined ? { eventId } : {}),
          itemsSignature: computeItemsSignature(state.selectedItems),
        });
        return token;
      },
      invalidateCheckoutToken() {
        set({ checkoutToken: null });
      },
      resetForEvent(eventId) {
        const state = get();
        if (state.eventId === eventId) return; // 같은 행사 — 상태 보존.
        set({
          selectedItems: [],
          buyerInfo: initialBuyerInfo,
          answers: {},
          selectedSeatIds: [],
          orderId: null,
          orderNumber: null,
          promoCode: null,
          discountAmount: 0,
          marketingConsent: false,
          checkoutToken: null,
          eventId,
          itemsSignature: null,
          step: 1,
        });
      },
      setBuyerInfo(buyerInfo) {
        set((state) => ({
          buyerInfo: {
            ...state.buyerInfo,
            ...buyerInfo,
          },
        }));
      },
      setMarketingConsent(v) {
        set({ marketingConsent: v });
      },
      setAnswer(questionId, value) {
        set((state) => ({
          answers: {
            ...state.answers,
            [questionId]: value,
          },
        }));
      },
      setSelectedSeatIds(seatIds) {
        // 서버 fingerprint는 seat_ids를 정렬해 포함한다. 좌석 집합이 바뀌면 이전 external_order_id를
        // 재사용할 수 없으므로 토큰을 무효화하되, 순서만 바뀐 동일 집합은 정당 재시도로 보존한다.
        set((state) => {
          const current = [...state.selectedSeatIds].sort().join("|");
          const next = [...seatIds].sort().join("|");
          return {
            selectedSeatIds: seatIds,
            checkoutToken: current !== next ? null : state.checkoutToken,
          };
        });
      },
      setOrder(orderId, orderNumber) {
        set({ orderId, orderNumber });
      },
      setPromo(promoCode, discountAmount) {
        // 서버 fingerprint의 discount 식별자와 total_amount 양쪽에 대응. 코드 적용/해제뿐 아니라
        // 동일 코드의 계산 할인액이 바뀐 경우에도 새 주문 문맥으로 재발급한다.
        set((state) => ({
          promoCode,
          discountAmount,
          checkoutToken:
            state.promoCode !== promoCode || state.discountAmount !== discountAmount
              ? null
              : state.checkoutToken,
        }));
      },
      nextStep() {
        set((state) => ({ step: state.step + 1 }));
      },
      prevStep() {
        set((state) => ({ step: Math.max(1, state.step - 1) }));
      },
      reset() {
        set({
          selectedItems: [],
          buyerInfo: initialBuyerInfo,
          answers: {},
          selectedSeatIds: [],
          orderId: null,
          orderNumber: null,
          promoCode: null,
          discountAmount: 0,
          marketingConsent: false,
          checkoutToken: null,
          eventId: null,
          itemsSignature: null,
          step: 1,
        });
      },
    }),
    {
      // 결제 중 새로고침·탭 크래시로 입력 전체가 날아가는 것 방지. 탭 닫으면 소멸(sessionStorage).
      name: "pickket-checkout",
      storage: createJSONStorage(() => sessionStorage),
      // SSR 하이드레이션 미스매치 방지 — CheckoutProgress 마운트 시 수동 rehydrate.
      skipHydration: true,
      partialize: (state) => ({
        selectedItems: state.selectedItems,
        // 🔴 종전엔 `identityNumber: ""` 로 실명확인번호를 덮어 저장을 막았다.
        //    영수증 입력을 걷어내면서 그 필드 자체가 사라져 덮을 것이 없다.
        buyerInfo: state.buyerInfo,
        answers: state.answers,
        selectedSeatIds: state.selectedSeatIds,
        orderId: state.orderId,
        orderNumber: state.orderNumber,
        promoCode: state.promoCode,
        discountAmount: state.discountAmount,
        marketingConsent: state.marketingConsent,
        // durable idempotency 토큰 — 새로고침·탭 크래시 후 재시도도 같은 토큰(=같은 주문)이어야 한다.
        checkoutToken: state.checkoutToken,
        // 문맥 결속 앵커(P1) — 이벤트/장바구니 변경 판정을 새로고침 후에도 유지.
        eventId: state.eventId,
        itemsSignature: state.itemsSignature,
        step: state.step,
      }),
    },
  ),
);
