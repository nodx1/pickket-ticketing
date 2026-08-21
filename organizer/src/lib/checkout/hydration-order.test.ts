import { describe, expect, it } from "vitest";
import { createJSONStorage, persist } from "zustand/middleware";
import { create } from "zustand";

import { resolveCheckoutRedirect } from "./resolve-redirect";

/**
 * 🔴 **1차 수정이 만든 회귀의 기전** 을 고정한다 (2026-07-30, 브라우저 실측 후 작성).
 *
 * ## 무슨 일이 있었나
 * 무한 루프(React #185)를 잡으려고 결제 스텝에서 `persist.rehydrate()` 를 지우고
 * 판정을 **렌더 클로저 값**으로 하게 바꿨다. 루프는 사라졌다 — 그리고 대신
 * **결제 URL 직접 진입/새로고침이 10/10 전부 장바구니로 튕겼다.**
 *
 * 기전:
 *   ① `skipHydration: true` ⟹ **첫 렌더의 store 는 빈 상태**
 *   ② 자식 `CheckoutProgress` 가 부모보다 먼저 `rehydrate()` 하지만,
 *      부모 이펙트가 읽는 것은 **렌더1 시점의 낡은 클로저**다
 *   ③ ⟹ `itemCount === 0` 오판 → 장바구니로 리다이렉트
 *   ④ once-guard(`redirectedRef`)가 그 오판을 **영구 고정** → 복구 불가
 *
 * ## 왜 기존 게이트가 못 잡았나 — 세 겹으로 다 빠져나갔다
 *   · 순수함수 테스트: `resolveCheckoutRedirect` 는 **주어진 입력에 대해 옳다.**
 *     틀린 건 *무엇을 입력으로 주는가*(클로저 vs 최신값)였다.
 *   · 구조 가드: "rehydrate 를 부르지 않는다" 를 **요구사항으로 단언**했는데
 *     그 단언 자체가 틀렸다. 가드는 내 가정을 검증하지 않고 **박아버린다.**
 *   · 기전 재현 테스트(`rehydrate-reference.test.ts`): 참조 안정성만 모델링하고
 *     **"부모 이펙트가 언제 실행되는가" 라는 순서를 모델링하지 않았다.**
 *
 * ⟹ 이 테스트는 그 빠진 축(**순서**)을 모델링한다.
 */

interface BuyerInfo {
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string;
}
interface TestState {
  buyerInfo: BuyerInfo;
  selectedItems: Array<{ productId: string; quantity: number }>;
  orderId: string | null;
}

const EMPTY_BUYER: BuyerInfo = { buyerName: "", buyerEmail: "", buyerPhone: "" };

/** jsdom 없이 쓰는 동기 Storage 스텁 — 실제 sessionStorage 와 같은 동기 계약. */
function memStorage(seed?: unknown): Storage {
  const m = new Map<string, string>();
  if (seed !== undefined) m.set("hydration-order", JSON.stringify({ state: seed, version: 0 }));
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => Array.from(m.keys())[i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  } as Storage;
}

/** 실제 store 와 같은 구성: 동기 storage + skipHydration + 중첩 객체 저장. */
function makeStore(storage: Storage) {
  return create<TestState>()(
    persist(
      (): TestState => ({ buyerInfo: EMPTY_BUYER, selectedItems: [], orderId: null }),
      {
        name: "hydration-order",
        storage: createJSONStorage(() => storage),
        skipHydration: true,
        partialize: (s) => ({
          buyerInfo: s.buyerInfo,
          selectedItems: s.selectedItems,
          orderId: s.orderId,
        }),
      },
    ),
  );
}

/** "담기 + 정보입력까지 끝낸" 저장값 — 결제 단계에 머물러야 하는 상태. */
const FILLED = {
  buyerInfo: { buyerName: "홍길동", buyerEmail: "a@b.test", buyerPhone: "01000000000" },
  selectedItems: [{ productId: "p1", quantity: 1 }],
  orderId: null,
};

