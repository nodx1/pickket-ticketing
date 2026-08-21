import { beforeEach, describe, expect, it } from "vitest";
import { createJSONStorage, persist } from "zustand/middleware";
import { create } from "zustand";

/**
 * 🔴 결제 페이지 무한 루프의 **기전 자체**를 실제로 재현한다 (2026-07-30).
 *
 * 왜 이 테스트가 필요한가: 원인 진단을 `zustand/middleware` **소스를 읽어서** 했다.
 * "소스에 `set(stateFromStorage, true)` 가 무조건 있다" 는 읽은 것이고,
 * "그래서 객체 참조가 매번 바뀐다" 는 **돌려봐야 아는 것**이다.
 * 이 리포가 반복해 사고를 낸 형태가 정확히 그 간격이다.
 *
 * 여기서 고정하는 사실 2가지:
 *   ① `rehydrate()` 는 저장소에 값이 있으면 **중첩 객체 참조를 새로 만든다**
 *      → `useEffect` deps 에 그 객체를 넣으면 매 렌더 변경 → 무한 루프
 *   ② 원시값(문자열 필드)은 **참조가 안정**하다 → deps 에 안전하다
 *
 * ⟹ zustand 를 올릴 때 ①이 바뀌면 이 테스트가 알려준다. 그때 결제 스텝의
 *    수정 근거가 유효한지 다시 봐야 한다.
 */

interface BuyerInfo {
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string;
}
interface TestState {
  buyerInfo: BuyerInfo;
  itemCount: number;
  setBuyer: (b: BuyerInfo) => void;
}

/** 실제 store 와 같은 구성: sessionStorage(동기) + skipHydration + 중첩 객체 저장. */
function makeStore(storage: Storage) {
  return create<TestState>()(
    persist(
      (set) => ({
        buyerInfo: { buyerName: "", buyerEmail: "", buyerPhone: "" },
        itemCount: 0,
        setBuyer: (b) => set({ buyerInfo: b }),
      }),
      {
        name: "loop-repro",
        storage: createJSONStorage(() => storage),
        skipHydration: true,
        partialize: (s) => ({ buyerInfo: s.buyerInfo, itemCount: s.itemCount }),
      },
    ),
  );
}

/** jsdom 없이 쓰는 동기 Storage 스텁 — 실제 sessionStorage 와 같은 동기 계약. */
function memStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

let storage: Storage;
beforeEach(() => {
  storage = memStorage();
});

describe("rehydrate 가 객체 참조를 바꾸는가 (루프 기전)", () => {
  it("🔴 저장된 값이 있으면 rehydrate 마다 buyerInfo 가 **새 객체**가 된다", async () => {
    const useStore = makeStore(storage);
    // 값을 넣어 저장소에 기록시킨다(partialize → setItem).
    useStore.getState().setBuyer({
      buyerName: "홍길동",
      buyerEmail: "a@b.com",
      buyerPhone: "01012345678",
    });
    expect(storage.getItem("loop-repro")).not.toBeNull();

    await useStore.persist.rehydrate();
    const first = useStore.getState().buyerInfo;
    await useStore.persist.rehydrate();
    const second = useStore.getState().buyerInfo;

    // 내용은 같지만 **참조가 다르다** — 이것이 deps 를 매 렌더 변경시킨 원인이다.
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("✅ 원시값 필드는 참조가 안정하다 — deps 에 안전하다", async () => {
    const useStore = makeStore(storage);
    useStore.getState().setBuyer({
      buyerName: "홍길동",
      buyerEmail: "a@b.com",
      buyerPhone: "01012345678",
    });

    await useStore.persist.rehydrate();
    const a = useStore.getState().buyerInfo.buyerName;
    await useStore.persist.rehydrate();
    const b = useStore.getState().buyerInfo.buyerName;

    // 문자열은 값 비교이므로 rehydrate 를 몇 번 해도 deps 가 변하지 않는다.
    expect(b).toBe(a);
  });

  it("저장소가 비어 있어도 rehydrate 는 상태 객체를 교체한다(전체 구독은 재렌더된다)", async () => {
    const useStore = makeStore(storage);
    const before = useStore.getState();
    await useStore.persist.rehydrate();
    const after = useStore.getState();

    // 🔴 값이 없어도 set() 이 불린다 → 셀렉터 없는 useStore() 구독은 매번 재렌더된다.
    //    다만 buyerInfo 참조는 보존되므로(기본 merge 가 current 를 펼침) 루프까지는 안 간다.
    //    ⟹ 루프의 필요조건은 "저장된 값 존재" 다. 빈 장바구니로 진입하면 재현되지 않는다.
    expect(after).not.toBe(before);
    expect(after.buyerInfo).toBe(before.buyerInfo);
  });
});
