import crypto from "node:crypto";
import { getPool } from "@/lib/db/pool";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { generateShortId } from "@/lib/shortId";
import { paymentAttemptView } from "@/lib/orders/payment-attempt-label";
import type { PaymentAttemptView } from "@/lib/orders/payment-attempt-label";
import { deriveTicketNumber } from "@/lib/ticket/ticket-number";
import {
  createOrder as v2CreateOrder,
  getOrder as v2GetOrder,
  listTierCatalog,
  V2CommerceError,
} from "@/lib/v2/commerce-client";
import { EventAccessError, requireOwnedEvent } from "@/lib/v2/event-access";
import { recordPaymentConfirmOutbox } from "@/lib/payment/confirm-v2";

interface CreateOrderItemInput {
  productId: string;
  quantity: number;
  /** F2/F1: daypass 지정일 초대권 — 발권 티켓에 admission_day(YYYY-MM-DD) 부여. */
  admissionDay?: string | null;
}

interface CreateOrderParams {
  accountId: string;
  eventId: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone?: string;
  items: CreateOrderItemInput[];
  answers?: Record<string, string | string[]>;
  /** T2-ORD: 주문 워크플로 메모(go orders.memo → v2 orders.memo 로 함께 기록). */
  memo?: string | null;
  selectedSeatIds?: string[];
  /**
   * 결제수단. **`null` = 아직 모른다** (2026-08-01).
   *
   * 소비자 체크아웃은 시작 시점에 수단을 모른다 — 카드·간편결제가 다 그 경로를 지난다.
   * 종전엔 `"offline"` 로 단정해 적어서 이탈 주문이 대시보드에 **"현장결제"** 로 보였다.
   * go 컬럼은 nullable 이다(마이그 171 이 NOT NULL·CHECK 를 이미 DROP).
   */
  paymentMethod: "offline" | "bank_transfer" | "card" | "toss" | "kakaopay" | "naverpay" | null;
  status: "pending" | "completed";
  paymentStatus: "pending" | "paid";
  paidAmount?: number;
  platformFee?: number;
  totalAmountOverride?: number;
  expiresAt?: string | null;
  /** v2 canonical discount_code_id (W5-COMMERCE: go promo_codes 앵커 폐기 — 해석 없이 그대로 전달). */
  promoCodeId?: string;
  /** 프로모 코드 문자열 — 있으면 v2 discount 해석에 우선 사용(go id 우회). */
  promoCode?: string;
  discountAmount?: number;
  source?: "direct" | "widget" | "marketplace" | "affiliate" | "api";
  /** affiliate 코드(쿠키) — v2 가 주문 시 conversion 원자기록. */
  affiliateRef?: string | null;
  /**
   * Phase 11: 새 좌석 시스템 hold 체크아웃.
   * 전달되면 기존 lock 재획득을 생략하고 holdId/holdToken 기준 검증 → reserved 처리만 수행.
   */
  holdId?: string;
  holdToken?: string;
  /**
   * 레벨2 재감사 P1 — createOrder retry idempotency(방향 a: 호출자 durable key).
   * 체크아웃 시도당 **안정 토큰**(프론트가 체크아웃 진입 시 1회 생성·재시도 시 재사용).
   * 있으면 external_order_id(=orderId)를 이 토큰에서 **결정적**으로 파생한다 →
   * 같은 토큰 재호출 = 같은 orderId = 같은 external_order_id → v2 dedup 이 중복 v2주문/좌석hold 를 흡수.
   * 미지정(내부 발권·수동주문 등 단발 경로)이면 기존대로 랜덤 UUID(호출당 신규 주문).
   */
  idempotencyToken: string;
  /** 전자금융거래·청약철회 동의 시각(구형 나이스 필수). v2 orders.terms_agreed_at 로 전달. */
  termsAgreedAt?: string | null;
}

/**
 * 호출자 durable 토큰 → go order id(=external_order_id) 결정적 파생(UUIDv5).
 * 같은 토큰 재시도 → 동일 UUID → v2 external_order_id UNIQUE dedup 흡수(중복 주문 0).
 * 고정 네임스페이스로 토큰 공간을 격리(다른 용도 UUID 와 충돌 불가).
 */
