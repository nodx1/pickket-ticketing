/**
 * Public GET — 이벤트의 published 좌석 배치도 + 티어 목록
 *
 * v2 포팅 Phase 3. 구매 UI 에서 최초 로딩 시 사용.
 * P0-S3: draft/paused 이벤트는 404.
 *
 * NOTE: 경로 파라미터는 slug 기반. 이벤트 UUID는 서버에서 slug로부터 조회한다.
 */
import { NextResponse, type NextRequest } from "next/server";
import { getPool } from "@/lib/db/pool";
import { withRateLimit } from "@/lib/auth/withRateLimit";
import { fetchPublishedMaps } from "@/lib/v2/seat-map-payload";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import {
  PUBLIC_PURCHASE_STATUSES,
  resolvePublicEventBySlug,
} from "@/lib/v2/public-event";

type Params = { slug: string };

const handler = async (
  _request: NextRequest,
  context: { params: Promise<Params> },
) => {
  const { slug } = await context.params;

  // W2-PUB: go `events` slug 조회 → v2 by-slug live read(미존재 404 / v2 불가 503).
  const resolved = await resolvePublicEventBySlug(slug, PUBLIC_PURCHASE_STATUSES);
  if (!resolved.ok) {
    return NextResponse.json(
      { success: false, error: resolved.error },
      { status: resolved.status },
    );
  }
  const eventId = resolved.event.event_id;

  // ── 레벨2 컷오버 T1 — 배치도는 v2 events.seat_map_data(SoT)에서 read(go seat_maps 미read) ──
  // ★ 소비자 공개 경로다. 3.1 계약상 seat_map_data 에는 draft 도 담기므로 **published 만** 필터해서
  //   노출한다(fetchPublishedMaps 가 강제). 필터가 빠지면 미발행 배치도가 구매 UI 에 샌다.
  // 🔴 잔여 go 의존: `seat_tiers`.
  //    v2 SeatTier 에 빌더 메타 12컬럼(view_description·distance_from_stage·max_group_size 등)이
  //    없어 지금 옮기면 데이터가 소실된다(정본 LEVEL2-CUTOVER-EXEC-PLAN T1 각주).
  //    alembic 스키마 확장이 선행돼야 하며, 같은 테이블을 seat-tiers/products 라우트(타 트랙)가
  //    쓰므로 한 배치로 이관해야 한다.
  let maps: Array<Record<string, unknown>> = [];
  try {
    maps = (await fetchPublishedMaps(eventId)).map((m) => ({
      id: m.id,
      name: m.name,
      status: m.status,
      mapData: m.map_data ?? null,
      createdAt: null,
      updatedAt: null,
    }));
  } catch (err: unknown) {
    if (!(err instanceof V2CommerceError)) throw err;
    return NextResponse.json(
      { success: false, error: "좌석 배치도를 불러오지 못했습니다. 잠시 후 다시 시도해주세요." },
      { status: 502 },
    );
  }

  const pool = getPool();
  const tiersResult = await pool.query(
    `SELECT
       id,
       seat_map_id AS "seatMapId",
       product_id AS "productId",
       name,
       capacity,
       base_price AS "basePrice",
       face_price AS "facePrice",
       sale_mode AS "saleMode",
       color_hex AS "colorHex",
       display_order AS "displayOrder",
       view_description AS "viewDescription",
       distance_from_stage AS "distanceFromStage",
       view_rating AS "viewRating",
       view_image_url AS "viewImageUrl",
       position_label AS "positionLabel",
       allow_group_tickets AS "allowGroupTickets",
       max_group_size AS "maxGroupSize"
     FROM seat_tiers
     WHERE event_id = $1
     ORDER BY display_order ASC, base_price DESC`,
    [eventId],
  );

  return NextResponse.json({
    success: true,
    data: {
      maps,
      tiers: tiersResult.rows,
    },
  });
};

export const GET = withRateLimit({
  max: 60,
  windowMs: 60_000,
  keyPrefix: "seats:read",
})(handler);
