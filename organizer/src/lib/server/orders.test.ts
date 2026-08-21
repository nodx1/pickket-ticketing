import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 레벨2 재감사 P0-1 회귀: createOrder(status=completed) 즉시확정 경로의 **pending-first** 계약.
 *
 * 배경(역 split-brain — 실돈): 과거 createOrder 는 go 앵커 트랜잭션 **밖·먼저** v2 confirmOrderPayment
 * 를 호출했다. v2 confirm 성공 뒤 go 앵커 INSERT/COMMIT 실패 시 → v2=confirmed·go 앵커 없음·outbox 없음·
 * reconcile 복구 불가(completed 행만 조회) = 역 split-brain. 호출자=group booking·수동주문·초대발권·
 * import·attendees POST 등 여러 completed 경로.
 *
 * 재배선 계약(이 테스트가 강제):
 *   1. createOrder 는 confirmOrderPayment 를 **절대 직접 호출하지 않는다**(외부 v2 호출 0).
 *   2. status=completed 는 recordPaymentConfirmOutbox 를 **go 앵커와 동일 anchorClient(같은 트랜잭션)**
 *      로 호출해 pending outbox 만 원자 기록한다 → "completed 앵커 커밋 ⟺ outbox 존재"(역 split-brain 불가).
 *   3. outbox 기록은 앵커 INSERT/attendees INSERT 이후·COMMIT **이전**(같은 client)이어야 한다.
 *   4. pending outbox 가 있으면 COMMIT **이후** enqueuePaymentConfirm 로 워커 트리거.
 *   5. status=pending 은 outbox 미기록·enqueue 없음(결제 전이는 별도 finalize 경로 소유).
 *   6. 0원(무료/초대/수동) completed 도 동일하게 pending outbox→워커(v2 confirm 은 워커가 수행).
 */

const h = vi.hoisted(() => {
  const outboxOrder: string[] = []; // 호출 순서 관찰용 태그 로그
  return {
    outboxOrder,
    v2CreateOrder: vi.fn(),
    confirmOrderPayment: vi.fn(),
    listTierCatalog: vi.fn(),
    getOrder: vi.fn(),
    recordPaymentConfirmOutbox: vi.fn(),
    enqueuePaymentConfirm: vi.fn(),
    generateShortId: vi.fn(),
    poolQuery: vi.fn(),
    poolConnect: vi.fn(),
    requireOwnedEvent: vi.fn(),
    class_EventAccessError: class EventAccessError extends Error {
      constructor(
        message: string,
        readonly reason: "not_found" | "unavailable",
        readonly status: number,
      ) {
        super(message);
      }
    },
    class_V2CommerceError: class V2CommerceError extends Error {
      constructor(message: string, readonly status: number) {
        super(message);
      }
    },
  };
});

vi.mock("@/lib/db/pool", () => ({
  getPool: () => ({ query: h.poolQuery, connect: h.poolConnect }),
}));
vi.mock("@/lib/v2/commerce-client", () => ({
  createOrder: (...a: unknown[]) => h.v2CreateOrder(...a),
  confirmOrderPayment: (...a: unknown[]) => h.confirmOrderPayment(...a),
  listTierCatalog: (...a: unknown[]) => h.listTierCatalog(...a),
  getOrder: (...a: unknown[]) => h.getOrder(...a),
  V2CommerceError: h.class_V2CommerceError,
}));
vi.mock("@/lib/v2/event-access", () => ({
  requireOwnedEvent: (...a: unknown[]) => h.requireOwnedEvent(...a),
  EventAccessError: h.class_EventAccessError,
}));
vi.mock("@/lib/payment/confirm-v2", () => ({
  recordPaymentConfirmOutbox: (...a: unknown[]) => h.recordPaymentConfirmOutbox(...a),
}));
vi.mock("@/lib/queue/payment-confirm-queue", () => ({
  enqueuePaymentConfirm: (...a: unknown[]) => h.enqueuePaymentConfirm(...a),
}));
vi.mock("@/lib/shortId", () => ({
  generateShortId: (...a: unknown[]) => h.generateShortId(...a),
}));

