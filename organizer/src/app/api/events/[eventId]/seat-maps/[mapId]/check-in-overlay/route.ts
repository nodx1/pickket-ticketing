/**
 * 트랙 7.7 — 현장 체크인 좌석맵 overlay
 *
 * GET /api/events/{eventId}/seat-maps/{mapId}/check-in-overlay
 *   응답: 좌석 ID 별 체크인 상태 배열
 *
 * 빌더의 SeatMap 컴포넌트를 체크인 모드로 재사용:
 *  - 체크인 완료 = 회색 (기존 sold 색상)
 *  - 미체크인 + 결제 완료 = 강조 (남은 입장 대기)
 *  - 미판매 = 흐림
 *
 * 현장 운영자가 도면에서 좌석 직접 클릭으로 체크인 가능하게 하는
 * 확장의 1차 기반 (PATCH 는 트랙 7.16 PWA + IndexedDB 에서).
 */
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { fetchV2SeatLiveMap } from "@/lib/seats/v2-status";
import { fetchSeatMapEntry } from "@/lib/v2/seat-map-payload";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError } from "@/lib/v2/event-access";

type Params = { eventId: string; mapId: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface OverlaySeat {
  seatId: string;
  section: string;
  row: string;
  seatNumber: string;
  status: "available" | "held" | "reserved" | "sold" | "blocked";
  /** "checked_in" | "confirmed" | "pending" | null (미판매) */
  attendeeStatus: string | null;
  attendeeName: string | null;
  ticketNumber: string | null;
  checkedInAt: string | null;
  orderId: string | null;
}

export const GET = withRole<Params>(
  "staff",
  async (_request, { session, params }) => {
    if (!UUID_RE.test(params.mapId)) {
      return errorResponse("잘못된 좌석맵 ID 입니다", 400);
    }
    const pool = getPool();

    // ── 레벨2 컷오버 T1 — 좌석은 v2 list_seats(SoT)에서 read(go seats 미read) ──
    // 소유권 판정도 fetchSeatMapEntry 가 함께 수행.
    //
    // ⚠️ 참석자 조인 관련 **기존 결함 유지(신규 아님)**: 이전 구현은 `seats.reserved_order_id`
    //    → orders → attendees 로 조인했는데, 그 컬럼은 코드베이스 어디서도 **write 되지 않는다**
    //    (빅뱅 flip 때 markReserved/markSold 가 폐기되면서 write 경로가 사라짐 — repo.ts 참조).
    //    즉 attendeeStatus/이름/티켓번호는 이미 **항상 null** 이었다. go 제거로 인한 기능 저하가 아니라
    //    이관 전부터 죽어 있던 링크다. 실제 복구는 v2 좌석↔티켓 매핑 API 가 선행돼야 한다(별도 과제).
    let owned: Awaited<ReturnType<typeof fetchSeatMapEntry>>;
    let live: Awaited<ReturnType<typeof fetchV2SeatLiveMap>> | null = null;
    try {
      owned = await fetchSeatMapEntry(pool, params.eventId, params.mapId, session.accountId);
      if (owned) live = await fetchV2SeatLiveMap(owned.v2EventId);
    } catch (err: unknown) {
      // 🔴 레벨2 T2-EVT — fetchSeatMapEntry 의 소유 검증이 v2 조회로 바뀌면서 v2 응답불가는
      //    EventAccessError 로 온다(안 잡으면 정체불명 500). 현장 체크인 화면이라 "없음(404)"과
      //    "일시 장애(503, 재시도하면 됨)"를 섞으면 운영자가 잘못 판단한다.
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

    const rows: OverlaySeat[] = [...live.byGoSeatId.values()]
      .map((s) => ({
        seatId: s.seatId,
        section: s.section,
        row: s.row,
        seatNumber: s.seatNumber,
        status: s.status as OverlaySeat["status"],
        attendeeStatus: null,
        attendeeName: null,
        ticketNumber: null,
        checkedInAt: null,
        orderId: null,
      }))
      .sort(
        (a, b) =>
          a.section.localeCompare(b.section) ||
          a.row.localeCompare(b.row) ||
          (Number(a.seatNumber) || 0) - (Number(b.seatNumber) || 0),
      );

    // 카운트 요약
    const summary = {
      total: rows.length,
      sold: 0,
      checkedIn: 0,
      pendingCheckIn: 0,
      available: 0,
    };
    for (const r of rows) {
      if (r.status === "sold" || r.status === "reserved") {
        summary.sold += 1;
        if (r.attendeeStatus === "checked_in") summary.checkedIn += 1;
        else summary.pendingCheckIn += 1;
      } else if (r.status === "available") {
        summary.available += 1;
      }
    }

    return successResponse({ seats: rows, summary });
  },
);
