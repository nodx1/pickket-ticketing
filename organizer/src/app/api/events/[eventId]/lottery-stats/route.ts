/**
 * 주최자 응모 현황 조회 — v2 lottery-stats 엔드포인트 프록시.
 *
 * 주최자 인증은 withRole('organizer') 로 처리하고,
 * 실제 집계 데이터는 v2 `/api/v1/internal/events/{id}/lottery-stats` 에서 가져옴.
 * 60초 서버 캐시 적용.
 */
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { getPool } from "@/lib/db/pool";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { EventAccessError, eventAccessStatus, getOwnedEvent } from "@/lib/v2/event-access";
import { fetchLotteryStats } from "@/lib/v2/lottery-stats";
import { fetchSalePlan } from "@/lib/v2/phase-client";

export const GET = withRole<{ eventId: string }>(
  "organizer",
  async (_request, { session, params }) => {
    // 이벤트 소유권 검증 (주최자가 자기 이벤트만 조회)
    // ── 레벨2 컷오버 W4-EVT ──
    // 옛 `SELECT id FROM events WHERE id=$1 AND account_id=$2` → v2 소유 검증 read.
    // 경계는 v2 organizer_ref 가 강제한다(불일치 → 404).
    // 🔴 v2 장애를 404 로 뭉개면 주최자가 "응모 데이터가 사라졌다"고 오인한다 → 503.
    const pool = getPool();
    try {
      const owned = await getOwnedEvent(params.eventId, session.accountId);
      if (!owned) {
        return errorResponse(ERR.NOT_FOUND, 404);
      }
    } catch (err: unknown) {
      if (err instanceof EventAccessError) {
        return errorResponse(
          "이벤트 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
          eventAccessStatus(err),
        );
      }
      throw err;
    }

    const stats = await fetchLotteryStats(params.eventId);

    // go 로컬: tier 별 sale_mode / 전환 시각 (seat_tiers 는 T1 잔여 범위 — 별도 트랙 소유)
    const { rows: fcfsRows } = await pool.query<{
      id: string;
      saleMode: string;
      fcfsConvertedAt: string | null;
    }>(
      `SELECT id, sale_mode AS "saleMode", fcfs_converted_at AS "fcfsConvertedAt"
       FROM seat_tiers WHERE event_id = $1`,
      [params.eventId],
    );
    const fcfsByTier = new Map(
      fcfsRows.map((r) => [
        r.id,
        { saleMode: r.saleMode, fcfsConvertedAt: r.fcfsConvertedAt },
      ]),
    );
    // ── 레벨2 컷오버 T2-PHASE ──
    // 예전엔 v2→go `fcfs-converted` webhook 이 go seat_tiers.fcfs_converted_at 을 찍었고
    // 이 뱃지가 그 값을 읽었다. 그 webhook 은 제거됐다(v2 auto_fcfs_transition 이 자체 전환).
    // 이제 **판매 단계 SSOT**(v2 phase_configs)에서 직접 판정한다:
    // fcfs_residual 단계가 open 이면 선착순 전환됨. 조회 실패는 go 잔재값으로 폴백.
    let anyFcfsConverted = fcfsRows.some((r) => r.fcfsConvertedAt);
    try {
      const plan = await fetchSalePlan(params.eventId, session.accountId);
      if (plan) {
        anyFcfsConverted = plan.phases.some(
          (p) => p.mode === "fcfs_residual" && p.status === "open",
        );
      }
    } catch (err: unknown) {
      logger.warn("v2 판매 단계 조회 실패 — fcfs 전환 뱃지 go 잔재값 사용", {
        eventId: params.eventId,
        error: err instanceof Error ? err.message : "unknown",
      });
    }

    if (!stats) {
      return successResponse({
        eventId: params.eventId,
        phase: "pre_apply",
        stats: {
          totalEntries: 0,
          totalApplicants: 0,
          totalSeats: 0,
          competitionRatio: 0,
          winnersCount: null,
          waitlistedCount: null,
          losersCount: null,
          totalApInvested: 0,
          avgApPerEntry: 0,
        },
        byTier: [],
        drawExecutedAt: null,
        anyFcfsConverted,
        _note: "v2 응답 없음 (미설정 또는 조회 실패) — 빈 응답 반환",
      });
    }

    // byTier 에 fcfs 전환 상태 병합
    const byTier = stats.byTier.map((t) => ({
      ...t,
      saleMode: fcfsByTier.get(t.tierId)?.saleMode ?? "point_lottery",
      fcfsConvertedAt: fcfsByTier.get(t.tierId)?.fcfsConvertedAt ?? null,
    }));

    return successResponse({ ...stats, byTier, anyFcfsConverted });
  },
);
