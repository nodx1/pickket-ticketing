/**
 * 레벨2 컷오버 W3-OPS — expire-orders 앵커 동기화 실패의 성공 위장 방지 회귀.
 *
 * v2 reap(만료 정본)은 성공했는데 go 앵커 sweep(orders→expired / attendees→cancelled)이 실패하면,
 * **만료된 주문의 참석자가 confirmed 로 남아 체크인이 가능한 상태**가 된다.
 * 이전 코드는 이를 logger.warn 만 남기고 200 성공으로 반환해 크론 감시에서 보이지 않았다.
 * 이제 `anchorSyncFailed` 를 결과에 담아 207 degraded 로 전파한다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPool, reapInventory, startCronRun, finishCronRun, askV2AboutOrder } = vi.hoisted(() => ({
  getPool: vi.fn(),
  reapInventory: vi.fn(),
  startCronRun: vi.fn(),
  finishCronRun: vi.fn(),
  askV2AboutOrder: vi.fn(),
}));
vi.mock("@/lib/db/pool", () => ({ getPool }));
vi.mock("@/lib/ops/cron-run", () => ({ startCronRun, finishCronRun }));
vi.mock("@/lib/orders/v2-authority", async () => {
  const actual = await vi.importActual<typeof import("@/lib/orders/v2-authority")>(
    "@/lib/orders/v2-authority",
  );
  return { ...actual, askV2AboutOrder };
});
vi.mock("@/lib/v2/commerce-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/v2/commerce-client")>(
    "@/lib/v2/commerce-client",
  );
  return { ...actual, reapInventory };
});

import { GET } from "@/app/api/cron/expire-orders/route";


/**
 * expire-orders 는 pool.query(후보·만료) + pool.connect(참석자 sweep 트랜잭션) 를 쓴다.
 * sweep 이 **주문행을 FOR UPDATE 로 잠그고 같은 트랜잭션에서** 참석자를 갱신하기 때문이다
 * (조인으로는 EPQ 가 조인된 주문행을 재검사하지 않아 막을 수 없다 — 2026-07-31 감사).
 */
function poolMock(opts: { candidates?: string[]; lockedOrders?: string[]; failQuery?: boolean } = {}) {
  const sqls: string[] = [];
  const clientSqls: string[] = [];
  const query = vi.fn(async (sql: string) => {
    if (opts.failQuery) throw new Error("go DB 연결 실패");
    sqls.push(sql);
    if (/SELECT id FROM orders/.test(sql)) {
      const ids = opts.candidates ?? [];
      return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
    }
    return { rows: [], rowCount: 1 };
  });
  const clientQuery = vi.fn(async (sql: string) => {
    clientSqls.push(sql);
    if (/FOR UPDATE/.test(sql)) {
      const ids = opts.lockedOrders ?? [];
      return { rows: ids.map((id) => ({ id })), rowCount: ids.length };
    }
    return { rows: [], rowCount: 1 };
  });
  getPool.mockReturnValue({
    query,
    connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })),
  });
  return { sqls, clientSqls, query, clientQuery };
}

const authed = () =>
  new Request("http://localhost/api/cron/expire-orders", {
    headers: { authorization: "Bearer cron-secret" },
  });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "cron-secret";
  reapInventory.mockResolvedValue({ orders_expired: 3, holds_reaped: 1, seats_released: 2 });
  startCronRun.mockResolvedValue({ id: "run-1", startedAt: Date.now() });
  finishCronRun.mockResolvedValue(undefined);
  // 기본값: v2 도 끝난 것으로 본다 → 종전과 같은 만료 동작.
  askV2AboutOrder.mockResolvedValue({ kind: "terminal", v2OrderId: "v2-1", v2Status: "expired" });
});

/**
 * 🔴 실행 기록(ops_cron_runs) 회귀 — 2026-07-30.
 *
 * 통합DB 감사에서 이 크론만 `ops_cron_runs` 에 **7일간 흔적 0건**으로 나왔다.
 * 원인은 결함이 아니라 계측 부재였는데, 그 상태가 정상과 구분되지 않는 것이 문제다:
 * "잘 돌고 있다" · "크론이 빠졌다" · "401 로 조용히 실패한다" 가 **전부 기록 없음**이다.
 * crontab 이 `curl -fsS … >/dev/null 2>&1` 이라 실패 출력도 버려진다.
 */
