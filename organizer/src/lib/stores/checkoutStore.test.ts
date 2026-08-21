import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 레벨2 재감사3차 P1 — createOrder 멱등키 **문맥 결속** 회귀.
 *
 * checkoutToken(=external_order_id 시드)이 (이벤트 + 장바구니 상품/수량)에 묶여야 한다.
 *  - 상품/수량 변경 → 토큰 무효화 → 재발급(이전 주문 시도 external_order_id 재사용 차단)
 *  - 이벤트 변경 → 컨텍스트 리셋 + 새 토큰(전역 sessionStorage 키 크로스-이벤트 오염 차단)
 *  - 같은 문맥(동일 event/상품/수량) → 토큰 유지(정상 재시도 dedup 흡수)
 */

// node 환경 — zustand persist 가 setItem 을 호출할 수 있으므로 sessionStorage 폴리필.
const mem = new Map<string, string>();
const fakeStorage: Storage = {
  get length() {
    return mem.size;
  },
  clear: () => mem.clear(),
  getItem: (k) => (mem.has(k) ? (mem.get(k) as string) : null),
  key: (i) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k) => void mem.delete(k),
  setItem: (k, v) => void mem.set(k, v),
};
vi.stubGlobal("sessionStorage", fakeStorage);

// crypto.randomUUID — node20+ 에 존재하지만 결정적 검증을 위해 카운터 스텁으로 고정.
let uuidSeq = 0;
vi.stubGlobal("crypto", {
  ...globalThis.crypto,
  randomUUID: () => `00000000-0000-0000-0000-${String(++uuidSeq).padStart(12, "0")}`,
});

import { useCheckoutStore, type CheckoutItem } from "./checkoutStore";

const EVENT_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const EVENT_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function item(productId: string, quantity: number, price = 10000): CheckoutItem {
  return { productId, name: `p-${productId}`, price, quantity };
}

