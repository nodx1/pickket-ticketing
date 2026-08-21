import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getPool } = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock("@/lib/db/pool", () => ({ getPool }));

import { enqueueAuditOutbox, processAuditOutbox } from "@/lib/audit/outbox";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.V2_INTERNAL_BASE_URL = "https://v2.test";
  process.env.GO_WEBHOOK_SECRET = "test-secret";
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...OLD_ENV };
});

describe("enqueueAuditOutbox — 트랜잭션 결합", () => {
  it("호출자 client(txn)로 audit_outbox INSERT (상태변경과 원자적)", async () => {
    const client = { query: vi.fn().mockResolvedValue({}) };
    await enqueueAuditOutbox(client, {
      action: "update",
      tableName: "seats",
      accountId: "acc1",
      userId: "u1",
      recordId: "seat-1",
      changes: { seatIds: ["seat-1"] },
      dedupKey: "k1",
    });
    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toContain("INSERT INTO audit_outbox");
    expect(sql).toContain("ON CONFLICT (dedup_key)");
    // 상태변경과 같은 txn client 로 실행 — 별도 pool 연결을 만들지 않는다(원자성).
    expect(getPool).not.toHaveBeenCalled();
    expect(params[0]).toBe("update");
    expect(params[7]).toBe("k1");
    // changes 는 JSON 직렬화.
    expect(params[5]).toBe(JSON.stringify({ seatIds: ["seat-1"] }));
  });

  it("changes/dedupKey 미지정이면 null 로 적재(중복허용)", async () => {
    const client = { query: vi.fn().mockResolvedValue({}) };
    await enqueueAuditOutbox(client, { action: "x", tableName: "seats" });
    const params = client.query.mock.calls[0][1];
    expect(params[5]).toBeNull();
    expect(params[7]).toBeNull();
  });
});

/** claim 트랜잭션 client(BEGIN, lease 회수, dead 격리, SELECT claim, per-row UPDATE, COMMIT). */
function makeClaimClient(claimRows: unknown[]) {
  const query = vi.fn();
  query.mockResolvedValueOnce({}); // BEGIN
  query.mockResolvedValueOnce({}); // stale lease 회수
  query.mockResolvedValueOnce({}); // dead 격리
  query.mockResolvedValueOnce({ rows: claimRows }); // SELECT ... FOR UPDATE SKIP LOCKED
  for (let i = 0; i < claimRows.length; i++) query.mockResolvedValueOnce({}); // per-row mark
  query.mockResolvedValueOnce({}); // COMMIT
  return { release: vi.fn(), query };
}

function row(over: Record<string, unknown> = {}) {
  return {
    id: "1",
    action: "update",
    table_name: "seats",
    account_id: "acc1",
    user_id: "u1",
    record_id: "seat-1",
    changes: { seatIds: ["seat-1"] },
    ip_address: null,
    attempts: 0,
    max_attempts: 10,
    ...over,
  };
}

describe("processAuditOutbox — 드레인", () => {
  it("pending 행을 클레임해 v2 /internal/audit-logs 로 POST 후 delivered", async () => {
    const client = makeClaimClient([row()]);
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue({ rowCount: 1 }), // 최종 delivered UPDATE
    };
    getPool.mockReturnValue(pool);
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(processAuditOutbox()).resolves.toEqual({ claimed: 1, delivered: 1, failed: 0, dead: 0 });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/api/v1/internal/audit-logs");
    expect(fetchMock.mock.calls[0][1].headers["Idempotency-Key"]).toBe("audit-outbox:1");
    const finalSql = pool.query.mock.calls[0][0] as string;
    expect(finalSql).toContain("status = 'delivered'");
    expect(finalSql).toContain("lease_token = $2::uuid"); // stale 워커 덮어쓰기 방지
  });

  it("v2 5xx → failed(백오프, 미소진)", async () => {
    const client = makeClaimClient([row({ attempts: 1 })]);
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    getPool.mockReturnValue(pool);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("err", { status: 500 })));

    await expect(processAuditOutbox()).resolves.toEqual({ claimed: 1, delivered: 0, failed: 1, dead: 0 });
    expect(pool.query.mock.calls[0][1]).toEqual(expect.arrayContaining(["1", "failed"]));
  });

  it("max_attempts 소진 시 dead 로 격리(조용한 유실 금지)", async () => {
    const client = makeClaimClient([row({ attempts: 9, max_attempts: 10 })]);
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    getPool.mockReturnValue(pool);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("socket")));

    await expect(processAuditOutbox()).resolves.toEqual({ claimed: 1, delivered: 0, failed: 0, dead: 1 });
    expect(pool.query.mock.calls[0][1]).toEqual(expect.arrayContaining(["1", "dead"]));
  });

  it("v2 미설정이면 삼키지 않고 failed 로 남긴다(감사 유실 금지)", async () => {
    delete process.env.V2_INTERNAL_BASE_URL;
    const client = makeClaimClient([row({ attempts: 0 })]);
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    getPool.mockReturnValue(pool);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(processAuditOutbox()).resolves.toEqual({ claimed: 1, delivered: 0, failed: 1, dead: 0 });
    expect(fetchMock).not.toHaveBeenCalled(); // 미설정이라 HTTP 시도 없음
    expect(pool.query.mock.calls[0][1]).toEqual(expect.arrayContaining(["1", "failed"]));
  });

  it("클레임 행 없으면 no-op(HTTP 미발생)", async () => {
    const client = makeClaimClient([]);
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };
    getPool.mockReturnValue(pool);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(processAuditOutbox()).resolves.toEqual({ claimed: 0, delivered: 0, failed: 0, dead: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
