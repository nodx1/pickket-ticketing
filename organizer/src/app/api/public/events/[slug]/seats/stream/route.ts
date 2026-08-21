/**
 * Public SSE — 좌석 상태 실시간 스트림 (Phase 4)
 *
 * - `runtime = "nodejs"` 필수 (ioredis 사용)
 * - Last-Event-ID 헤더로 재접속 catch-up (Redis Stream 재생)
 *
 * NOTE: 경로 파라미터는 slug 기반. slug→id 조회로 이벤트 존재/공개 여부 검증 후 구독.
 */
import type { NextRequest } from "next/server";
import {
  replaySeatUpdates,
  subscribeSeatUpdates,
  type SeatUpdateMessage,
} from "@/lib/seats/event-bus";
import { seatMetrics } from "@/lib/seats/metrics";
import { fetchPublishedMapIds } from "@/lib/v2/seat-map-payload";
import { withRateLimit, SEAT_RATE_LIMITS } from "@/lib/auth/withRateLimit";
import {
  PUBLIC_PURCHASE_STATUSES,
  resolvePublicEventBySlug,
} from "@/lib/v2/public-event";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { slug: string };

async function handler(
  request: NextRequest,
  context: { params: Promise<Params> },
) {
  const { slug } = await context.params;
  const url = new URL(request.url);
  const mapId = url.searchParams.get("mapId");
  if (!mapId) {
    return new Response("mapId 파라미터가 필요합니다", { status: 400 });
  }

  // slug 조회 + 이벤트 공개 검증 (W2-PUB: v2 by-slug live read)
  // ⚠️ v2 불가는 404 가 아니라 503 — SSE 클라이언트가 "이벤트 없음"으로 오해해
  //    재연결을 포기하면 좌석 화면이 영구히 정지한다.
  const resolved = await resolvePublicEventBySlug(slug, PUBLIC_PURCHASE_STATUSES);
  if (!resolved.ok) {
    return new Response(resolved.error, { status: resolved.status });
  }

  // 🔴 mapId 가 **이 이벤트의 것인지** 확인한다 (2026-07-29 감사).
  //
  // 종전에는 slug 로 "공개된 이벤트인가"만 보고, 구독은 쿼리스트링으로 받은 mapId 를
  // 그대로 썼다. 즉 공개 이벤트 slug 하나만 알면 게이트를 통과시킨 뒤 **다른 이벤트
  // (비공개 draft·타 주최자)의 좌석맵 ID** 를 넣어 실시간 좌석 상태를 구독할 수 있었다.
  // slug 검증이 실질적인 접근제어로 작동하지 않았다.
  //
  // 형제 라우트(`../seats/route.ts`)는 이미 이 대조를 한다 — 같은 패턴을 쓴다.
  // ⚠️ v2 조회 실패는 404 가 아니라 503 이어야 한다. SSE 클라이언트가 "없는 이벤트"로
  //    오해해 재연결을 포기하면 좌석 화면이 영구히 멈춘다(위 주석과 같은 이유).
  let publishedMapIds: string[];
  try {
    publishedMapIds = await fetchPublishedMapIds(resolved.event.event_id);
  } catch {
    return new Response("좌석 정보를 불러오지 못했습니다", { status: 503 });
  }
  if (!publishedMapIds.includes(mapId)) {
    return new Response("좌석맵을 찾을 수 없습니다", { status: 404 });
  }

  const lastEventId = request.headers.get("last-event-id") ?? "";

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      let unsubscribe: (() => void) | null = null;

      const safeEnqueue = (chunk: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // 컨트롤러 이미 종료
        }
      };

      const send = (id: string | null, data: unknown) => {
        const idLine = id ? `id: ${id}\n` : "";
        safeEnqueue(`${idLine}data: ${JSON.stringify(data)}\n\n`);
      };

      // 초기 연결 알림 + 메트릭
      seatMetrics.sseConnected();
      send(null, { type: "connected", mapId });

      // 주기적 keepalive (30초) — 프록시 타임아웃 방지
      const keepalive = setInterval(() => safeEnqueue(`: keepalive\n\n`), 30_000);

      // catch-up 재생
      if (lastEventId) {
        try {
          const replayed = await replaySeatUpdates(mapId, lastEventId, 200);
          for (const { streamId, message } of replayed) {
            send(streamId, message);
          }
        } catch {
          // 재생 실패는 무시 — 실시간 구독은 계속
        }
      }

      // 실시간 구독
      unsubscribe = subscribeSeatUpdates(
        mapId,
        (msg: SeatUpdateMessage & { streamId?: string }) => {
          send(msg.streamId ?? null, msg);
        },
      );

      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        seatMetrics.sseDisconnected();
        try {
          unsubscribe?.();
        } catch {
          // 해제 실패 무시
        }
        try {
          controller.close();
        } catch {
          // 이미 닫혔으면 무시
        }
      };

      request.signal.addEventListener("abort", cleanup);
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
}

// 🔴 공개 SSE 라우트라 레이트리밋이 필요하다 (2026-07-29 감사).
//    연결마다 Redis 커넥션을 새로 여는데(`subscribeSeatUpdates` → `duplicate()`) 상한이
//    없어, 무제한 연결로 Redis·서버 자원을 고갈시킬 수 있었다. 형제 라우트(seats·watch·
//    collab)는 전부 걸려 있는데 이 스트림만 빠져 있었다.
export const GET = withRateLimit(SEAT_RATE_LIMITS.collab)(handler);
