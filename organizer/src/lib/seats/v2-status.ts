/**
 * 좌석 status v2 보강 — 빅뱅 read-flip (refactor/commerce-cutover-bigbang)
 *
 * ★ SoT 전환: seats.status 의 SoT 는 v2(seats 앵커는 go 생존하나 status 는 v2 SoT·stale).
 *   go-local seats.status 를 직접 read 하면 block/unblock 후 부정확 → v2 GET /events/{id}/seats(list_seats)
 *   live read 로 정확한 status·status_counts 를 가져온다.
 *
 * 매핑: v2 seat.external_ref = go seat id(upsertSeats 멱등키). v2_seat_id 도 직접 앵커.
 *       → external_ref 기준으로 go seat id → v2 status 맵 구성.
 *
 * 좌표/빌더 메타(section/row/x/y/tier/quality)는 go 가 정본 — 여기선 status 만 보강.
 *
 * 미앵커(v2_event_id NULL) 이벤트는 v2 좌석이 없으므로 빈 맵 반환(호출자가 go-local status 폴백 가능).
 *
 * ── 레벨2 컷오버 T2-EVT ──
 * go `events` 앵커 조회가 제거되면서 "미앵커" 상태 자체가 사라졌다(id 승격 → go id == v2 id).
 * 이벤트가 v2 에 없다는 사실은 이후 v2 호출(listSeats)의 404 가 알려준다.
 */
import type { Pool, PoolClient } from "pg";
import { listSeats, type SeatListResult } from "@/lib/v2/commerce-client";
import { toV2EventId } from "@/lib/v2/event-access";

/**
 * go DB 핸들. **더 이상 사용하지 않는다**(W2-PS: go 미read). 호출부 다수의 시그니처를 유지하려고
 * 인자만 남겼고, `null` 을 넘길 수 있게 넓혔다 — 새 호출부는 `null` 을 넘겨 go 풀을 만들지 않는다.
 */
type Queryable = Pool | PoolClient | null;

/**
 * 레벨2 컷오버 T1 — `resolveV2EventIdForMap(seatMapId)` 는 제거됐다.
 * go `seat_maps JOIN events` 로 맵→이벤트를 되짚던 함수였는데, seat_maps 가 사라지면 성립하지 않는다.
 * 빌더 라우트는 URL 에 이미 `eventId` 를 갖고 있으므로 `resolveV2EventId(db, eventId)` 를 직접 쓴다.
 */

/**
 * event_id(go) → v2 canonical event_id.
 *
 * 레벨2 T2-EVT — `SELECT v2_event_id FROM events WHERE id=$1` 제거. v2 `_do_create_event` 가
 * go event id 를 그대로 canonical id 로 채택하므로 **항등 변환**이다(DB 왕복 없음).
 * ⚠️ 미스 시맨틱 변화: 옛 코드는 앵커가 NULL 이면 null 을 돌려 호출부가 go-local 폴백/스킵을 탔지만,
 *    이제 이 레이어에 NULL 케이스가 없다 — "v2 에 그 이벤트가 있는가"는 뒤따르는 v2 호출의 404 가
 *    답한다. 호출부의 `if (!v2EventId)` 가지는 남겨둔다(계약 유지, 실질 도달 불가).
 * @param _db 계약 유지를 위해 남긴 인자(호출부 다수). 더 이상 사용하지 않는다.
 */
export async function resolveV2EventId(
  _db: Queryable,
  eventId: string,
): Promise<string | null> {
  return toV2EventId(eventId);
}

/**
 * v2 좌석 전체 페이지네이션 read. 단일 페이지(limit)로 부족하면 offset 순회.
 * status_counts/total_seats 는 첫 페이지의 집계(이벤트 전체 집계라 페이지 무관)를 사용.
 */
