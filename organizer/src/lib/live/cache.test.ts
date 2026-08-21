import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 라이브 캐시 — lazy + single-flight.
 *
 * 🔴 여기서 지키는 것 넷:
 *   ① 빈 응답으로 직전 값을 **덮어쓰지 않는다** (화면이 통째로 빈다)
 *   ② 외부 장애에도 직전 값을 지킨다
 *   ③ 동시 요청에 외부 **호출 횟수**가 1회다 (thundering herd → 상대 429)
 *   ④ 지문이 같아도 60초 넘으면 본문을 받는다 (스펙 §3 연결 확인)
 */

/** 인메모리 Redis — SET NX/EX · GET · DEL 만 쓴다. */
const h = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    store,
    redis: {
      get: vi.fn(async (k: string) => store.get(k) ?? null),
      set: vi.fn(async (k: string, v: string, ..._rest: unknown[]) => {
        const nx = _rest.includes("NX");
        if (nx && store.has(k)) return null;
        store.set(k, v);
        return "OK";
      }),
      del: vi.fn(async (k: string) => {
        store.delete(k);
        return 1;
      }),
    },
  };
});

vi.mock("@/lib/redis", () => ({
  getPrefixedRedis: () => h.redis,
  getRedis: () => h.redis,
}));

import { BODY_MAX_AGE_MS, REV_FRESH_MS, getLiveSnapshot } from "@/lib/live/cache";
import { LiveSourceError } from "@/lib/live/source";
import type { LiveBody, LiveSource } from "@/lib/live/source";

function body(over: Partial<LiveBody> = {}): LiveBody {
  return {
    tournament: { name: "테스트 대회", round: 2, status: "live", is_rehearsal: false },
    leaderboard: [
      { rank: 1, tied: false, name: "선수 A", player_code: "선수 A", total: -8, current_hole: 15, ranked: true },
    ],
    groups: [
      {
        group_no: 1, tee_time: "06:50", start_hole: 1, current_hole: 15,
        finished: false, player_codes: ["선수 A"],
      },
    ],
    ...over,
  };
}

const EMPTY: LiveBody = {
  tournament: { name: "테스트 대회", round: 2, status: "live", is_rehearsal: false },
  leaderboard: [],
  groups: [],
};

/** 호출 **횟수**를 세는 원천. "캐시가 있다" 로는 단일 비행을 증명할 수 없다. */
function countingSource(over: Partial<LiveSource> & { dataAt?: string } = {}) {
  const calls = { rev: 0, bodyCalls: 0 };
  const src: LiveSource = {
    async fetchRev() {
      calls.rev += 1;
      return { data_at: over.dataAt ?? "A" };
    },
    async fetchBody() {
      calls.bodyCalls += 1;
      return body();
    },
    ...over,
  };
  return { src, calls };
}

beforeEach(() => {
  h.store.clear();
  vi.clearAllMocks();
});

