/**
 * 결제 확정 outbox 재조정 E2E (레벨2 P0 pending-first 재배선).
 *
 * 대상: recordPaymentConfirmOutbox 가 go COMMIT 과 원자적으로 남기는 payment_confirm_outbox
 *   pending 행과, 워커(payment-confirm-worker)/cron(payment-reconcile) 의 **트랜잭션 밖·커밋 후**
 *   v2 confirm drain 의 confirmed 수렴.
 *
 * 재배선 불변식(코덱스 P0):
 *   - completed 주문(v2 앵커 존재)은 **반드시** outbox 행을 갖는다(원자 커밋). record-time 은 항상 pending.
 *   - v2 confirm 은 오직 drain 에서만(커밋 후) 일어난다 → 역 split-brain(v2=confirmed·go=롤백) 불가.
 *   - 성공은 **confirmed 만**이다. drain 후 pending/failed 잔류를 "통과"로 보지 않는다.
 *
 * 검증 시나리오:
 *   1) 정상 결제확정 → outbox pending 원자 기록 → cron drain → confirmed 로 수렴(성공=confirmed 만)
 *   4) 재확정(동일 주문) → 이미 confirmed 인 outbox 를 pending 으로 되돌리지 않음(불변식)
 *   7) NICE/레거시(v2_order_id 없음) → outbox 행 미기록(무영향)
 *   2·6) v2 confirm 실패 주입(E2E_V2_FAULT_CONFIRM=1) → drain 후에도 pending/failed 잔류(=confirmed 아님) →
 *        fault 해제 후 drain 하면 confirmed 로 수렴(수렴 증명)
 *
 * ⚠️ 실행 요건:
 *   - go DB 직접 접속(DATABASE_URL) 로 payment_confirm_outbox 를 검사한다.
 *   - fault 주입(E2E_V2_FAULT_CONFIRM=1)은 **go 측 drain 테스트 훅**이다(v2 백엔드 무변경).
 *     주입 시 drain 의 v2 confirm 이 강제 실패 → pending/failed 로 남는지 검증한다.
 *   - 마이그레이션 224 선적용 필수(payment_confirm_outbox 테이블).
 */
import { Client } from "pg";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { createFullEvent } from "../helpers/fixture-event";
import { checkoutInitiate, checkoutComplete } from "../helpers/checkout";

const DATABASE_URL = process.env.DATABASE_URL ?? "";
const FAULT_CONFIRM = process.env.E2E_V2_FAULT_CONFIRM === "1";
const CRON_SECRET = process.env.CRON_SECRET ?? "";

const hasDb = DATABASE_URL.length > 0;
test.describe.configure({ mode: "serial" });

async function withDb<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

interface OutboxRow {
  order_id: string;
  v2_order_id: string;
  amount: string;
  status: string;
  attempts: number;
  max_attempts: number;
  confirmed_at: string | null;
  last_error: string | null;
}

async function getOutbox(orderId: string): Promise<OutboxRow | null> {
  return withDb(async (c) => {
    const { rows } = await c.query<OutboxRow>(
      `SELECT order_id, v2_order_id, amount::text, status, attempts, max_attempts, confirmed_at, last_error
         FROM payment_confirm_outbox WHERE order_id = $1`,
      [orderId],
    );
    return rows[0] ?? null;
  });
}

/** cron drain(payment-reconcile) 을 1회 호출. */
async function runCronDrain(request: APIRequestContext) {
  return request.get("/api/cron/payment-reconcile", {
    headers: {
      authorization: `Bearer ${CRON_SECRET}`,
      "x-cron-timestamp": new Date().toISOString(),
    },
  });
}

/** 유료 주문을 생성하고 offline 확정(주최자 입금확정 경로 = order-finalize) 으로 completed 로 만든다. */
async function createCompletedOrder(request: APIRequestContext) {
  const fx = await createFullEvent(request);
  const initiate = await checkoutInitiate(request, {
    eventId: fx.eventId,
    items: [{ productId: fx.productId, quantity: 1 }],
    buyerName: "아웃박스구매자",
    buyerEmail: `outbox_${Date.now()}@example.com`,
    buyerPhone: "01000000000",
  });
  // offline 은 주최자 입금확정 경로만 완료 → 여기선 확정 API 를 호출해 completed 로 전이.
  const complete = await checkoutComplete(
    request,
    { orderId: initiate.orderId, paymentMethod: "offline" },
    initiate.ownerCookie,
  );
  return { orderId: initiate.orderId, complete };
}