const GO_ORDER_ID_NAMESPACE = "6f9619ff-8b86-d011-b42d-00c04fc964ff"; // 고정 네임스페이스(임의 상수 UUID)
function deriveOrderId(idempotencyToken: string): string {
  const hash = crypto
    .createHash("sha1")
    .update(Buffer.from(GO_ORDER_ID_NAMESPACE.replace(/-/g, ""), "hex"))
    .update(idempotencyToken)
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant RFC4122
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** 주문 write-through 에 필요한 상품 앵커(v2 tier 해석 + 가격). */
interface ProductAnchorRow {
  id: string;
  name: string;
  price: string;
  stock: number | null;
  min_per_order: number;
  max_per_order: number | null;
  /** v2 canonical seat_tier id (migration 170). 없으면 external_ref(=go productId)로 v2 가 해석. */
  v2_tier_id: string | null;
}

/**
 * 상품 검증 + v2 tier 앵커 수집.
 * 재고/수량 게이트(min/max/stock)는 UX 즉응을 위해 go 에서 1차 검증하되,
 * **원자성·최종 재고확정은 v2 createOrder 가 소유**(go 는 더 이상 stock 을 차감하지 않음).
 */
async function ensureProducts(
  accountId: string,
  eventId: string,
  /** 소유 검증을 마친 v2 canonical event id (W2-ORD: 옛 go events 앵커 조회 대체 — 호출자가 해석). */
  v2EventId: string,
  items: CreateOrderItemInput[],
): Promise<Map<string, ProductAnchorRow>> {
  const ids = items.map((item) => item.productId);

  // ── 레벨2 컷오버 W2-PS×W2-ORD 접합 ──
  // 옛 코드는 go `products` 행을 **하드 요구**했다(`rows.length !== ids.size → 404`).
  // W2-PS 가 상품 생성을 v2 카탈로그 단독 write 로 옮기면서 go `products` 에 새 행이 더 이상
  // 생기지 않는다 ⟹ 그대로 두면 RSVP 접수·초대권 발송·수동발권·CSV 임포트·체크아웃이
  // **전부 404** 로 죽는다. 상품 정본을 v2 tier 카탈로그로 전환한다.
  //
  // 🔴 조회 실패를 "상품 없음(404)"으로 뭉개지 않는다 — 그러면 v2 일시 장애가 주최자에게
  //    "그런 상품이 없습니다"로 보여 오진을 유발한다. 그대로 던져 상위가 503 으로 통지한다.
  const catalog = await listTierCatalog(v2EventId);
  const productMap = new Map<string, ProductAnchorRow>();
  const v2Remaining = new Map<string, number>();
  for (const tier of catalog.tiers) {
    // external_ref = go product id(정본 키). 없으면 v2 tier_id 로 주소지정된 신규 상품.
    const productId = tier.external_ref ?? tier.tier_id;
    productMap.set(productId, {
      id: productId,
      name: tier.name,
      price: String(tier.base_price),
      // stock 은 **원본 재고**(stock_limit). capacity 는 무제한 sentinel(1,000,000)이 섞여 있어
      // 그대로 쓰면 무제한 상품이 "재고 100만"으로 보인다.
      stock: tier.stock_limit,
      min_per_order: tier.min_per_order ?? 1,
      max_per_order: tier.max_per_order,
      v2_tier_id: tier.tier_id,
    });
    v2Remaining.set(
      productId,
      Math.max(0, Number(tier.capacity) - Number(tier.sold_count)),
    );
  }

  // 요청 상품이 이 이벤트 카탈로그에 전부 있는지 — 타 이벤트 상품 주입(IDOR) 차단.
  // 테넌트 경계는 호출자가 이미 `requireOwnedEvent(eventId, accountId)` 로 확인했고,
  // 카탈로그는 그 이벤트 스코프라 여기서 accountId 재확인은 불필요하다.
  void accountId;
  void eventId;
  if (ids.some((id) => !productMap.has(id))) {
    throw new Error(ERR.NOT_FOUND);
  }

  for (const item of items) {
    const product = productMap.get(item.productId);
    if (!product) {
      throw new Error(ERR.NOT_FOUND);
    }
    if (item.quantity < product.min_per_order) {
      throw new Error("최소 주문 수량보다 적습니다");
    }
    if (product.max_per_order && item.quantity > product.max_per_order) {
      throw new Error("최대 주문 수량을 초과했습니다");
    }
    const remaining = v2Remaining.get(item.productId);
    if (remaining !== undefined && item.quantity > remaining) {
      throw new Error("재고가 부족합니다");
    }
  }

  return productMap;
}

/**
 * ⭐ 주문 생성 — v2 createOrder write-through.
 *
 * 빅뱅 flip: go DB 6테이블(orders+order_items+attendees+promo차감+products sold+seats hold→sold)을
 * 1트랜잭션으로 쓰던 코어를 **v2 원자 주문 API 단일 호출로 대체**(원자성=v2 소유).
 * go 는 응답으로:
 *   - go orders 행 1개를 thin 앵커로 기록(id ↔ v2_order_id, external_order_id=go order id 멱등앵커).
 *   - go attendees 를 v2 응답 ticket_id 로 키잉해 answers/체크인 워크플로 보존(go-local).
 *
 * 호출자(checkout/initiate · manual order · group-booking)가 기대하는 반환 shape
 * { id, orderNumber, totalAmount, paidAmount } 를 보존한다.
 *
 * V2CommerceError 는 그대로 전파(부분커밋 금지). go 앵커는 v2 성공 후에만 기록한다.
 *
 * @throws EventAccessError 이벤트가 없거나 내 계정 소유가 아님(`not_found`, 404) /
 *   v2 장애로 소유 확인 불가(`unavailable`, 502→호출측 503). 호출측은 이 둘을 반드시
 *   구분해 매핑해야 한다 — v2 장애를 400 "입력오류"로 위장하면 재시도 판단이 불가능해진다.
 */
export async function createOrder(params: CreateOrderParams) {
  const pool = getPool();

  // 1) 이벤트 소유 검증 + v2 canonical event id 해석.
  //    ── W2-ORD: 옛 `SELECT v2_event_id FROM events WHERE id=$1 AND account_id=$2` 폐기 ──
  //    go event id == v2 event id(항등)이므로 앵커 컬럼 조회는 불필요하다. 다만 그 조회가
  //    **유일한 테넌트 경계**였으므로 순수 통과로 바꾸면 크로스테넌트 누출이 된다.
  //    → 경계는 v2 가 강제한다(`organizer_ref` 불일치 → 404 → EventAccessError.not_found).
  //    미앵커(v2_event_id NULL) 폴백도 함께 사라진다: v2 에 이벤트가 있으면 곧 커머스 연결됨.
  const ownedEvent = await requireOwnedEvent(params.eventId, params.accountId);
  const v2EventId = ownedEvent.event_id;

  // 🔴 종전에는 여기서 `pool.connect()` 로 go 커넥션을 잡은 채 `ensureProducts` 를 기다렸다.
  //    레벨2 컷오버로 그 함수의 상품 조회가 go SELECT → v2 HTTP(`listTierCatalog`)로 바뀌면서
  //    **쓰지도 않는 커넥션을 왕복 내내 점유**하게 됐다(타임아웃 10s × 재시도 2회 + 백오프).
  //    풀은 max=20 이라 v2 가 느려지는 순간 체크아웃 20건이 풀을 전부 잡고, 그러면 무통장 확정·
  //    크론·관리자까지 **go DB 전 경로**가 connectionTimeout(10s) 뒤에 실패한다.
  //    커넥션을 쓰지 않으므로 순수 제거한다 — 동작 불변.
  const productMap = await ensureProducts(
    params.accountId,
    params.eventId,
    v2EventId,
    params.items,
  );

  // 2) go-local 멱등 앵커 order id(=external_order_id). 재시도 시 v2 가 같은 canonical order 재생.
  //    호출자 durable 토큰이 있으면 그걸로 결정적 파생(체크아웃 재시도 → 같은 orderId → v2 dedup).
  //    없으면(단발 내부 경로) 랜덤 UUID. 이 값은 **함수 스코프에서 1회 확정** 되고 v2 호출·go 앵커·
  //    idempotencyKey 시드에 **동일 값**으로 재사용된다(내부 재시도/캐치가 새 ID 를 만들지 않음).
  const orderId = deriveOrderId(params.idempotencyToken);
  const orderNumber = await generateShortId("ORD");

  // 3) v2 createOrder 입력 매핑.
  //    - items: v2_tier_id 있으면 tier_id, 없으면 external_ref(=go productId)로 v2 가 해석.
  //    - unit_price = go 상품가(v2 가 tier min/max 범위로 검증·재계산, SoT).
  //    - seat_ids: v2 canonical seat_id 필요(좌석 기반 주문). go seat 앵커 매핑은 위성 전환 영역.
  const calculatedTotal = params.items.reduce((sum, item) => {
    const product = productMap.get(item.productId);
    return sum + Number(product?.price ?? 0) * item.quantity;
  }, 0);
  const totalAmount = params.totalAmountOverride ?? calculatedTotal;

  // 좌석 주문: selectedSeatIds 는 **이미 v2 canonical seat_id** 다(레벨2 컷오버 T1).
  // hold_id = bearer 소유증명(익명 hold). 단일 좌석 상품 가정 — 다상품 좌석은 후속.
  //
  // ── 왜 조회가 사라졌나 ──
  // 예전엔 `SELECT v2_seat_id FROM seats WHERE id = ANY(...)` 로 go seat id → v2 id 를 되짚고,
  // 하나라도 미앵커면 "좌석 주문 불가"로 거부했다. 좌석빌더가 go `seats` 에 더 이상 INSERT 하지
  // 않으면서 그 테이블은 항상 비었고, 이 조회는 **모든 좌석 주문을 무조건 거부**하게 됐다.
  // 좌석 선택 경로(공개 seats API·hold)가 v2 canonical seat_id 를 그대로 내려주므로 앵커 해석은
  // 항등이다. 존재하지 않는/타 이벤트 좌석 주입은 v2 createOrder 가 event_id 스코프로 거부한다
  // (좌석 중복·소유 집행의 정본은 v2 — go 에는 잠글 행이 없다).
  const v2SeatIds: string[] = params.selectedSeatIds ?? [];

  const items = params.items.map((item, idx) => {
    const product = productMap.get(item.productId);
    // 좌석은 첫 좌석상품 아이템에 부착(단일 좌석상품 가정). hold_id = bearer.
    const isSeatItem = idx === 0 && v2SeatIds.length > 0;
    return {
      tier_id: product?.v2_tier_id ?? undefined,
      external_ref: product?.v2_tier_id ? undefined : item.productId,
      quantity: item.quantity,
      unit_price: Number(product?.price ?? 0),
      seat_ids: isSeatItem ? v2SeatIds : undefined,
      hold_id: isSeatItem ? (params.holdId ?? null) : undefined,
      // F2/F1: daypass 지정일 초대권 — v2 가 발권 티켓에 admission_day 부여.
      admission_day: item.admissionDay ?? undefined,
    };
  });

  // 4) 할인: v2 가 코드 rule 로 amount 재계산(SoT). go 는 코드 식별자만 전달.
  //    ── W5-COMMERCE: go `promo_codes` 앵커 폐기 ──
  //    옛 코드는 `SELECT code, v2_code_id FROM promo_codes` 로 go 앵커 id → v2 code_id 를
  //    되짚었다. 이제 프로모코드 정본은 v2 `discount_codes` 하나뿐이고 `promoCodeId` 가
  //    **곧 v2 discount_code_id** 이므로(체크아웃이 v2 검증 응답의 promo_id 를 그대로 넘김)
  //    되짚을 앵커가 없다 — DB 왕복 자체가 사라진다.
  //    우선순위는 종전 그대로: 코드 문자열이 있으면 그것(v2 가 code 로 재계산), 없으면 code_id.
  let discount: { code_id?: string | null; code?: string | null } | null = null;
  if (params.promoCode) {
    discount = { code: params.promoCode };
  } else if (params.promoCodeId) {
    discount = { code_id: params.promoCodeId };
  }

  // 5) v2 원자 주문 생성(write-through). 멱등키 = go order id(재시도 안전).
  const v2Order = await v2CreateOrder(
    {
      external_order_id: orderId,
      buyer: {
        name: params.buyerName,
        email: params.buyerEmail,
        phone: params.buyerPhone ?? null,
      },
      event_id: v2EventId,
      source: params.source ?? "go_internal",
      affiliate_ref: params.affiliateRef ?? null,
      items,
      discount,
      total_amount: totalAmount,
      payment_deadline: params.expiresAt ?? null,
      // T2-ORD: 설문응답·메모를 v2 에도 보관(go attendees.answers / orders.memo 흡수).
      // go 앵커 write 는 유지 — 앵커 read 를 걷어내는 단계에서 함께 제거한다.
      answers: params.answers ?? null,
      memo: params.memo ?? null,
      terms_agreed_at: params.termsAgreedAt ?? null,
    },
    { idempotencyKey: `go-order:${orderId}` },
  );

  const v2OrderId = v2Order.order_id;
  const ticketIds = v2Order.ticket_ids;

  // 5b) status-sync (P0 pending-first 재배선 — 코덱스 재감사 P0-1, 역 split-brain 원천 차단):
  //     manual/group/comp/초대/import 등 status=completed 즉시확정 주문도 v2 결제확정이 필요하다
  //     (v2 createOrder 는 항상 PAYMENT_REQUIRED 로 생성 → CONFIRMED 전이 필요). 소비자 PG결제와 별개.
  //
  //     ⚠️ 과거 결함: 여기서 confirmOrderPayment(외부 v2 호출)를 go 앵커 트랜잭션(:아래) **보다 먼저**
  //     실행했다. v2 confirm 성공 후 go 앵커 INSERT/COMMIT 이 실패하면 → v2=confirmed·go 앵커 없음·
  //     outbox 없음 = reconcile 복구 불가(completed 행만 조회) = **역 split-brain(실돈 confirmed 인데
  //     go 미완료·추적행 전무)**. 외부호출과 go 커밋은 원자화 불가하므로 순서로는 못 막는다.
  //
  //     ✅ 재배선: 이 시점에 v2 confirm 을 호출하지 않는다. 아래 go 앵커 트랜잭션에서 앵커 INSERT 직후
  //     같은 client 로 recordPaymentConfirmOutbox(외부호출 0, pending outbox 만) 를 원자 기록한다
  //     → "completed 앵커인데 outbox 없음"이 구조적으로 불가능. 실제 v2 confirm 은 COMMIT 후 워커/cron
  //     (processPaymentConfirmOutbox)이 커밋된 pending 행을 클레임해 멱등키(go-confirm:orderId)로 수행한다
  //     → v2 confirmed 인데 go 롤백/outbox 소멸이 원천 불가(역 split-brain 불가).

  // 6) go 앵커 기록 — v2 성공 후에만. go orders 는 thin 앵커, attendees 는 워크플로(answers/체크인).
  //    트랜잭션은 go-local 부분(앵커+attendee)만 감싼다(커머스 원자성은 v2 가 이미 보장).
  //    status=completed 이면 결제확정 pending outbox 도 이 트랜잭션에 원자 기록한다.
  const anchorClient = await pool.connect();
  try {
    await anchorClient.query("BEGIN");

    const paidAmount = params.paidAmount ?? (params.status === "completed" ? totalAmount : 0);
    // ON CONFLICT (v2_order_id) DO NOTHING — 같은 v2 주문에 대한 멱등 재시도/동시호출 시
    // 중복 앵커를 만들지 않는다. 이미 앵커가 있으면 rowCount=0 → 아래 attendees 재삽입도 skip
    // (첫 호출에서 이미 생성됨). (감사 P1-15, migration 177)
    const anchorInsert = await anchorClient.query(
      `
        INSERT INTO orders (
          id, account_id, event_id, order_number, buyer_name, buyer_email, buyer_phone,
          total_amount, paid_amount, refund_amount, platform_fee, status,
          payment_method, payment_status, ordered_at, expires_at, source,
          v2_order_id, created_at, updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7,
          $8, $9, 0, $10, $11,
          $12, $13, NOW(), $14, $15,
          $16, NOW(), NOW()
        )
        ON CONFLICT (v2_order_id) DO NOTHING
        RETURNING id
      `,
      [
        orderId,
        params.accountId,
        params.eventId,
        orderNumber,
        params.buyerName,
        params.buyerEmail,
        params.buyerPhone ?? null,
        totalAmount,
        paidAmount,
        params.platformFee ?? 0,
        params.status,
        params.paymentMethod,
        params.paymentStatus,
        params.expiresAt ?? null,
        params.source ?? "direct",
        v2OrderId,
      ],
    );

    // 앵커가 이미 존재(멱등 재시도)면 attendees 재삽입 skip — 첫 호출에서 이미 생성됨. (감사 P1-15)
    const anchorCreated = (anchorInsert.rowCount ?? 0) > 0;

    // attendees: v2 ticket_id 1:1 키잉(answers/체크인 워크플로 go-local 보존).
    // v2 가 라인별 ticket_ids 를 주지만 answers 는 주문 단위라 ticket 순서대로 키잉.
    if (anchorCreated && ticketIds.length > 0) {
      const attendeeStatus = params.status === "completed" ? "confirmed" : "pending";
      const answersJson = JSON.stringify(params.answers ?? {});
      // F4: v2 가 raffle_enabled 이벤트 발권 시 부여한 경품번호(ticket_id → 번호). 표시용 미러링.
      const raffleNumbers = v2Order.raffle_numbers ?? {};
      const valuePlaceholders: string[] = [];
      const attendeeValues: unknown[] = [];
      let p = 1;
      for (const ticketId of ticketIds) {
        // ticket_number 는 go-local 표시 키(UNIQUE). v2 ticket_id 는 write-through 식별자.
        valuePlaceholders.push(
          `(gen_random_uuid(), $${p}, $${p + 1}, $${p + 2}, $${p + 3}, $${p + 4}, $${p + 5}, $${p + 6}, $${p + 7}, NULL, $${p + 8}::jsonb, $${p + 9}, $${p + 10}, NOW(), NOW())`,
        );
        attendeeValues.push(
          params.accountId,
          params.eventId,
          orderId,
          // T2-ORD: 공식은 v2 `derive_ticket_number` 와 동일해야 한다(단일 헬퍼로 고정).
          deriveTicketNumber(ticketId),
          params.buyerName,
          params.buyerEmail,
          params.buyerPhone ?? null,
          attendeeStatus,
          answersJson,
          ticketId,
          raffleNumbers[ticketId] ?? null,
        );
        p += 11;
      }
      await anchorClient.query(
        `
          INSERT INTO attendees (
            id, account_id, event_id, order_id, ticket_number,
            name, email, phone, status, checked_in_at, answers, v2_ticket_id,
            raffle_number, created_at, updated_at
          )
          VALUES ${valuePlaceholders.join(", ")}
        `,
        attendeeValues,
      );
    }

    // P0 pending-first(코덱스 재감사 P0-1): status=completed 즉시확정 경로도 v2 confirm 을
    // 직접 호출하지 않고, 결제확정 pending outbox 행을 **go 앵커와 동일 트랜잭션(anchorClient)** 에
    // 기록한다. 앵커 INSERT 직후라 recordPaymentConfirmOutbox 가 방금 넣은 orders 행에서
    // v2_order_id 를 읽어 원자 기록한다(외부호출 0) → "completed 앵커 커밋 ⟺ pending outbox 존재"가
    // 같은 COMMIT 으로 성립. 재시도(anchorCreated=false)여도 재기록해 outbox 존재를 보장하되,
    // 이미 confirmed 인 행은 recordPaymentConfirmOutbox 내부 WHERE status<>'confirmed' 로 보존한다.
    // v2_order_id 없음(레거시/미앵커)=outbox 미기록(pending=false) → 그 경로엔 v2 확정 자체가 무의미.
    let confirmOutboxPending = false;
    if (params.status === "completed") {
      const outboxResult = await recordPaymentConfirmOutbox(anchorClient, orderId, { amount: totalAmount });
      confirmOutboxPending = outboxResult.pending;
    }

    await anchorClient.query("COMMIT");

    // COMMIT 후: pending outbox 가 있으면 결제확정 워커 트리거(v2 confirm 은 트랜잭션 밖·커밋 후).
    // enqueue 실패해도 payment-confirm cron 이 pending 행을 스캔하는 이중 안전망 → 유실 없음.
    if (confirmOutboxPending) {
      const { enqueuePaymentConfirm } = await import("@/lib/queue/payment-confirm-queue");
      await enqueuePaymentConfirm(orderId);
    }
  } catch (err: unknown) {
    await anchorClient.query("ROLLBACK");
    // v2 주문은 이미 생성됨(canonical). go 앵커 기록 실패 → 재시도 시 external_order_id 멱등으로
    // 동일 v2 주문 재생되므로 안전. 호출자에 에러 전파.
    throw err;
  } finally {
    anchorClient.release();
  }

  return {
    id: orderId,
    orderNumber,
    totalAmount,
    paidAmount: params.paidAmount ?? (params.status === "completed" ? totalAmount : 0),
    v2OrderId,
    ticketIds,
    // T2-ORD: 발권 결과를 호출자가 go attendees 재조회 없이 쓸 수 있게 노출한다.
    // ticketNumbers 는 ticketIds 에서 결정적으로 파생 — 앵커에 기록한 값과 동일 보장.
    ticketNumbers: ticketIds.map(deriveTicketNumber),
    raffleNumbers: v2Order.raffle_numbers ?? {},
  };
}

// W2-ORD: createOrder 가 던지는 접근오류를 호출측이 상태코드로 매핑할 수 있도록 재수출한다
// (not_found → 404, unavailable → 503). 이걸 일반 Error 로 뭉개면 v2 장애가 400 이 된다.
export { V2CommerceError, EventAccessError };

/**
 * getOrderDetail 라인아이템 — UI/인보이스 계약(productName/quantity/unitPrice/totalAmount/taxRate).
 * 기존 호출자(page.tsx/invoice route)가 `as Record<string, unknown>` 캐스팅으로 소비 → 인덱스 시그니처 유지.
 */
interface OrderDetailItem {
  id: string;
  productName: string;
  taxRate: number;
  taxIncluded: boolean;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  cancelledAt: string | null;
  [key: string]: unknown;
}

/** getOrderDetail 주문 헤더 앵커(go orders thin anchor — DROP 후에도 생존하는 표시·앵커 컬럼). */
interface OrderDetailHeader {
  id: string;
  orderNumber: string;
  buyerName: string;
  buyerEmail: string;
  buyerPhone: string | null;
  totalAmount: string | number;
  paidAmount: string | number;
  refundAmount: string | number;
  status: string;
  paymentMethod: string | null;
  paymentStatus: string | null;
  paymentReference: string | null;
  memo: string | null;
  expiresAt: string | null;
  orderedAt: string | null;
  v2OrderId: string | null;
}

/**
 * 빅뱅 flip B3 — 주문 상세 read.
 *
 * DROP 대상(order_items + products JOIN)을 더 이상 읽지 않는다.
 *  - 주문 헤더: go orders thin 앵커(migration 171 에서 표시·앵커 컬럼은 생존 — buyer/금액/상태/메모 등).
 *    상태·환불액은 PATCH write-through 가 v2 성공 후 투영 동기화하므로 앵커가 정합 SoT 표시값.
 *  - 참석자: go attendees (go-local 워크플로 — answers/체크인. DROP 무관).
 *  - 라인아이템: v2 가 canonical(order_items SoT=v2). 빅뱅 flip #1 단건 주문 read
 *    (getOrder(v2OrderId))로 정확한 라인(상품별 quantity·unit_price·line_amount)을 가져온다.
 *    다상품 주문도 라인별 정확 단가/금액을 반영(이전 listAttendees 그룹핑 역산 복원 폐기).
 *    세율/취소시각은 v2 order read 에 미존재 → 0/false 폴백(go 세금처리 boundary).
 *
 * V2CommerceError 는 전파(미러 swallow 금지) — v2 read 실패는 주문상세 실패로 다룬다.
 */
export async function getOrderDetail(accountId: string, eventId: string, orderId: string) {
  const pool = getPool();
  const [orderResult, attendeesResult] = await Promise.all([
    pool.query<OrderDetailHeader>(
      `
        SELECT
          orders.id,
          orders.order_number AS "orderNumber",
          orders.buyer_name AS "buyerName",
          orders.buyer_email AS "buyerEmail",
          orders.buyer_phone AS "buyerPhone",
          orders.total_amount AS "totalAmount",
          orders.paid_amount AS "paidAmount",
          orders.refund_amount AS "refundAmount",
          orders.status,
          orders.payment_method AS "paymentMethod",
          orders.payment_status AS "paymentStatus",
          orders.payment_reference AS "paymentReference",
          orders.memo,
          orders.expires_at AS "expiresAt",
          orders.ordered_at AS "orderedAt",
          orders.v2_order_id AS "v2OrderId"
        -- W2-ORD: 옛 JOIN events 는 events.v2_event_id 를 노출하려고만 존재했다.
        -- go event id == v2 event id 항등이라 그 컬럼은 무의미하고(소비자 0 — grep 실측),
        -- JOIN 자체가 go events 를 주문상세 렌더의 하드 의존으로 만들고 있었다 → 제거.
        FROM orders
        WHERE orders.account_id = $1 AND orders.event_id = $2 AND orders.id = $3
        LIMIT 1
      `,
      [accountId, eventId, orderId],
    ),
    pool.query(
      `
        SELECT
          id,
          ticket_number AS "ticketNumber",
          name,
          email,
          phone,
          status,
          checked_in_at AS "checkedInAt",
          v2_ticket_id AS "v2TicketId"
        FROM attendees
        WHERE account_id = $1 AND event_id = $2 AND order_id = $3
        ORDER BY created_at ASC
      `,
      [accountId, eventId, orderId],
    ),
  ]);

  if (orderResult.rows.length === 0) {
    return null;
  }

  const header = orderResult.rows[0]!;
  const { items, platformFee, netAmount, hasPgPayment, isInvitation, isManualIssue, paymentAttempt } =
    await resolveOrderLines(header);

  return {
    ...header,
    // platformFee/netAmount: v2 단건 read SoT(fee 동결 전이면 null). invoice/정산표시 정합.
    platformFee,
    netAmount,
    hasPgPayment,
    isInvitation,
    isManualIssue,
    paymentAttempt,
    items,
    attendees: attendeesResult.rows,
  };
}

/** resolveOrderLines 결과 — 라인 + v2 단건 read 의 fee/net(fee 동결 전 null). */
interface ResolvedOrderLines {
  items: OrderDetailItem[];
  platformFee: number | null;
  netAmount: number | null;
  /** v2 `has_pg_payment`. `undefined` = 모름(앵커 미연결) — 입금확정은 fail-closed 로 막는다. */
  hasPgPayment: boolean | undefined;
  /**
   * v2 `is_invitation` — 초대권에서 나온 주문인가. 상세 화면이 결제수단 자리에 「초대권」을
   * 띄우는 근거다. `undefined`(앵커 미연결·구버전 v2) 면 **표시를 바꾸지 않는다** — 초대권이
   * 아닌 주문을 초대권으로 보이게 하는 쪽이 훨씬 비싸다(정산 오해).
   */
  isInvitation: boolean | undefined;
  /**
   * v2 `is_manual_issue` — 주최자 수동발권 주문인가. `undefined` 면 **표시를 바꾸지 않는다**
   * (`isInvitation` 과 같은 fail-safe: 모르면 지금 그대로).
   */
  isManualIssue: boolean | undefined;
  /** 🔴 결제 시도 표시 — 목록과 같은 판정을 쓴다(두 화면이 다른 말을 하면 안 된다). */
  paymentAttempt: PaymentAttemptView;
}

/**
 * 주문 라인아이템 + fee/net — 빅뱅 flip #1 단건 주문 read(getOrder)로 정확 복원.
 * v2 OrderDetail.items 는 라인별 product_name·quantity·unit_price·line_amount 를 보유하므로
 * 다상품 주문도 라인별 정확 단가/금액을 반영한다(이전 listAttendees 그룹핑·총액 역산 폐기).
 * platform_fee/net_amount 도 같은 read 로 노출(invoice 별도 go-local 쿼리 제거 — 단일 v2 호출).
 * 세율/취소시각은 v2 order read 에 미존재 → 0/false 폴백(go 세금처리 boundary).
 * v2 앵커 미연결(v2_order_id 누락) 시 빈 라인 + null fee(UI 안전). V2CommerceError 는 전파(swallow 금지).
 */
async function resolveOrderLines(header: OrderDetailHeader): Promise<ResolvedOrderLines> {
  const v2OrderId = header.v2OrderId;
  // 앵커 미연결(v2_order_id 누락) — v2 read 불가. 빈 라인으로 안전 표시.
  if (!v2OrderId) {
    // hasPgPayment 는 **모름**으로 남긴다 — 입금확정 판정이 fail-closed 로 막는다.
    return {
      items: [], platformFee: null, netAmount: null,
      hasPgPayment: undefined, isInvitation: undefined, isManualIssue: undefined,
      paymentAttempt: paymentAttemptView(undefined, header.status),
    };
  }

  let detail;
  try {
    detail = await v2GetOrder(v2OrderId, { idempotencyKey: `go-order-items:${v2OrderId}` });
  } catch (err: unknown) {
    // v2 read 실패는 전파(미러 swallow 금지) — 주문상세 자체가 실패해야 정합 깨짐을 숨기지 않음.
    if (err instanceof V2CommerceError) {
      throw err;
    }
    logger.warn("주문 라인아이템 v2 주문 read 실패", {
      v2OrderId,
      error: err instanceof Error ? err.message : "unknown",
    });
    throw err;
  }

  // v2 라인 → UI/인보이스 계약(productName/quantity/unitPrice/totalAmount). id 는 라인 안정키
  // (external_ref(=go productId) → tier_id → index 순). 세율/취소시각은 v2 미보유 → 0/false.
  const items = detail.items.map((item, index) => ({
    id: item.external_ref ?? item.tier_id ?? `${v2OrderId}:${index}`,
    productName: item.product_name ?? "상품",
    taxRate: 0,
    taxIncluded: false,
    quantity: item.quantity,
    unitPrice: item.unit_price,
    totalAmount: item.line_amount,
    cancelledAt: null,
  }));

  return {
    items,
    platformFee: detail.platform_fee,
    netAmount: detail.net_amount,
    // 무통장 입금확정 판정에 쓴다 — go payment_method 로는 카드 이탈 주문과 구분되지 않는다.
    hasPgPayment: detail.has_pg_payment,
    // 초대권 표시 판정. go orders.payment_method 는 초대권도 'offline' 로 적는다(발급 시점)
    // — 그 값으로는 수동 주문(진짜 현장결제)과 갈리지 않는다.
    isInvitation: detail.is_invitation,
    // 수동발권 표시 판정. 발권 라우트가 payment_method 에 'offline' 을 적어
    // 종전엔 「현장결제」로 보였다(0원인데).
    isManualIssue: detail.is_manual_issue,
    paymentAttempt: paymentAttemptView(detail.payment_attempts, header.status),
  };
}
