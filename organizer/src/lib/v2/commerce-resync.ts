import { getPool } from "@/lib/db/pool";
import { toCanonicalSaleMode } from "@/lib/domain-model";
import { upsertTiers } from "@/lib/v2/commerce-client";
import { resolveOwnedV2EventId } from "@/lib/v2/event-access";

export interface ResyncResult {
  v2EventId: string;
  tierCount: number;
}

/**
 * 이벤트의 커머스(상품·좌석티어)를 v2 에 재-push 한다 (P1 재동기화).
 *
 * 소유·존재를 v2 에서 확인한 뒤, go 의 ticket 상품 + seat_tiers 를 external_ref 멱등 upsert 로
 * v2 seat_tiers 에 수렴시킨다. 동기화 누락으로 v2 커머스가 비어버린 기존 이벤트("목록엔 뜨나
 * 못 사는" 유령 이벤트)를 복구하는 용도. 정본: `docs/GO_V2_COMMERCE_SYNC_AUDIT.md`.
 *
 * @throws Error 이벤트 미소유/미존재 / EventAccessError(v2 장애) / V2CommerceError 전파
 *   (호출측이 4xx/5xx 통지).
 */
export async function resyncEventCommerce(
  eventId: string,
  accountId: string,
): Promise<ResyncResult> {
  const pool = getPool();

  // 소유 확인 + v2 canonical id 회수 (레벨2 T2-EVT).
  //
  // 옛 구현은 2단계였다: go `SELECT 1 FROM events ... AND account_id=$2`(소유 게이트) +
  // `ensureV2EventAnchor`(앵커 회수·자가치유). id 승격으로 앵커 컬럼이 사라졌으므로 v2 조회 1회가
  // 둘을 겸한다 — 테넌트 경계는 v2 `organizer_ref` 가 강제한다(불일치/미존재 → 404 → null).
  // 두 옛 미스 경로(미소유 / 앵커 없음) 모두 동일 메시지로 수렴하므로 호출부 계약은 그대로다.
  //
  // ⚠️ 행동 변화: 옛 `ensureV2EventAnchor` 는 v2 에 이벤트가 없으면 **멱등 createEvent 로 생성**하는
  //    자가치유를 했다. 이제 v2 가 이벤트 정본이라 go 가 대신 만들 수 없다 — 없으면 명확히 실패한다
  //    (조용한 재생성 금지). 재동기화 대상은 "v2 에 이미 있는 이벤트의 커머스(티어)" 로 좁혀졌다.
  const v2EventId = await resolveOwnedV2EventId(eventId, accountId);
  if (!v2EventId) throw new Error("이벤트를 찾을 수 없습니다");

  const { rows: products } = await pool.query<{
    id: string;
    name: string;
    price: string | null;
    stock: number | null;
    sale_mode: string | null;
  }>(
    `SELECT id, name, price, stock, sale_mode FROM products
       WHERE event_id = $1 AND type = 'ticket' AND is_active = true`,
    [eventId],
  );
  const { rows: tiers } = await pool.query<{
    id: string;
    name: string;
    capacity: number;
    base_price: number | null;
    sale_mode: string | null;
  }>(
    `SELECT id, name, capacity, base_price, sale_mode FROM seat_tiers WHERE event_id = $1`,
    [eventId],
  );

  const inputs = [
    ...products.map((p) => ({
      external_ref: p.id,
      name: p.name,
      capacity: p.stock && p.stock > 0 ? p.stock : 1_000_000, // 무제한 sentinel
      base_price: Number(p.price ?? 0),
      sale_mode: toCanonicalSaleMode(p.sale_mode ?? "fixed_fcfs"),
    })),
    ...tiers.map((t) => ({
      external_ref: t.id,
      name: t.name,
      capacity: t.capacity > 0 ? t.capacity : 1,
      base_price: Number(t.base_price ?? 0),
      sale_mode: toCanonicalSaleMode(t.sale_mode ?? "fixed_fcfs"),
    })),
  ];
  if (inputs.length === 0) return { v2EventId, tierCount: 0 };

  // 재동기화는 명시적 강제 재실행 — 매 호출 fresh idem 키(캐시된 응답 재사용 금지 → min/max 재계산·캐시무효화 보장).
  // replace=true: go 에 없는(=삭제된) 미판매 v2 팬텀 티어를 정리 → min/max_price 정합 회복.
  const result = await upsertTiers(
    v2EventId,
    inputs,
    { idempotencyKey: `resync-commerce:${eventId}:${Date.now()}` },
    true,
  );

  // canonical tier_id 를 go 앵커에 반영(products/seat_tiers 어느 쪽이든 external_ref 매칭).
  for (const r of result.tiers) {
    if (!r.external_ref || !r.tier_id) continue;
    await pool.query(`UPDATE products SET v2_tier_id = $1, updated_at = NOW() WHERE id = $2`, [
      r.tier_id,
      r.external_ref,
    ]);
    await pool.query(`UPDATE seat_tiers SET v2_tier_id = $1, updated_at = NOW() WHERE id = $2`, [
      r.tier_id,
      r.external_ref,
    ]);
  }
  return { v2EventId, tierCount: result.tiers.length };
}
