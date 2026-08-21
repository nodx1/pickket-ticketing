import { describe, expect, it, vi } from "vitest";
import { runGuarded } from "./useConfirmAction";

/** ref 흉내 — 훅이 쓰는 저장소와 같은 성질(렌더 무관, 즉시 반영). */
function makeFlag() {
  let v = false;
  const seen: boolean[] = [];
  return {
    is: () => v,
    set: (next: boolean) => {
      v = next;
      seen.push(next);
    },
    get seen() {
      return seen;
    },
  };
}

describe("runGuarded — 확인 동작 1회 실행 보장", () => {
  it("정상 실행: 진행 표시가 켜졌다 꺼진다", async () => {
    const f = makeFlag();
    const onError = vi.fn();
    const action = vi.fn(async () => {
      expect(f.is(), "실행 중에는 진행 표시가 켜져 있어야 한다").toBe(true);
    });
    await expect(runGuarded(action, f.is, f.set, onError)).resolves.toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
    expect(f.seen).toEqual([true, false]);
  });

  it("🔴 실행 중 재진입은 건너뛴다 — 요청이 두 번 나가지 않는다", async () => {
    const f = makeFlag();
    let release!: () => void;
    const action = vi.fn(() => new Promise<void>((r) => (release = r)));
    const onError = vi.fn();

    const first = runGuarded(action, f.is, f.set, onError);
    expect(await runGuarded(action, f.is, f.set, onError), "재진입이 실행돼버렸다").toBe(false);
    expect(action).toHaveBeenCalledTimes(1);

    release();
    await expect(first).resolves.toBe(true);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("🔴 action 이 던져도 진행 표시가 풀린다 — 안 풀면 확인창이 잠긴 채 남는다", async () => {
    const f = makeFlag();
    const onError = vi.fn();
    await expect(
      runGuarded(() => Promise.reject(new Error("네트워크 오류")), f.is, f.set, onError),
    ).resolves.toBe(false);
    expect(f.is(), "던진 뒤에도 잠겨 있다").toBe(false);
    expect(f.seen).toEqual([true, false]);
  });

  /**
   * 🔴 이 배치의 실제 구멍이었다.
   * 1차 구현은 거부를 밖으로 던졌고 훅이 `void` 로 버렸다 → **unhandled rejection, 무음.**
   * 호출하는 핸들러 21개 중 11개에 `catch` 가 없어서(fetch 거부 미처리) 실제로 닿는 경로였다.
   */
  describe("실패를 삼키지 않는다", () => {
    it("거부하면 onError 가 그 오류로 불린다", async () => {
      const f = makeFlag();
      const onError = vi.fn();
      const boom = new Error("Failed to fetch");
      await expect(runGuarded(() => Promise.reject(boom), f.is, f.set, onError)).resolves.toBe(false);
      expect(onError, "실패했는데 아무에게도 알리지 않았다").toHaveBeenCalledTimes(1);
      expect(onError).toHaveBeenCalledWith(boom);
    });

    it("동기 throw 도 onError 로 간다", async () => {
      const f = makeFlag();
      const onError = vi.fn();
      await expect(
        runGuarded(
          () => {
            throw new Error("즉시 실패");
          },
          f.is,
          f.set,
          onError,
        ),
      ).resolves.toBe(false);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(f.is()).toBe(false);
    });

    it("Error 가 아닌 값을 던져도 그대로 넘긴다", async () => {
      const f = makeFlag();
      const onError = vi.fn();
      await runGuarded(() => Promise.reject("문자열 거부"), f.is, f.set, onError);
      expect(onError).toHaveBeenCalledWith("문자열 거부");
    });

    it("🔴 거부를 밖으로 흘리지 않는다 — 흘리면 훅의 void 가 버려 무음이 된다", async () => {
      const f = makeFlag();
      // rejects 가 아니라 resolves 여야 한다. 이 단언이 1차 구현을 잡는다.
      await expect(
        runGuarded(() => Promise.reject(new Error("x")), f.is, f.set, vi.fn()),
      ).resolves.toBe(false);
    });

    it("재진입으로 건너뛴 경우는 실패가 아니다 — onError 를 부르지 않는다", async () => {
      const f = makeFlag();
      const onError = vi.fn();
      let release!: () => void;
      const first = runGuarded(() => new Promise<void>((r) => (release = r)), f.is, f.set, onError);
      await runGuarded(() => Promise.resolve(), f.is, f.set, onError);
      expect(onError, "중복 클릭인데 오류 토스트가 떴다").not.toHaveBeenCalled();
      release();
      await first;
    });
  });

  it("한 번 끝난 뒤에는 다시 실행할 수 있다 (일회용이 아니다)", async () => {
    const f = makeFlag();
    const action = vi.fn(async () => {});
    await runGuarded(action, f.is, f.set, vi.fn());
    await runGuarded(action, f.is, f.set, vi.fn());
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("실패한 뒤에도 재시도할 수 있다", async () => {
    const f = makeFlag();
    const action = vi
      .fn()
      .mockRejectedValueOnce(new Error("첫 시도 실패"))
      .mockResolvedValueOnce(undefined);
    expect(await runGuarded(action, f.is, f.set, vi.fn())).toBe(false);
    expect(await runGuarded(action, f.is, f.set, vi.fn())).toBe(true);
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("동기 action 도 받는다 (Promise 를 안 돌려줘도 된다)", async () => {
    const f = makeFlag();
    let called = 0;
    await expect(runGuarded(() => void called++, f.is, f.set, vi.fn())).resolves.toBe(true);
    expect(called).toBe(1);
    expect(f.is()).toBe(false);
  });
});
