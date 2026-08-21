// @vitest-environment jsdom
/**
 * 🔴 폴링 규약 — 지시서 §4.
 *
 * ```
 * 20초마다 · 백그라운드면 멈춤 · 실패해도 화면을 비우지 않음
 * ```
 *
 * ⚠️ **백그라운드 정지는 운영 위험**이다. 갤러리 수천 명의 주머니 속 폰이 20초마다
 *    계속 때리면 우리 서버와 상대 API 상한이 함께 무너진다.
 */
import { StrictMode } from "react";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { LIVE_POLL_MS, useLiveSummary } from "./use-live-summary";

const OK = {
  status: "live",
  stale: false,
  is_rehearsal: false,
  tournament: { name: "T", round: 1, phase: "play" },
  leaders: [],
  groups: [],
  content_age_sec: 5,
  updated_at: "2026-08-20T10:00:00+09:00",
};

let visibility: DocumentVisibilityState = "visible";

function setVisibility(v: DocumentVisibilityState) {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => visibility,
  });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => OK })));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function calls(): number {
  return (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
}

describe("첫 읽기", () => {
  it("티켓 번호를 붙여 우리 라우트를 부른다", async () => {
    const { result } = renderHook(() => useLiveSummary("PK-1"));
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    const url = String((globalThis.fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]);
    expect(url).toBe("/api/public/live/summary?ticket=PK-1");
  });

  it("티켓 번호를 인코딩한다", async () => {
    renderHook(() => useLiveSummary("PK/1 2"));
    await waitFor(() => expect(calls()).toBe(1));
    const url = String((globalThis.fetch as unknown as { mock: { calls: string[][] } }).mock.calls[0][0]);
    expect(url).toContain("ticket=PK%2F1%202");
  });
});

describe("🔴 실패해도 화면을 비우지 않는다", () => {
  it("🔴 직전 값을 유지하고 실패 표시만 켠다", async () => {
    const { result } = renderHook(() => useLiveSummary("PK-1"));
    await waitFor(() => expect(result.current.summary).not.toBeNull());

    // 다음 시도부터 실패시킨다.
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })));
    setVisibility("hidden");
    setVisibility("visible"); // 복귀 시 즉시 한 번 읽는다

    await waitFor(() => expect(result.current.failing).toBe(true));
    expect(result.current.summary, "실패했다고 값을 지웠다").not.toBeNull();
  });

  it("응답 모양이 다르면 실패로 본다 — 빈 화면보다 옛 값이 낫다", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ nope: 1 }) })));
    const { result } = renderHook(() => useLiveSummary("PK-1"));
    await waitFor(() => expect(result.current.failing).toBe(true));
    expect(result.current.summary).toBeNull();
  });
});

describe("🔴 백그라운드면 멈춘다", () => {
  it("🔴 탭이 숨겨진 동안에는 추가 요청이 없다", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderHook(() => useLiveSummary("PK-1"));
    await vi.waitFor(() => expect(calls()).toBe(1));

    setVisibility("hidden");
    const before = calls();
    await act(async () => {
      // 주기를 넉넉히 넘긴다 — 살아 있으면 여러 번 불렸을 시간.
      vi.advanceTimersByTime(LIVE_POLL_MS * 5);
    });
    expect(calls(), "숨겨진 탭이 계속 때리고 있다").toBe(before);
  });

  it("다시 보이면 즉시 한 번 읽는다 — 오래된 값을 보여주지 않는다", async () => {
    renderHook(() => useLiveSummary("PK-1"));
    await waitFor(() => expect(calls()).toBe(1));
    setVisibility("hidden");
    setVisibility("visible");
    await waitFor(() => expect(calls()).toBe(2));
  });
});

describe("겹쳐 부르지 않는다", () => {
  it("응답이 느려도 요청이 쌓이지 않는다", async () => {
    let release: (() => void) | null = null;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await gate;
        return { ok: true, json: async () => OK };
      }),
    );
    renderHook(() => useLiveSummary("PK-1"));
    await waitFor(() => expect(calls()).toBe(1));

    // 진행 중에 복귀 이벤트가 여러 번 와도 한 번만 나가 있어야 한다.
    setVisibility("hidden");
    setVisibility("visible");
    setVisibility("hidden");
    setVisibility("visible");
    expect(calls(), "진행 중인데 또 불렀다").toBe(1);

    release!();
    await waitFor(() => expect(calls()).toBeGreaterThanOrEqual(1));
  });
});

/**
 * 🔴 F2 — **첫 로드에서 요약이 정확히 한 번 나가는가** (2026-08-07 재현 요청).
 *
 * 배포 세션 관측: 임시 미리보기 페이지에서 `/api/public/live/*` 요청이 **0건**이고
 * 화면이 「불러오는 중」에 고착됐다. 원인은 단정하지 않고 재현 사실만 넘겨받았다.
 *
 * ⚠️ **「로딩이 끝났다」·「값이 있다」로는 안 잡힌다** — 캐시나 초기값으로도 통과한다.
 *    **호출 횟수**를 센다.
 *
 * ## 🔴 StrictMode 이중 마운트
 * 개발 모드에서 React 는 effect 를 **mount → cleanup → mount** 로 두 번 돌린다.
 * 훅에 재진입 가드(`inFlight`)가 있으므로 **두 번째가 첫 호출을 삼키지 않는지**를 본다.
 */
describe("🔴 F2 — 첫 로드 호출 횟수", () => {
  it("🔴 일반 마운트에서 정확히 1회 나간다", async () => {
    renderHook(() => useLiveSummary("PK-1"));
    await waitFor(() => expect(calls()).toBe(1));
    // 잠시 더 두고도 늘지 않는다(즉시 재시도가 없다).
    await new Promise((r) => setTimeout(r, 50));
    expect(calls()).toBe(1);
  });

  it("🔴 StrictMode 이중 마운트에서도 **최소 1회** 나간다 — 가드가 첫 호출을 삼키면 안 된다", async () => {
    const { result } = renderHook(() => useLiveSummary("PK-1"), { wrapper: StrictMode });
    await waitFor(() => expect(calls()).toBeGreaterThanOrEqual(1));
    // 그리고 실제로 값이 들어와야 한다 — 호출만 나가고 상태가 안 붙으면 화면은 그대로 고착이다.
    await waitFor(() => expect(result.current.summary).not.toBeNull());
    expect(result.current.loading).toBe(false);
  });

  it("🔴 StrictMode 에서도 중복 호출로 번지지 않는다", async () => {
    renderHook(() => useLiveSummary("PK-1"), { wrapper: StrictMode });
    await waitFor(() => expect(calls()).toBeGreaterThanOrEqual(1));
    await new Promise((r) => setTimeout(r, 50));
    expect(calls(), "이중 마운트가 요청을 두 배로 냈다").toBeLessThanOrEqual(2);
  });
});
