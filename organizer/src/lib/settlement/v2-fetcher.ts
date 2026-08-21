/**
 * v2 internal settlement endpoint 호출.
 *
 * Endpoint: GET /api/v1/internal/organizers/{organizer_id}/settlement?event_id={uuid}
 * 인증: X-Pickket-Service-Token (V2_EVENT_SYNC_SECRET 환경변수, v2 측 GO_WEBHOOK_SECRET 동일값)
 *
 * 응답: { gross_revenue, platform_fee, platform_fee_rate, net_settlement,
 *         pending_refunds, final_payout, computed_at, event_id, organizer_id }
 *
 * Phase A 한계: 기간 필터 없음 — 호출 시점까지 누적값만 반환.
 *               월 단위 row 만들려면 호출자가 직접 차분 계산.
 */
import crypto from "node:crypto";
import { logger } from "@/lib/logger";

export interface V2SettlementSummary {
  organizer_id: string;
  event_id: string | null;
  gross_revenue: number;
  platform_fee: number;
  platform_fee_rate: number;
  net_settlement: number;
  pending_refunds: number;
  final_payout: number;
  computed_at: string;
}

export class V2SettlementFetchError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: string,
  ) {
    super(message);
    this.name = "V2SettlementFetchError";
  }
}

export async function fetchV2Settlement(
  organizerId: string,
  eventId: string | null = null,
): Promise<V2SettlementSummary> {
  const baseUrl = process.env.V2_INTERNAL_BASE_URL;
  const secret = process.env.V2_EVENT_SYNC_SECRET;

  if (!baseUrl || !secret) {
    throw new V2SettlementFetchError(
      "V2_INTERNAL_BASE_URL/SECRET 환경변수 미설정",
      500,
    );
  }

  const url = new URL(
    `${baseUrl.replace(/\/$/, "")}/api/v1/internal/organizers/${organizerId}/settlement`,
  );
  if (eventId) {
    url.searchParams.set("event_id", eventId);
  }

  // HMAC 서명 병행(GET=빈 본문). 토큰 유지 + 서명 추가 → 이 라우터가 향후 enforce 전환돼도 무중단
  //   (commerce-client/organizer-sync 와 동일 계약: sig = HMAC(secret, `${ts}.${rawBody}`)).
  const ts = new Date().toISOString();
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.`).digest("hex");
  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "X-Pickket-Service-Token": secret,
      "X-Pickket-Signature": sig,
      "X-Pickket-Timestamp": ts,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logger.warn("v2 settlement fetch 실패", {
      organizerId,
      eventId,
      status: res.status,
      body: body.slice(0, 500),
    });
    throw new V2SettlementFetchError(
      `v2 settlement ${res.status}`,
      res.status,
      body,
    );
  }

  return (await res.json()) as V2SettlementSummary;
}
