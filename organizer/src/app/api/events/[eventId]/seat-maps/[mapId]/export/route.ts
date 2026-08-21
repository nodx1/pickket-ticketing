/**
 * 트랙 2.15 — 좌석맵 전체 JSON 내보내기
 *
 * GET /api/events/{eventId}/seat-maps/{mapId}/export
 *   ?format=json (기본) | csv
 *
 * JSON: { map, seats, landmarks, groups, tiers }
 * CSV: section,row,seat_number,x,y,tier_id,quality_score,label,is_obstructed
 */
import { errorResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { fetchV2SeatLiveMap } from "@/lib/seats/v2-status";
import { fetchSeatMapEntry } from "@/lib/v2/seat-map-payload";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError } from "@/lib/v2/event-access";

type Params = { eventId: string; mapId: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const GET = withRole<Params>(
  "organizer",
  async (request, { session, params }) => {
    if (!UUID_RE.test(params.mapId)) {
      return errorResponse("잘못된 좌석맵 ID 입니다", 400);
    }
    const url = new URL(request.url);
    const format = (url.searchParams.get("format") ?? "json").toLowerCase();

    const pool = getPool();

    // ── 레벨2 컷오버 T1 — 소유권·맵 헤더·좌석 전부 v2 에서 read(go seat_maps/seats 미read) ──
    // 좌석은 v2 list_seats 가 정본(구조·상태·좌표 모두). 이전엔 go 가 좌표 정본이고 status 만 v2 보강이었다.
    let owned: Awaited<ReturnType<typeof fetchSeatMapEntry>>;
    let live: Awaited<ReturnType<typeof fetchV2SeatLiveMap>> | null = null;
    try {
      owned = await fetchSeatMapEntry(pool, params.eventId, params.mapId, session.accountId);
      if (owned) live = await fetchV2SeatLiveMap(owned.v2EventId);
    } catch (err: unknown) {
      // 🔴 레벨2 T2-EVT — fetchSeatMapEntry 의 소유 검증이 v2 조회로 바뀌면서 v2 응답불가는
      //    EventAccessError 로 온다(안 잡으면 정체불명 500). 404(없음)와 분리해 503 으로.
      if (err instanceof EventAccessError) {
        return errorResponse("이벤트 정보를 확인하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
      }
      if (err instanceof V2CommerceError) {
        return errorResponse("좌석맵을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 502);
      }
      throw err;
    }
    if (!owned || !live) {
      return errorResponse("좌석맵을 찾을 수 없습니다", 404);
    }
    const entry = owned.entry;
    const mapOut = {
      id: entry.id,
      name: entry.name,
      status: entry.status,
      mapData: entry.map_data ?? null,
      backgroundUrl: entry.background?.url ?? null,
      backgroundOpacity: entry.background?.opacity ?? null,
    };

    const seatRows = [...live.byGoSeatId.values()]
      .map((s) => ({
        id: s.seatId,
        externalRef: s.externalRef,
        section: s.section,
        row: s.row,
        seatNumber: s.seatNumber,
        status: s.status,
        tierId: s.tierId,
        x: s.x,
        y: s.y,
        qualityScore: s.qualityScore,
        label: s.label,
        isObstructed: s.isObstructed,
      }))
      .sort(
        (a, b) =>
          a.section.localeCompare(b.section) ||
          a.row.localeCompare(b.row) ||
          (Number(a.seatNumber) || 0) - (Number(b.seatNumber) || 0),
      );

    if (format === "csv") {
      const header =
        "section,row,seat_number,x,y,tier_id,quality_score,label,is_obstructed\n";
      const body = seatRows
        .map((r) =>
          [
            r.section,
            r.row,
            r.seatNumber,
            r.x ?? "",
            r.y ?? "",
            r.tierId ?? "",
            r.qualityScore ?? "",
            r.label ?? "",
            r.isObstructed ? "1" : "0",
          ]
            .map((v) => String(v).replace(/,/g, " "))
            .join(","),
        )
        .join("\n");
      return new Response(header + body, {
        headers: {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="seat-map-${params.mapId}.csv"`,
        },
      });
    }

    // 랜드마크·그룹은 v2 seat_map_data(SoT)에서 read(go seat_map_landmarks/seat_groups 미read).
    // tier 는 아직 go seat_tiers 저장소(3.1 범위 밖 — 정본 LEVEL2-PHASE-3.1-SEATS).
    const landmarksOut = (entry.landmarks ?? []).map((lm) => ({
      id: lm.id ?? null,
      type: lm.type,
      label: lm.label,
      x: lm.x,
      y: lm.y,
      width: lm.width,
      height: lm.height,
      rotation: lm.rotation,
      colorHex: lm.color_hex,
    }));
    const groupsOut = (entry.groups ?? []).map((g) => ({
      id: g.id ?? null,
      name: g.name,
      type: g.type,
      colorHex: g.color_hex,
      icon: g.icon,
      seatIds: g.seat_refs ?? [],
    }));
    const tiers = await pool.query(
      `SELECT id, name, base_price AS "basePrice", color_hex AS "colorHex"
         FROM seat_tiers
         WHERE event_id = $1 AND account_id = $2`,
      [params.eventId, session.accountId],
    );

    return new Response(
      JSON.stringify(
        {
          map: mapOut,
          seats: seatRows,
          landmarks: landmarksOut,
          groups: groupsOut,
          tiers: tiers.rows.map((t) => ({
            ...t,
            basePrice: Number(t.basePrice),
          })),
          exportedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
      {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Disposition": `attachment; filename="seat-map-${params.mapId}.json"`,
        },
      },
    );
  },
);