import { createOrder, getOrderDetail } from "@/lib/server/orders";

const EVT = "cbaccedd-51bf-4242-addb-a325ae603cbb";
const PROD_A = "2f0aeb23-573e-4a02-b2a4-a3df1bb51db6";
const V2_EVT = "aaaaaaaa-0000-0000-0000-000000000001";
const V2_ORDER = "bbbbbbbb-0000-0000-0000-000000000002";

/**
 * anchorClient mock — createOrder 6절 트랜잭션.
 * 호출 순서: BEGIN → 앵커 INSERT(RETURNING id) → attendees INSERT → (recordPaymentConfirmOutbox: 별도 mock)
 *          → COMMIT. anchorInsert.rowCount 로 신규앵커 여부 제어.
 */
function makeAnchorClient(anchorCreated = true) {
  const query = vi.fn((sql: string, _params?: unknown[]) => {
    if (/INSERT INTO orders/.test(sql)) {
      return Promise.resolve({ rows: anchorCreated ? [{ id: "row" }] : [], rowCount: anchorCreated ? 1 : 0 });
    }
    // BEGIN / attendees INSERT / COMMIT / ROLLBACK 등
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  const release = vi.fn();
  return { query, release, _tag: "anchor" as const };
}

/** ensureProducts 용 client — W2-PS 이후 go DB 를 전혀 열지 않는다(상품 정본 = v2 카탈로그).
 *  풀에서 꺼내는 구조 자체는 남아 있으므로(앵커 트랜잭션과 순서 공유) 스텁만 유지한다. */

/** v2 tier 카탈로그 1건 — external_ref 가 go product id 정본 키. */
function catalogRow(over: Record<string, unknown> = {}) {
  return {
    tier_id: "tier-a", external_ref: PROD_A, name: "일반",
    capacity: 1_000_000, base_price: 10000, sale_mode: null,
    sale_window: { opens_at: null, closes_at: null }, sold_count: 0, fill_rate: 0,
    stock_limit: null, min_per_order: 1, max_per_order: null,
    ...over,
  };
}

function baseParams(over: Partial<Parameters<typeof createOrder>[0]> = {}): Parameters<typeof createOrder>[0] {
  return {
    accountId: "acc-1",
    eventId: EVT,
    buyerName: "홍길동",
    buyerEmail: "buyer@example.com",
    buyerPhone: "01012345678",
    items: [{ productId: PROD_A, quantity: 2 }],
    paymentMethod: "offline",
    status: "completed",
    paymentStatus: "paid",
    idempotencyToken: "test-idem-token",
    ...over,
  };
}

let anchorClient: ReturnType<typeof makeAnchorClient>;

beforeEach(() => {
  vi.clearAllMocks();
  // W2-ORD: 이벤트 해석 = v2 소유검증 조회(go events 앵커 SELECT 폐기).
  h.requireOwnedEvent.mockResolvedValue({ event_id: V2_EVT, title: "테스트", status: "live" });
  h.poolQuery.mockImplementation(() => Promise.resolve({ rows: [] }));
  // pool.connect: anchorClient 1회뿐.
  //   종전에는 ensureProducts 용 커넥션을 먼저 잡아 2회였는데, 그 커넥션은 **쓰이지 않으면서**
  //   v2 HTTP 왕복 내내 풀을 점유하고 있어 제거했다(풀 소진 경로). 여기 mock 도 1회로 맞춘다.
  anchorClient = makeAnchorClient(true);
  h.poolConnect.mockResolvedValue(anchorClient);

  h.generateShortId.mockResolvedValue("ORD-250725-001");
  h.listTierCatalog.mockResolvedValue({ tiers: [catalogRow()], total: 1 });
  h.v2CreateOrder.mockResolvedValue({
    order_id: V2_ORDER,
    ticket_ids: ["tkt-1", "tkt-2"],
    raffle_numbers: {},
  });
  h.recordPaymentConfirmOutbox.mockResolvedValue({ pending: true, v2OrderId: V2_ORDER });
});

describe("createOrder — P0-1 pending-first(역 split-brain 원천 차단)", () => {
  it("status=completed 는 confirmOrderPayment 를 절대 직접 호출하지 않는다", async () => {
    await createOrder(baseParams({ status: "completed" }));
    // 재배선의 핵심: createOrder 내부에서 v2 confirm 을 트랜잭션 밖/먼저 호출하지 않는다.
    expect(h.confirmOrderPayment).not.toHaveBeenCalled();
  });

  it("status=completed 는 anchorClient(=go 앵커 트랜잭션)로 pending outbox 를 원자 기록한다", async () => {
    await createOrder(baseParams({ status: "completed", totalAmountOverride: 20000 }));

    expect(h.recordPaymentConfirmOutbox).toHaveBeenCalledTimes(1);
    const [client, goOrderId, opts] = h.recordPaymentConfirmOutbox.mock.calls[0]!;
    // 반드시 **앵커와 동일 client**(같은 트랜잭션) — 별도 pool.query/새 커넥션이면 원자성 깨짐.
    expect(client).toBe(anchorClient);
    expect(typeof goOrderId).toBe("string");
    expect(opts).toEqual({ amount: 20000 });
  });

  it("outbox 기록은 앵커/attendees INSERT 이후·COMMIT 이전(같은 client)에 일어난다", async () => {
    // recordPaymentConfirmOutbox 가 호출된 시점에 anchorClient 에 COMMIT 이 아직 안 나갔는지 검증.
    let commitBeforeOutbox = false;
    h.recordPaymentConfirmOutbox.mockImplementation(async () => {
      const committed = anchorClient.query.mock.calls.some((c) => /COMMIT/.test(String(c[0])));
      if (committed) commitBeforeOutbox = true;
      return { pending: true, v2OrderId: V2_ORDER };
    });

    await createOrder(baseParams({ status: "completed" }));

    expect(commitBeforeOutbox).toBe(false); // COMMIT 은 outbox 기록 뒤에만
    const sqls = anchorClient.query.mock.calls.map((c) => String(c[0]));
    expect(sqls.some((s) => /INSERT INTO orders/.test(s))).toBe(true);
    expect(sqls.some((s) => /COMMIT/.test(s))).toBe(true);
  });

  it("pending outbox 가 있으면 COMMIT 후 enqueuePaymentConfirm 로 워커를 트리거한다", async () => {
    h.recordPaymentConfirmOutbox.mockResolvedValue({ pending: true, v2OrderId: V2_ORDER });
    const result = await createOrder(baseParams({ status: "completed" }));
    expect(h.enqueuePaymentConfirm).toHaveBeenCalledTimes(1);
    expect(h.enqueuePaymentConfirm).toHaveBeenCalledWith(result.id);
  });

  it("v2 앵커 미연결(pending=false)이면 enqueue 하지 않는다(레거시/미앵커 안전)", async () => {
    h.recordPaymentConfirmOutbox.mockResolvedValue({ pending: false, v2OrderId: null });
    await createOrder(baseParams({ status: "completed" }));
    expect(h.enqueuePaymentConfirm).not.toHaveBeenCalled();
  });

  it("status=pending(결제 전 주문)은 outbox 미기록·enqueue 없음·confirm 없음", async () => {
    await createOrder(baseParams({ status: "pending", paymentStatus: "pending" }));
    expect(h.recordPaymentConfirmOutbox).not.toHaveBeenCalled();
    expect(h.enqueuePaymentConfirm).not.toHaveBeenCalled();
    expect(h.confirmOrderPayment).not.toHaveBeenCalled();
  });

  it("0원(무료/초대/수동) completed 도 pending outbox→워커 경유(v2 confirm 은 워커가 수행)", async () => {
    await createOrder(baseParams({ status: "completed", totalAmountOverride: 0 }));
    // 0원이라도 v2 confirm 직접호출 금지 — pending outbox 로 위임(amount=0).
    expect(h.confirmOrderPayment).not.toHaveBeenCalled();
    expect(h.recordPaymentConfirmOutbox).toHaveBeenCalledTimes(1);
    const [, , opts] = h.recordPaymentConfirmOutbox.mock.calls[0]!;
    expect(opts).toEqual({ amount: 0 });
    expect(h.enqueuePaymentConfirm).toHaveBeenCalledTimes(1);
  });

  it("outbox 기록 실패 시 앵커 트랜잭션 롤백(completed 인데 outbox 없음 = 원천 불가)", async () => {
    h.recordPaymentConfirmOutbox.mockRejectedValue(new Error("outbox insert failed"));
    await expect(createOrder(baseParams({ status: "completed" }))).rejects.toThrow("outbox insert failed");
    const sqls = anchorClient.query.mock.calls.map((c) => String(c[0]));
    // COMMIT 은 없어야 하고 ROLLBACK 이 나가야 한다(부분커밋 금지).
    expect(sqls.some((s) => /COMMIT/.test(s))).toBe(false);
    expect(sqls.some((s) => /ROLLBACK/.test(s))).toBe(true);
    // 확정도 큐잉도 없다.
    expect(h.confirmOrderPayment).not.toHaveBeenCalled();
    expect(h.enqueuePaymentConfirm).not.toHaveBeenCalled();
  });
});

/**
 * 레벨2 재감사 P1 회귀: createOrder retry idempotency(방향 a — 호출자 durable key → external_order_id).
 *
 * 버그(실돈·중복발권): orderId=crypto.randomUUID() 를 **매 호출 새로** 생성 → 재시도마다
 *   external_order_id(=orderId)와 Idempotency-Key(=go-order:orderId)가 둘 다 바뀌어 v2 dedup 미발동
 *   → v2 주문 생성 성공 후 go 앵커 실패→재시도 시 **별도 v2주문/좌석hold 중복**.
 *
 * 계약(이 테스트가 강제):
 *   1. idempotencyToken 이 있으면 orderId(=external_order_id)를 **결정적** 파생 →
 *      같은 토큰 재호출은 v2CreateOrder 에 **같은 external_order_id + 같은 Idempotency-Key** 전달
 *      → v2 external_order_id UNIQUE dedup 이 중복 주문/좌석hold 흡수.
 *   2. 다른 토큰 → 다른 orderId(격리).
 *   3. 토큰 미지정(단발 내부 경로) → 랜덤 UUID(호출당 신규 주문, 하위호환).
 *   4. 함수 스코프 1회 ID: v2 external_order_id == Idempotency-Key 시드 == go 앵커 INSERT id ==
 *      반환 result.id 가 **전부 동일 값**(내부 재시도/캐치가 새 ID 를 만들지 않음).
 */
describe("createOrder — P1 durable idempotency(재시도 중복발권 차단)", () => {
  function primeConnectOnce() {
    // createOrder 는 connect 를 1회(anchor)만 소비한다 — 미사용 product 커넥션은 제거됐다.
    h.poolConnect.mockResolvedValue(makeAnchorClient(true));
  }

  it("같은 idempotencyToken → 같은 external_order_id + 같은 Idempotency-Key(v2 dedup 시드)", async () => {
    const token = "11111111-2222-3333-4444-555555555555";
    // 1차 호출.
    await createOrder(baseParams({ status: "pending", paymentStatus: "pending", idempotencyToken: token }));
    // 2차 호출(같은 체크아웃 재시도) — connect mock 재장전.
    primeConnectOnce();
    await createOrder(baseParams({ status: "pending", paymentStatus: "pending", idempotencyToken: token }));

    const call1 = h.v2CreateOrder.mock.calls[0]!;
    const call2 = h.v2CreateOrder.mock.calls[1]!;
    const ext1 = (call1[0] as { external_order_id: string }).external_order_id;
    const ext2 = (call2[0] as { external_order_id: string }).external_order_id;
    const key1 = (call1[1] as { idempotencyKey: string }).idempotencyKey;
    const key2 = (call2[1] as { idempotencyKey: string }).idempotencyKey;

    // 재시도 두 호출이 v2 에 **동일** external_order_id·Idempotency-Key 를 보낸다 = dedup 발동 조건.
    expect(ext1).toBe(ext2);
    expect(key1).toBe(key2);
    expect(key1).toBe(`go-order:${ext1}`);
  });

  it("다른 토큰 → 다른 external_order_id(격리)", async () => {
    await createOrder(baseParams({ status: "pending", paymentStatus: "pending", idempotencyToken: "aaaaaaaa-1111-1111-1111-111111111111" }));
    primeConnectOnce();
    await createOrder(baseParams({ status: "pending", paymentStatus: "pending", idempotencyToken: "bbbbbbbb-2222-2222-2222-222222222222" }));

    const ext1 = (h.v2CreateOrder.mock.calls[0]![0] as { external_order_id: string }).external_order_id;
    const ext2 = (h.v2CreateOrder.mock.calls[1]![0] as { external_order_id: string }).external_order_id;
    expect(ext1).not.toBe(ext2);
  });

  // (삭제) "토큰 미지정 → 랜덤 external_order_id" 하위호환 — P1-11 로 idempotencyToken 이
  // 필수(타입상 항상 존재)가 되어 랜덤 폴백 경로가 제거됨. deterministic 파생은 위 테스트가 커버.

  it("함수 스코프 1회 ID: external_order_id == Idempotency-Key 시드 == go 앵커 INSERT id == result.id", async () => {
    const token = "99999999-8888-7777-6666-555555555555";
    const result = await createOrder(baseParams({ status: "pending", paymentStatus: "pending", idempotencyToken: token }));

    const ext = (h.v2CreateOrder.mock.calls[0]![0] as { external_order_id: string }).external_order_id;
    const key = (h.v2CreateOrder.mock.calls[0]![1] as { idempotencyKey: string }).idempotencyKey;
    // 앵커 INSERT 의 첫 파라미터($1)가 orderId(=id) 여야 한다.
    const insertCall = anchorClient.query.mock.calls.find((c) => /INSERT INTO orders/.test(String(c[0])));
    const anchorId = insertCall?.[1]?.[0];

    expect(result.id).toBe(ext);
    expect(key).toBe(`go-order:${ext}`);
    expect(anchorId).toBe(ext);
  });
});

/**
 * W2-ORD 회귀: 주문 생성의 이벤트 해석이 go `events` 앵커에서 v2 소유검증으로 이관됐다.
 *
 * 잃으면 안 되는 것 두 가지:
 *  1. **테넌트 경계** — 옛 `WHERE id=$1 AND account_id=$2` 가 유일한 소유검증이었다.
 *     v2 로 옮길 때 accountId 를 organizer_ref 로 넘기지 않으면 크로스테넌트 주문이 생긴다.
 *  2. **fail-closed** — v2 장애(unavailable)를 "이벤트 없음"으로 뭉개면 호출측이 404 를 내고
 *     구매자는 "행사가 사라졌다"고 오인한다. 예외는 그대로 전파돼야 한다.
 */
describe("W2-ORD — 이벤트 해석 v2 이관(go events 앵커 폐기)", () => {
  it("go events 앵커 SELECT 를 더 이상 실행하지 않는다", async () => {
    await createOrder(baseParams({ status: "pending", paymentStatus: "pending" }));
    const allSql = [
      ...h.poolQuery.mock.calls.map((c) => String(c[0])),
      ...anchorClient.query.mock.calls.map((c) => String(c[0])),
    ];
    expect(allSql.some((s) => /v2_event_id\s+FROM\s+events/i.test(s))).toBe(false);
  });

  it("소유검증을 accountId 로 위임한다(크로스테넌트 차단 경계 보존)", async () => {
    await createOrder(baseParams({ status: "pending", paymentStatus: "pending" }));
    expect(h.requireOwnedEvent).toHaveBeenCalledWith(EVT, "acc-1");
  });

  it("v2 가 돌려준 canonical event_id 로 주문을 만든다(항등이지만 v2 응답이 정본)", async () => {
    await createOrder(baseParams({ status: "pending", paymentStatus: "pending" }));
    const body = h.v2CreateOrder.mock.calls[0]![0] as { event_id: string };
    expect(body.event_id).toBe(V2_EVT);
  });

  it("v2 장애(EventAccessError unavailable)는 전파된다 — 주문도 앵커도 만들지 않는다", async () => {
    h.requireOwnedEvent.mockRejectedValue(
      new h.class_EventAccessError("v2 down", "unavailable", 502),
    );
    await expect(
      createOrder(baseParams({ status: "completed" })),
    ).rejects.toBeInstanceOf(h.class_EventAccessError);
    expect(h.v2CreateOrder).not.toHaveBeenCalled();
    expect(h.recordPaymentConfirmOutbox).not.toHaveBeenCalled();
  });

  it("미소유/미존재(EventAccessError not_found)도 전파된다(주문 생성 없음)", async () => {
    h.requireOwnedEvent.mockRejectedValue(
      new h.class_EventAccessError("없음", "not_found", 404),
    );
    await expect(
      createOrder(baseParams({ status: "pending", paymentStatus: "pending" })),
    ).rejects.toBeInstanceOf(h.class_EventAccessError);
    expect(h.v2CreateOrder).not.toHaveBeenCalled();
  });
});

describe("W2-PS×W2-ORD 접합 — 상품 정본이 v2 카탈로그", () => {
  it("go DB 를 열지 않고 v2 카탈로그로 상품을 검증한다", async () => {
    await createOrder(baseParams());
    expect(h.listTierCatalog).toHaveBeenCalledWith(V2_EVT);
    // W2-PS 가 go `products` write 를 없앴으므로 go 조회가 남아 있으면 전 주문이 404 로 죽는다.
    const productClient = h.poolConnect.mock.results[0]?.value;
    if (productClient) {
      const sqls = (await productClient).query.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(sqls.some((s: string) => /FROM products/.test(s))).toBe(false);
    }
  });

  it("v2 장애를 '상품 없음'으로 뭉개지 않는다 — 그대로 전파(상위가 503)", async () => {
    // 이걸 404 로 흡수하면 주최자에게 "그런 상품이 없습니다"로 보여 오진을 유발한다.
    h.listTierCatalog.mockRejectedValueOnce(new h.class_V2CommerceError("v2 down", 502));
    await expect(createOrder(baseParams())).rejects.toBeInstanceOf(h.class_V2CommerceError);
    expect(h.v2CreateOrder).not.toHaveBeenCalled();
  });

  it("카탈로그에 없는 상품 id 는 404 — 타 이벤트 상품 주입 차단", async () => {
    await expect(
      createOrder(baseParams({ items: [{ productId: "00000000-0000-4000-8000-000000000999", quantity: 1 }] })),
    ).rejects.toThrow();
    expect(h.v2CreateOrder).not.toHaveBeenCalled();
  });

  it("재고 원본은 stock_limit — capacity sentinel(100만)을 재고로 쓰지 않는다", async () => {
    // stock_limit=2 인데 3개 요구 → 재고 부족. capacity(100만)를 봤다면 통과해버린다.
    h.listTierCatalog.mockResolvedValue({
      tiers: [catalogRow({ stock_limit: 2, capacity: 2, sold_count: 0 })],
      total: 1,
    });
    await expect(
      createOrder(baseParams({ items: [{ productId: PROD_A, quantity: 3 }] })),
    ).rejects.toThrow("재고가 부족합니다");
  });
});

/**
 * 🔴 초대권 주문이 「현장결제」로 보이던 것 (2026-08-04)
 *
 * 발급이 go `orders.payment_method` 에 'offline' 을 적는다 → 상세 화면이 「현장결제」로 표시.
 * 발주처는 "현장에서 16건 결제받았나?" 로 읽는다.
 *
 * ⚠️ 라벨 맵을 고쳐서는 안 된다 — 'offline' 은 주최자 **수동 주문**의 정당한 값이다.
 *    v2 가 그 주문의 티켓(`answers._invitationId`)으로 판정한 `is_invitation` 을 받아 쓴다.
 */
describe("주문 상세 — 초대권 여부 배선", () => {
  const ACCT = "acct-1";
  const ORDER = "order-1";

  function mockDetail(v2: Record<string, unknown> | null, header: Record<string, unknown> = {}) {
    h.poolQuery.mockReset();
    h.getOrder.mockReset();
    // getOrderDetail 은 헤더·참석자를 Promise.all 로 동시에 던진다 — SQL 로 갈라 답한다.
    h.poolQuery.mockImplementation((sql: string) => {
      if (/FROM orders/.test(sql)) {
        return Promise.resolve({
          rows: [{
            id: ORDER, orderNumber: "GO-1", buyerName: "구매자",
            paymentMethod: "offline", status: "completed",
            v2OrderId: v2 === null ? null : V2_ORDER, ...header,
          }],
          rowCount: 1,
        });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });
    if (v2 !== null) h.getOrder.mockResolvedValue(v2);
    return getOrderDetail(ACCT, EVT, ORDER);
  }

  const V2_BASE = {
    items: [], platform_fee: null, net_amount: null, has_pg_payment: false,
  };

  it("🔴 초대권이면 isInvitation=true 가 화면까지 올라온다", async () => {
    const d = await mockDetail({ ...V2_BASE, is_invitation: true });
    expect(d?.isInvitation).toBe(true);
  });

  it("카드/수동 주문이면 false — 결제수단 라벨은 그대로 쓴다", async () => {
    const d = await mockDetail({ ...V2_BASE, is_invitation: false });
    expect(d?.isInvitation).toBe(false);
    expect(d?.paymentMethod).toBe("offline"); // 🔴 원본 값을 덮어쓰지 않는다
  });

  it("🔴 구버전 v2(필드 없음)면 undefined — 표시를 바꾸지 않는다", async () => {
    const d = await mockDetail({ ...V2_BASE });
    expect(d?.isInvitation).toBeUndefined();
    expect(d?.isManualIssue).toBeUndefined();
  });

  it("🔴 수동발권이면 isManualIssue=true 가 화면까지 올라온다", async () => {
    const d = await mockDetail({ ...V2_BASE, is_invitation: false, is_manual_issue: true });
    expect(d?.isManualIssue).toBe(true);
    expect(d?.isInvitation).toBe(false);
    expect(d?.paymentMethod).toBe("offline"); // 🔴 원본 값을 덮어쓰지 않는다
  });

  it("🔴 수동 주문(현장결제)은 둘 다 false — 표식이 없다", async () => {
    const d = await mockDetail({ ...V2_BASE, is_invitation: false, is_manual_issue: false });
    expect(d?.isInvitation).toBe(false);
    expect(d?.isManualIssue).toBe(false);
  });

  it("🔴 v2 앵커 미연결이면 undefined — 초대권으로 단정하지 않는다", async () => {
    const d = await mockDetail(null);
    expect(d?.isInvitation).toBeUndefined();
    expect(d?.isManualIssue).toBeUndefined();
    expect(h.getOrder).not.toHaveBeenCalled();
  });
});
