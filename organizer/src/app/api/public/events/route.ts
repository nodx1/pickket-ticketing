/**
 * GET /api/public/events — 공개 이벤트 목록(인증 불필요, 피켓 마켓 호환 포맷).
 *
 * ── 레벨2 컷오버 W2-PUB ──
 * go `events + organizers + products` SELECT → v2 `/internal/public/events`.
 * 상태·채널 게이트(`status='live' AND 'marketplace' = ANY(sale_channels)`)는 **v2 가 강제**한다.
 *
 * 🔴 실패는 빈 목록으로 위장하지 않는다 → **503**. 마켓 연동측이 "판매중 이벤트 0건"으로
 *    오인해 노출을 내리면 매출이 조용히 0 이 된다.
 *
 * ⚠️ 응답 축소(불가피): `seatTiers`(구 go products 배열)는 더 이상 목록에 실리지 않는다.
 *    v2 목록 API 는 티어 배열을 내려주지 않고, 이벤트당 별도 티어 조회(N+1)를 공개 목록에
 *    붙이는 것은 위험하다. 티어가 필요한 소비자는 상세(`/api/public/events/[slug]`)를 쓴다.
 *    현재 실호출자 0(플랫폼 grep) — consumer 는 자체 v2 API 를 쓴다.
 */
import { NextRequest } from "next/server";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { listPublicEventsV2 } from "@/lib/v2/commerce-client";
import { logger } from "@/lib/logger";

// v2 이벤트 상태 매핑 (go 4-상태 → 마켓 호환 어휘)
function toV2Status(goStatus: string): string {
  if (goStatus === "draft") return "DRAFT";
  if (goStatus === "live") return "APPROVED";
  if (goStatus === "paused") return "BIDDING_CLOSED";
  if (goStatus === "archived") return "COMPLETED";
  return "DRAFT";
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const limit = Math.min(Number(searchParams.get("limit") ?? 20), 100);
  const offset = Number(searchParams.get("offset") ?? 0);
  const format = searchParams.get("format"); // ?format=v2 → v2 호환 응답

  let result: Awaited<ReturnType<typeof listPublicEventsV2>>;
  try {
    result = await listPublicEventsV2({
      channel: "marketplace",
      sort: "date",
      limit: Number.isFinite(limit) && limit > 0 ? limit : 20,
      offset: Number.isFinite(offset) && offset >= 0 ? offset : 0,
    });
  } catch (err: unknown) {
    logger.warn("공개 이벤트 목록 v2 조회 실패", {
      error: err instanceof Error ? err.message : "unknown",
    });
    return errorResponse("이벤트 목록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
  }

  const events = result.events.map((e) => ({
    id: e.event_id,
    title: e.title,
    slug: e.slug,
    summary: e.summary,
    description: e.description,
    venueName: e.venue,
    venueAddress: e.venue_address,
    eventType: e.event_type,
    ageRating: e.age_rating,
    startsAt: e.event_date,
    endsAt: e.event_date_end ?? e.event_date,
    heroImageUrl: e.image_url,
    status: e.status,
    maxAttendees: e.total_seats,
    productCount: e.tier_count,
    // 레벨2 컷오버: 추첨 SoT = v2. go allocation_sessions 는 폐기(행 0)라 이 값은
    // 항상 false 였다 → 상수 유지. 추첨 진행 표시가 다시 필요하면 v2 phase_configs 기준으로.
    hasOpenSession: false,
  }));

  const payload = format === "v2"
    ? events.map((e) => ({ ...e, status: toV2Status(e.status) }))
    : events;

  return successResponse({ events: payload, total: result.total });
}