export async function fetchAllV2Seats(v2EventId: string): Promise<SeatListResult> {
  const PAGE = 5000; // v2 list_seats 최대 limit
  const first = await listSeats(v2EventId, { limit: PAGE, offset: 0 });
  const all = [...first.seats];
  let offset = first.page_count;
  while (offset < first.total_seats && first.page_count > 0) {
    const next = await listSeats(v2EventId, { limit: PAGE, offset });
    if (next.seats.length === 0) break;
    all.push(...next.seats);
    offset += next.page_count;
  }
  return { ...first, seats: all, page_count: all.length };
}

/**
 * go seat id → v2 status 맵. v2 seat.external_ref 가 go seat id.
 * external_ref 가 없는(레거시 미키잉) v2 좌석은 맵에 포함되지 않음(호출자 go-local 폴백).
 */
export async function fetchV2SeatStatusMap(
  v2EventId: string,
): Promise<{
  statusByGoSeatId: Map<string, string>;
  statusCounts: Record<string, number>;
  totalSeats: number;
}> {
  const result = await fetchAllV2Seats(v2EventId);
  const statusByGoSeatId = new Map<string, string>();
  for (const s of result.seats) {
    if (s.external_ref) statusByGoSeatId.set(s.external_ref, s.status);
  }
  return {
    statusByGoSeatId,
    statusCounts: result.status_counts,
    totalSeats: result.total_seats,
  };
}

/**
 * 레벨2 2차 A2 — go seat id → v2 좌석 live 행(status + 커머스 좌표) 맵.
 *
 * 빌더 GET read-flip: 좌석 상태·좌표(x/y/label/is_obstructed)를 v2 커머스 SoT 에서 live 로 읽어
 * go-local 의 stale mirror 대신 정확한 값을 투영한다. external_ref(=go seat id) 로 키잉.
 * 미앵커(v2_event_id NULL)면 빈 맵(호출자 go-local 폴백).
 */
export interface V2SeatLiveRow {
  /**
   * 레벨2 컷오버 T1 — v2 canonical seat_id. go `seats` 가 사라지면서 **이것이 좌석의 정본 id** 다.
   * 빌더 GET 이 그대로 내려주고, block/unblock(v2 seat_ids 계약)이 이 값을 받는다.
   */
  seatId: string;
  /** 결정적 좌석키(`smseat:{mapId}:{hash}`). upsertSeats 멱등키 — tier 재배정 write-through 에 필요. */
  externalRef: string;
  status: string;
  tierId: string | null;
  x: number | null;
  y: number | null;
  label: string | null;
  isObstructed: boolean;
  qualityScore: number | null;
  // 레벨2 3차 3.1 — 개별 맵 GET go select 제거 → 좌석 자연키(section/row/seat)도 v2 에서 read.
  // row/seatNumber 는 v2 int 를 문자열로 투영(권위 레이아웃은 map_data canvas). section 은 문자열.
  section: string;
  row: string;
  seatNumber: string;
}

export async function fetchV2SeatLiveMap(
  v2EventId: string,
): Promise<{
  byGoSeatId: Map<string, V2SeatLiveRow>;
  statusCounts: Record<string, number>;
  totalSeats: number;
}> {
  const result = await fetchAllV2Seats(v2EventId);
  const byGoSeatId = new Map<string, V2SeatLiveRow>();
  for (const s of result.seats) {
    if (!s.external_ref) continue; // 레거시 미키잉 좌석은 go 앵커와 매칭 불가 → 폴백.
    byGoSeatId.set(s.external_ref, {
      seatId: s.seat_id,
      externalRef: s.external_ref,
      status: s.status,
      tierId: s.tier_id ?? null,
      x: s.x ?? null,
      y: s.y ?? null,
      label: s.label ?? null,
      isObstructed: Boolean(s.is_obstructed),
      qualityScore: s.quality_score ?? null,
      section: s.section ?? "",
      row: s.row_number != null ? String(s.row_number) : "",
      seatNumber: s.seat_number != null ? String(s.seat_number) : "",
    });
  }
  return {
    byGoSeatId,
    statusCounts: result.status_counts,
    totalSeats: result.total_seats,
  };
}
