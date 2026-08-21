/**
 * POST /api/events/[eventId]/public/queue/join — 대기열 참여(공개·비인증)
 *
 * ── 레벨2 컷오버 W2-PUB ──
 * go `SELECT queue_enabled, queue_config, v2_event_id FROM events` → v2 이벤트 상세 read.
 * queue_enabled/queue_config 는 v2 가 이미 SoT 로 내려준다(ctevt_0727). 앵커(v2_event_id)는
 * ID 승격으로 소멸 — event_id 자체가 canonical id 다.
 *
 * 실패 계약: 미존재 404 / v2 응답불가 **503**(대기열은 재시도가 자연스러운 경로).
 */
import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import {
  createQueueSessionToken,
  joinQueue,
} from "@/lib/queue/smart-queue";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { PUBLIC_ANY_STATUS, resolvePublicEventById } from "@/lib/v2/public-event";

function resolveMaxConcurrent(config: Record<string, unknown> | null | undefined): number {
  const value = config?.maxConcurrent;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= 10_000
    ? value
    : 100;
}

export async function POST(_request: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await params;

    // 상태 게이트 없음(기존 동작 유지) — go 도 status 를 보지 않았다. 대기열은 판매개시
    // **직전** 대기 트래픽을 받는 장치라 live 이전에도 줄을 세워야 한다.
    const resolved = await resolvePublicEventById(eventId, PUBLIC_ANY_STATUS);
    if (!resolved.ok) {
      return NextResponse.json({ error: resolved.error }, { status: resolved.status });
    }
    const event = resolved.event;

    if (!event.queue_enabled) {
      return NextResponse.json({ data: { position: 0, status: "active", sessionToken: "" } });
    }

    const result = await joinQueue(
      event.event_id,
      resolveMaxConcurrent(event.queue_config),
      createQueueSessionToken(eventId, event.event_id),
    );
    return NextResponse.json({ data: result });
  } catch (error) {
    logger.error("[queue] v2 대기열 참여 실패", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json(
      { error: "대기열 참여에 실패했습니다" },
      { status: error instanceof V2CommerceError ? 503 : 500 },
    );
  }
}
