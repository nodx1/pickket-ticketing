import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPool, confirmOrderPayment, V2CommerceError, alertPaymentManualReview } = vi.hoisted(() => ({
  getPool: vi.fn(),
  confirmOrderPayment: vi.fn(),
  alertPaymentManualReview: vi.fn(),
  V2CommerceError: class V2CommerceError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
    }
  },
}));
vi.mock("@/lib/db/pool", () => ({ getPool }));
vi.mock("@/lib/v2/commerce-client", () => ({ confirmOrderPayment, V2CommerceError }));
vi.mock("@/lib/payment/payment-alert", () => ({ alertPaymentManualReview }));

import { processPaymentConfirmOutbox } from "@/lib/payment/confirm-outbox";

/** claim 트랜잭션 client(BEGIN, lease 회수, max소진 격리, SELECT claim, per-row UPDATE, COMMIT). */
function makeClaimClient(claimRows: unknown[]) {
  const query = vi.fn();
  // BEGIN
  query.mockResolvedValueOnce({});
  // stale lease 회수
  query.mockResolvedValueOnce({});
  // max_attempts 소진 격리 — RETURNING 이므로 rows/rowCount 를 준다(실제 드라이버 형태).
  //   `{}` 로 두면 코드가 rows 를 못 읽는데도 테스트가 통과할 수 있다(픽스처가 결함을 비껴감).
  query.mockResolvedValueOnce({ rows: [], rowCount: 0 });
  // SELECT ... FOR UPDATE SKIP LOCKED
  query.mockResolvedValueOnce({ rows: claimRows });
  // per-row mark-processing UPDATE (claimRows.length 개)
  for (let i = 0; i < claimRows.length; i++) query.mockResolvedValueOnce({});
  // COMMIT
  query.mockResolvedValueOnce({});
  return { release: vi.fn(), query };
}

describe("payment confirm outbox drain", () => {
  beforeEach(() => vi.clearAllMocks());

  it("claims a pending row and re-confirms with the stable idempotency key", async () => {
    const client = makeClaimClient([
      { order_id: "order-1", v2_order_id: "v2-1", amount: "1000", attempts: 0, max_attempts: 8 },
    ]);
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      query: vi.fn().mockResolvedValue({ rowCount: 1 }), // final confirmed UPDATE
    };
    getPool.mockReturnValue(pool);
    confirmOrderPayment.mockResolvedValue({ order_id: "v2-1", status: "confirmed", captured_at: null });

    await expect(processPaymentConfirmOutbox()).resolves.toEqual({
      claimed: 1,
      confirmed: 1,
      failed: 0,
      manualReview: 0,
      superseded: 0,
      sweptToManualReview: 0,
    });
    expect(confirmOrderPayment).toHaveBeenCalledWith(
      "v2-1",
      { amount: 1000 },
      { idempotencyKey: "pay-confirm:order-1" },
    );
    // 최종 confirmed UPDATE 는 lease_token 조건으로 stale 방지.
    const finalSql = pool.query.mock.calls[0][0] as string;
    expect(finalSql).toContain("status = 'confirmed'");
    expect(finalSql).toContain("lease_token = $2::uuid");
  });

  it("marks a row failed with backoff on a transient v2 error (not exhausted)", async () => {
    const client = makeClaimClient([
      { order_id: "order-2", v2_order_id: "v2-2", amount: "500", attempts: 1, max_attempts: 8 },
    ]);
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    getPool.mockReturnValue(pool);
    confirmOrderPayment.mockRejectedValue(new V2CommerceError("upstream 503", 503));

    await expect(processPaymentConfirmOutbox()).resolves.toEqual({
      claimed: 1,
      confirmed: 0,
      failed: 1,
      manualReview: 0,
      superseded: 0,
      sweptToManualReview: 0,
    });
    const sql = pool.query.mock.calls[0][0] as string;
    expect(sql).toContain("status = $2");
    expect(pool.query.mock.calls[0][1]).toEqual(
      expect.arrayContaining(["order-2", "failed"]),
    );
  });

  it("escalates to manual_review when the next attempt exhausts max_attempts", async () => {
    // attempts=7, max=8 → 이 시도(8회차)가 max 소진 → manual_review.
    const client = makeClaimClient([
      { order_id: "order-3", v2_order_id: "v2-3", amount: "2000", attempts: 7, max_attempts: 8 },
    ]);
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    getPool.mockReturnValue(pool);
    confirmOrderPayment.mockRejectedValue(new Error("still failing"));

    await expect(processPaymentConfirmOutbox()).resolves.toEqual({
      claimed: 1,
      confirmed: 0,
      failed: 0,
      manualReview: 1,
      superseded: 0,
      sweptToManualReview: 0,
    });
    expect(pool.query.mock.calls[0][1]).toEqual(
      expect.arrayContaining(["order-3", "manual_review"]),
    );
  });

  it("is a no-op when there are no pending rows (NICE/legacy has no outbox row)", async () => {
    const client = makeClaimClient([]);
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() };
    getPool.mockReturnValue(pool);

    await expect(processPaymentConfirmOutbox()).resolves.toEqual({
      claimed: 0,
      confirmed: 0,
      failed: 0,
      manualReview: 0,
      superseded: 0,
      sweptToManualReview: 0,
    });
    expect(confirmOrderPayment).not.toHaveBeenCalled();
  });
});