describe("expire-orders — 실행 기록", () => {
  it("성공 시 succeeded 로 기록한다", async () => {
    poolMock();
    const res = await GET(authed());
    expect(res.status).toBe(200);
    expect(startCronRun).toHaveBeenCalledWith(expect.anything(), "expire-orders");
    expect(finishCronRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "run-1" }),
      "succeeded",
      expect.objectContaining({ expired: 3 }),
    );
  });

  it("🔴 앵커 sweep 실패(207)도 degraded 로 기록한다 — 207 을 무기록으로 흘리지 않는다", async () => {
    poolMock({ failQuery: true });
    const res = await GET(authed());
    expect(res.status).toBe(207);
    expect(finishCronRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "degraded",
      expect.objectContaining({ anchorSyncFailed: true }),
    );
  });

  it("🔴 v2 reap 실패 시 failed 로 기록한다 — 실패가 기록에 남아야 감시가 가능하다", async () => {
    poolMock();
    reapInventory.mockRejectedValue(new Error("v2 down"));
    const res = await GET(authed());
    expect(res.status).toBe(500);
    expect(finishCronRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "failed",
      undefined,
      expect.anything(),
    );
  });

  it("🔴 인증 실패(401)는 기록하지 않는다 — 인증 전 외부 요청이 원장에 행을 만들면 쓰기 표면이 된다", async () => {
    const res = await GET(new Request("http://localhost/api/cron/expire-orders"));
    expect(res.status).toBe(401);
    expect(startCronRun).not.toHaveBeenCalled();
    expect(finishCronRun).not.toHaveBeenCalled();
  });
});

describe("expire-orders — 앵커 sweep 결과 전파", () => {
  it("앵커 sweep 성공 시 200 + anchorSyncFailed=false", async () => {
    poolMock();

    const res = await GET(authed());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.anchorSyncFailed).toBe(false);
    expect(body.data.expired).toBe(3);
  });

  it("앵커 sweep 실패를 200 성공으로 위장하지 않고 207 degraded 로 알린다", async () => {
    poolMock({ failQuery: true });

    const res = await GET(authed());
    const body = await res.json();

    expect(res.status).toBe(207);
    expect(body.success).toBe(false);
    expect(body.data.anchorSyncFailed).toBe(true);
    // v2 만료(정본)는 성공했으므로 집계는 그대로 보고된다 — 실패를 이유로 정본 결과를 감추지 않는다.
    expect(body.data.expired).toBe(3);
  });
});

/**
 * 🔴 2026-07-31 실사고 회귀 — 결제된 주문을 만료시키지 않는다.
 *
 * v2→go 결제확정 전파가 유실된 동안 결제 완료 주문이 go 에서 `pending` 으로 남았고,
 * 이 크론이 그것을 `expired` 로 만들고 참석자를 `cancelled` 로 만들었다
 * (`ORD-260731-002`: v2 confirmed·티켓 active). 참석자 취소는 발송 세그먼트에서
 * 그 구매자를 지운다.
 *
 * 여기서 증명할 것은 "예외가 난다" 가 아니라 **UPDATE 가 나가지 않는다** 이다.
 */
