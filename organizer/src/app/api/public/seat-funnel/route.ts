/**
 * 트랙 7.9 — 좌석 funnel 이벤트 수집 (public, 비로그인 가능)
 *
 * 클라이언트가 sendBeacon 으로 호출. 인증 없음.
 * session_id (cookie) 기준으로 사용자 단위 funnel 추적.
 *
 * 레벨2 컷오버 T2-REST: 저장소를 go seat_funnel_events → **v2 정본**으로 이관.
 * fail-soft 계약은 그대로 — 수집 실패는 삼키고 항상 200 을 돌려준다(분석이 구매를 막지 않는다).
 * 멱등키 없음이 의도다: 집계가 COUNT(DISTINCT session_id) 라 중복 수집이 결과를 바꾸지 않는다.
 *
 * ── 레벨2 컷오버 W2-PUB ──
 * 앵커 조회(`SELECT v2_event_id FROM events WHERE id=$1`)를 제거했다. ID 승격 이후
 * go event id == v2 event id 라 변환이 필요 없고, 미앵커 이벤트라는 개념도 사라졌다.
 * (앵커 조회가 남아 있으면 go DB 왕복 1회가 모든 좌석 비콘마다 붙는다.)
 */
import crypto from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { seatMetrics } from "@/lib/seats/metrics";
import { collectSeatFunnelEvent } from "@/lib/v2/commerce-client";
import { toV2EventId } from "@/lib/v2/event-access";

const SESSION_COOKIE = "pickket_seat_session";

const eventSchema = z.object({
  eventId: z.string().uuid(),
  seatMapId: z.string().uuid().nullable().optional(),
  step: z.enum(["view", "hover", "select", "hold", "checkout", "complete", "abandon"]),
  seatCount: z.number().int().min(0).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function POST(request: NextRequest): Promise<Response> {
  let body: z.infer<typeof eventSchema>;
  try {
    body = eventSchema.parse(await request.json());
  } catch {
    // analytics 는 fail-soft (스키마 안 맞아도 200)
    return NextResponse.json({ success: true });
  }

  const sessionId =
    request.cookies.get(SESSION_COOKIE)?.value ?? crypto.randomUUID();

  try {
    // 공개 비콘이라 계정 스코프가 없다 — 쓰기 전용·조회 불가 데이터라 테넌트 누출
    // 경로가 아니다(집계 조회는 organizer 스코프 API 로만 가능). 미존재 event id 는
    // v2 가 accepted:false 로 조용히 버린다.
    await collectSeatFunnelEvent(toV2EventId(body.eventId), {
      seat_map_id: body.seatMapId ?? null,
      session_id: sessionId,
      step: body.step,
      seat_count: body.seatCount ?? null,
      meta: body.metadata ?? {},
    });
    seatMetrics.incrementFunnelEvent();
  } catch {
    // v2 수집 실패해도 200 (analytics 가 구매를 차단하지 않는다)
  }

  return NextResponse.json({ success: true });
}
