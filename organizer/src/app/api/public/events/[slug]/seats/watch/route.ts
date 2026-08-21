/**
 * 트랙 1.9 — 좌석 즐겨찾기 + 가격 알림
 *
 * GET    /api/public/events/{slug}/seats/watch — 내 watch 목록
 * POST   /api/public/events/{slug}/seats/watch — 좌석 추가 { seatId, targetPrice? }
 * DELETE /api/public/events/{slug}/seats/watch?seatId=... — 단일 해제
 *
 * 비로그인 게스트는 session_id (cookie) 기준, 로그인 사용자는 user_id 기준.
 * 같은 좌석 중복 추가는 unique index 로 차단.
 *
 * ── 레벨2 컷오버 W2-PUB → W5-ATTENDEE (전환 완료) ──
 * ✅ go `events` slug/앵커 조회 제거 → v2 by-slug live read (W2-PUB).
 * ✅ `seat_watches` 원장도 v2 정본으로 이관 (W5-ATTENDEE). 등록 라우트와 알림 cron
 *    (`api/cron/seat-watch-trigger`)을 **같은 배치로** 옮겨 split-brain 을 만들지 않았다.
 * ℹ️ `event_id` 는 ID 승격으로 v2 event_id 와 같은 값이라 데이터 변환이 없다.
 * ℹ️ 소유축: 로그인 = v2 user id(세션 sub), 비로그인 = 쿠키 session_id. go DB 미참조.
 *
 * 🔴 fail-closed: v2 실패를 빈 목록/삭제성공으로 위장하지 않는다(503).
 */
import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withRateLimit, SEAT_RATE_LIMITS } from "@/lib/auth/withRateLimit";
import { getServerSession } from "@/lib/auth/server-session";
import { seatRepo } from "@/lib/seats";
import { seatMetrics } from "@/lib/seats/metrics";
import {
  deleteSeatWatch,
  listSeatWatches,
  upsertSeatWatch,
  V2CommerceError,
  type SeatWatchOwner,
} from "@/lib/v2/commerce-client";
import { fetchPublishedMapIds } from "@/lib/v2/seat-map-payload";
import {
  PUBLIC_ANY_STATUS,
  resolvePublicEventBySlug,
  type PublicEventResult,
} from "@/lib/v2/public-event";

type Params = { slug: string };
const SESSION_COOKIE = "pickket_seat_session";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type WatchRow = {
  id: string;
  seatId: string;
  /** 원 단위 BIGINT — v2 응답은 이미 number 다(옛 pg 드라이버 string 변환 불필요). */
  targetPrice: number | null;
  notifyAt: string | null;
  createdAt: string;
};

