/**
 * 레벨2 read-flip — 매진 알림 대상 산출(go order_items/products.stock DROP 대비).
 *
 * 기존: `INNER JOIN order_items ON ... INNER JOIN products ... WHERE products.stock = 0`
 *   → go-local order_items(DROP 대상) + stale go products.stock 를 읽어 매진 상품을 산출.
 *
 * 전환: 재고 정본은 v2. 주문의 라인아이템(v2 getOrder.items.external_ref=go productId)과
 *   v2 티어 상태(getTiersByEvent: capacity vs sold_count)를 대조해 **이 주문으로 매진된 상품**을 산출.
 *   sold_count ≥ capacity(capacity>0) 인 티어를 매진으로 판정한다.
 *
 * 알림은 결제완료 후처리(COMMIT 후 best-effort)에서만 호출되므로 v2 조회 실패는 빈 목록으로 폴백한다
 * (매진 알림 누락 ≤ 결제완료 차단 — 알림은 비차단 부가효과). 실패는 호출자가 로깅.
 */
// W4-ORD 잔여 go DB: `orders` 앵커 1행 read 뿐(account_id·event_id·v2_order_id).
//   go order id → v2 order id 는 go 앵커에만 있는 매핑이라(주문 id 는 event id 와 달리 canonical
//   승격되지 않았다) 여기서는 앵커가 정본 진입점이다.
import { getPool } from "@/lib/db/pool";
import { logger } from "@/lib/logger";
import { getOrder, getTiersByEvent, V2CommerceError } from "@/lib/v2/commerce-client";

export interface SoldOutProduct {
  accountId: string;
  eventId: string;
  productName: string;
}

/**
 * 주어진 go orderId 로 이 주문에 포함된 상품 중 **현재 매진된 상품**의 알림 페이로드를 반환.
 * go orders 앵커에 v2_order_id 가 없으면(미앵커 주문) 빈 목록(알림 대상 아님).
 *
 * ── 🔴 W4-ORD 결함 수정: 매진 알림이 전부 죽어 있었다 ──
 * 옛 코드는 `JOIN events e` 로 `e.v2_event_id` 를 읽고 그 값이 NULL 이면 `[]` 를 반환했다.
 * 그런데 T2-EVT(go event id == v2 event id 항등 승격) 이후 **`events.v2_event_id` 를 쓰는
 * 코드가 하나도 남지 않았다**(writer 0 — grep 실측). 즉 승격 이후 만들어진 모든 이벤트는
 * 이 컬럼이 NULL 이고, 이 함수는 항상 빈 목록을 돌려줬다 → **매진 알림 무발송**.
 * 예외도 로그도 없이 "매진된 상품 0개"로 보이는 조용한 기능 사망이라 감시에 걸리지 않는다.
 * (prod 데이터 초기화 후에는 예외 없이 100% 해당된다.)
 * 조치: 죽은 앵커 컬럼과 go `events` JOIN 을 함께 제거하고 `orders.event_id` 를 v2 event id 로
 * 그대로 쓴다(항등).
 */
export async function resolveSoldOutProductsForOrder(orderId: string): Promise<SoldOutProduct[]> {
  const pool = getPool();
  const { rows } = await pool.query<{
    accountId: string;
    eventId: string;
    v2OrderId: string | null;
  }>(
    `SELECT o.account_id AS "accountId", o.event_id AS "eventId",
            o.v2_order_id AS "v2OrderId"
       FROM orders o
      WHERE o.id = $1
      LIMIT 1`,
    [orderId],
  );
  const anchor = rows[0];
  if (!anchor?.v2OrderId) {
    return [];
  }

  try {
    const [order, tierMap] = await Promise.all([
      getOrder(anchor.v2OrderId),
      // go event id == v2 event id(T2-EVT 항등) — 별도 앵커 컬럼 불필요.
      getTiersByEvent(anchor.eventId),
    ]);

    const seen = new Set<string>();
    const out: SoldOutProduct[] = [];
    for (const item of order.items) {
      const productId = item.external_ref;
      if (!productId || seen.has(productId)) continue;
      const tier = tierMap.get(productId);
      // 매진 판정: capacity>0 이고 잔여(capacity − sold_count) ≤ 0.
      if (tier && tier.capacity > 0 && tier.sold_count >= tier.capacity) {
        seen.add(productId);
        out.push({
          accountId: anchor.accountId,
          eventId: anchor.eventId,
          productName: item.product_name ?? tier.name ?? "상품",
        });
      }
    }
    return out;
  } catch (err: unknown) {
    // 알림 부가효과 — v2 조회 실패는 빈 목록(결제완료 흐름 비차단). 로깅만.
    if (!(err instanceof V2CommerceError)) {
      logger.warn("매진 알림 대상 v2 조회 실패(스킵)", {
        orderId,
        error: err instanceof Error ? err.message : "unknown",
      });
    }
    return [];
  }
}