describe("라이브 캐시", () => {
  it("정상 — data_at 이 바뀌면 본문을 받아 교체한다", async () => {
    const { src, calls } = countingSource();
    const t0 = 1_000_000;
    const first = await getLiveSnapshot(t0, src);
    expect(first?.body.groups).toHaveLength(1);
    expect(first?.stale).toBe(false);
    expect(calls.bodyCalls).toBe(1);

    // 지문이 바뀌면 다시 받는다
    const src2 = countingSource({ dataAt: "B" });
    const second = await getLiveSnapshot(t0 + REV_FRESH_MS + 1, src2.src);
    expect(src2.calls.bodyCalls).toBe(1);
    expect(second?.dataAt).toBe("B");
  });

  it("🔴 무변경 — data_at 이 같으면 **본문 호출 0회**", async () => {
    const t0 = 1_000_000;
    await getLiveSnapshot(t0, countingSource().src);

    const { src, calls } = countingSource(); // 같은 dataAt="A"
    const again = await getLiveSnapshot(t0 + REV_FRESH_MS + 1, src);
    expect(calls.rev).toBe(1);
    expect(calls.bodyCalls).toBe(0); // 🔴 약 80바이트로 끝났다
    expect(again?.stale).toBe(false);
    // ⚠️ contentAt 은 그대로여야 한다 — 그게 정지 판정의 근거다
    expect(again?.contentAt).toBe(t0);
  });

  it("지문 캐시가 신선하면 원천을 아예 안 때린다 (5초 안엔 호출 0)", async () => {
    const t0 = 1_000_000;
    await getLiveSnapshot(t0, countingSource().src);
    const { src, calls } = countingSource();
    await getLiveSnapshot(t0 + REV_FRESH_MS - 1, src);
    expect(calls.rev).toBe(0);
    expect(calls.bodyCalls).toBe(0);
  });

  it("🔴 빈 응답 — 직전 값을 덮어쓰지 않는다 · stale 로 표시", async () => {
    const t0 = 1_000_000;
    await getLiveSnapshot(t0, countingSource().src);

    const emptySrc: LiveSource = {
      fetchRev: async () => ({ data_at: "B" }),
      fetchBody: async () => EMPTY,
    };
    const after = await getLiveSnapshot(t0 + REV_FRESH_MS + 1, emptySrc);
    expect(after?.body.groups).toHaveLength(1); // 🔴 직전 값이 살아 있다
    expect(after?.body.leaderboard).toHaveLength(1);
    expect(after?.stale).toBe(true);
  });

  it("🔴 외부 장애(타임아웃) — 직전 값 유지 · stale · contentAt 불변", async () => {
    const t0 = 1_000_000;
    await getLiveSnapshot(t0, countingSource().src);

    const failing: LiveSource = {
      fetchRev: async () => {
        throw new LiveSourceError("timeout", "timeout");
      },
      fetchBody: async () => body(),
    };
    const after = await getLiveSnapshot(t0 + REV_FRESH_MS + 1, failing);
    expect(after?.body.groups).toHaveLength(1);
    expect(after?.stale).toBe(true);
    // 🔴 실패를 "방금 받았다" 로 적으면 정지를 영원히 못 잡는다
    expect(after?.contentAt).toBe(t0);
  });

  it("🔴 단일 비행 — 동시 100 요청에 외부 **호출 1회**", async () => {
    const t0 = 1_000_000;
    let revCalls = 0;
    let bodyCalls = 0;
    const slow: LiveSource = {
      async fetchRev() {
        revCalls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return { data_at: "A" };
      },
      async fetchBody() {
        bodyCalls += 1;
        await new Promise((r) => setTimeout(r, 5));
        return body();
      },
    };

    const results = await Promise.all(
      Array.from({ length: 100 }, () => getLiveSnapshot(t0, slow)),
    );

    // ⚠️ "캐시가 있다" 로는 이걸 증명할 수 없다 — 횟수를 센다.
    expect(revCalls).toBe(1);
    expect(bodyCalls).toBe(1);
    // 락을 못 잡은 요청은 **기다리지 않고** 즉시 돌아온다(첫 요청이라 null).
    expect(results.filter((r) => r !== null).length).toBeGreaterThanOrEqual(1);
  });

  it("🔴 지문이 같아도 60초 넘으면 본문을 받는다 (연결 확인)", async () => {
    const t0 = 1_000_000;
    await getLiveSnapshot(t0, countingSource().src);

    const { src, calls } = countingSource(); // 같은 dataAt
    await getLiveSnapshot(t0 + BODY_MAX_AGE_MS, src);
    expect(calls.bodyCalls).toBe(1); // 지문이 같아도 받았다
  });

  it("60초 이내 · 지문 동일이면 본문을 안 받는다 (경계 반대쪽)", async () => {
    const t0 = 1_000_000;
    await getLiveSnapshot(t0, countingSource().src);
    const { src, calls } = countingSource();
    await getLiveSnapshot(t0 + BODY_MAX_AGE_MS - 1, src);
    expect(calls.bodyCalls).toBe(0);
  });

  it("🔴 data_at 이 바뀌면 본문 캐시가 아무리 새것이어도 **다시 받는다**", async () => {
    // 본문 무효화 기준은 **지문**이지 시간이 아니다. 시간 기반으로 되돌리면
    // 원천이 갱신됐는데 "캐시가 신선하다"는 이유로 옛 본문이 나간다 —
    // 20초 통합 캐시가 만들던 최대 50초 지연이 바로 이 자리에서 생겼다.
    const t0 = 1_000_000;
    await getLiveSnapshot(t0, countingSource().src); // dataAt="A"

    const { src, calls } = countingSource({ dataAt: "B" });
    // 본문은 겨우 6초 됐다(60초 훨씬 이내). 그래도 지문이 달라졌으니 받아야 한다.
    const after = await getLiveSnapshot(t0 + REV_FRESH_MS + 1000, src);
    expect(calls.bodyCalls).toBe(1);
    expect(after?.dataAt).toBe("B");
    expect(after?.contentAt).toBe(t0 + REV_FRESH_MS + 1000);
  });

  it("🔴 rev 는 5초마다 묻는다 — 원천 30초 주기를 놓치지 않는 최소 조건", async () => {
    const t0 = 1_000_000;
    await getLiveSnapshot(t0, countingSource().src);

    const a = countingSource();
    await getLiveSnapshot(t0 + REV_FRESH_MS - 1, a.src);
    expect(a.calls.rev).toBe(0); // 5초 안 — 안 묻는다

    const b = countingSource();
    await getLiveSnapshot(t0 + REV_FRESH_MS, b.src);
    expect(b.calls.rev).toBe(1); // 5초 지남 — 묻는다
    expect(b.calls.bodyCalls).toBe(0); // 지문이 같으면 본문은 그대로
  });
});