/**
 * T4 — `next_retry_at` NOT NULL(mig 224:28) 위반으로 **성공이 실패로 기록되던** 실결함.
 *
 * prod 실측: v2 confirm 성공(orders=confirmed, tickets=active) 후 성공기록 UPDATE 가
 * `next_retry_at = NULL` 로 23502 를 내고, catch 가 status 를 failed 로 뒤집었다.
 * ⟹ 확정된 주문이 영원한 재시도 대상이 되고 결국 manual_review 로 간다.
 */
describe("T4: 성공 기록이 NOT NULL 위반으로 실패로 뒤집히지 않는다", () => {
  beforeEach(() => vi.clearAllMocks());

  const row = { order_id: "order-t4", v2_order_id: "v2-t4", amount: "5000", attempts: 0, max_attempts: 8 };

  it("종결 상태 UPDATE 는 next_retry_at 에 NULL 을 쓰지 않는다(23502 원천 차단)", async () => {
    const client = makeClaimClient([row]);
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({ rowCount: 1 }) };
    getPool.mockReturnValue(pool);
    confirmOrderPayment.mockResolvedValue({ order_id: "v2-t4", status: "confirmed" });

    await expect(processPaymentConfirmOutbox()).resolves.toMatchObject({ confirmed: 1 });

    // 성공 경로
    const successSql = String(pool.query.mock.calls[0][0]);
    expect(successSql).toContain("status = 'confirmed'");
    expect(successSql).not.toContain("next_retry_at = NULL");
    // claim 트랜잭션의 max_attempts 격리 UPDATE(manual_review)도 마찬가지
    const claimSqls = client.query.mock.calls.map((c: unknown[]) => String(c[0]));
    const manualReviewSql = claimSqls.find((s: string) => s.includes("status = 'manual_review'"));
    expect(manualReviewSql).toBeDefined();
    expect(manualReviewSql).not.toContain("next_retry_at = NULL");
  });

  it("🔴 v2 확정 성공 후 로컬 기록이 실패해도 status 를 failed 로 뒤집지 않는다", async () => {
    const client = makeClaimClient([row]);
    const pool = {
      connect: vi.fn().mockResolvedValue(client),
      // 성공 기록 UPDATE 가 DB 제약 위반으로 터지는 상황(과거 23502 재현)
      query: vi.fn().mockRejectedValue(new Error('null value in column "next_retry_at" violates not-null constraint')),
    };
    getPool.mockReturnValue(pool);
    confirmOrderPayment.mockResolvedValue({ order_id: "v2-t4", status: "confirmed" });

    const summary = await processPaymentConfirmOutbox();
    // 실패로 계상하지 않는다(결제는 이미 확정됨).
    expect(summary).toMatchObject({ claimed: 1, confirmed: 0, failed: 0, manualReview: 0, superseded: 0 });
    // failed 로 기록하는 UPDATE 자체를 시도하지 않는다 → 다음 드레인에서 재시도(재confirm 은 멱등).
    const attemptedFailWrite = pool.query.mock.calls.some((c: unknown[]) => String(c[0]).includes("status = $2"));
    expect(attemptedFailWrite).toBe(false);
  });

  it("드레인 SELECT 는 종결 행을 status 조건으로 이미 제외한다(next_retry_at 값과 무관)", async () => {
    const client = makeClaimClient([]);
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn().mockResolvedValue({ rowCount: 0 }) };
    getPool.mockReturnValue(pool);

    await processPaymentConfirmOutbox();
    const selectSql = client.query.mock.calls.map((c: unknown[]) => String(c[0])).find((s: string) => s.includes("FOR UPDATE SKIP LOCKED"));
    expect(selectSql).toBeDefined();
    expect(selectSql).toContain("status IN ('pending', 'failed')");
  });
});


