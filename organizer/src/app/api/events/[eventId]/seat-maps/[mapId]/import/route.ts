/**
 * 좌석 대량 import (CSV/좌표 붙여넣기 등) — 레벨2 컷오버 T1
 *
 * ── 변경 ──
 * 이전엔 go `seats` 에 벌크 INSERT 한 뒤 그 RETURNING id 를 external_ref 로 삼아 v2 로 write-through 했다.
 * go 좌석 스테이징이 사라지면서 **요청 본문에서 바로 v2 로** 보낸다(go INSERT/UPDATE 없음).
 * external_ref 는 좌석 자연키에서 결정적으로 파생하므로(`seatExternalRef`) go 앵커가 필요 없고,
 * 같은 파일을 두 번 import 해도 같은 좌석을 갱신할 뿐 중복 생성되지 않는다(멱등).
 *
 * ⚠️ import 좌석은 캔버스(map_data)에 없다. 이후 빌더가 figmaLayout 을 전체 저장하면
 *    `replace`(scope=이 맵) 정리 대상이 되어 사라진다 — go 시절 `DELETE FROM seats WHERE seat_map_id`
 *    가 import 분까지 지우던 것과 **동일한 기존 동작**이다.
 */
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { rowToNumber, seatExternalRef } from "@/lib/seats/seat-generator";
import { fetchSeatMapEntry } from "@/lib/v2/seat-map-payload";
import { upsertSeats, V2CommerceError, type SeatUpsertInput } from "@/lib/v2/commerce-client";
import { EventAccessError } from "@/lib/v2/event-access";

type Params = { eventId: string; mapId: string };

interface ImportSeat {
  section: string;
  row: string;
  seatNumber: string;
  status?: string;
  tierId?: string | null;
  x?: number | null;
  y?: number | null;
  qualityScore?: number | null;
  label?: string | null;
  isObstructed?: boolean;
}

/** go 빌더 어휘 → v2 SeatStatus. v2 에는 blocked 가 없어 판매중지(reserved)로 매핑. */
function toV2Status(status: string | undefined): string {
  return status === "blocked" ? "reserved" : "available";
}

export const POST = withRole<Params>("organizer", async (request, { session, params }) => {
  const { eventId, mapId } = params;
  const body = (await request.json()) as { seats?: ImportSeat[] };

  const seats = body.seats ?? [];
  if (seats.length === 0) {
    return errorResponse("가져올 좌석 데이터가 없습니다", 400);
  }
  if (seats.length > 5000) {
    return errorResponse("한 번에 최대 5,000개 좌석까지 가져올 수 있습니다", 400);
  }

  const pool = getPool();

  // 소유권 확인 — 맵이 세션 계정 소유 이벤트에 속하는지. v2 seat_map_data(SoT) 기준(go seat_maps 미read).
  let owned: Awaited<ReturnType<typeof fetchSeatMapEntry>>;
  try {
    owned = await fetchSeatMapEntry(pool, eventId, mapId, session.accountId);
  } catch (err: unknown) {
    // 🔴 레벨2 T2-EVT — fetchSeatMapEntry 의 소유 검증이 v2 조회로 바뀌면서 v2 응답불가는
    //    EventAccessError 로 온다(안 잡으면 정체불명 500). 소유 확인 불가 상태로 import 를
    //    진행하지 않는다(fail-closed) — 404 가 아니라 재시도 가능한 503.
    if (err instanceof EventAccessError) {
      return errorResponse("이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    if (err instanceof V2CommerceError) {
      return errorResponse("좌석 배치도를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 502);
    }
    throw err;
  }
  if (!owned) {
    return errorResponse("좌석 배치도를 찾을 수 없습니다", 404);
  }

  // tier 미배정 좌석은 v2 계약상 전송 불가(tier_id 필수) → 제외한다.
  // (go 시절엔 tier 없이도 스테이징됐지만 v2 로는 어차피 안 갔다 — 동작 동일.)
  const payload: SeatUpsertInput[] = seats
    .filter((s) => s.tierId)
    .map((s) => ({
      external_ref: seatExternalRef(mapId, s.section, s.row, s.seatNumber),
      section: s.section,
      row_number: rowToNumber(s.row),
      seat_number: Number.parseInt(s.seatNumber, 10) || 0,
      tier_ref: s.tierId as string,
      ...(s.x != null ? { x: s.x } : {}),
      ...(s.y != null ? { y: s.y } : {}),
      ...(s.qualityScore != null ? { quality_score: s.qualityScore } : {}),
      label: s.label ?? null,
      is_obstructed: s.isObstructed ?? false,
      status: toV2Status(s.status),
    }));

  if (payload.length === 0) {
    return errorResponse("등급이 배정된 좌석이 없습니다. 좌석 등급을 지정해주세요.", 400);
  }

  // ── v2 커머스 SoT 로 전송(추가 upsert — replace 아님: import 는 기존 좌석을 지우지 않는다). ──
  // 멱등키에 맵+좌석수를 넣어 재시도 안전. 실패 시 502(백업 저장소가 없으므로 조용한 유실 금지).
  try {
    await upsertSeats(owned.v2EventId, payload, {
      idempotencyKey: `seatmap-import:${mapId}:${Date.now()}`,
    });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse("좌석 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.", 502);
    }
    throw err;
  }

  return successResponse({ imported: payload.length }, 201);
});
