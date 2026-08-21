/**
 * v2 lottery-stats 프록시 + in-memory 캐시 (60초 TTL).
 *
 * v2 엔드포인트: GET /api/v1/internal/events/{eventId}/lottery-stats
 * 인증: X-Pickket-Service-Token 헤더에 V2_EVENT_SYNC_SECRET 값 전달.
 *
 * 주최자 대시보드에서 30초 주기로 자동 갱신되므로 서버 사이드 캐시가 핵심.
 */
import crypto from "node:crypto";
import { logger } from "@/lib/logger";

export type LotteryPhase =
  | "pre_apply"
  | "applying"
  | "closed"
  | "drawing"
  | "drawn";

export interface LotteryStats {
  eventId: string;
  phase: LotteryPhase;
  stats: {
    totalEntries: number;
    totalApplicants: number;
    totalSeats: number;
    competitionRatio: number;
    winnersCount: number | null;
    waitlistedCount: number | null;
    losersCount: number | null;
    totalApInvested: number;
    avgApPerEntry: number;
  };
  byTier: Array<{
    tierId: string;
    tierName: string;
    seats: number;
    entries: number;
    applicants: number;
    competitionRatio: number;
    winnersCount: number | null;
    totalApInvested: number;
  }>;
  drawExecutedAt: string | null;
}

const CACHE_TTL_MS = 60_000;
const cache = new Map<string, { value: LotteryStats; expiresAt: number }>();

export async function fetchLotteryStats(eventId: string): Promise<LotteryStats | null> {
  const now = Date.now();
  const cached = cache.get(eventId);
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }

  const baseUrl = process.env.V2_INTERNAL_BASE_URL;
  const secret = process.env.V2_EVENT_SYNC_SECRET;
  if (!baseUrl || !secret) {
    logger.debug("lottery-stats skip: env 미설정");
    return null;
  }

  const url = `${baseUrl.replace(/\/$/, "")}/api/v1/internal/events/${eventId}/lottery-stats`;

  try {
    // HMAC 서명 병행(GET=빈 본문) → enforce 전환 대비. 토큰 유지(현 라우터는 토큰 검증).
    const ts = new Date().toISOString();
    const sig = crypto.createHmac("sha256", secret).update(`${ts}.`).digest("hex");
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "X-Pickket-Service-Token": secret,
        "X-Pickket-Signature": sig,
        "X-Pickket-Timestamp": ts,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      logger.warn("v2 lottery-stats 실패", { eventId, status: res.status });
      return null;
    }

    const data = (await res.json()) as LotteryStats;
    cache.set(eventId, { value: data, expiresAt: now + CACHE_TTL_MS });
    return data;
  } catch (err) {
    logger.warn("v2 lottery-stats 에러", {
      eventId,
      error: err instanceof Error ? err.message : "unknown",
    });
    return null;
  }
}

/** 테스트/관리자 수동 무효화용 */
export function invalidateLotteryStatsCache(eventId?: string): void {
  if (eventId) cache.delete(eventId);
  else cache.clear();
}
