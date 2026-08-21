/**
 * 좌석 리포지토리 — 레벨2 컷오버 T1: go `seats` 테이블 read/write **0**.
 *
 * ── 왜 다시 바뀌었나 ──
 * 빅뱅 flip 때는 "재고 WRITE 만 v2, 빌더 메타 READ 는 go-local" 이었다. 그 전제가 깨졌다:
 * 좌석빌더가 go `seats`/`seat_maps` 에 더 이상 INSERT 하지 않는다(레이아웃 → v2 upsertSeats 직행).
 * 즉 **go `seats` 는 항상 빈 테이블**이라 여기서 SELECT 하면 "좌석 0석"이라는 거짓말을 한다.
 *   → READ 도 전부 v2 live read(`fetchV2SeatLiveMap` = GET /events/{id}/seats)로 옮겼다.
 *
 * ── 계약 변화(호출부가 알아야 할 것) ──
 *  1. **좌석 id = v2 canonical seat_id**(uuid). go seats.id 는 존재하지 않는다.
 *     → 앵커 해석 헬퍼(resolveV2SeatIds: go id → v2 id)는 **항등이 되어 소멸**했다.
 *  2. **이벤트 단위 read**. v2 list_seats 는 이벤트 전량을 준다 → `seatMapId` 로 좌석을 고르던
 *     시그니처는 `v2EventId` + (선택) `mapIds` 로 바뀌었다. 맵 소속은 external_ref
 *     (`smseat:{mapId}:{hash}`) prefix 로 판정한다(go seats.seat_map_id 대체).
 *  3. 호출부가 **v2 canonical event_id 를 넘긴다**. go seats↔seat_maps↔events JOIN 으로
 *     이벤트를 되짚던 `resolveV2EventIdForSeat` 도 제거됐다(라우트는 이미 eventId 를 안다 →
 *     `resolveV2EventId(db, eventId)` 로 앵커만 회수).
 *  4. hold 소유권 검증(verifyHold/verifyAndMarkSold)은 사라졌다 — go `hold_id`/`held_by` 컬럼
 *     기반이었고 그 컬럼은 이제 아무도 쓰지 않는다. 권위 검증은 v2 가 hold_id 발급주체로서 수행.
 *
 * ── 트랜잭션 경계 ──
 * 이 모듈은 go DB 를 전혀 건드리지 않는다(순수 v2 클라이언트). 따라서 **PoolClient 를 받지 않고**,
 * 호출부는 go 트랜잭션 **밖**에서(또는 COMMIT 후) 호출해야 한다 —
 * 외부호출을 go 트랜잭션 안에 넣으면 원자화가 불가능해 split-brain 이 생긴다.
 *
 * 에러전파: V2CommerceError 를 swallow 금지. 4xx(HELD_BY_OTHER/SOLD_OUT 409 등)=사용자 에러,
 * 5xx=재시도 후 전파.
 */
import {
  blockSeats as v2BlockSeats,
  confirmInventory,
  holdInventory,
  releaseInventory,
  V2CommerceError,
} from "@/lib/v2/commerce-client";
import { mapIdFromSeatRef } from "./seat-generator";
import { fetchV2SeatLiveMap, type V2SeatLiveRow } from "./v2-status";
import type { BestAvailableQuery, Seat, SeatStatus } from "./types";

const SEAT_STATUSES: ReadonlySet<string> = new Set<SeatStatus>([
  "available",
  "held",
  "reserved",
  "sold",
  "blocked",
]);

/**
 * v2 status 문자열 → SeatStatus.
 * 모르는 상태를 available 로 낙관 해석하면 매진석이 판매 가능한 것처럼 노출된다(초과판매) →
 * 알 수 없으면 "판매 불가"쪽(reserved)으로 보수적으로 접는다.
 */
function toSeatStatus(raw: string): SeatStatus {
  const normalized = (raw ?? "").toLowerCase();
  return (SEAT_STATUSES.has(normalized) ? normalized : "reserved") as SeatStatus;
}

/** v2 live 행 → 좌석 도메인 객체. id = v2 canonical seat_id(정본). */
function liveToSeat(live: V2SeatLiveRow): Seat {
  return {
    id: live.seatId,
    externalRef: live.externalRef,
    tierId: live.tierId,
    section: live.section,
    row: live.row,
    seatNumber: live.seatNumber,
    status: toSeatStatus(live.status),
    x: live.x,
    y: live.y,
    qualityScore: live.qualityScore,
    label: live.label,
    isObstructed: live.isObstructed,
    // v2 list_seats 는 홀드 만료시각을 주지 않는다(홀드는 v2 hold 가 소유).
    heldUntil: null,
  };
}