describe("checkoutStore — 멱등키 문맥 결속(P1)", () => {
  beforeEach(() => {
    mem.clear();
    uuidSeq = 0;
    useCheckoutStore.getState().reset();
  });

  it("같은 문맥(동일 event/상품/수량) 재시도는 토큰을 유지한다(dedup 흡수)", () => {
    const s = useCheckoutStore.getState();
    s.resetForEvent(EVENT_A);
    s.setSelectedItems([item("p1", 2)]);
    const t1 = s.ensureCheckoutToken(EVENT_A);
    // 같은 문맥에서 재확보 — 같은 토큰(재시도 = 같은 external_order_id).
    const t2 = useCheckoutStore.getState().ensureCheckoutToken(EVENT_A);
    expect(t2).toBe(t1);
  });

  it("상품/수량 변경 시 토큰을 재발급한다", () => {
    const s = useCheckoutStore.getState();
    s.resetForEvent(EVENT_A);
    s.setSelectedItems([item("p1", 2)]);
    const t1 = useCheckoutStore.getState().ensureCheckoutToken(EVENT_A);

    // 수량 변경 → 토큰 무효화.
    useCheckoutStore.getState().setSelectedItems([item("p1", 3)]);
    expect(useCheckoutStore.getState().checkoutToken).toBeNull();
    const t2 = useCheckoutStore.getState().ensureCheckoutToken(EVENT_A);
    expect(t2).not.toBe(t1);

    // 상품 변경 → 토큰 무효화.
    useCheckoutStore.getState().setSelectedItems([item("p2", 3)]);
    expect(useCheckoutStore.getState().checkoutToken).toBeNull();
    const t3 = useCheckoutStore.getState().ensureCheckoutToken(EVENT_A);
    expect(t3).not.toBe(t2);
  });

  it("수량 순서만 다르고 동일 상품/수량 집합이면 토큰을 유지한다(서명 정렬)", () => {
    const s = useCheckoutStore.getState();
    s.resetForEvent(EVENT_A);
    s.setSelectedItems([item("p1", 1), item("p2", 2)]);
    const t1 = useCheckoutStore.getState().ensureCheckoutToken(EVENT_A);
    // 순서만 뒤바꿈 — 같은 서명 → 토큰 유지.
    useCheckoutStore.getState().setSelectedItems([item("p2", 2), item("p1", 1)]);
    expect(useCheckoutStore.getState().checkoutToken).toBe(t1);
  });

  it("좌석 집합 변경 시 토큰을 재발급하고 순서만 바뀌면 유지한다", () => {
    const s = useCheckoutStore.getState();
    s.resetForEvent(EVENT_A);
    s.setSelectedItems([item("p1", 2)]);
    s.setSelectedSeatIds(["seat-a", "seat-b"]);
    const t1 = useCheckoutStore.getState().ensureCheckoutToken(EVENT_A);

    useCheckoutStore.getState().setSelectedSeatIds(["seat-b", "seat-a"]);
    expect(useCheckoutStore.getState().checkoutToken).toBe(t1);

    useCheckoutStore.getState().setSelectedSeatIds(["seat-a", "seat-c"]);
    expect(useCheckoutStore.getState().checkoutToken).toBeNull();
    expect(useCheckoutStore.getState().ensureCheckoutToken(EVENT_A)).not.toBe(t1);
  });

  it("프로모 적용·해제 또는 할인액 변경 시 토큰을 재발급한다", () => {
    const s = useCheckoutStore.getState();
    s.resetForEvent(EVENT_A);
    s.setSelectedItems([item("p1", 1)]);
    const t1 = useCheckoutStore.getState().ensureCheckoutToken(EVENT_A);

    useCheckoutStore.getState().setPromo("PROMO10", 1000);
    expect(useCheckoutStore.getState().checkoutToken).toBeNull();
    const t2 = useCheckoutStore.getState().ensureCheckoutToken(EVENT_A);
    expect(t2).not.toBe(t1);

    useCheckoutStore.getState().setPromo("PROMO10", 1000);
    expect(useCheckoutStore.getState().checkoutToken).toBe(t2);
    useCheckoutStore.getState().setPromo("PROMO10", 2000);
    expect(useCheckoutStore.getState().checkoutToken).toBeNull();
    const t3 = useCheckoutStore.getState().ensureCheckoutToken(EVENT_A);
    useCheckoutStore.getState().setPromo(null, 0);
    expect(useCheckoutStore.getState().checkoutToken).toBeNull();
    expect(t3).not.toBe(t2);
  });

  it("이벤트 변경 시 컨텍스트를 리셋하고 새 토큰을 발급한다", () => {
    const s = useCheckoutStore.getState();
    s.resetForEvent(EVENT_A);
    s.setSelectedItems([item("p1", 2)]);
    s.setBuyerInfo({ buyerName: "홍길동" });
    const tA = useCheckoutStore.getState().ensureCheckoutToken(EVENT_A);

    // 다른 행사로 진입(딥링크·탭 재사용) → ensureCheckoutToken(B) 이 컨텍스트 리셋.
    const tB = useCheckoutStore.getState().ensureCheckoutToken(EVENT_B);
    const st = useCheckoutStore.getState();
    expect(tB).not.toBe(tA);
    expect(st.eventId).toBe(EVENT_B);
    expect(st.selectedItems).toHaveLength(0); // 이전 행사 장바구니 미유출.
    expect(st.buyerInfo.buyerName).toBe(""); // 이전 행사 구매자정보 미유출.
  });

  it("resetForEvent 는 다른 행사면 컨텍스트를 비우고 같은 행사면 보존한다", () => {
    const s = useCheckoutStore.getState();
    s.resetForEvent(EVENT_A);
    s.setSelectedItems([item("p1", 2)]);
    const tA = useCheckoutStore.getState().ensureCheckoutToken(EVENT_A);

    // 같은 행사 재진입(새로고침·단계이동) → 보존.
    useCheckoutStore.getState().resetForEvent(EVENT_A);
    expect(useCheckoutStore.getState().checkoutToken).toBe(tA);
    expect(useCheckoutStore.getState().selectedItems).toHaveLength(1);

    // 다른 행사 진입 → 리셋.
    useCheckoutStore.getState().resetForEvent(EVENT_B);
    expect(useCheckoutStore.getState().checkoutToken).toBeNull();
    expect(useCheckoutStore.getState().selectedItems).toHaveLength(0);
    expect(useCheckoutStore.getState().eventId).toBe(EVENT_B);
  });
});

describe("checkoutStore — 카드사 할인 선택 변경 시 토큰 무효화", () => {
  beforeEach(() => {
    useCheckoutStore.getState().reset();
  });

  it("🔴 invalidateCheckoutToken 후 새 토큰이 발급된다 — 유지하면 v2 가 409 로 막는다", () => {
    // 카드사 할인을 켜면 v2 주문 문맥 지문(할인코드·총액)이 달라진다. external_order_id 는
    // 토큰에서 결정적으로 파생되므로, 토큰을 그대로 두면 옛 문맥의 주문과 충돌해 409 다.
    useCheckoutStore.getState().setSelectedItems([item("p1", 1)]);
    const t1 = useCheckoutStore.getState().ensureCheckoutToken(EVENT_A);
    expect(t1).toBeTruthy();

    useCheckoutStore.getState().invalidateCheckoutToken();
    expect(useCheckoutStore.getState().checkoutToken).toBeNull();

    const t2 = useCheckoutStore.getState().ensureCheckoutToken(EVENT_A);
    expect(t2).not.toBe(t1);
  });

  it("선택을 바꾸지 않은 재시도는 같은 토큰을 유지한다 — 이중주문 dedup 이 살아 있어야 한다", () => {
    useCheckoutStore.getState().setSelectedItems([item("p1", 1)]);
    const t1 = useCheckoutStore.getState().ensureCheckoutToken(EVENT_A);
    const t2 = useCheckoutStore.getState().ensureCheckoutToken(EVENT_A);
    expect(t2).toBe(t1);
  });
});
