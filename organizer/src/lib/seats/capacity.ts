/**
 * 정원 산출·반영 — 레벨2 컷오버 wave2 **W2-PS**(go DB 미read·미write).
 *
 * ── 이전 구조 ──
 * 좌석수를 레이아웃에서 세고 결과를 go 에 썼다:
 *   `UPDATE events SET max_attendees = …` + `UPDATE seat_tiers SET capacity = …`
 * go `seat_tiers` 가 사라지면 후자가 성립하지 않고, 전자는 v2 가 이미 파생하는 값이다.
 *
 * ── 지금 구조 ──
 * 산출은 그대로(레이아웃 + v2 live status 보정), **반영은 v2 티어 카탈로그로 write-through** 한다.
 *  - tier capacity → v2 `seat_tiers.capacity`(카탈로그 정본).
 *  - events.max_attendees → **더 쓰지 않는다**. v2 `_do_upsert_tiers` 가 같은 호출 안에서
 *    `event.total_seats` 를 티어 capacity 집계로 재계산하므로 별도 write 가 중복이자
 *    갈라짐의 원인이다(go 투영 테이블 write 제거 = W2-PS 목표).
 *
 * ── capacity 정본 판정(실측) ──
 * dev DB 대조 결과 go 값과 v2 값은 **전부 일치**했다(products.stock 100/100 ×2,
 * seat_tiers.capacity 6/6·20/20). 즉 go 쪽은 write-through 미러였을 뿐 독립 권위가 없었다.
 * 반면 초과판매를 원자적으로 막는 불변식(`sold_count <= capacity`, `capacity - sold >= 1`)은
 * **v2 에만** 있다 → **v2 seat_tiers.capacity 가 정본**이다.
 *
 * ── 트랜잭션 경계 ──
 * 산출(v2 read)·반영(v2 write) 모두 외부호출이다. 호출부는 로컬 확정 **후** 부른다.
 * 도중 crash 해도 v2 는 직전 확정 상태로 남고, 다음 저장이 같은 레이아웃을 재전송해 수렴한다
 * (external_ref 멱등 upsert). 동시 2회 실행은 같은 티어행을 두 번 update 할 뿐이다.
 */
import type { Pool, PoolClient } from "pg";

import {
  countSellableByTier,
  type GeneratedLayout,
} from "./seat-generator";
import { fetchV2SeatStatusMap, resolveV2EventId } from "./v2-status";
import { loadCatalog, toSeatTierUpsert } from "@/lib/v2/tier-catalog";
import { upsertTierCatalog } from "@/lib/v2/commerce-client";

/**
 * go DB 핸들. **더 이상 사용하지 않는다** — 호출부 다수(범위 밖 라우트 포함)의 시그니처를
 * 유지하기 위해 인자만 남겼다. `null` 을 넘겨도 동작한다.
 */
type Queryable = Pool | PoolClient | null;

/**
 * v2 에서 "판매대상 아님"으로 보는 상태.
 * - reserved: organizer 판매중지(block). v2 가 좌석을 RESERVED 로 잠근다.
 * - blocked : v2 레거시 어휘 방어(현 enum 에는 없으나 응답 방어).
 * sold/held/available 은 전부 산입 — 점유 여부와 무관하게 "구성된 좌석수"가 정원이다.
 */
const V2_EXCLUDED_STATUSES = new Set(["reserved", "blocked"]);

/** 레이아웃 + v2 live status 로 "판매대상 좌석"만 남긴다(차단 규칙 합집합). */
function sellableSeats(
  layout: GeneratedLayout,
  statusByRef: Map<string, string> | null,
): GeneratedLayout["seats"] {
  return layout.seats.filter((s) => {
    if (s.blocked) return false; // 규칙1 — 캔버스 차단석
    const v2Status = statusByRef?.get(s.externalRef);
    if (v2Status && V2_EXCLUDED_STATUSES.has(v2Status)) return false; // 규칙2 — v2 판매중지
    return true;
  });
}

/** 산출 결과 — v2 read 를 끝낸 순수 숫자. */
export interface ComputedCapacity {
  /**
   * 좌석+스탠딩 총 정원(0이면 null = 정원 미설정).
   * ⚠️ 더 이상 go `events.max_attendees` 로 쓰이지 않는다(v2 가 total_seats 를 파생).
   *   관측·테스트용 산출값으로만 남는다.
   */
  maxAttendees: number | null;
  /** tierId(= v2 external_ref) → 반영할 capacity. */
  capacityByTier: Map<string, number>;
}

