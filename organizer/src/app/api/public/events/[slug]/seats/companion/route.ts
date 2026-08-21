/**
 * 트랙 1.8 — 친구 함께 예매 (공동 인접 좌석 추천 + atomic hold)
 *
 * POST /api/public/events/{slug}/seats/companion
 *   body: { size: number, tierId?: string }
 *   → group-allocator 가 인접한 size 개 좌석을 찾아 한 번에 hold
 *   → all-win-or-all-lose (group-tickets 의 보장)
 *
 * 비로그인 게스트도 사용 가능(익명 hold — hold_id 가 bearer 소유권).
 * leader/member 분리는 결제 단계에서 처리하므로 여기서는 단일 사용자가 size 개를 잠근다.
 *
 * ── 레벨2 컷오버 T1 ──
 *  - 활성 배치도 조회: go `seat_maps` SELECT → v2 seat_map_data 의 **published 맵**.
 *  - 좌석 후보/홀드: allocateGroup 이 v2 canonical event_id 로 v2 재고 API 를 직접 호출한다.
 *  - go 트랜잭션 제거: 이 경로는 go DB 에 쓰지 않는다(재고=v2 소유) → BEGIN/COMMIT 이 감싸던
 *    것은 외부호출뿐이라 원자성을 준 적이 없다. 실패 시 홀드는 TTL·reaper 가 회수한다.
 *  - `seat_tiers` 는 아직 go 소유(별도 게이트)라 그대로 둔다.
 */
import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { getPool } from "@/lib/db/pool";
import { allocateGroup } from "@/lib/seats/group-allocator";
import { withRateLimit, SEAT_RATE_LIMITS } from "@/lib/auth/withRateLimit";
import {
  publishSeatUpdate,
  type SeatUpdateMessage,
} from "@/lib/seats/event-bus";
import { seatMetrics } from "@/lib/seats/metrics";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { fetchPublishedMapIds } from "@/lib/v2/seat-map-payload";
import {
  PUBLIC_PURCHASE_STATUSES,
  resolvePublicEventBySlug,
} from "@/lib/v2/public-event";

type Params = { slug: string };

const SESSION_COOKIE = "pickket_seat_session";

const companionSchema = z.object({
  size: z.number().int().min(2).max(10),
  tierId: z.string().uuid().optional(),
});

function checkSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return true;
  try {
    const originHost = new URL(origin).host;
    const host = request.headers.get("host");
    return host !== null && originHost === host;
  } catch {
    return false;
  }
}

function getOrCreateSessionId(request: NextRequest): {
  sessionId: string;
  isNew: boolean;
} {
  const existing = request.cookies.get(SESSION_COOKIE)?.value;
  if (existing && /^[0-9a-f-]{36}$/i.test(existing)) {
    return { sessionId: existing, isNew: false };
  }
  return { sessionId: crypto.randomUUID(), isNew: true };
}

