/**
 * go reaper → v2 `/internal/lottery/draw-event` 호출.
 *
 * v2 는 이벤트의 모든 point_lottery tier 에 대해 추첨 실행 + 당첨자 Order/Ticket 생성 + 좌석 랜덤 배정.
 * 실패해도 예외 throw 하지 않고 false 반환 (reaper 가 계속 진행하도록).
 */
import crypto from "node:crypto";
import { logger } from "@/lib/logger";

const V2_DRAW_PATH = "/api/v1/internal/lottery/draw-event";

function sign(secret: string, timestamp: string, body: string): string {
  return crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

export async function triggerV2LotteryDraw(eventId: string): Promise<{
  ok: boolean;
  poolsDrawn?: number;
  winners?: number;
  waitlisted?: number;
}> {
  const baseUrl = process.env.V2_INTERNAL_BASE_URL;
  const secret = process.env.V2_EVENT_SYNC_SECRET;
  if (!baseUrl || !secret) {
    logger.debug("v2 lottery draw 스킵: V2_INTERNAL_BASE_URL/SECRET 미설정");
    return { ok: false };
  }

  const url = `${baseUrl.replace(/\/$/, "")}${V2_DRAW_PATH}`;
  const timestamp = new Date().toISOString();
  const deliveryId = crypto.randomUUID();
  const body = JSON.stringify({ eventId });
  const signature = sign(secret, timestamp, body);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pickket-Signature": signature,
        "X-Pickket-Timestamp": timestamp,
        "X-Pickket-Event": "lottery.draw-event",
        "X-Pickket-Delivery-Id": deliveryId,
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      logger.warn("v2 lottery draw 실패", {
        eventId,
        status: res.status,
        body: await res.text().catch(() => ""),
      });
      return { ok: false };
    }
    const data = (await res.json()) as {
      poolsDrawn?: number;
      winners?: number;
      waitlisted?: number;
    };
    logger.info("v2 lottery draw 성공", { eventId, ...data });
    return { ok: true, ...data };
  } catch (err: unknown) {
    logger.warn("v2 lottery draw 에러", {
      eventId,
      error: err instanceof Error ? err.message : "알 수 없는 오류",
    });
    return { ok: false };
  }
}
