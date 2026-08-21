import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logAudit } from "./audit";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  process.env.V2_INTERNAL_BASE_URL = "https://v2.test";
  process.env.GO_WEBHOOK_SECRET = "test-secret";
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env = { ...OLD_ENV };
});

describe("logAudit — v2 프록시", () => {
  it("go 필드를 snake_case body 로 v2 audit-logs 에 POST", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, id: "a1" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await logAudit({
      userId: "u1",
      accountId: "acc1",
      action: "refund.approve" as never,
      tableName: "orders",
      recordId: "o1",
      changes: { amount: 1000 },
      ipAddress: "1.2.3.4",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call?.[0]).toContain("/api/v1/internal/audit-logs");
    expect(call?.[1]?.method).toBe("POST");
    const body = JSON.parse(call?.[1]?.body as string);
    expect(body.action).toBe("refund.approve");
    expect(body.table_name).toBe("orders");
    expect(body.user_id).toBe("u1");
    expect(body.account_id).toBe("acc1");
    expect(body.record_id).toBe("o1");
    expect(body.changes).toEqual({ amount: 1000 });
    const headers = call?.[1]?.headers as Record<string, string>;
    expect(headers["X-Pickket-Signature"]).toMatch(/^[a-f0-9]{64}$/);
  });

  it("v2 실패(fetch throw)해도 상위 트랜잭션을 깨지 않는다(swallow)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("socket closed"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      logAudit({
        userId: "u1",
        accountId: "acc1",
        action: "x" as never,
        tableName: "t",
      }),
    ).resolves.toBeUndefined();
  });

  it("미설정이면 발송 스킵(에러 없이 반환)", async () => {
    delete process.env.V2_INTERNAL_BASE_URL;
    delete process.env.GO_WEBHOOK_SECRET;
    delete process.env.V2_EVENT_SYNC_SECRET;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await logAudit({ userId: null, accountId: null, action: "x" as never, tableName: "t" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