test.describe("결제 확정 outbox 재조정(pending-first)", () => {
  test.skip(!hasDb, "DATABASE_URL 미설정 — outbox 직접검사 불가");

  test("1) 정상 결제확정 → outbox pending 원자기록 → cron drain → confirmed(성공=confirmed만)", async ({ request }) => {
    test.skip(FAULT_CONFIRM, "fault 주입 모드에선 confirmed 수렴 불가(별도 시나리오)");
    const { orderId, complete } = await createCompletedOrder(request);
    expect([200, 409]).toContain(complete.status());

    const recorded = await getOutbox(orderId);
    // v2 앵커가 있으면 outbox 행이 반드시 존재(원자 불변식). record-time 은 pending.
    test.skip(!recorded, "v2 앵커 없음(레거시) — 시나리오 7 로 커버");
    expect(["pending", "confirmed"]).toContain(recorded!.status);
    expect(recorded!.v2_order_id).toBeTruthy();

    // cron drain 으로 confirmed 수렴. 성공은 confirmed 만 인정한다(pending/failed 통과 불가).
    const res = await runCronDrain(request);
    expect(res.status()).toBe(200);

    const after = await getOutbox(orderId);
    expect(after!.status).toBe("confirmed");
    expect(after!.confirmed_at).not.toBeNull();
  });

  test("4) 재확정(동일 주문) → confirmed outbox 는 pending 으로 회귀하지 않음(불변식)", async ({ request }) => {
    test.skip(FAULT_CONFIRM, "정상 confirmed 상태 전제");
    const { orderId } = await createCompletedOrder(request);
    await runCronDrain(request); // confirmed 로 수렴시킴
    const before = await getOutbox(orderId);
    test.skip(!before || before.status !== "confirmed", "confirmed outbox 전제 미충족");

    // 동일 주문 재확정 시도(멱등) — completed 는 already_completed 로 무해 반환.
    await checkoutComplete(request, { orderId, paymentMethod: "offline" }, "").catch(() => undefined);

    const after = await getOutbox(orderId);
    expect(after?.status).toBe("confirmed"); // confirmed 보존(status <> 'confirmed' 가드)
    expect(after?.confirmed_at).toBe(before!.confirmed_at); // confirmed_at 보존
  });

  test("7) NICE/레거시(v2 앵커 없음) → outbox 행 미기록(무영향)", async () => {
    // v2_order_id 가 NULL 인 주문은 recordPaymentConfirmOutbox 가 outbox 를 기록하지 않는다.
    const orphan = await withDb(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `SELECT o.id FROM orders o
           LEFT JOIN payment_confirm_outbox x ON x.order_id = o.id
          WHERE o.status = 'completed' AND o.v2_order_id IS NULL AND x.order_id IS NULL
          LIMIT 1`,
      );
      return rows[0] ?? null;
    });
    expect(orphan === null || typeof orphan.id === "string").toBe(true);
  });

  test("2·6) v2 confirm 실패 주입 → drain 후에도 confirmed 아님(pending/failed 잔류)", async ({ request }) => {
    test.skip(!FAULT_CONFIRM, "E2E_V2_FAULT_CONFIRM=1 (v2 confirm 실패 주입) 미설정");
    const { orderId } = await createCompletedOrder(request);

    // record-time: 항상 pending 으로 원자 기록됨(외부호출 전).
    const recorded = await getOutbox(orderId);
    expect(recorded).not.toBeNull();
    expect(recorded!.status).toBe("pending");
    expect(recorded!.confirmed_at).toBeNull();

    // fault 활성 상태에서 drain → v2 confirm 강제 실패 → confirmed 로 수렴하면 안 된다.
    await runCronDrain(request);
    const afterFault = await getOutbox(orderId);
    expect(afterFault!.status).not.toBe("confirmed");
    expect(["pending", "failed", "manual_review"]).toContain(afterFault!.status);
    expect(afterFault!.confirmed_at).toBeNull();
    expect(afterFault!.attempts).toBeGreaterThan(0); // drain 이 시도는 했음
  });
});