/**
 * 🔴 sweep 격리분 알림 회귀 — 2026-07-30.
 *
 * `attempts >= max_attempts` 인 행을 드레인 **루프 밖에서** manual_review 로 격리하는
 * sweep 이 있다. 그 행은 곧바로 claim 조건(`status IN ('pending','failed')`)에서 빠지므로
 * **루프 안의 alertPaymentManualReview 에 영원히 도달하지 않는다.**
 * 종전 주석은 "아래에서 알림" 이었지만 거짓이었고, 건수도 세지 않았다.
 *
 * prod 실측: 30,000원 1건이 manual_review 로 2일간 방치 — 통합DB 감사에서 처음 발견.
 * 이 경로에는 테스트가 **하나도 없었다**(그래서 조용히 삼켜졌다).
 */
function makeSweepClient(sweptRows: unknown[]) {
  const query = vi.fn();
  query.mockResolvedValueOnce({});                                    // BEGIN
  query.mockResolvedValueOnce({});                                    // stale lease 회수
  query.mockResolvedValueOnce({ rows: sweptRows, rowCount: sweptRows.length }); // sweep(RETURNING)
  query.mockResolvedValueOnce({ rows: [] });                          // claim SELECT — 없음
  query.mockResolvedValueOnce({});                                    // COMMIT
  return { release: vi.fn(), query };
}

describe("sweep 으로 격리된 manual_review", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    alertPaymentManualReview.mockReturnValue(undefined);
  });

  it("🔴 격리 건수를 요약에 담는다 — 세지 않으면 감시에 안 보인다", async () => {
    const client = makeSweepClient([
      { order_id: "o-1", v2_order_id: "v2-1", amount: 30000, attempts: 8, last_error: null },
    ]);
    getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client), query: vi.fn() });

    const summary = await processPaymentConfirmOutbox();
    expect(summary.sweptToManualReview).toBe(1);
    expect(summary.claimed).toBe(0); // 격리분은 claim 되지 않는다 = 루프 알림 미도달
  });

  it("🔴 격리된 행마다 알림을 보낸다 — 실돈 매출 누락 가능 건이 조용히 묻히지 않게", async () => {
    const client = makeSweepClient([
      { order_id: "o-1", v2_order_id: "v2-1", amount: 30000, attempts: 8, last_error: "STATE_TRANSITION_FORBIDDEN" },
      { order_id: "o-2", v2_order_id: null, amount: "12000", attempts: 8, last_error: null },
    ]);
    getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client), query: vi.fn() });

    const summary = await processPaymentConfirmOutbox();
    expect(summary.sweptToManualReview).toBe(2);
    expect(alertPaymentManualReview).toHaveBeenCalledTimes(2);
    expect(alertPaymentManualReview).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "confirm_outbox_sweep",
        orderId: "o-1",
        amount: 30000,
        reason: "STATE_TRANSITION_FORBIDDEN",
        attempts: 8,
      }),
    );
    // last_error 가 없으면 사유를 max_attempts_exceeded 로 채운다(빈 사유로 알리지 않는다).
    expect(alertPaymentManualReview).toHaveBeenCalledWith(
      expect.objectContaining({ orderId: "o-2", reason: "max_attempts_exceeded", amount: 12000 }),
    );
  });

  it("🔴 sweep 쿼리가 RETURNING 으로 신원을 받아온다 — 모킹이 못 잡는 자리", async () => {
    // ⚠️ 이 단언만 SQL **문자열**을 본다. 목은 쿼리 텍스트와 무관하게 rows 를 돌려주므로,
    //    `RETURNING` 을 지워도 위 알림 테스트들은 **전부 통과한다**(뮤테이션 C 생존 확인).
    //    실제로는 RETURNING 이 없으면 rows 가 비어 알림이 한 건도 나가지 않는다.
    //    ⟹ 모킹의 구조적 한계를 이 한 줄로 막는다. 컬럼을 바꾸면 여기서 걸리니
    //       그때 알림에 필요한 필드가 다 오는지 다시 확인할 것.
    const client = makeSweepClient([]);
    getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client), query: vi.fn() });
    await processPaymentConfirmOutbox();

    const sweepSql = String(client.query.mock.calls[2]?.[0] ?? "");
    expect(sweepSql).toContain("status = 'manual_review'");
    expect(sweepSql).toContain("RETURNING");
    for (const col of ["order_id", "v2_order_id", "amount", "attempts", "last_error"]) {
      expect(sweepSql).toContain(col);
    }
  });

  it("격리분이 없으면 알리지 않는다 — 매 tick 마다 빈 알림을 쏘지 않는다", async () => {
    const client = makeSweepClient([]);
    getPool.mockReturnValue({ connect: vi.fn().mockResolvedValue(client), query: vi.fn() });

    const summary = await processPaymentConfirmOutbox();
    expect(summary.sweptToManualReview).toBe(0);
    expect(alertPaymentManualReview).not.toHaveBeenCalled();
  });
});