/** 기존 `ORDER BY section, row, seat_number::int` 를 in-memory 로 재현. */
function compareSeats(a: Seat, b: Seat): number {
  const bySection = a.section.localeCompare(b.section);
  if (bySection !== 0) return bySection;
  const byRow = a.row.localeCompare(b.row);
  if (byRow !== 0) return byRow;
  const an = Number.parseInt(a.seatNumber, 10);
  const bn = Number.parseInt(b.seatNumber, 10);
  if (Number.isFinite(an) && Number.isFinite(bn) && an !== bn) return an - bn;
  return a.seatNumber.localeCompare(b.seatNumber);
}

/** 품질점수 내림차순(NULLS LAST) → 자연키 — 기존 추천 정렬과 동일. */
function compareByQuality(a: Seat, b: Seat): number {
  const aq = a.qualityScore ?? Number.NEGATIVE_INFINITY;
  const bq = b.qualityScore ?? Number.NEGATIVE_INFINITY;
  if (aq !== bq) return bq - aq;
  return compareSeats(a, b);
}

export interface SeatReadQuery {
  /**
   * 이 배치도들의 좌석만. 미지정/빈 배열이면 이벤트 전량.
   * 맵을 판정할 수 없는 레거시 좌석(external_ref 가 `smseat:` 형식이 아님)은 **보존**한다 —
   * 단일맵 계약상 그 이벤트 좌석이 맞고, 배제하면 레거시 이벤트가 통째로 사라진다.
   */
  mapIds?: string[] | null;
  status?: SeatStatus;
  tierId?: string;
}

/** 좌석이 지정 배치도 집합에 속하는지(맵 불명=속함). 공개 경로의 published 게이트에 쓴다. */
export function seatBelongsToMaps(seat: Seat, mapIds: ReadonlySet<string>): boolean {
  const mapId = mapIdFromSeatRef(seat.externalRef);
  return mapId === null || mapIds.has(mapId);
}

/**
 * 이벤트 좌석 live read(v2 SoT). 모든 READ 의 단일 입구.
 * @throws V2CommerceError — v2 실패(호출부가 502 로 통지). go 폴백은 존재하지 않는다.
 */
async function readEventSeats(
  v2EventId: string,
  query: SeatReadQuery = {},
): Promise<Seat[]> {
  const { byGoSeatId } = await fetchV2SeatLiveMap(v2EventId);
  const mapFilter =
    query.mapIds && query.mapIds.length > 0 ? new Set(query.mapIds) : null;
  const seats: Seat[] = [];
  for (const live of byGoSeatId.values()) {
    const seat = liveToSeat(live);
    if (mapFilter && !seatBelongsToMaps(seat, mapFilter)) continue;
    if (query.status && seat.status !== query.status) continue;
    if (query.tierId && seat.tierId !== query.tierId) continue;
    seats.push(seat);
  }
  return seats.sort(compareSeats);
}

