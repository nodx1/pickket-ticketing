/**
 * 좌석 도메인 타입 — v2 seat 모델 포팅 (Phase 2)
 *
 * v2 SQLAlchemy 모델 (backend/app/models/seat.py 및 seat_tier.py)을
 * TypeScript 타입으로 1:1 매핑.
 *
 * ── 레벨2 컷오버 T1 — go `seats` 소멸 반영 ──
 * 좌석은 더 이상 go 테이블에 존재하지 않는다(빌더가 v2 upsertSeats 로 직접 write-through).
 * 따라서 이 타입도 **v2 list_seats 가 실제로 주는 필드**만 남긴다:
 *  - 삭제: accountId·seatMapId(맵 소속은 externalRef prefix 로 판정)·productId·reservedOrderId·
 *          heldBy·holdId·holdToken·createdAt·updatedAt — 전부 go 컬럼이었고 v2 응답에 없다.
 *          (남겨두면 "" / null 로 채운 가짜 값이 화면·로직에 흘러든다.)
 *  - id 의 의미 변경: **v2 canonical seat_id**(go seats.id 아님).
 */

export type SeatStatus = "available" | "held" | "reserved" | "sold" | "blocked";

export interface Seat {
  /** v2 canonical seat_id — 좌석의 정본 id(hold/createOrder/block 이 이 값을 받는다). */
  id: string;
  /**
   * 결정적 좌석키 `smseat:{mapId}:{16hex}` (seat-generator.seatExternalRef).
   * 배치도 소속 판정·멱등키. 레거시(go uuid 를 ref 로 쓰던 좌석)는 파싱 불가라 optional.
   */
  externalRef?: string | null;
  tierId: string | null;
  section: string;
  row: string;
  seatNumber: string;
  status: SeatStatus;
  x: number | null;
  y: number | null;
  qualityScore: number | null;
  label: string | null;
  isObstructed: boolean;
  /**
   * 홀드 만료시각. v2 list_seats 는 이 값을 주지 않는다(홀드 TTL 은 v2 hold 가 소유) →
   * 서버 read 결과는 항상 null 이고, 클라이언트가 SSE 업데이트로만 채운다.
   */
  heldUntil?: string | null;
}

export interface SeatTier {
  id: string;
  accountId: string;
  eventId: string;
  seatMapId: string | null;
  productId: string | null;
  name: string;
  capacity: number;
  basePrice: number;
  facePrice: number;
  saleMode: string;
  viewDescription: string | null;
  distanceFromStage: number | null;
  viewRating: number | null;
  viewImageUrl: string | null;
  positionLabel: string | null;
  resaleAllowed: boolean;
  resaleMaxPrice: number;
  allowGroupTickets: boolean;
  maxGroupSize: number;
  colorHex: string | null;
  displayOrder: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SeatHoldRequest {
  seatIds: string[];
  ttlSeconds?: number;
}

export interface SeatHoldResponse {
  holdId: string;
  holdToken: string;
  heldSeatIds: string[];
  expiresAt: string;
}

export interface BestAvailableQuery {
  /**
   * 좌석을 좁힐 배치도 id 목록. 레벨2 T1 전에는 `seatMapId` 단건이었고 go seats.seat_map_id 로
   * 걸렀지만, 이제 좌석은 이벤트 단위(v2 list_seats)로 오고 맵 소속은 external_ref prefix 로 판정한다.
   * 비우면(또는 생략) 이벤트 전체 좌석이 후보.
   */
  mapIds?: string[] | null;
  tierId?: string;
  quantity: number;
  preferAdjacent?: boolean;
}
