/**
 * 레벨2 컷오버 W3-OPS(+W5-ATTENDEE) — seat-watch-trigger v2 flip 회귀.
 *
 * 고정하는 계약:
 *  1) 판정 근거를 go `seats`/`seat_tiers` 가 아니라 **v2 좌석/티어 live read** 에서 가져온다
 *     (go seats 는 T1 이후 writer 0 = 영구 빈 테이블이라 JOIN 이 항상 0행이었다 = 무성 누락).
 *  2) v2 조회 실패를 "대상 0건 200 성공"으로 위장하지 않는다 → 207 degraded.
 *  3) 발송 전 `notify_at` 선점(조건부 UPDATE)으로 동시 2회 실행 시 이중발송 불가.
 *  4) 발송 실패 시 선점을 되돌려 다음 tick 이 재시도한다(영구 유실 금지).
 *  5) **W5-ATTENDEE**: 찜 원장이 v2 정본이다 — go DB(pool) 를 한 번도 만지지 않는다.
 *     후보 조회 실패도 "0건 성공"이 아니라 503 으로 끊는다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getPool, createSeatNotification, fetchAllV2Seats, listTiers,
  listPendingSeatWatches, claimSeatWatch, releaseSeatWatch,
} = vi.hoisted(() => ({
  // 🔴 go DB 접근이 남아 있으면 즉시 실패 — W5-ATTENDEE 이관 회귀 가드.
  getPool: vi.fn(() => {
    throw new Error("go DB 접근이 남아 있다(W5-ATTENDEE 이관 위반)");
  }),
  createSeatNotification: vi.fn(),
  fetchAllV2Seats: vi.fn(),
  listTiers: vi.fn(),
  listPendingSeatWatches: vi.fn(),
  claimSeatWatch: vi.fn(),
  releaseSeatWatch: vi.fn(),
}));
vi.mock("@/lib/db/pool", () => ({ getPool }));
vi.mock("@/lib/notifications/seat-channels", () => ({ createSeatNotification }));
vi.mock("@/lib/seats/v2-status", () => ({ fetchAllV2Seats }));
vi.mock("@/lib/v2/commerce-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/v2/commerce-client")>(
    "@/lib/v2/commerce-client",
  );
  return { ...actual, listTiers, listPendingSeatWatches, claimSeatWatch, releaseSeatWatch };
});

import { GET } from "@/app/api/cron/seat-watch-trigger/route";
import { V2CommerceError } from "@/lib/v2/commerce-client";

const EVENT = "11111111-1111-4111-8111-111111111111";
const SEAT = "22222222-2222-4222-8222-222222222222";

const authed = () =>
  new Request("http://localhost/api/cron/seat-watch-trigger", {
    headers: { authorization: "Bearer cron-secret" },
  });

/** v2 찜 후보 응답 + 선점 결과를 세팅한다(claimed=false 면 다른 실행이 선점한 상황). */
function mockWatches(watchRows: unknown[], claimed = true) {
  listPendingSeatWatches.mockResolvedValue({ watches: watchRows });
  claimSeatWatch.mockResolvedValue({ claimed });
  releaseSeatWatch.mockResolvedValue({ released: true });
}

const watch = (over: Record<string, unknown> = {}) => ({
  id: "w1",
  account_ref: "acc-1",
  seat_id: SEAT,
  session_id: null,
  event_id: EVENT,
  target_price: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "cron-secret";
  createSeatNotification.mockResolvedValue(undefined);
  listTiers.mockResolvedValue({ tiers: [{ tier_id: "t1", base_price: 50_000 }], total: 1 });
});