/**
 * 정원 산출 — v2 live read 를 포함하므로 트랜잭션 밖에서 호출한다.
 *
 *   지정석 = 레이아웃 좌석 중 판매대상(캔버스 차단·v2 판매중지 제외)
 *   스탠딩 = 캔버스 standing 섹션 capacity 합
 *   tier capacity = 해당 tier 지정석 판매대상 수 + 해당 tier standing capacity 합
 *
 * @param _db 사용하지 않음(호출부 시그니처 유지용).
 */
export async function computeCapacity(
  _db: Queryable,
  eventId: string,
  layout: GeneratedLayout,
): Promise<ComputedCapacity> {
  const v2EventId = await resolveV2EventId(_db, eventId);
  const statusByRef = v2EventId
    ? (await fetchV2SeatStatusMap(v2EventId)).statusByGoSeatId
    : null;

  const sellable = sellableSeats(layout, statusByRef);
  const assignedByTier = countSellableByTier({ ...layout, seats: sellable });

  const capacityByTier = new Map<string, number>();
  for (const tierId of new Set([...layout.standingByTier.keys(), ...assignedByTier.keys()])) {
    capacityByTier.set(
      tierId,
      (assignedByTier.get(tierId) ?? 0) + (layout.standingByTier.get(tierId) ?? 0),
    );
  }

  const total = sellable.length + layout.standingTotal;
  return { maxAttendees: total > 0 ? total : null, capacityByTier };
}

/**
 * 산출된 정원을 **v2 티어 카탈로그**에 반영한다(go write 폐기).
 *
 * ⚠️ v2 upsert 계약은 전량 upsert 라 `name`/`base_price` 등을 함께 실어야 한다 →
 *    현재 카탈로그를 먼저 읽어 **capacity 만 교체**한 페이로드를 만든다. 카탈로그 조회에
 *    실패하면 아무것도 쓰지 않고 throw 한다(추측값으로 정원을 덮어쓰지 않는다).
 *
 * ⚠️ 레이아웃에 없는 tierId 는 건드리지 않는다(다른 배치도 소속 등급을 0으로 지우지 않기 위해).
 *
 * @param _client 사용하지 않음(호출부 시그니처 유지용). **외부호출이므로 트랜잭션 밖 호출 권장.**
 * @throws V2CommerceError
 */
export async function persistCapacity(
  _client: PoolClient | null,
  eventId: string,
  accountId: string,
  computed: ComputedCapacity,
): Promise<void> {
  if (computed.capacityByTier.size === 0) return;
  const v2EventId = await resolveV2EventId(null, eventId);
  if (!v2EventId) return;

  const entries = await loadCatalog(v2EventId);
  const byRef = new Map(entries.map((e) => [e.ref, e]));
  const payload = [];
  for (const [tierRef, capacity] of computed.capacityByTier) {
    const current = byRef.get(tierRef);
    if (!current) continue; // v2 에 없는 tier — 좌석 write-through 가 먼저 만들어야 한다.
    const upsert = toSeatTierUpsert({
      ref: tierRef,
      name: current.row.name,
      capacity,
      basePrice: Number(current.row.base_price ?? 0),
      facePrice: current.row.face_price,
      saleMode: current.row.sale_mode,
      colorHex: current.row.color_hex,
      displayOrder: current.row.sort_order,
      seatMapId: current.row.seat_map_id,
    });
    // 🔴 출처(go_source)·상품유형을 **덮어쓰지 않는다**. 정원 반영은 capacity 만 바꾸는 작업인데
    //    여기서 seat_tier 로 재분류하면 상품이 상품 목록에서 사라진다(화면 유실).
    if (current.row.tier_metadata) upsert.tier_metadata = current.row.tier_metadata;
    if (current.row.product_type) upsert.product_type = current.row.product_type;
    payload.push(upsert);
  }
  if (payload.length === 0) return;

  await upsertTierCatalog(v2EventId, payload, {
    // fresh 키 — 정원은 저장할 때마다 달라질 수 있어 캐시 응답 재사용을 막는다.
    idempotencyKey: `capacity-sync:${eventId}:${Date.now()}`,
  });
  void accountId; // 테넌트 경계는 호출부의 소유 검증(requireOwnedEvent)이 이미 강제했다.
}

/**
 * 산출 + 반영 편의 래퍼. 전부 외부호출이라 트랜잭션을 열지 않는다.
 * @param _pool 사용하지 않음(호출부 시그니처 유지용).
 */
export async function syncCapacityFromLayout(
  _pool: Pool | null,
  eventId: string,
  accountId: string,
  layout: GeneratedLayout,
): Promise<ComputedCapacity> {
  const computed = await computeCapacity(null, eventId, layout);
  await persistCapacity(null, eventId, accountId, computed);
  return computed;
}
