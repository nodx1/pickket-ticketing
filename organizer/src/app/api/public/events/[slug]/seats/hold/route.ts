/**
 * Public POST / DELETE — 좌석 홀드 관리
 *
 * v2 포팅 Phase 3. 비로그인 세션 기반 홀드.
 * - POST: 지정 좌석 홀드. sessionId (cookie) 또는 새 UUID 발급.
 * - DELETE: holdId 로 전체 해제.
 *
 * P0-S2: 모든 좌석이 동일 이벤트(공개 배치도) 소속인지 검증.
 * P0-S5: Origin 헤더로 CSRF 방어.
 *
 * ── 레벨2 컷오버 T1 — go 좌석 read 제거 ──
 *  - 소속 검증: `seats JOIN seat_maps` → **v2 live 좌석목록(published 배치도)** 대조.
 *    seatIds 는 이미 v2 canonical seat_id 이므로 앵커 변환이 없다.
 *  - SSE 대상 mapId: `SELECT DISTINCT seat_map_id FROM seats WHERE hold_id` → external_ref
 *    (`smseat:{mapId}:{hash}`) 역파싱 / published 맵 폴백.
 *  - go 트랜잭션 제거: 이 경로는 go DB 에 **쓰지 않는다**(재고는 v2 소유). 예전 BEGIN/COMMIT 은
 *    외부호출을 감싸기만 해서 원자성을 주지 못했고 오해만 남겼다.
 *
 * ── 멱등성 / 크래시 ──
 *  - 동시 2회: 같은 좌석에 대한 두 번째 hold 는 v2 가 HELD_BY_OTHER/SOLD_OUT(409)로 거부한다
 *    (재고 원자성은 v2 단일 소유 — go 에는 잠글 행 자체가 없다). 부분 성공분은 응답 failed 로 노출.
 *  - 외부호출 후 crash: v2 에는 hold 가 남고 클라이언트는 hold_id 를 못 받는다 → TTL(기본 600초)
 *    만료 + seat-hold-reaper(reapInventory)가 회수한다. 좌석이 영구 잠기지 않는다.
 *
 * NOTE: 경로 파라미터는 slug 기반. 이벤트 UUID는 서버에서 slug로부터 조회한다.
 */
import crypto from "node:crypto";
import { isProdRuntime } from "@/lib/env/runtime";
import { rateLimitKey } from "@/lib/request-ip";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { seatRepo } from "@/lib/seats";
import { mapIdFromSeatRef } from "@/lib/seats/seat-generator";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { fetchPublishedMapIds } from "@/lib/v2/seat-map-payload";
import { withRateLimit, SEAT_RATE_LIMITS } from "@/lib/auth/withRateLimit";
import {
  publishSeatUpdate,
  type SeatUpdateMessage,
} from "@/lib/seats/event-bus";
import { evaluateBotScore } from "@/lib/security/bot-shield";
import { seatMetrics } from "@/lib/seats/metrics";
import {
  PUBLIC_PURCHASE_STATUSES,
  resolvePublicEventBySlug,
  type PublicEventResult,
} from "@/lib/v2/public-event";

type Params = { slug: string };

const SESSION_COOKIE = "pickket_seat_session";

const holdSchema = z.object({
  seatIds: z.array(z.string().uuid()).min(1, "좌석을 한 개 이상 선택해주세요"),
  ttlSeconds: z.number().int().min(30).max(1800).optional(),
});

const deleteSchema = z.object({
  holdId: z.string().uuid("holdId 형식이 올바르지 않습니다"),
});

/**
 * P0-S5: Origin 헤더가 Host 와 일치하는지 검증.
 * same-origin API 요청만 허용하여 브라우저 CSRF 방어.
 */
function checkSameOrigin(request: NextRequest): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    // 비-브라우저 클라이언트(SSR/서버-서버)는 Origin 이 없을 수 있음 — 허용.
    return true;
  }
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
 * slug → 공개 이벤트. W2-PUB: go `events` SELECT 를 v2 by-slug live read 로 대체.
 * ID 승격 이후 event_id 가 곧 v2 canonical id 라 앵커 변환이 없다.
 */
