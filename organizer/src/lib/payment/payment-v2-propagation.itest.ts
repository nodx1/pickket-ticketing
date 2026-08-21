import { describe, expect, it, beforeAll, beforeEach, afterAll, vi } from "vitest";

/**
 * T8 — 보고서 2장의 "실패 시 status code" 표를 **실행으로** 검증한다.
 *
 * 종전 근거는 전부 코드 리딩이었다. 여기서는
 *   · go 는 **실 PostgreSQL**(제약·트랜잭션 실동작)
 *   · v2 는 **실 HTTP 스텁**(commerce-client 의 상태코드→예외 매핑이 실제로 실행됨)
 * 로 돌린다. 모킹은 **Toss(실돈 외부호출)와 인증** 두 곳뿐이다.
 *
 * 검증 경로:
 *   ① v2 앵커 없음 → 409 (관리자 보상 확정)
 *   ② provider 성공 + v2 전파 실패 → manual_review, go 는 refunded 가 **아님**
 *   ③ 관리자 보상 v2 선전파 실패 → 502, go 미확정
 */

// ── Toss: 실돈 외부호출이라 스텁한다(이 경로만) ────────────────────────────────
const toss = vi.hoisted(() => ({
  cancel: vi.fn(),
  getPayment: vi.fn(),
}));
vi.mock("@/lib/payment/toss", () => ({
  tossProvider: { cancel: toss.cancel },
  getTossPaymentByPaymentKey: toss.getPayment,
}));
// ── 인증: T8 의 대상이 아니다. 세션만 주입하고 라우트 본문을 실행시킨다 ────────
vi.mock("@/lib/auth/permissions", () => ({
  withRole: (_role: string, handler: unknown) => (request: Request, ctx: unknown) =>
    (handler as (r: Request, c: unknown) => Promise<Response>)(request, ctx),
}));
vi.mock("@/lib/auth/withAuth", () => ({
  withAuth: (handler: unknown) => (request: Request, ctx: unknown) =>
    (handler as (r: Request, c: unknown) => Promise<Response>)(request, ctx),
}));
vi.mock("@/lib/payment/payment-alert", () => ({ alertPaymentManualReview: vi.fn() }));

import { getPool } from "@/lib/db/pool";
import {
  resetTables, seedOrder, readOrder, readCompensation, readOutbox,
  startV2Stub, useV2Stub, verifyStubSignature, type V2Stub,
} from "@/test/itest-harness";
import { processExpiredPaymentCompensations } from "@/lib/payment/compensation";
import { processPaymentConfirmOutbox } from "@/lib/payment/confirm-outbox";
import { POST as adminPost } from "@/app/api/admin/payment-compensations/[actionId]/route";

let stub: V2Stub;
let restoreEnv: () => void;

beforeAll(async () => {
  stub = await startV2Stub();
  restoreEnv = useV2Stub(stub);
});
afterAll(async () => {
  restoreEnv();
  await stub.close();
  await getPool().end().catch(() => undefined);
});
beforeEach(async () => {
  await resetTables();
  stub.routes.length = 0;
  stub.calls.length = 0;
  vi.clearAllMocks();
});

const ACTOR_ID = crypto.randomUUID();
const REFUND_PATH = /^\/api\/v1\/internal\/orders\/[^/]+\/refund$/;

