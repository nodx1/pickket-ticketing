/**
 * Owner 발송 복구 라우트 회귀 — 레벨2 컷오버 W5-MSG(원장 v2 이관) 이후 계약.
 *
 * 고정하는 것:
 *   ① go DB 에 message_deliveries / _attempts / _operator_actions 를 쓰지 않는다(원장 v2 단일).
 *   ② 클라이언트 Idempotency-Key 를 **그대로** v2 operation_key 로 넘긴다(안정 멱등키).
 *      여기서 새 UUID 를 만들면 같은 조작이 두 번 기록되고 상태가 두 번 전이된다.
 *   ③ 감사는 v2 전이 **성공 후** audit_outbox 에 적재(dedup_key = operationKey).
 *   ④ 감사 적재 실패는 200(상태는 이미 바뀌었다) — 500 으로 위장해 재조작을 유도하지 않는다.
 *   ⑤ CSRF/동일출처 게이트는 v2 호출 **전에** 막는다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class V2MessagingLedgerError extends Error {
    status?: number;
    constructor(message: string, status?: number) {
      super(message);
      this.name = "V2MessagingLedgerError";
      this.status = status;
    }
  }
  return {
    query: vi.fn(),
    // 모듈 import 시점에 호출되므로 clearAllMocks 영향을 받지 않도록 배열로 수집한다.
    roles: [] as string[],
    runAction: vi.fn(),
    getDetail: vi.fn(),
    V2MessagingLedgerError,
  };
});

vi.mock("@/lib/auth/permissions", () => ({
  withRole: (role: string, handler: unknown) => {
    h.roles.push(role);
    return async (request: NextRequest, context: { params: Promise<unknown>; session: typeof session }) =>
      (handler as (req: NextRequest, ctx: unknown) => Promise<Response>)(request, {
        session: context.session,
        params: await context.params,
      });
  },
}));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.query }) }));
vi.mock("@/lib/v2/messaging-ledger-client", () => ({
  runDeliveryOperatorAction: h.runAction,
  getDeliveryDetail: h.getDetail,
  V2MessagingLedgerError: h.V2MessagingLedgerError,
  ledgerErrorStatus: (err: { status?: number }) => (err.status === 404 ? 404 : 503),
}));

import { NextRequest } from "next/server";
import { POST } from "./[deliveryId]/route";

const session = { id: "owner-1", accountId: "account-1", role: "owner" };

function request(body: unknown, key = "op-1") {
  return new NextRequest("https://go.pickket.kr/api/admin/message-deliveries/d1", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "idempotency-key": key,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

const invoke = (req: NextRequest) =>
  (POST as unknown as (r: NextRequest, ctx: unknown) => Promise<Response>)(req, {
    params: Promise.resolve({ deliveryId: "d1" }),
    session,
  });

const okResult = {
  delivery_id: "d1",
  action: "confirm_sent",
  previous_status: "unknown",
  status: "sent",
  parent_status: "sent",
  requeued: false,
};

describe("owner delivery recovery route (v2 원장)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.query.mockResolvedValue({ rows: [], rowCount: 1 });
    h.runAction.mockResolvedValue(okResult);
  });

  it("owner 권한 + v2 위임 + 감사 아웃박스 적재, go 원장 SQL 0", async () => {
    const response = await invoke(
      request({
        action: "confirm_sent",
        reason: "provider console confirms acceptance",
        providerRequestId: "req-1",
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("sent");
    expect(h.roles).toContain("owner");

    // ② 안정 멱등키 — 클라이언트가 준 키가 그대로 전달돼야 한다.
    expect(h.runAction).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account-1",
        actorId: "owner-1",
        deliveryId: "d1",
        operationKey: "op-1",
        action: "confirm_sent",
        providerRequestId: "req-1",
      }),
    );

    // ① go 원장 write 0 — audit_outbox 만 남는다.
    const sqls = h.query.mock.calls.map(([sql]) => String(sql));
    expect(sqls.some((sql) => sql.includes("INSERT INTO audit_outbox"))).toBe(true);
    expect(sqls.some((sql) => sql.includes("message_delivery_operator_actions"))).toBe(false);
    expect(sqls.some((sql) => sql.includes("message_delivery_attempts"))).toBe(false);
    expect(sqls.some((sql) => sql.includes("UPDATE message_deliveries"))).toBe(false);
    expect(sqls.some((sql) => sql.includes("INSERT INTO audit_logs"))).toBe(false);
    // ③ dedup_key = operationKey (재시도 double-enqueue 차단)
    expect(h.query.mock.calls[0]?.[1]).toContain("message-delivery:account-1:op-1");
  });

  it("④ 감사 적재 실패해도 200 — 상태는 이미 v2 에서 바뀌었다", async () => {
    h.query.mockRejectedValue(new Error("audit_outbox down"));
    const response = await invoke(
      request({ action: "manual_review", reason: "operator review pending" }, "op-2"),
    );
    expect(response.status).toBe(200);
  });

  it("v2 원장 장애는 503 — 400/500 입력오류로 위장하지 않는다", async () => {
    h.runAction.mockRejectedValue(new h.V2MessagingLedgerError("ledger unreachable"));
    const response = await invoke(
      request({ action: "manual_review", reason: "operator review pending" }, "op-3"),
    );
    expect(response.status).toBe(503);
    expect(h.query).not.toHaveBeenCalled();
  });

  it("v2 409(상태 불일치·키 재사용)는 409 로 그대로 전달", async () => {
    h.runAction.mockRejectedValue(new h.V2MessagingLedgerError("action not allowed", 409));
    const response = await invoke(
      request({ action: "resend", reason: "retry after failure confirmed" }, "op-4"),
    );
    expect(response.status).toBe(409);
  });

  it("⑤ 동일출처 증명 없는 쿠키 인증은 v2 호출 전에 403", async () => {
    const req = new NextRequest("https://go.pickket.kr/api/admin/message-deliveries/d1", {
      method: "POST",
      headers: {
        cookie: "pickket_access=opaque",
        "idempotency-key": "op-csrf",
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "manual_review", reason: "operator review" }),
    });
    const response = await invoke(req);
    expect(response.status).toBe(403);
    expect(h.runAction).not.toHaveBeenCalled();
    expect(h.query).not.toHaveBeenCalled();
  });

  it("Idempotency-Key 누락은 400 — 멱등 없는 상태 전이를 허용하지 않는다", async () => {
    const req = new NextRequest("https://go.pickket.kr/api/admin/message-deliveries/d1", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ action: "manual_review", reason: "operator review" }),
    });
    const response = await invoke(req);
    expect(response.status).toBe(400);
    expect(h.runAction).not.toHaveBeenCalled();
  });
});