function resolvePublicEvent(slug: string): Promise<PublicEventResult> {
  return resolvePublicEventBySlug(slug, PUBLIC_PURCHASE_STATUSES);
}

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

  // 트랙 7.3 — 봇 방어: hold 호출에 봇 스코어 평가
  // PLAYWRIGHT_TEST=1 환경에서는 우회 (E2E 테스트가 한도 초과)
  if (process.env.PLAYWRIGHT_TEST !== "1") {
    // 🔴 봇 스코어의 입력이 위조 가능하면 스코어 자체가 무의미하다 —
    //    프리픽스를 바꾸면 매번 "처음 보는 IP" 가 되어 이력 기반 판정이 무력화된다.
    const ip = rateLimitKey(request.headers, isProdRuntime());
    if (ip === null) {
      return NextResponse.json(
        { success: false, error: "요청을 처리할 수 없습니다" },
        { status: 503 },
      );
    }
    const userAgent = request.headers.get("user-agent") ?? "";
    const headers: Record<string, string> = {
      accept: request.headers.get("accept") ?? "",
      "accept-language": request.headers.get("accept-language") ?? "",
    };
    const score = await evaluateBotScore(ip, userAgent, headers);
    if (score.blocked) {
      return NextResponse.json(
        {
          success: false,
          error: "봇 의심 트래픽으로 차단되었습니다. 잠시 후 다시 시도해주세요.",
          flags: score.flags,
        },
        { status: 429 },
      );
    }
  }

  const { slug } = await context.params;

  let body: z.infer<typeof holdSchema>;
  try {
    body = holdSchema.parse(await request.json());
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

  // P0-S3: slug 조회 + 이벤트 공개 상태 검증 (미존재=404 / v2 불가=503)
  const resolved = await resolvePublicEvent(slug);
  if (!resolved.ok) {
    return NextResponse.json(
      { success: false, error: resolved.error },
      { status: resolved.status },
    );
  }
  const v2EventId = resolved.event.event_id;

  // P0-S2: 요청 좌석이 전부 이 이벤트의 **공개(published) 배치도** 좌석인지 검증.
  // 예전 go JOIN 검증을 대체 — 타 이벤트/미발행 배치도 좌석 주입을 여기서 끊는다.
  let seatMapId: string | null = null;
  try {
    const publishedMapIds = await fetchPublishedMapIds(v2EventId);
    const seats =
      publishedMapIds.length === 0
        ? []
        : await seatRepo.getByEvent(v2EventId, { mapIds: publishedMapIds });
    const byId = new Map(seats.map((s) => [s.id, s]));
    const allBelong = body.seatIds.every((id) => byId.has(id));
    if (!allBelong) {
      return NextResponse.json(
        { success: false, error: "해당 이벤트에 속하지 않은 좌석이 포함되어 있습니다" },
        { status: 400 },
      );
    }
    // SSE 채널 키 = 배치도 id. 좌석키에서 역파싱하고, 레거시 ref 면 published 첫 맵으로 폴백.
    seatMapId =
      mapIdFromSeatRef(byId.get(body.seatIds[0])?.externalRef) ??
      publishedMapIds[0] ??
      null;
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return NextResponse.json(
        { success: false, error: "좌석 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요." },
        { status: 502 },
      );
    }
    throw err;
  }

  const { sessionId, isNew } = getOrCreateSessionId(request);

  let result: Awaited<ReturnType<typeof seatRepo.holdSeats>>;
  try {
    result = await seatRepo.holdSeats({
      v2EventId,
      seatIds: body.seatIds,
      // 익명 소비자: v2 user 없음 → heldBy 생략(held_by NULL). 반환 hold_id 가 bearer 소유권.
      // (sessionId 는 go 쿠키/표시용으로만 유지)
      heldBy: undefined,
      ttlSeconds: body.ttlSeconds,
    });
    seatMetrics.incrementHold(result.held.length > 0);
  } catch (err) {
    seatMetrics.incrementHold(false);
    // v2 재고 hold 4xx(HELD_BY_OTHER/SOLD_OUT 409 등)=사용자 에러 → 그대로 전파(graceful 거부).
    // 5xx/네트워크(status 0)는 500 유지.
    if (err instanceof V2CommerceError && err.status >= 400 && err.status < 500) {
      return NextResponse.json(
        { success: false, error: err.message },
        { status: err.status },
      );
    }
    const message =
      err instanceof Error ? err.message : "좌석을 홀드하지 못했습니다";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }

  // SSE 브로드캐스트: held 상태 변경 알림
  if (result.held.length > 0 && seatMapId) {
    const mapId = seatMapId;
    const payload: Omit<SeatUpdateMessage, "ts" | "sequence"> = {
      type: "seat_update",
      mapId,
      seats: result.held.map((id) => ({ id, status: "held" })),
    };
    publishSeatUpdate(mapId, payload).catch(() => {});
  }

  const response = NextResponse.json({
    success: true,
    data: {
      holdId: result.holdId,
      holdToken: result.holdToken,
      expiresAt: result.expiresAt,
      held: result.held,
      failed: result.failed,
    },
  });

  if (isNew) {
    response.cookies.set(SESSION_COOKIE, sessionId, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 2, // 2시간
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

  let body: z.infer<typeof deleteSchema>;
  try {
    body = deleteSchema.parse(await request.json());
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

  // 빅뱅 cutover: 소유권 bearer = holdId(v2 hold_id). 세션쿠키 게이트 폐기
  // (releaseByHoldId 는 heldBy/holdToken 미사용 — v2 가 hold_id 발급주체로 검증).
  let released = 0;
  try {
    released = await seatRepo.releaseByHoldId(body.holdId);
  } catch (err) {
    if (err instanceof V2CommerceError && err.status >= 400 && err.status < 500) {
      return NextResponse.json(
        { success: false, error: err.message },
        { status: err.status },
      );
    }
    const message =
      err instanceof Error ? err.message : "홀드를 해제하지 못했습니다";
    return NextResponse.json(
      { success: false, error: message },
      { status: 500 },
    );
  }

  // SSE 브로드캐스트(비차단): 해제된 좌석 id 는 hold_id 만으로 알 수 없으므로 빈 배열을 보내
  // 클라이언트가 snapshot 을 refetch 하게 한다. 대상 채널(mapId)은 published 배치도.
  // ⚠️ 표시 경로라 실패해도 해제 결과를 망가뜨리지 않는다(폴백=클라이언트 폴링).
  if (released > 0) {
    void (async () => {
      const evt = await resolvePublicEvent(slug);
      if (!evt.ok) return;
      const mapIds = await fetchPublishedMapIds(evt.event.event_id);
      for (const mapId of mapIds) {
        await publishSeatUpdate(mapId, {
          type: "seat_update",
          mapId,
          seats: [],
        });
      }
    })().catch(() => {});
  }

  return NextResponse.json({
    success: true,
    data: { released },
  });
};

export const POST = withRateLimit(SEAT_RATE_LIMITS.hold)(postHandler);

export const DELETE = withRateLimit(SEAT_RATE_LIMITS.hold)(deleteHandler);