type Judge = (s: TestState) => ReturnType<typeof resolveCheckoutRedirect>;

const judge: Judge = (s) =>
  resolveCheckoutRedirect({
    orderId: s.orderId,
    itemCount: s.selectedItems.length,
    buyerName: s.buyerInfo.buyerName,
    buyerEmail: s.buyerInfo.buyerEmail,
    buyerPhone: s.buyerInfo.buyerPhone,
  });

/**
 * 결제 페이지 **마운트 1회분**을 React 의 실행 순서대로 재생한다.
 *
 * React 계약: 같은 커밋에서 **자식 이펙트가 부모 이펙트보다 먼저** 실행된다.
 * `readFresh=false` 는 1차 수정판(렌더 클로저 사용), `true` 는 현재판(`getState()` 사용).
 *
 * @returns once-guard 까지 반영한 최종 리다이렉트 판정
 */
function mountOnce(storage: Storage, readFresh: boolean) {
  const store = makeStore(storage);

  // ── 렌더 1: skipHydration 이므로 아직 빈 상태. 이 값이 이펙트 클로저에 잡힌다.
  const renderClosure = store.getState();

  // ── 자식(CheckoutProgress) 이펙트: deps [] 로 복원. 동기 storage 라 즉시 끝난다.
  void store.persist.rehydrate();

  // ── 부모(결제 스텝) 이펙트: 클로저를 읽느냐, 최신값을 읽느냐
  const seen = readFresh ? store.getState() : renderClosure;
  const target = judge(seen);

  // once-guard: 첫 판정이 리다이렉트면 그대로 고정된다(이후 렌더가 정정하지 못한다).
  return { target, hydrated: store.persist.hasHydrated(), afterHydration: store.getState() };
}

describe("결제 스텝 하이드레이션 순서", () => {
  it("🔴 클로저로 판정하면 저장값이 있어도 장바구니로 튕긴다 — 1차 수정판의 회귀", () => {
    const r = mountOnce(memStorage(FILLED), /* readFresh */ false);

    // 저장값은 멀쩡하다 — 복원 자체는 성공했다.
    expect(r.hydrated).toBe(true);
    expect(r.afterHydration.selectedItems).toHaveLength(1);
    expect(r.afterHydration.buyerInfo.buyerName).toBe("홍길동");

    // 그런데 판정은 "장바구니로" 다. 이것이 브라우저에서 10/10 튕긴 원인이다.
    expect(r.target).toEqual({ to: "cart" });
  });

  it("최신값(getState)으로 판정하면 결제 단계에 머문다 — 현재 수정판", () => {
    const r = mountOnce(memStorage(FILLED), /* readFresh */ true);
    expect(r.target).toBeNull(); // null = 머문다
  });

  it("저장값이 진짜 없으면 최신값 판정도 장바구니로 보낸다 — 게이트가 죽지 않았다", () => {
    // ⚠️ 이 단언이 없으면 위 테스트는 "판정을 아예 안 하는" 수정으로도 통과한다.
    const r = mountOnce(memStorage(), /* readFresh */ true);
    expect(r.target).toEqual({ to: "cart" });
  });

  it("완료된 주문이 저장돼 있으면 최신값 판정이 완료 페이지로 보낸다 — 재결제 차단 유지", () => {
    const storage = memStorage({ ...FILLED, orderId: "ord-1" });
    const r = mountOnce(storage, /* readFresh */ true);
    expect(r.target).toEqual({ to: "complete", orderId: "ord-1" });
    // 클로저판은 이 자리도 놓친다 — orderId 를 못 보고 장바구니로 보낸다(중복결제 위험).
    expect(mountOnce(memStorage({ ...FILLED, orderId: "ord-1" }), false).target).toEqual({
      to: "cart",
    });
  });

  it("구매자 정보만 빈 저장값이면 정보 입력으로 — 순서 계약 유지", () => {
    const r = mountOnce(memStorage({ ...FILLED, buyerInfo: EMPTY_BUYER }), true);
    expect(r.target).toEqual({ to: "details" });
  });
});
