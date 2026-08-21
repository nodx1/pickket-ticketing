/**
 * 레벨2 컷오버 T1 — 배치도 레이아웃 → v2 좌석 인벤토리 write-through (go `seats` 미사용).
 *
 * ── 이전 구조 ──
 * 빌더가 go `seats` 에 INSERT → 다시 SELECT → v2 upsertSeats → 응답 seat_id 를 go `seats.v2_seat_id` 에 역기입.
 * go DB 를 지우면 이 3단 왕복이 전부 성립하지 않는다.
 *
 * ── 지금 구조 ──
 * 캔버스(map_data)에서 파생한 좌석을 **바로** v2 로 보낸다. 좌석 정체성은 결정적 external_ref
 * (`smseat:{mapId}:{hash(자연키)}`)가 담보하므로 go 앵커 테이블이 필요 없다.
 *
 * ── 멱등성 ("동시 2회 실행하면?") ──
 * external_ref 가 레이아웃에서 결정적으로 파생되므로, 같은 레이아웃을 동시에 두 번 저장해도
 * v2 는 **같은 좌석행을 두 번 update** 할 뿐 중복 생성되지 않는다(v2 `ix_seats_external_ref` UNIQUE).
 * 서로 다른 레이아웃이 경합하면 나중 것이 이긴다(last-write-wins) — 빌더는 맵당 단일 편집자
 * (collab=presence-only)라 실무상 노출이 낮고, 어느 쪽이 이겨도 v2 상태는 그 레이아웃과 정합한다.
 *
 * ── 트랜잭션 경계 ("외부호출 후 crash 하면?") ──
 * 호출부는 **go 로컬 커밋 이후** 이 함수를 부른다. 여기서 crash 해도 v2 는 직전 확정 상태로 남고,
 * 다음 저장이 같은 레이아웃을 재전송하면 같은 external_ref 로 수렴한다(재시도 안전).
 * 반대로 v2 만 성공하고 go 커밋이 실패하는 순서는 만들지 않는다.
 *
 * ── 삭제(축소) 처리 ──
 * `replace` + `scope_prefix` 로 **이 맵 소속(prefix 일치) 중 페이로드에 없는 좌석**을 v2 가 정리한다.
 * SOLD/HELD 는 v2 가 보호해 삭제되지 않는다(결제분 안전). 다른 맵·import 경로 좌석은 prefix 밖이라 무사.
 */
import type { Pool, PoolClient } from "pg";

import { upsertSeats } from "@/lib/v2/commerce-client";

import {
  seatRefPrefix,
  toSeatUpsertInputs,
  type GeneratedLayout,
} from "./seat-generator";
import { resolveV2EventId } from "./v2-status";

/** W2-PS: go 미read. 인자만 남은 핸들 — `null` 허용. */
type Queryable = Pool | PoolClient | null;

/**
 * 레이아웃의 좌석을 v2 커머스 SoT 로 write-through 한다.
 *
 * - tier 미배정 좌석은 v2 계약상 전송 불가(tier_id 필수) → 제외된다. 그런 좌석만 있는 맵은
 *   빈 페이로드가 되지만 **replace 정리는 그대로 수행**한다(티어를 떼면 v2 에서도 사라져야 하므로).
 * - v2 앵커(v2_event_id)가 아직 없으면 조용히 스킵 — 이벤트 write-through 가 앵커를 만든 뒤
 *   다음 저장에서 전송된다(에러 아님).
 *
 * @throws V2CommerceError — v2 write 실패(호출부가 502 로 사용자에게 통지).
 */
export async function writeThroughLayoutSeats(
  db: Queryable,
  eventId: string,
  mapId: string,
  layout: GeneratedLayout,
  idempotencyKey: string,
): Promise<{ pushed: boolean }> {
  const v2EventId = await resolveV2EventId(db, eventId);
  if (!v2EventId) return { pushed: false };

  await upsertSeats(
    v2EventId,
    toSeatUpsertInputs(layout.seats),
    { idempotencyKey },
    { replace: true, scopePrefix: seatRefPrefix(mapId) },
  );
  return { pushed: true };
}
