/**
 * Public GET — 최적 가용 좌석 자동 선택
 *
 * v2 포팅 Phase 3. 품질점수 + 인접성 기반 추천.
 * 필수: quantity. 선택: mapId(다층 배치도에서 층 좁히기), tierId, adjacent=true|false
 *
 * 레벨2 컷오버 T1: 후보 좌석을 go `seats` 가 아니라 v2 live read 에서 고른다
 * (go 좌석은 빌더 write 경로 소멸로 항상 0행 → 추천이 언제나 "좌석 없음"이 됐다).
 * 반환 seat.id 는 v2 canonical seat_id 라 그대로 hold/주문에 넘길 수 있다.
 *
 * NOTE: 경로 파라미터는 slug 기반. 이벤트 UUID는 서버에서 slug로부터 조회한다.
 */
import { NextResponse, type NextRequest } from "next/server";
import { seatRepo } from "@/lib/seats";
import { withRateLimit, SEAT_RATE_LIMITS } from "@/lib/auth/withRateLimit";
import { seatMetrics } from "@/lib/seats/metrics";
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
  const requestedMapId = url.searchParams.get("mapId");
  const quantityRaw = url.searchParams.get("quantity");
  const tierId = url.searchParams.get("tierId") ?? undefined;
  const adjacentParam = url.searchParams.get("adjacent");

  const quantity = quantityRaw ? Number(quantityRaw) : NaN;
  if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 20) {
    return NextResponse.json(
      { success: false, error: "quantity 는 1~20 범위 정수여야 합니다" },
      { status: 400 },
    );
  }

  const preferAdjacent = adjacentParam === null ? true : adjacentParam !== "false";

  // P0-S3: slug 조회 + 이벤트 공개 검증 (W2-PUB: v2 by-slug live read)
  const resolved = await resolvePublicEventBySlug(slug, PUBLIC_PURCHASE_STATUSES);
  if (!resolved.ok) {
    if (resolved.status === 503) seatMetrics.incrementBestAvailable(false);
    return NextResponse.json(
      { success: false, error: resolved.error },
      { status: resolved.status },
    );
  }

  // ID 승격 이후 go event id == v2 event id — 앵커 조회 없음.
  const v2EventId = resolved.event.event_id;

  try {
    // 공개 경로 게이트: published 배치도 좌석만 추천한다(미발행 좌석 추천 금지).
    const publishedMapIds = await fetchPublishedMapIds(v2EventId);
    const mapIds =
      requestedMapId && publishedMapIds.includes(requestedMapId)
        ? [requestedMapId]
        : publishedMapIds;
    const seats =
      mapIds.length === 0
        ? []
        : await seatRepo.getBestAvailable(v2EventId, {
            mapIds,
            tierId,
            quantity: Math.floor(quantity),
            preferAdjacent,
          });
    seatMetrics.incrementBestAvailable(seats.length > 0);
    return NextResponse.json({
      success: true,
      data: { seats, found: seats.length, requested: Math.floor(quantity) },
    });
  } catch (err: unknown) {
    seatMetrics.incrementBestAvailable(false);
    // v2 실패는 swallow 금지 — go 폴백이 없으므로 "추천 좌석 없음"으로 위장하면 안 된다.
    if (err instanceof V2CommerceError) {
      return NextResponse.json(
        { success: false, error: "추천 좌석을 불러오지 못했습니다. 잠시 후 다시 시도해주세요." },
        { status: 502 },
      );
    }
    throw err;
  }
};

export const GET = withRateLimit(SEAT_RATE_LIMITS.bestAvailable)(handler);