const handler = async (
  request: NextRequest,
  context: { params: Promise<Params> },
) => {
  if (!checkSameOrigin(request)) {
    return NextResponse.json(
      { success: false, error: "잘못된 요청 출처입니다" },
      { status: 403 },
    );
  }

  const { slug } = await context.params;

  let body: z.infer<typeof companionSchema>;
  try {
    body = companionSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: err.issues[0]?.message ?? "입력값을 확인해주세요" },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { success: false, error: "요청 본문을 해석하지 못했습니다" },
      { status: 400 },
    );
  }

  // W2-PUB: go `events` slug 조회 → v2 by-slug live read(미존재 404 / v2 불가 503).
  const resolved = await resolvePublicEventBySlug(slug, PUBLIC_PURCHASE_STATUSES);
  if (!resolved.ok) {
    return NextResponse.json(
      { success: false, error: resolved.error },
      { status: resolved.status },
    );
  }
  // ID 승격 이후 go event id == v2 event id — 앵커 조회·미앵커 분기 소멸.
  const eventId = resolved.event.event_id;
  const v2EventId = eventId;

  // 🔴 잔여 go 의존: `seat_tiers`(max_group_size·base_price). v2 SeatTier 에 빌더 메타가
  //    없어 지금 옮기면 데이터 소실 — seat-tiers/products 라우트(타 트랙)와 한 배치로 이관.
  const pool = getPool();

  // 활성 좌석맵 조회 — v2 seat_map_data 의 published 맵(첫 번째 = 기본 층).
  let publishedMapIds: string[];
  try {
    publishedMapIds = await fetchPublishedMapIds(v2EventId);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return NextResponse.json(
        { success: false, error: "좌석 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요." },
        { status: 502 },
      );
    }
    throw err;
  }
  if (publishedMapIds.length === 0) {
    return NextResponse.json(
      { success: false, error: "좌석맵을 찾을 수 없습니다" },
      { status: 404 },
    );
  }
  const seatMapId = publishedMapIds[0];

  // tier 결정 (미지정 시 가장 낮은 가격대)
  let tierId = body.tierId;
  let maxGroupSize = 10;
  if (tierId) {
    const { rows: tierRows } = await pool.query<{
      max_group_size: number;
    }>(
      `SELECT max_group_size FROM seat_tiers WHERE id = $1 AND event_id = $2 LIMIT 1`,
      [tierId, eventId],
    );
    if (tierRows.length === 0) {
      return NextResponse.json(
        { success: false, error: "등급을 찾을 수 없습니다" },
        { status: 404 },
      );
    }
    maxGroupSize = tierRows[0].max_group_size ?? 10;
  } else {
    const { rows: defaultTier } = await pool.query<{
      id: string;
      max_group_size: number;
    }>(
      `SELECT id, max_group_size FROM seat_tiers
       WHERE event_id = $1 AND seat_map_id = $2
       ORDER BY base_price ASC NULLS LAST
       LIMIT 1`,
      [eventId, seatMapId],
    );
    if (defaultTier.length === 0) {
      return NextResponse.json(
        { success: false, error: "선택 가능한 등급이 없습니다" },
        { status: 404 },
      );
    }
    tierId = defaultTier[0].id;
    maxGroupSize = defaultTier[0].max_group_size ?? 10;
  }

  if (body.size > maxGroupSize) {
    return NextResponse.json(
      {
        success: false,
        error: `이 등급은 최대 ${maxGroupSize}명까지 함께 예매할 수 있습니다`,
      },
      { status: 400 },
    );
  }

  const { sessionId, isNew } = getOrCreateSessionId(request);

  let allocation: Awaited<ReturnType<typeof allocateGroup>>;
  try {
    allocation = await allocateGroup({
      v2EventId,
      mapIds: publishedMapIds,
      tierId,
      maxGroupSize,
      // 익명 게스트 → heldBy 생략. sessionId 는 v2 buyer uuid 가 아니므로 v2 user_id 로 넘기지 않는다
      // (그룹 요청 검증용 leaderId 로만 사용). 소유권은 반환 hold_id 가 갖는다.
      heldBy: undefined,
      request: {
        leaderId: sessionId,
        // member 검증을 우회하기 위해 빈 배열 + size 만큼 placeholder 생성
        // (이 endpoint 는 단일 사용자가 size 만큼 잠그는 시나리오)
        memberIds: Array.from({ length: body.size - 1 }, () => crypto.randomUUID()),
        tierId,
        size: body.size,
      },
    });
  } catch (err) {
    // v2 재고 4xx(HELD_BY_OTHER/SOLD_OUT 등)=사용자 에러 → 그대로 전파. 5xx 는 500.
    if (err instanceof V2CommerceError && err.status >= 400 && err.status < 500) {
      return NextResponse.json(
        { success: false, error: err.message },
        { status: err.status },
      );
    }
    const message =
      err instanceof Error ? err.message : "친구 함께 예매에 실패했습니다";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }

  if (!allocation.success || !allocation.allocated) {
    seatMetrics.incrementCompanion(false);
    return NextResponse.json(
      { success: false, error: allocation.error ?? "인접 좌석을 찾을 수 없습니다" },
      { status: 409 },
    );
  }
  seatMetrics.incrementCompanion(true);

  // SSE: held 상태 브로드캐스트
  const payload: Omit<SeatUpdateMessage, "ts" | "sequence"> = {
    type: "seat_update",
    mapId: seatMapId,
    seats: allocation.allocated.seatIds.map((id) => ({
      id,
      status: "held",
    })),
  };
  publishSeatUpdate(seatMapId, payload).catch(() => {});

  const response = NextResponse.json({
    success: true,
    data: {
      holdId: allocation.allocated.holdId,
      holdToken: allocation.allocated.holdToken,
      expiresAt: allocation.allocated.expiresAt,
      seatIds: allocation.allocated.seatIds,
      tierId,
      size: body.size,
    },
  });

  if (isNew) {
    response.cookies.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 2,
    });
  }

  return response;
};

export const POST = withRateLimit(SEAT_RATE_LIMITS.companion)(handler);