describe("seat-watch-trigger — v2 판정", () => {
  it("go seats/go DB 를 읽지 않고 v2 available 로 매진풀림을 발송한다", async () => {
    mockWatches([watch()]);
    fetchAllV2Seats.mockResolvedValue({
      seats: [{ seat_id: SEAT, tier_id: "t1", status: "available" }],
    });

    const res = await GET(authed());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.notified).toBe(1);
    expect(createSeatNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "watch_available", seatId: SEAT }),
    );
    // go DB 를 다시 읽기 시작하면(seat_watches JOIN seats 부활 포함) 무성 누락으로 회귀한다.
    expect(getPool).not.toHaveBeenCalled();
  });

  it("target_price 이하이면 가격도달로 발송한다", async () => {
    mockWatches([watch({ target_price: 60_000 })]);
    fetchAllV2Seats.mockResolvedValue({
      seats: [{ seat_id: SEAT, tier_id: "t1", status: "sold" }],
    });

    await GET(authed());

    expect(createSeatNotification).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "watch_price_drop" }),
    );
  });

  it("조건 미충족이면 발송하지 않는다", async () => {
    mockWatches([watch()]);
    fetchAllV2Seats.mockResolvedValue({
      seats: [{ seat_id: SEAT, tier_id: "t1", status: "sold" }],
    });

    const res = await GET(authed());
    const body = await res.json();

    expect(body.data.triggered).toBe(0);
    expect(createSeatNotification).not.toHaveBeenCalled();
  });
});

describe("seat-watch-trigger — fail-closed", () => {
  it("v2 조회 실패를 200 성공으로 위장하지 않고 207 degraded 로 알린다", async () => {
    mockWatches([watch()]);
    fetchAllV2Seats.mockRejectedValue(new V2CommerceError("v2 down", 503));

    const res = await GET(authed());
    const body = await res.json();

    expect(res.status).toBe(207);
    expect(body.success).toBe(false);
    expect(body.data.degradedEvents).toBe(1);
    expect(createSeatNotification).not.toHaveBeenCalled();
  });

  it("cron 인증 없이는 401", async () => {
    const res = await GET(new Request("http://localhost/api/cron/seat-watch-trigger"));
    expect(res.status).toBe(401);
  });
});

describe("seat-watch-trigger — 멱등/복구", () => {
  it("선점(notify_at 조건부 UPDATE)에 지면 발송하지 않는다 — 동시 2회 실행 이중발송 불가", async () => {
    mockWatches([watch()], false); // 다른 실행이 이미 notify_at 을 채운 상황
    fetchAllV2Seats.mockResolvedValue({
      seats: [{ seat_id: SEAT, tier_id: "t1", status: "available" }],
    });

    const res = await GET(authed());
    const body = await res.json();

    expect(createSeatNotification).not.toHaveBeenCalled();
    expect(body.data.notified).toBe(0);
  });

  it("발송 실패 시 notify_at 을 되돌려 다음 tick 이 재시도하게 한다", async () => {
    mockWatches([watch()]);
    fetchAllV2Seats.mockResolvedValue({
      seats: [{ seat_id: SEAT, tier_id: "t1", status: "available" }],
    });
    createSeatNotification.mockRejectedValue(new Error("채널 장애"));

    const res = await GET(authed());
    const body = await res.json();

    expect(res.status).toBe(207);
    expect(body.data.failed).toBe(1);
    expect(releaseSeatWatch).toHaveBeenCalledWith("w1");
  });

  it("🔴 후보 조회 실패를 '대상 0건 200 성공'으로 위장하지 않는다(무성 정지 금지)", async () => {
    listPendingSeatWatches.mockRejectedValue(new V2CommerceError("v2 down", 503));

    const res = await GET(authed());

    expect(res.status).toBe(503);
    expect(createSeatNotification).not.toHaveBeenCalled();
  });

  it("🔴 선점 호출 자체가 실패하면 발송하지 않는다(확정 없는 발송 = 다음 tick 중복)", async () => {
    mockWatches([watch()]);
    claimSeatWatch.mockRejectedValue(new V2CommerceError("v2 down", 503));
    fetchAllV2Seats.mockResolvedValue({
      seats: [{ seat_id: SEAT, tier_id: "t1", status: "available" }],
    });

    const res = await GET(authed());
    const body = await res.json();

    expect(createSeatNotification).not.toHaveBeenCalled();
    expect(body.data.failed).toBe(1);
  });
});