export const seatRepo = {
  // ───────────────────────────────────────────────────────────────────────────
  // READ — v2 live read(GET /events/{id}/seats). go-local SELECT 없음.
  // ★ 첫 인자는 **v2 canonical event_id**(events.v2_event_id) — go eventId 아님.
  // ───────────────────────────────────────────────────────────────────────────

  /** 1. 단일 좌석 조회. seatId = v2 canonical seat_id. */
  async getById(v2EventId: string, seatId: string): Promise<Seat | null> {
    const seats = await readEventSeats(v2EventId);
    return seats.find((s) => s.id === seatId) ?? null;
  },

  /**
   * 2. 이벤트 좌석 목록 (필터: mapIds, status, tierId).
   * ★ 구 `getByMap(client, seatMapId, ...)` 대체 — v2 list_seats 가 이벤트 전량을 주므로
   *   맵 단위 조회는 external_ref prefix 필터로 표현한다.
   */
  async getByEvent(v2EventId: string, query?: SeatReadQuery): Promise<Seat[]> {
    return readEventSeats(v2EventId, query);
  },

  /** 3. 특정 티어의 가용 좌석 (품질 점수 내림차순). */
  async getAvailableByTier(
    v2EventId: string,
    tierId: string,
    limit = 100,
    opts?: { mapIds?: string[] | null },
  ): Promise<Seat[]> {
    const seats = await readEventSeats(v2EventId, {
      status: "available",
      tierId,
      mapIds: opts?.mapIds,
    });
    return seats.sort(compareByQuality).slice(0, Math.max(0, limit));
  },

  // ───────────────────────────────────────────────────────────────────────────
  // WRITE — v2 재고 API write-through. 앵커 해석 없음(seatIds 가 이미 v2 canonical).
  // ★ go 트랜잭션 **밖**에서 호출할 것(외부호출+로컬커밋 원자화 불가).
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * 4. 좌석 홀드 — v2 POST /inventory/hold(HELD, TTL).
   * ★ heldBy 는 v2 buyer uuid(회원). 익명 소비자는 생략 → held_by NULL, hold_id 가 bearer 소유권.
   *   v2 가 hold_id 를 발급·소유 → go 의 HMAC hold_token 은 폐기(holdToken="" 반환, 호환 유지).
   * HELD_BY_OTHER / SOLD_OUT 는 V2CommerceError(409) 로 전파 → 호출자가 사용자 에러로 변환.
   *
   * ★ T1 개선: 반환 held/failed 를 v2 응답(canonical seat_id)과 **정확히 대조**한다.
   *   과거엔 go id ↔ v2 id 가 달라 "전부 성공/전부 실패"로 근사했지만, 이제 같은 id 공간이라
   *   부분 홀드도 정확히 구분된다.
   */
  async holdSeats(args: {
    /** v2 canonical event_id. */
    v2EventId: string;
    /** v2 canonical seat_id[]. */
    seatIds: string[];
    /** v2 buyer uuid(회원). 익명이면 생략. */
    heldBy?: string | null;
    ttlSeconds?: number;
  }): Promise<{
    held: string[];
    failed: string[];
    holdId: string;
    holdToken: string;
    expiresAt: string;
  }> {
    if (args.seatIds.length === 0) {
      throw new V2CommerceError("홀드할 좌석이 없습니다", 400);
    }
    const { hold_id, expires_at, held } = await holdInventory({
      event_id: args.v2EventId,
      seat_ids: args.seatIds,
      user_id: args.heldBy ?? undefined, // 익명이면 생략 → v2 held_by NULL
      ttl_seconds: args.ttlSeconds ?? 600,
    });
    const heldSet = new Set(held);
    return {
      held: args.seatIds.filter((id) => heldSet.has(id)),
      failed: args.seatIds.filter((id) => !heldSet.has(id)),
      holdId: hold_id,
      holdToken: "", // v2 hold_id 가 소유권 식별자 — go HMAC token 폐기.
      expiresAt: expires_at,
    };
  },

  /**
   * 4b. 홀드 확정 — v2 POST /inventory/confirm(HELD→SOLD, 멱등).
   * ★ W3.2 createOrder 경로는 좌석 SOLD 를 이미 확정하므로 confirm 불필요.
   *   별도 hold→confirm 레거시 좌석 체크아웃에서만 호출. holdId = v2 hold_id.
   *   멱등: 이미 SOLD 인 좌석도 confirmed 에 포함되므로 동시 2회/재시도 안전.
   */
  async confirmHold(holdId: string): Promise<string[]> {
    const { confirmed } = await confirmInventory(holdId);
    return confirmed;
  },

  /**
   * 5. 판매 완료 처리 — 폐기. 좌석 SOLD 확정은 v2 createOrder(W3.2)/confirmHold(4b) 가 원자 소유.
   */
  async markSold(_args: { seatIds: string[]; orderId: string }): Promise<void> {
    throw new V2CommerceError(
      "markSold 폐기: 좌석 SOLD 는 v2 createOrder/confirmHold 가 원자 소유 (go 직접 마킹 금지)",
      500,
    );
  },

  /** 6. 예약 처리 — 폐기. 결제대기 예약 상태도 v2 주문/hold 상태머신이 소유. */
  async markReserved(_args: { seatIds: string[]; orderId: string }): Promise<void> {
    throw new V2CommerceError(
      "markReserved 폐기: 예약 상태는 v2 hold/주문 상태머신이 소유",
      500,
    );
  },

  /**
   * 7. 홀드 해제 — v2 POST /inventory/release({seat_ids}).
   * ★ 소유권 검증은 v2 가 hold_id/소유자 기준으로 수행. seat_ids 기반 만료/취소 해제용.
   */
  async releaseHolds(v2EventId: string, seatIds: string[]): Promise<number> {
    if (seatIds.length === 0) return 0;
    const { released } = await releaseInventory({
      seat_ids: seatIds,
      reason: "refund",
      event_id: v2EventId,
    });
    return released;
  },

  /**
   * 8. 판매된 좌석 복원 (환불/취소) — v2 POST /inventory/release({seat_ids,reason:"refund"}).
   * SOLD→AVAILABLE + 티켓 CANCELLED 를 v2 가 원자 수행.
   * ★ 일반적으로 환불은 refundOrder(주문 단위)가 좌석 release 까지 원자 수행하므로,
   *   주문 앵커 없이 좌석만 직접 복원해야 하는 예외 경로에서만 사용.
   */
  async releaseSold(v2EventId: string, seatIds: string[]): Promise<number> {
    if (seatIds.length === 0) return 0;
    const { released } = await releaseInventory({
      seat_ids: seatIds,
      reason: "refund",
      event_id: v2EventId,
    });
    return released;
  },

  /**
   * 9. holdId 기준 해제 — v2 POST /inventory/release({hold_id}).
   * ★ 소유권 검증은 v2 가 hold_id 발급주체로서 수행 → go 의 HMAC/세션 검증 폐기.
   *   멱등: 이미 해제된 hold 는 released=0 으로 수렴(재시도·중복클릭 안전).
   */
  async releaseByHoldId(holdId: string): Promise<number> {
    const { released } = await releaseInventory({ hold_id: holdId });
    return released;
  },

  /**
   * 10. 사용자 단위 홀드 전체 해제 — 폐기. v2 release 는 hold_id/seat_ids 키 기반이라
   *   "맵+사용자" 광역 해제에 대응하는 엔드포인트가 없다.
   */
  async releaseHoldsByUser(_heldBy: string): Promise<number> {
    throw new V2CommerceError(
      "releaseHoldsByUser 폐기: v2 release 는 hold_id/seat_ids 키 기반 — 호출자가 보유 hold_id 로 releaseByHoldId 호출",
      500,
    );
  },

  /**
   * 11. 만료 홀드 정리 — 폐기. seat-hold-reaper.ts 가 reapInventory(commerce-client)를 직접 호출.
   */
  async cleanupExpiredHolds(): Promise<{ released: number; seatIds: string[] }> {
    throw new V2CommerceError(
      "cleanupExpiredHolds 폐기: 만료 정리는 v2 reapInventory(seat-hold-reaper.ts) 가 소유",
      500,
    );
  },

  /**
   * 12. Best-Available — 품질 점수 + 인접성 기반 추천(후보 선정만, 실제 hold 는 holdSeats).
   * 상태(available)·차단(is_obstructed) 판정은 v2 live 값 기준.
   */
  async getBestAvailable(
    v2EventId: string,
    args: BestAvailableQuery,
  ): Promise<Seat[]> {
    const { tierId, quantity, preferAdjacent = true, mapIds } = args;
    const pool = (
      await readEventSeats(v2EventId, { status: "available", tierId, mapIds })
    ).filter((s) => !s.isObstructed);
    // 후보는 요청 수량의 5배까지(기존 SQL LIMIT quantity*5 와 동일).
    const candidates = pool.sort(compareByQuality).slice(0, quantity * 5);
    if (candidates.length === 0 || !preferAdjacent || quantity <= 1) {
      return candidates.slice(0, quantity);
    }
    // 슬라이딩 윈도우로 인접 좌석 찾기
    const groups: Record<string, Seat[]> = {};
    for (const seat of candidates) {
      const key = `${seat.section}:${seat.row}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(seat);
    }
    let bestGroup: Seat[] | null = null;
    let bestScore = -1;
    for (const key of Object.keys(groups)) {
      const rowSeats = groups[key].sort(
        (a, b) => Number(a.seatNumber) - Number(b.seatNumber),
      );
      for (let i = 0; i <= rowSeats.length - quantity; i++) {
        const window = rowSeats.slice(i, i + quantity);
        const isAdjacent = window.every(
          (s, idx) =>
            idx === 0 ||
            Number(s.seatNumber) - Number(window[idx - 1].seatNumber) === 1,
        );
        if (isAdjacent) {
          const avgScore =
            window.reduce((sum, s) => sum + (s.qualityScore ?? 0.5), 0) /
            window.length;
          if (avgScore > bestScore) {
            bestScore = avgScore;
            bestGroup = window;
          }
        }
      }
    }
    return bestGroup ?? candidates.slice(0, quantity);
  },

  /**
   * 13. 좌석 차단 (관리자 — 판매중지/정비) — v2 POST /inventory/block(→RESERVED).
   * ★ SOLD/HELD 좌석은 v2 가 409. → affected 수 반환.
   */
  async blockSeats(v2EventId: string, seatIds: string[]): Promise<number> {
    if (seatIds.length === 0) return 0;
    const { affected } = await v2BlockSeats({
      event_id: v2EventId,
      seat_ids: seatIds,
    });
    return affected;
  },
};
