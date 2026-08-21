/**
 * Public GET — 좌석 배치도 스냅샷 (공개)
 *
 * v2 포팅 Phase 3. 좌석 전체 조회 + 상태 집계.
 * 로그인 없이 접근 가능. draft 이벤트는 404.
 * P0-S3: 이벤트 상태 검증 (live / soldout 만 공개)
 *
 * ── 레벨2 컷오버 T1 — go 좌석 read 제거 ──
 * 예전엔 go `seats` 를 SELECT 하고 v2 status 만 머지했다. 좌석빌더가 go 에 더 이상 INSERT 하지
 * 않으면서 그 SELECT 는 **항상 0행**이 됐다 → 좌석 목록 자체를 v2 live read 로 전환한다.
 *  - 좌석 id = v2 canonical seat_id(hold/주문이 이 값을 받는다).
 *  - 배치도 소속은 external_ref(`smseat:{mapId}:{hash}`) prefix 로 판정.
 *  - **published 배치도만** 노출한다(v2 seat_map_data 에는 draft 도 담겨 있음 — 미발행 누출 차단).
 *  - v2 실패 시 폴백이 없다(go 좌석이 없으므로) → 빈 목록으로 "전석 매진"처럼 보이게 하지 말고
 *    502 로 명시 통지한다.
 *
 * NOTE: 경로 파라미터는 slug 기반. 이벤트 UUID는 서버에서 slug로부터 조회한다.
 */
import { NextResponse, type NextRequest } from "next/server";
import { seatRepo } from "@/lib/seats";
import { withRateLimit, SEAT_RATE_LIMITS } from "@/lib/auth/withRateLimit";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { fetchPublishedMapIds } from "@/lib/v2/seat-map-payload";
import {
  PUBLIC_PURCHASE_STATUSES,
  resolvePublicEventBySlug,
} from "@/lib/v2/public-event";

type Params = { slug: string };

const handler = async (
  request: NextRequest,
  context: { params: Promise<Params> },
) => {
  const { slug } = await context.params;
  const url = new URL(request.url);
  // mapId 는 이제 "좌석을 담고 있는 테이블 키"가 아니라 published 배치도 중 하나를 고르는 힌트다.
  // (좌석은 이벤트 단위로 오고, 다층 배치도면 층별로 좁힐 때만 의미가 있다.) 미지정=전체 published.
  const requestedMapId = url.searchParams.get("mapId");
  const tierId = url.searchParams.get("tierId") ?? undefined;
  const section = url.searchParams.get("section") ?? undefined;

  // P0-S3: slug 조회 + Draft/paused/archived 이벤트 공개 차단 (W2-PUB: v2 by-slug live read)
  const resolved = await resolvePublicEventBySlug(slug, PUBLIC_PURCHASE_STATUSES);
  if (!resolved.ok) {
    return NextResponse.json(
      { success: false, error: resolved.error },
      { status: resolved.status },
    );
  }

  const emptyResult = {
    success: true,
    data: {
      seats: [],
      summary: { total: 0, available: 0, held: 0, reserved: 0, sold: 0, blocked: 0 },
    },
  };

  // ID 승격 이후 go event id == v2 event id — 앵커 조회 없음.
  const v2EventId = resolved.event.event_id;

  let seats;
  try {
    const publishedMapIds = await fetchPublishedMapIds(v2EventId);
    if (publishedMapIds.length === 0) return NextResponse.json(emptyResult);
    // 요청 mapId 가 published 목록에 있으면 그 층만, 아니면 published 전체.
    const mapIds =
      requestedMapId && publishedMapIds.includes(requestedMapId)
        ? [requestedMapId]
        : publishedMapIds;
    seats = await seatRepo.getByEvent(v2EventId, { mapIds, tierId });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return NextResponse.json(
        { success: false, error: "좌석 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요." },
        { status: 502 },
      );
    }
    throw err;
  }

  const filtered = section ? seats.filter((s) => s.section === section) : seats;

  const summary = {
    total: filtered.length,
    available: filtered.filter((s) => s.status === "available").length,
    held: filtered.filter((s) => s.status === "held").length,
    reserved: filtered.filter((s) => s.status === "reserved").length,
    sold: filtered.filter((s) => s.status === "sold").length,
    blocked: filtered.filter((s) => s.status === "blocked").length,
  };

  return NextResponse.json({
    success: true,
    data: { seats: filtered, summary },
  });
};

export const GET = withRateLimit(SEAT_RATE_LIMITS.read)(handler);