async function seedCompensation(opts: {
  v2OrderId: string | null;
  orderId: string;
  accountId: string;
  status?: string;
  amount?: number;
}): Promise<string> {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO payment_compensation_actions
       (order_id, v2_order_id, action, reason, requested_amount, requested_refund_amount, status,
        provider_name, provider_payment_key, idempotency_key, next_attempt_at)
     VALUES ($1,$2,'refund','payment_confirmed_after_order_expired',$3,$3,$4,
             'toss','tviva-itest-key',$5, NOW())
     RETURNING id`,
    // account_id 컬럼은 이 테이블에 없다 — 테넌트 스코프는 orders 경유(T8 에서 확인된 실결함).
    [opts.orderId, opts.v2OrderId, opts.amount ?? 15000,
      opts.status ?? "pending", `itest-${crypto.randomUUID()}`],
  );
  return rows[0].id;
}

function adminRequest(body: unknown) {
  return new Request("https://go.pickket.kr/api/admin/payment-compensations/x", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer itest-token",
      "idempotency-key": `itest-${crypto.randomUUID()}`,
    },
    body: JSON.stringify(body),
  });
}

const callAdmin = (actionId: string, accountId: string, body: unknown) =>
  (adminPost as unknown as (r: Request, c: unknown) => Promise<Response>)(
    adminRequest(body),
    { session: { id: ACTOR_ID, accountId, role: "owner" }, params: { actionId } },
  );

describe("T8-① 관리자 확정 — v2 앵커 없음", () => {
  it("409 를 돌려주고 go 상태를 바꾸지 않는다", async () => {
    const seeded = await seedOrder();
    const actionId = await seedCompensation({
      orderId: seeded.orderId, accountId: seeded.accountId,
      v2OrderId: null, status: "unknown",
    });

    const res = await callAdmin(actionId, seeded.accountId, {
      action: "confirm_completed", reason: "운영자 확정 테스트 사유", providerRefundId: "tx-operator",
    });

    expect(res.status).toBe(409);
    const after = await readCompensation(actionId);
    expect(after.status).toBe("unknown");        // completed 로 넘어가지 않는다
    expect(after.completed_at).toBeNull();
    // v2 는 애초에 호출되지 않아야 한다(앵커가 없으므로 보낼 대상이 없다).
    expect(stub.calls.filter((c) => REFUND_PATH.test(c.path))).toHaveLength(0);
  });
});

describe("T8-③ 관리자 확정 — v2 선전파 실패", () => {
  it("502 + manual_review 로 남고 go 는 completed 가 되지 않는다", async () => {
    const seeded = await seedOrder();
    const actionId = await seedCompensation({
      orderId: seeded.orderId, accountId: seeded.accountId,
      v2OrderId: seeded.v2OrderId, status: "unknown",
    });
    // v2 가 5xx — commerce-client 는 재시도 후 V2CommerceError 를 던진다.
    stub.routes.push({ method: "POST", pathPattern: REFUND_PATH, status: 503 });

    const res = await callAdmin(actionId, seeded.accountId, {
      action: "confirm_completed", reason: "운영자 확정 테스트 사유", providerRefundId: "tx-operator",
    });

    expect(res.status).toBe(502);
    const after = await readCompensation(actionId);
    expect(after.status).toBe("manual_review");
    expect(after.manual_review_reason).toBe("v2_propagation_failed");
    expect(after.completed_at).toBeNull();
    // v2 를 실제로 때렸는지(=코드가 아니라 실행으로 확인)
    expect(stub.calls.filter((c) => REFUND_PATH.test(c.path)).length).toBeGreaterThan(0);
  });

  it("v2 선전파가 성공하면 completed 로 확정된다", async () => {
    const seeded = await seedOrder();
    const actionId = await seedCompensation({
      orderId: seeded.orderId, accountId: seeded.accountId,
      v2OrderId: seeded.v2OrderId, status: "unknown",
    });
    stub.routes.push({
      method: "POST", pathPattern: REFUND_PATH, status: 200,
      data: { order_id: seeded.v2OrderId, status: "refunded", refunded: 15000, total_refunded: 15000, seats_released: 1 },
    });

    const res = await callAdmin(actionId, seeded.accountId, {
      action: "confirm_completed", reason: "운영자 확정 테스트 사유", providerRefundId: "tx-operator",
    });

    expect(res.status).toBe(200);
    expect((await readCompensation(actionId)).status).toBe("completed");
    // 🔴 여기가 비어 있어서 "v2 선전파를 통째로 지워도" 이 테스트가 통과했다(뮤테이션 실증).
    //    성공했다는 사실만으로는 v2 가 반영됐는지 알 수 없다 — 호출 자체를 단언한다.
    const refundCalls = stub.calls.filter((c) => REFUND_PATH.test(c.path) && c.method === "POST");
    expect(refundCalls).toHaveLength(1);
    // 멱등키는 워커와 동일해야 한다 — 달라지면 재시도 시 **이중 환불**이 난다.
    expect(refundCalls[0].headers["idempotency-key"]).toBe(`payment-compensation:${actionId}`);
    // HMAC 서명이 실제로 유효한가(스텁은 검증하지 않으므로 여기서 검산한다).
    expect(verifyStubSignature(refundCalls[0])).toEqual({ ok: true });
  });
});

describe("T8-② 드레인 — provider 성공 + v2 전파 실패", () => {
  it("manual_review 로 고정되고 go 주문은 refunded 가 되지 않는다", async () => {
    const seeded = await seedOrder({ orderStatus: "expired" });
    const actionId = await seedCompensation({
      orderId: seeded.orderId, accountId: seeded.accountId,
      v2OrderId: seeded.v2OrderId, status: "pending",
    });
    // Toss: 취소 성공(실돈 나감)
    toss.getPayment
      .mockResolvedValueOnce({ status: "DONE", cancels: [], lastTransactionKey: "tx-before" })
      .mockResolvedValueOnce({ status: "CANCELED", cancels: [{ cancelAmount: 15000 }], lastTransactionKey: "tx-after" });
    toss.cancel.mockResolvedValue({ success: true, cancelAmount: 15000 });
    // v2: 환불 전파 실패
    stub.routes.push({ method: "POST", pathPattern: REFUND_PATH, status: 503 });

    const summary = await processExpiredPaymentCompensations(10);

    expect(summary.manualReview).toBe(1);
    expect(summary.completed).toBe(0);
    const after = await readCompensation(actionId);
    expect(after.status).toBe("manual_review");
    expect(after.manual_review_reason).toBe("v2_propagation_failed");
    // 🔴 provider 환불 id 가 보존돼야 한다 — 실돈 추적의 유일한 단서.
    expect(after.provider_refund_id).toBe("tx-after");
    // 🔴 go 를 환불로 투영하면 v2(=confirmed)와 발산한다. 상태·결제상태 **둘 다** 그대로여야 한다.
    const order = await readOrder(seeded.orderId);
    expect(order.status).toBe("expired");
    expect(order.payment_status).not.toBe("refunded");
  });

  it("v2 전파까지 성공하면 completed + go 주문 refunded 투영", async () => {
    const seeded = await seedOrder({ orderStatus: "expired" });
    const actionId = await seedCompensation({
      orderId: seeded.orderId, accountId: seeded.accountId,
      v2OrderId: seeded.v2OrderId, status: "pending",
    });
    toss.getPayment
      .mockResolvedValueOnce({ status: "DONE", cancels: [], lastTransactionKey: "tx-before" })
      .mockResolvedValueOnce({ status: "CANCELED", cancels: [{ cancelAmount: 15000 }], lastTransactionKey: "tx-after" });
    toss.cancel.mockResolvedValue({ success: true, cancelAmount: 15000 });
    stub.routes.push({
      method: "POST", pathPattern: REFUND_PATH, status: 200,
      data: { order_id: seeded.v2OrderId, status: "refunded", refunded: 15000, total_refunded: 15000, seats_released: 1 },
    });

    const summary = await processExpiredPaymentCompensations(10);

    expect(summary.completed).toBe(1);
    expect((await readCompensation(actionId)).status).toBe("completed");
    // 만료 주문의 환불 투영은 status 가 아니라 payment_status 에 수렴한다
    // (projectRefundedOrder 레거시 경로 — 상태 전이는 만료 시점에 이미 끝났다).
    const order = await readOrder(seeded.orderId);
    expect(order.status).toBe("expired");
    expect(order.payment_status).toBe("refunded");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T9 — 아웃박스 종결 감지
// ═══════════════════════════════════════════════════════════════════════════════

const ORDER_GET_PATH = /^\/api\/v1\/internal\/orders\/[^/?]+$/;
const CONFIRM_PATH = /^\/api\/v1\/internal\/orders\/[^/]+\/confirm-payment$/;

async function seedOutbox(orderId: string, v2OrderId: string, amount = 15000) {
  await getPool().query(
    `INSERT INTO payment_confirm_outbox (order_id, v2_order_id, amount, status, attempts, next_retry_at)
     VALUES ($1,$2,$3,'pending',0, NOW())`,
    [orderId, v2OrderId, amount],
  );
}

describe("T9 아웃박스 종결 감지", () => {
  it("🔴 v2 주문이 refunded 면 confirm 을 시도하지 않고 superseded 로 닫는다", async () => {
    const seeded = await seedOrder({ orderStatus: "completed" });
    await seedOutbox(seeded.orderId, seeded.v2OrderId);
    stub.routes.push({
      method: "GET", pathPattern: ORDER_GET_PATH, status: 200,
      // 실제 v2 계약(internal_commerce_read._order_detail_response): order_id / status(go 투영) /
      // status_v2(v2 원본). 예전 스텁은 `id`+`status` 라 **주 분기(status_v2)가 한 번도 실행되지
      // 않았다** — 폴백만 검증되고 있었다(재검수 지적).
      data: { order_id: seeded.v2OrderId, status: "refunded", status_v2: "refunded",
              total_refunded: 15000, tickets: [] },
    });
    // confirm 라우트는 정의하지 않는다 — 호출되면 스텁이 501 을 주고 confirmed 가 될 수 없다.

    const summary = await processPaymentConfirmOutbox(10);

    expect(summary.superseded).toBe(1);
    expect(summary.confirmed).toBe(0);
    expect(summary.failed).toBe(0);
    expect(summary.manualReview).toBe(0);          // 🔴 정상 취소가 실패 큐를 오염시키지 않는다
    const row = await readOutbox(seeded.orderId);
    expect(row.status).toBe("superseded");          // 🔴 confirmed 위장도, failed 오염도 아니다
    expect(row.last_error).toBe("v2_order_terminal:refunded");
    expect(row.confirmed_at).toBeNull();
    // confirm 을 아예 부르지 않았는가
    expect(stub.calls.filter((c) => CONFIRM_PATH.test(c.path))).toHaveLength(0);
  });

  it("종결 처리된 행은 다음 드레인이 다시 집지 않는다(재시도 중단)", async () => {
    const seeded = await seedOrder({ orderStatus: "completed" });
    await seedOutbox(seeded.orderId, seeded.v2OrderId);
    stub.routes.push({
      method: "GET", pathPattern: ORDER_GET_PATH, status: 200,
      data: { order_id: seeded.v2OrderId, status: "cancelled", status_v2: "cancelled", tickets: [] },
    });
    await processPaymentConfirmOutbox(10);

    const second = await processPaymentConfirmOutbox(10);

    expect(second.claimed).toBe(0);
    expect((await readOutbox(seeded.orderId)).status).toBe("superseded");
  });

  it("종결이 아니면 기존 confirm 경로 그대로 — confirmed 로 수렴", async () => {
    const seeded = await seedOrder({ orderStatus: "completed" });
    await seedOutbox(seeded.orderId, seeded.v2OrderId);
    stub.routes.push({
      method: "GET", pathPattern: ORDER_GET_PATH, status: 200,
      data: { order_id: seeded.v2OrderId, status: "pending", status_v2: "payment_required", tickets: [] },
    });
    stub.routes.push({
      method: "POST", pathPattern: CONFIRM_PATH, status: 200,
      // confirm-payment 실제 응답은 {order_id, status, already} — captured_at 이 아니다.
      data: { order_id: seeded.v2OrderId, status: "confirmed", already: false },
    });

    const summary = await processPaymentConfirmOutbox(10);

    expect(summary.confirmed).toBe(1);
    expect(summary.superseded).toBe(0);
    const row = await readOutbox(seeded.orderId);
    expect(row.status).toBe("confirmed");
    expect(row.last_error).toBeNull();
  });

  it("선확인(getOrder)이 실패해도 기존 confirm 경로로 진행한다(새 실패원인 금지)", async () => {
    const seeded = await seedOrder({ orderStatus: "completed" });
    await seedOutbox(seeded.orderId, seeded.v2OrderId);
    stub.routes.push({ method: "GET", pathPattern: ORDER_GET_PATH, status: 503 });
    stub.routes.push({
      method: "POST", pathPattern: CONFIRM_PATH, status: 200,
      data: { order_id: seeded.v2OrderId, status: "confirmed", already: true },
    });

    const summary = await processPaymentConfirmOutbox(10);

    expect(summary.confirmed).toBe(1);
    expect((await readOutbox(seeded.orderId)).status).toBe("confirmed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// T10 — 보상경로 입장 게이트
// ═══════════════════════════════════════════════════════════════════════════════

describe("T10 보상 드레인 — 입장한 티켓", () => {
  it("🔴 입장 이력이 있으면 provider 를 부르지 않고 ticket_already_admitted 로 남긴다", async () => {
    const seeded = await seedOrder({ orderStatus: "expired" });
    const actionId = await seedCompensation({
      orderId: seeded.orderId, accountId: seeded.accountId,
      v2OrderId: seeded.v2OrderId, status: "pending",
    });
    stub.routes.push({
      method: "GET", pathPattern: ORDER_GET_PATH, status: 200,
      data: {
        order_id: seeded.v2OrderId, status: "completed", status_v2: "confirmed",
        tickets: [
          { ticket_id: "tk1", status: "used", checked_in_at: "2026-07-28T01:00:00Z" },
          { ticket_id: "tk2", status: "active", checked_in_at: null },
        ],
      },
    });

    const summary = await processExpiredPaymentCompensations(10);

    expect(summary.manualReview).toBe(1);
    const after = await readCompensation(actionId);
    expect(after.status).toBe("manual_review");
    // 🔴 v2_propagation_failed 와 섞이면 운영자가 "v2 장애"로 오해한다.
    expect(after.manual_review_reason).toBe("ticket_already_admitted");
    // 🔴 실돈이 나가지 않았는가 — provider 취소 미호출 + 환불 id 없음.
    expect(toss.cancel).not.toHaveBeenCalled();
    expect(after.provider_refund_id).toBeNull();
    // go 주문도 그대로여야 한다.
    expect((await readOrder(seeded.orderId)).payment_status).not.toBe("refunded");
  });

  it("입장 이력이 없으면 기존 경로 그대로 — provider 취소 후 완료", async () => {
    const seeded = await seedOrder({ orderStatus: "expired" });
    const actionId = await seedCompensation({
      orderId: seeded.orderId, accountId: seeded.accountId,
      v2OrderId: seeded.v2OrderId, status: "pending",
    });
    stub.routes.push({
      method: "GET", pathPattern: ORDER_GET_PATH, status: 200,
      data: {
        order_id: seeded.v2OrderId, status: "completed", status_v2: "confirmed",
        tickets: [{ ticket_id: "tk1", status: "active", checked_in_at: null }],
      },
    });
    toss.getPayment
      .mockResolvedValueOnce({ status: "DONE", cancels: [], lastTransactionKey: "tx-before" })
      .mockResolvedValueOnce({ status: "CANCELED", cancels: [{ cancelAmount: 15000 }], lastTransactionKey: "tx-after" });
    toss.cancel.mockResolvedValue({ success: true, cancelAmount: 15000 });
    stub.routes.push({
      method: "POST", pathPattern: REFUND_PATH, status: 200,
      data: { order_id: seeded.v2OrderId, status: "refunded", refunded: 15000, total_refunded: 15000, seats_released: 1 },
    });

    const summary = await processExpiredPaymentCompensations(10);

    expect(summary.completed).toBe(1);
    expect(toss.cancel).toHaveBeenCalledTimes(1);
    expect((await readCompensation(actionId)).status).toBe("completed");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 읽기 경로 — 재검수에서 드러난 구멍
//
// 기존 통합테스트는 [actionId]/route.ts 에서 **POST 만** import 했다. 그래서 같은 파일의
// GET 이 괄호 불균형(42601) + 미바인딩 alias 로 **한 번도 파싱된 적이 없는데도** 초록이었다.
// 목록·summary 라우트도 어느 테스트에서도 import 되지 않았다.
// ⟹ 실 PG 에 대해 실제로 실행해 SQL 이 파싱·실행되는지 자체를 고정한다.
// ═══════════════════════════════════════════════════════════════════════════════

describe("관리자 보상 읽기 경로 — SQL 이 실제로 실행되는가", () => {
  const callGet = async (actionId: string, accountId: string) => {
    const { GET } = await import("@/app/api/admin/payment-compensations/[actionId]/route");
    return (GET as unknown as (r: Request, c: unknown) => Promise<Response>)(
      new Request("https://go.pickket.kr/api/admin/payment-compensations/x"),
      { session: { id: ACTOR_ID, accountId, role: "owner" }, params: { actionId } },
    );
  };

  it("GET 상세 — 200 + operator_actions 집계", async () => {
    const seeded = await seedOrder();
    const actionId = await seedCompensation({
      orderId: seeded.orderId, accountId: seeded.accountId,
      v2OrderId: seeded.v2OrderId, status: "manual_review",
    });

    const res = await callGet(actionId, seeded.accountId);

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.id).toBe(actionId);
    expect(body.data.account_id).toBe(seeded.accountId);
    // 운영자 조작이 없으면 빈 배열이어야 한다(COALESCE 기본값이 실제로 동작하는지).
    expect(body.data.operator_actions).toEqual([]);
  });

  it("GET 상세 — 타 계정의 actionId 는 404 (테넌트 격리)", async () => {
    const mine = await seedOrder();
    const theirs = await seedOrder();
    const theirAction = await seedCompensation({
      orderId: theirs.orderId, accountId: theirs.accountId,
      v2OrderId: theirs.v2OrderId, status: "manual_review",
    });

    expect((await callGet(theirAction, mine.accountId)).status).toBe(404);
  });

  it("목록 — 내 계정 행만 돌려준다", async () => {
    const mine = await seedOrder();
    const theirs = await seedOrder();
    await seedCompensation({
      orderId: mine.orderId, accountId: mine.accountId,
      v2OrderId: mine.v2OrderId, status: "unknown",
    });
    await seedCompensation({
      orderId: theirs.orderId, accountId: theirs.accountId,
      v2OrderId: theirs.v2OrderId, status: "unknown",
    });

    const { GET } = await import("@/app/api/admin/payment-compensations/route");
    const res = await (GET as unknown as (r: Request, c: unknown) => Promise<Response>)(
      new Request("https://go.pickket.kr/api/admin/payment-compensations?status=unknown"),
      { session: { id: ACTOR_ID, accountId: mine.accountId, role: "owner" } },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].order_id).toBe(mine.orderId);
  });

  it("recovery-summary — SQL 이 실행되고 내 계정만 센다", async () => {
    const mine = await seedOrder();
    const theirs = await seedOrder();
    await seedCompensation({
      orderId: mine.orderId, accountId: mine.accountId,
      v2OrderId: mine.v2OrderId, status: "manual_review",
    });
    await seedCompensation({
      orderId: theirs.orderId, accountId: theirs.accountId,
      v2OrderId: theirs.v2OrderId, status: "manual_review",
    });

    // 이 라우트는 v2 발송원장에도 물어본다. 스텁하지 않으면 라우트가 fail-closed 로 503 을
    // 내는데(설계대로), 그러면 정작 검증하려던 go SQL 이 실행되지 않는다.
    stub.routes.push({
      method: "POST",   // 발송원장 클라이언트는 GET 이 아니라 POST 로 조회한다
      pathPattern: /^\/api\/v1\/internal\/messaging\/deliveries\/recovery-summary/,
      status: 200,
      data: { queued: 0, failed: 0, dead_letter: 0, oldest_age_seconds: null },
    });
    const { GET } = await import("@/app/api/admin/ops/recovery-summary/route");
    const res = await (GET as unknown as (r: Request, c: unknown) => Promise<Response>)(
      new Request("https://go.pickket.kr/api/admin/ops/recovery-summary"),
      { session: { id: ACTOR_ID, accountId: mine.accountId, role: "owner" } },
    );

    expect(res.status).toBe(200);
  });
});

describe("T18 보상 드레인 — v2-provider 경로의 입장거절", () => {
  it("🔴 v2 refundOrder 422(입장이력)가 failed 종착역이 아니라 manual_review 로 간다", async () => {
    const seeded = await seedOrder({ orderStatus: "expired" });
    // provider_name='v2' — Toss 가 아니라 v2 refundOrder 를 직접 부르는 경로.
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO payment_compensation_actions
         (order_id, v2_order_id, action, reason, requested_amount, requested_refund_amount,
          status, provider_name, idempotency_key, next_attempt_at)
       VALUES ($1,$2,'refund','payment_confirmed_after_order_expired',15000,15000,
               'pending','v2',$3, NOW())
       RETURNING id`,
      [seeded.orderId, seeded.v2OrderId, `itest-${crypto.randomUUID()}`],
    );
    const actionId = rows[0].id;
    // 입장 게이트 선확인은 통과시키고(미입장으로 보이게), v2 가 환불 시점에 422 로 거절하는 상황.
    // (게이트와 v2 판정이 어긋나는 실제 경합 — 게이트 조회 후 입장이 일어난 경우)
    stub.routes.push({
      method: "GET", pathPattern: ORDER_GET_PATH, status: 200,
      data: { order_id: seeded.v2OrderId, status: "completed", status_v2: "confirmed",
              tickets: [{ ticket_id: "tk1", status: "active", checked_in_at: null }] },
    });
    stub.routes.push({
      method: "POST", pathPattern: REFUND_PATH, status: 422,
      errorBody: JSON.stringify({ ok: false, error: {
        code: "TICKET_ALREADY_ADMITTED", message: "이미 입장한 티켓이 있어 환불할 수 없습니다" } }),
    });

    const summary = await processExpiredPaymentCompensations(10);

    expect(summary.manualReview).toBe(1);
    expect(summary.failed).toBe(0);   // 🔴 예전엔 여기가 1 이었고 아무도 보지 않았다
    const after = await readCompensation(actionId);
    expect(after.status).toBe("manual_review");
    expect(after.manual_review_reason).toBe("ticket_already_admitted");
    // provider 는 v2 자신이므로 실돈은 나가지 않았다.
    expect(toss.cancel).not.toHaveBeenCalled();
  });
});