describe("expire-orders — 결제 주문 만료 차단(v2 대조)", () => {
  /** 후보 SELECT → (가드) → UPDATE 순서를 흉내내는 목. 실행된 SQL 을 모아준다. */
  const poolWithCandidates = (ids: string[]) => poolMock({ candidates: ids });

  it("🔴 v2 가 결제 유효로 보면 만료 UPDATE 를 내보내지 않는다", async () => {
    const { sqls } = poolWithCandidates(["order-paid"]);
    askV2AboutOrder.mockResolvedValue({ kind: "paid", v2OrderId: "v2-paid", v2Status: "confirmed", facts: { amount: 15000, method: "card" } });

    const res = await GET(authed());
    const body = await res.json();

    // 이것이 이 테스트의 전부다 — 만료 UPDATE 가 **아예 나가지 않아야** 한다.
    expect(sqls.some((s) => /UPDATE orders SET status = 'expired'/.test(s))).toBe(false);
    expect(res.status).toBe(200);
    expect(body.data.goAnchorsExpired).toBe(0);
    expect(body.data.paidSkipped).toBe(1);
  });

  it("🔴 v2 에 못 물어보면 만료하지 않는다(fail-closed)", async () => {
    const { sqls } = poolWithCandidates(["order-unknown"]);
    askV2AboutOrder.mockResolvedValue({ kind: "unknown", reason: "v2 timeout" });

    const res = await GET(authed());
    const body = await res.json();

    expect(sqls.some((s) => /UPDATE orders SET status = 'expired'/.test(s))).toBe(false);
    expect(body.data.undecidable).toBe(1);
    expect(body.data.goAnchorsExpired).toBe(0);
  });

  it("v2 가 끝났다고 하면 종전대로 만료한다(무회귀)", async () => {
    const { sqls } = poolWithCandidates(["order-dead"]);
    askV2AboutOrder.mockResolvedValue({
      kind: "terminal", v2OrderId: "v2-dead", v2Status: "expired",
    });

    const res = await GET(authed());
    const body = await res.json();

    expect(sqls.some((s) => /UPDATE orders SET status = 'expired'/.test(s))).toBe(true);
    expect(res.status).toBe(200);
    expect(body.data.paidSkipped).toBe(0);
  });

  it("v2 에 없는 주문(무통장 등)은 종전대로 만료한다", async () => {
    const { sqls } = poolWithCandidates(["order-golocal"]);
    askV2AboutOrder.mockResolvedValue({ kind: "absent" });

    await GET(authed());
    expect(sqls.some((s) => /UPDATE orders SET status = 'expired'/.test(s))).toBe(true);
  });

  it("결제 주문과 죽은 주문이 섞이면 죽은 것만 만료한다", async () => {
    const { sqls } = poolWithCandidates(["paid-1", "dead-1"]);
    askV2AboutOrder.mockImplementation(async (id: string) =>
      id === "paid-1"
        ? { kind: "paid", v2OrderId: "v2-paid", v2Status: "confirmed", facts: { amount: 15000, method: "card" } }
        : { kind: "terminal", v2OrderId: "v2-dead", v2Status: "cancelled" },
    );

    const res = await GET(authed());
    const body = await res.json();

    const update = sqls.find((s) => /UPDATE orders SET status = 'expired'/.test(s));
    expect(update).toBeDefined();
    expect(body.data.paidSkipped).toBe(1);
  });
});

/**
 * 🔴 참석자 sweep 의 두 보호장치 — 감사 뮤테이션 M4 생존분.
 *
 * ① `checked_in` 제외 — 입장 이력을 되돌리면 재입장이 열린다.
 * ② IN-서브쿼리가 아니라 **조인** — 서브쿼리는 문장 시작 스냅샷으로 구체화돼,
 *    repair 가 참석자를 복원하는 동안 락에 걸렸다 풀리면 **옛 스냅샷 기준으로 재취소**한다.
 *    그러면 주문은 completed 인데 참석자만 cancelled 로 남고, 대사는 completed 를 안 보므로
 *    **복구 경로가 없는 영구 불일치**가 된다.
 */
describe("expire-orders — 참석자 sweep 보호", () => {
  it("🔴 checked_in 참석자는 취소하지 않고, 주문 상태를 조인으로 재검사한다", async () => {
    const { clientSqls } = poolMock({ lockedOrders: ["ord-1"] });

    await GET(authed());

    // 🔴 주문행을 **먼저 잠그고** 같은 트랜잭션에서 참석자를 갱신해야 한다.
    //    조인으로는 EPQ 가 조인된 주문행을 재검사하지 않아 repair 와 경합에서 진다.
    expect(clientSqls[0]).toBe("BEGIN");
    expect(clientSqls[1]).toMatch(/FROM orders[\s\S]*FOR UPDATE/);
    const sweep = clientSqls.find((q) => /UPDATE attendees/.test(q));
    expect(sweep).toBeDefined();
    expect(sweep).toMatch(/NOT IN \('cancelled', 'checked_in'\)/);
    expect(clientSqls).toContain("COMMIT");
  });
});
