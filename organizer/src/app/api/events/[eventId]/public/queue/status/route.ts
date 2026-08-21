import { NextRequest, NextResponse } from "next/server";
import { logger } from "@/lib/logger";
import {
  getQueuePosition,
  resolveQueueEventFromSessionToken,
} from "@/lib/queue/smart-queue";
import { V2CommerceError } from "@/lib/v2/commerce-client";

export async function GET(request: NextRequest, { params }: { params: Promise<{ eventId: string }> }) {
  try {
    const { eventId } = await params;
    const url = new URL(request.url);
    const sessionToken = url.searchParams.get("token") ?? "";

    const v2EventId = resolveQueueEventFromSessionToken(sessionToken, eventId);
    if (!v2EventId) {
      return NextResponse.json({ error: "토큰이 필요합니다" }, { status: 400 });
    }

    const result = await getQueuePosition(v2EventId, sessionToken);
    return NextResponse.json(
      { data: result },
      { headers: { "Cache-Control": "no-store, no-cache, must-revalidate" } },
    );
  } catch (error) {
    logger.error("[queue] v2 대기열 상태 조회 실패", {
      error: error instanceof Error ? error.message : "unknown",
    });
    return NextResponse.json(
      { error: "대기열 상태 조회에 실패했습니다" },
      { status: error instanceof V2CommerceError ? 503 : 500 },
    );
  }
}
