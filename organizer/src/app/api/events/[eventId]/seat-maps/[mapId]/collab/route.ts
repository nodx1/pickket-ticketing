/**
 * 트랙 2.16 — 빌더 협업 SSE
 *
 * GET /api/events/{eventId}/seat-maps/{mapId}/collab — SSE 스트림 (presence)
 * POST                                                — presence 발행 (cursor/select)
 *
 * 접속만으로 join, 단절 시 leave 자동.
 * 단일 process in-memory (multi-process 시 Redis pub/sub 확장).
 */
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { withRateLimit, SEAT_RATE_LIMITS } from "@/lib/auth/withRateLimit";
import {
  publishPresence,
  subscribePresence,
} from "@/lib/builder/collab-presence";
import { verifySeatMapOwnershipV2 } from "@/lib/seats/ownership";
import { EventAccessError } from "@/lib/v2/event-access";

type Params = { eventId: string; mapId: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 소유 판정 결과 3분기. **boolean 을 쓰지 않는 이유**가 이 라우트의 핵심이다.
 *  - `owned`       — 세션 계정 소유 이벤트 + 맵 존재.
 *  - `denied`      — 없거나 내 것이 아님(404. 존재 사실을 노출하지 않는다).
 *  - `unavailable` — v2 응답불가라 **소유 여부를 판정하지 못함**(503).
 */
type MapAccess = "owned" | "denied" | "unavailable";

/**
 * 레벨2 3차 3.1 — IDOR 방어를 v2 event 소유권 + v2 seat_map_data 맵 존재로 검증(go seat_maps 미read).
 *
 * 🔴 레벨2 T2-EVT — "확인 불가"를 "확인됨"으로도 "없음"으로도 바꾸지 않는다(fail-closed).
 * 옛 구현은 `catch (V2CommerceError) → false` 로 v2 장애를 404 로 흡수했다. 소유 검증 주체가
 * `getOwnedEvent` 로 바뀌면서 그 예외는 더 이상 오지 않고(V2CommerceError 는 내부에서 흡수됨)
 * 대신 `EventAccessError(unavailable)` 가 온다 — 그대로 두면 정체불명 500 이 된다.
 * true 로 뭉개면 **미검증 접근 허용**(IDOR), false 로 뭉개면 재시도 가능한 장애가 영구 404 로
 * 보인다 → 어느 쪽도 아닌 별도 결과로 올려 라우트가 503 으로 통지한다. 접근은 어느 경우에도 불허.
 */
async function resolveMapAccess(
  eventId: string,
  mapId: string,
  accountId: string,
): Promise<MapAccess> {
  try {
    return (await verifySeatMapOwnershipV2(eventId, mapId, accountId)) ? "owned" : "denied";
  } catch (err: unknown) {
    if (err instanceof EventAccessError) return "unavailable";
    throw err;
  }
}

/** 소유 판정 실패 → 사용자 응답. `owned` 면 null(진행). */
function accessDeniedResponse(access: MapAccess): Response | null {
  if (access === "owned") return null;
  // v2 장애 = 재시도하면 풀리는 일시 오류 → 404(영구 없음)와 분리해 503 으로 통지한다.
  if (access === "unavailable") {
    return errorResponse(
      "좌석맵 접근 권한을 확인하지 못했습니다. 잠시 후 다시 시도해주세요.",
      503,
    );
  }
  return errorResponse("좌석맵을 찾을 수 없습니다", 404);
}

const publishSchema = z.object({
  type: z.enum(["cursor", "select"]),
  x: z.number().optional(),
  y: z.number().optional(),
  seatIds: z.array(z.string().uuid()).optional(),
  displayName: z.string().max(40).optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
});

export const runtime = "nodejs";

export const GET = withRole<Params>(
  "staff",
  async (_request, { session, params }) => {
    if (!UUID_RE.test(params.mapId)) {
      return errorResponse("잘못된 좌석맵 ID 입니다", 400);
    }
    // IDOR 방어 — 소유 확인 실패(404)·확인 불가(503) 어느 쪽이든 스트림을 열지 않는다.
    const denied = accessDeniedResponse(
      await resolveMapAccess(params.eventId, params.mapId, session.accountId),
    );
    if (denied) return denied;
    const userId = session.id;
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        function send(payload: unknown) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(payload)}\n\n`),
          );
        }
        // 연결 즉시 ping + join broadcast
        send({ type: "connected", mapId: params.mapId, userId });
        publishPresence(params.mapId, {
          type: "join",
          userId,
        });
        const unsubscribe = subscribePresence(params.mapId, (msg) => {
          if (msg.userId === userId) return; // self echo 차단
          send(msg);
        });
        // heartbeat (15s)
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(":heartbeat\n\n"));
          } catch {
            clearInterval(heartbeat);
          }
        }, 15_000);

        // 단절 감지
        const onAbort = () => {
          clearInterval(heartbeat);
          unsubscribe();
          publishPresence(params.mapId, { type: "leave", userId });
          try {
            controller.close();
          } catch {
            /* noop */
          }
        };
        // signal 은 GET request 의 abortController
        // (Next.js Edge Runtime / Node 양쪽 호환)
        if (typeof globalThis !== "undefined") {
          // request.signal 에 listener 부착은 호출자 측에서 처리되며,
          // 여기서는 stream cancel callback 으로 대체
        }
        return onAbort;
      },
      cancel() {
        publishPresence(params.mapId, { type: "leave", userId });
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  },
);

const postHandler = withRole<Params>(
  "staff",
  async (request, { session, params }) => {
    if (!UUID_RE.test(params.mapId)) {
      return errorResponse("잘못된 좌석맵 ID 입니다", 400);
    }
    const denied = accessDeniedResponse(
      await resolveMapAccess(params.eventId, params.mapId, session.accountId),
    );
    if (denied) return denied;
    try {
      const body = publishSchema.parse(await request.json());
      publishPresence(params.mapId, {
        type: body.type,
        userId: session.id,
        displayName: body.displayName,
        color: body.color,
        x: body.x,
        y: body.y,
        seatIds: body.seatIds,
      });
      return successResponse({ published: true });
    } catch (err) {
      if (err instanceof z.ZodError) {
        return errorResponse(err.issues[0]?.message ?? "입력값 오류", 400);
      }
      return errorResponse("발행 실패", 400);
    }
  },
);

export const POST = withRateLimit(SEAT_RATE_LIMITS.collab)(postHandler);