const watchSchema = z.object({
  seatId: z.string().uuid(),
  targetPrice: z.number().int().min(0).nullable().optional(),
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

/**
 * watch 소유자 해석 — 로그인 유저(v2 JWT)면 user_id 로 키잉, 아니면 게스트 session_id.
 * (BFF cutover: seat_watches.user_id 가 정본이어야 쿠키 분실/타기기에도 watch 유지)
 */
async function resolveWatcher(request: NextRequest): Promise<{
  userId: string | null;
  accountId: string | null;
  sessionId: string | null;
  isNewSession: boolean;
}> {
  const user = await getServerSession();
  if (user) {
    return { userId: user.id, accountId: user.accountId, sessionId: null, isNewSession: false };
  }
  const { sessionId, isNew } = getOrCreateSessionId(request);
  return { userId: null, accountId: null, sessionId, isNewSession: isNew };
}

/**
 * W2-PUB: go `SELECT id FROM events WHERE slug=$1` → v2 by-slug live read.
 * ⚠️ 상태 게이트는 **기존 동작 그대로 없음** — 즐겨찾기는 판매 개시 전(draft)에도
 *    담아둘 수 있어야 한다(go 도 status 를 보지 않았다). 게이트 추가는 제품 결정 사항.
 * ID 승격 이후 v2 canonical event_id == 반환 event_id 라 별도 앵커 조회가 없다.
 */
function resolveEvent(slug: string): Promise<PublicEventResult> {
  return resolvePublicEventBySlug(slug, PUBLIC_ANY_STATUS);
}

const getHandler = async (
  request: NextRequest,
  context: { params: Promise<Params> },
) => {
  const { slug } = await context.params;
  const resolved = await resolveEvent(slug);
  if (!resolved.ok) {
    return NextResponse.json(
      { success: false, error: resolved.error },
      { status: resolved.status },
    );
  }
  const eventId = resolved.event.event_id;
  const { userId, sessionId } = await resolveWatcher(request);
  const owner: SeatWatchOwner | null = userId
    ? { userId }
    : sessionId
      ? { sessionId }
      : null;
  // 소유축이 없으면(쿠키 없는 첫 방문) 찜이 있을 수 없다 — 이건 장애가 아니라 사실이다.
  if (!owner) return NextResponse.json({ success: true, data: [] });

  try {
    const { watches } = await listSeatWatches(eventId, owner);
    const data: WatchRow[] = watches.map((w) => ({
      id: w.id,
      seatId: w.seat_id,
      targetPrice: w.target_price !== null ? Number(w.target_price) : null,
      notifyAt: w.notify_at,
      createdAt: w.created_at ?? "",
    }));
    return NextResponse.json({ success: true, data });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // 🔴 조회 실패를 빈 배열로 강등하면 "찜 없음"으로 읽혀 사용자가 다시 담는다 → 503.
      return NextResponse.json(
        { success: false, error: "관심 좌석을 불러오지 못했습니다. 잠시 후 다시 시도해주세요." },
        { status: 503 },
      );
    }
    throw err;
  }
};

const postHandler = async (
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

  let body: z.infer<typeof watchSchema>;
  try {
    body = watchSchema.parse(await request.json());
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: err.issues[0]?.message ?? "입력값 오류" },
        { status: 400 },
      );
    }
    return NextResponse.json(
      { success: false, error: "요청 본문을 해석하지 못했습니다" },
      { status: 400 },
    );
  }

  const resolved = await resolveEvent(slug);
  if (!resolved.ok) {
    return NextResponse.json(
      { success: false, error: resolved.error },
      { status: resolved.status },
    );
  }
  const eventId = resolved.event.event_id;
  const v2EventId = eventId;

  // 좌석이 해당 이벤트 소속인지 검증.
  // ── 레벨2 컷오버 T1 ── 예전엔 `seats JOIN seat_maps` 로 되짚었으나 go 좌석이 사라졌다.
  //   seatId 는 이제 v2 canonical seat_id 이므로 v2 좌석목록(published 배치도)과 대조한다.
  //   ⚠️ seat_watches.seat_id 의 FK(REFERENCES seats(id))는 mig233 에서 DROP 했다 —
  //      v2 id 를 넣으면 go seats 에 없어 FK 위반이 나기 때문(그 테이블은 이제 항상 비어 있다).
  try {
    const publishedMapIds = await fetchPublishedMapIds(v2EventId);
    const seats =
      publishedMapIds.length === 0
        ? []
        : await seatRepo.getByEvent(v2EventId, { mapIds: publishedMapIds });
    if (!seats.some((s) => s.id === body.seatId)) {
      return NextResponse.json(
        { success: false, error: "해당 이벤트의 좌석이 아닙니다" },
        { status: 400 },
      );
    }
  } catch (err: unknown) {
    // 표시용 부가기능이지만 소속 검증을 건너뛰면 타 이벤트 좌석이 등록된다 → swallow 금지.
    if (err instanceof V2CommerceError) {
      return NextResponse.json(
        { success: false, error: "좌석 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요." },
        { status: 502 },
      );
    }
    throw err;
  }

  const { userId, accountId, sessionId, isNewSession } = await resolveWatcher(request);

  // upsert — 소유축(user_id 또는 session_id)+seat_id 부분 유니크. v2 가 집행한다.
  let data: WatchRow;
  try {
    const { watch } = await upsertSeatWatch(eventId, {
      seat_id: body.seatId,
      user_id: userId,
      session_id: userId ? null : sessionId,
      account_ref: accountId,
      target_price: body.targetPrice ?? null,
    });
    data = {
      id: watch.id,
      seatId: watch.seat_id,
      targetPrice: watch.target_price !== null ? Number(watch.target_price) : null,
      notifyAt: watch.notify_at,
      createdAt: watch.created_at ?? "",
    };
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return NextResponse.json(
        { success: false, error: "관심 좌석을 저장하지 못했습니다. 잠시 후 다시 시도해주세요." },
        { status: 503 },
      );
    }
    throw err;
  }
  seatMetrics.incrementWatch();

  const response = NextResponse.json({ success: true, data });
  if (!userId && isNewSession && sessionId) {
    response.cookies.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 30, // 30일 (즐겨찾기는 길게)
    });
  }
  return response;
};

const deleteHandler = async (
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
  const url = new URL(request.url);
  const seatId = url.searchParams.get("seatId");
  if (!seatId || !UUID_RE.test(seatId)) {
    return NextResponse.json(
      { success: false, error: "seatId 가 필요합니다" },
      { status: 400 },
    );
  }
  const resolved = await resolveEvent(slug);
  if (!resolved.ok) {
    return NextResponse.json(
      { success: false, error: resolved.error },
      { status: resolved.status },
    );
  }
  const eventId = resolved.event.event_id;
  const user = await getServerSession();
  const cookieSession = request.cookies.get(SESSION_COOKIE)?.value ?? null;
  const owner: SeatWatchOwner | null = user
    ? { userId: user.id }
    : cookieSession
      ? { sessionId: cookieSession }
      : null;
  // 소유축 자체가 없음 = 이 요청자에겐 찜이 존재할 수 없다(장애 아님).
  if (!owner) {
    return NextResponse.json({ success: true, data: { deleted: 0 } });
  }
  try {
    const { deleted } = await deleteSeatWatch(eventId, seatId, owner);
    return NextResponse.json({ success: true, data: { deleted } });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // 🔴 DELETE 멱등 흡수 금지 — 장애를 "이미 없음 → 삭제 성공"으로 흘리지 않는다.
      return NextResponse.json(
        { success: false, error: "관심 좌석을 해제하지 못했습니다. 잠시 후 다시 시도해주세요." },
        { status: 503 },
      );
    }
    throw err;
  }
};

export const GET = withRateLimit(SEAT_RATE_LIMITS.watch)(getHandler);
export const POST = withRateLimit(SEAT_RATE_LIMITS.watch)(postHandler);
export const DELETE = withRateLimit(SEAT_RATE_LIMITS.watch)(deleteHandler);
