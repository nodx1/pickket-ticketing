/**
 * 트랙 7.21 — 좌석 알림 트리거 cron (5분 주기)
 *
 * seat_watches 에 등록된 항목 중:
 *  - target_price 설정 → 현재 base_price 가 target 이하인 좌석
 *  - target_price NULL → 좌석 status 가 available 으로 변경된 경우
 * → 알림 발송 후 notify_at 갱신 (중복 발송 방지)
 *
 * 인증: Bearer ${CRON_SECRET}
 *
 * ── 레벨2 컷오버 W3-OPS — 무성 고장 수리 ──
 * 이 cron 은 `JOIN seats s ON s.id = w.seat_id` + `LEFT JOIN seat_tiers` 로 go 좌석을 읽었다.
 * 그런데 T1 좌석 write 컷오버 이후 go `seats` 에는 **writer 가 하나도 없다** — mig234 주석이
 * 직접 명시한다: "go `seats` 는 좌석빌더 write 경로가 사라져 **항상 빈 테이블**".
 * 게다가 같은 마이그가 `seat_watches.seat_id` 의 FK 를 떼면서 그 컬럼의 의미를
 * **v2 canonical seat_id** 로 바꿨다(컬럼 COMMENT 로 문서화됨).
 * ⟹ INNER JOIN 은 **영원히 0행**. 관심좌석 알림은 등록만 받고 한 건도 나가지 않는 상태였다.
 *    (에러도 0건이라 로그로는 드러나지 않는 전형적 무성 누락.)
 *
 * 지금은 좌석 status·가격을 v2(SoT)에서 live read 한다:
 *   - status   : GET /internal/events/{id}/seats (fetchAllV2Seats)
 *   - basePrice: GET /internal/events/{id}/tiers (seat.tier_id → tier.base_price)
 * go event id == v2 event id(앵커 폐기, `toV2EventId` 항등)이므로 seat_watches.event_id 를 그대로 쓴다.
 *
 * ## fail-closed
 * 이벤트별 v2 조회가 실패하면 그 이벤트의 watch 는 **건너뛰되 성공으로 위장하지 않는다** —
 * `degradedEvents` 로 세고 207(degraded)로 전파한다. "조회 실패 → 대상 0건 → 200 성공"은
 * 알림이 조용히 누락되는 경로다.
 *
 * ## 멱등성
 * 발송 후 `notify_at` 을 채워 다음 tick 에서 제외한다(기존 계약 유지). 동시 2회 실행 시
 * 같은 watch 가 두 번 잡힐 수 있으므로, 클레임을 `notify_at IS NULL` 조건부 UPDATE 로
 * **선점**한 뒤 발송한다 — 선점에 진 실행은 claimed:false 를 받아 발송하지 않는다(이중발송 불가).
 * 선점 후 발송 실패 시에는 notify_at 을 되돌려 다음 tick 이 재시도하게 한다.
 *
 * ── 레벨2 컷오버 W5-ATTENDEE ──
 * `seat_watches` 원장이 v2 정본으로 이관됐다. 후보 조회/선점/해제가 전부 v2 internal API 다.
 * **선점의 원자성은 그대로 조건부 UPDATE**(v2 `POST /seat-watches/{id}/claim` 이 서버측에서
 * `notify_at IS NULL` 조건으로 갱신) — 판정 로직·이중발송 차단 근거는 이관 전과 동일하다.
 * 등록 라우트(`public/events/{slug}/seats/watch`)와 **같은 배치로** 옮겨 split-brain 없음.
 */
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { logger } from "@/lib/logger";
import {
  createSeatNotification,
  type SeatNotifyKind,
} from "@/lib/notifications/seat-channels";
import {
  claimSeatWatch,
  listPendingSeatWatches,
  listTiers,
  releaseSeatWatch,
  V2CommerceError,
} from "@/lib/v2/commerce-client";
import { toV2EventId } from "@/lib/v2/event-access";
import { fetchAllV2Seats } from "@/lib/seats/v2-status";

interface WatchRow {
  id: string;
  accountId: string | null;
  seatId: string;
  sessionId: string | null;
  eventId: string;
  targetPrice: number | null;
}

/** 이벤트 1건의 v2 좌석 상태 + 좌석별 가격. */
interface EventSeatFacts {
  statusBySeatId: Map<string, string>;
  basePriceBySeatId: Map<string, number>;
}

async function loadEventSeatFacts(goEventId: string): Promise<EventSeatFacts> {
  const v2EventId = toV2EventId(goEventId);
  const [seatList, tierList] = await Promise.all([
    fetchAllV2Seats(v2EventId),
    listTiers(v2EventId),
  ]);

  const priceByTierId = new Map(tierList.tiers.map((t) => [t.tier_id, Number(t.base_price)]));
  const statusBySeatId = new Map<string, string>();
  const basePriceBySeatId = new Map<string, number>();

  for (const seat of seatList.seats) {
    statusBySeatId.set(seat.seat_id, seat.status);
    const price = seat.tier_id ? priceByTierId.get(seat.tier_id) : undefined;
    if (price !== undefined) basePriceBySeatId.set(seat.seat_id, price);
  }

  return { statusBySeatId, basePriceBySeatId };
}

export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  const authHeader = request.headers.get("authorization") ?? "";
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return errorResponse("인증 정보가 올바르지 않습니다", 401);
  }

  // 미발송(notify_at IS NULL) watch 만 후보로 읽는다(v2 정본).
  // 🔴 fail-closed: 후보 조회 자체가 실패하면 "대상 0건 → 200 성공"으로 위장하지 않는다.
  //    그건 알림이 조용히 멈춘 채 감시가 초록으로 보이는 정확히 그 실패 모드다 → 503.
  let candidates: WatchRow[];
  try {
    const { watches } = await listPendingSeatWatches(200);
    candidates = watches.map((w) => ({
      id: w.id,
      accountId: w.account_ref,
      seatId: w.seat_id,
      sessionId: w.session_id,
      eventId: w.event_id,
      targetPrice: w.target_price,
    }));
  } catch (err: unknown) {
    logger.error("[seat-watch] 후보 조회 실패 — tick 중단", {
      status: err instanceof V2CommerceError ? err.status : undefined,
      error: err instanceof Error ? err.message : "unknown",
    });
    return errorResponse("관심 좌석 후보를 불러오지 못했습니다", 503);
  }

  // 이벤트 단위로 묶어 v2 왕복을 이벤트당 2회로 억제(watch 당 N+1 금지).
  const byEvent = new Map<string, WatchRow[]>();
  for (const w of candidates) {
    const list = byEvent.get(w.eventId);
    if (list) list.push(w);
    else byEvent.set(w.eventId, [w]);
  }

  let triggered = 0;
  let notified = 0;
  let failed = 0;
  let degradedEvents = 0;

  for (const [eventId, watches] of byEvent) {
    let facts: EventSeatFacts;
    try {
      facts = await loadEventSeatFacts(eventId);
    } catch (err: unknown) {
      // 조회 실패를 "트리거 대상 없음"으로 흘리면 알림이 조용히 누락된다 → degraded 로 표면화.
      degradedEvents += 1;
      logger.error("[seat-watch] v2 좌석/티어 조회 실패 — 이번 tick 건너뜀", {
        eventId,
        watchCount: watches.length,
        status: err instanceof V2CommerceError ? err.status : undefined,
        error: err instanceof Error ? err.message : "unknown",
      });
      continue;
    }

    for (const w of watches) {
      const status = facts.statusBySeatId.get(w.seatId);
      // v2 에 없는 좌석(배치도 축소로 사라짐 등)은 판정 불가 — 발송하지 않고 넘어간다.
      // (watch 는 남겨둔다: 좌석이 되살아나면 다음 tick 이 잡는다.)
      if (status === undefined) continue;

      const basePrice = facts.basePriceBySeatId.get(w.seatId) ?? null;
      const priceHit =
        w.targetPrice !== null && basePrice !== null && basePrice <= w.targetPrice;
      const availableHit = w.targetPrice === null && status === "available";
      if (!priceHit && !availableHit) continue;

      triggered += 1;

      // 멱등 선점: notify_at 을 먼저 확정한다(v2 서버측 조건부 UPDATE). 1행을 갱신한 쪽만 발송.
      // 🔴 선점 호출 실패는 "선점 실패"로 취급한다 — 발송하지 않는다. 확정 못 한 채 보내면
      //    다음 tick 이 같은 watch 를 다시 잡아 **이중발송**이 된다(선점의 존재 이유).
      let claimed = false;
      try {
        claimed = (await claimSeatWatch(w.id)).claimed;
      } catch (err: unknown) {
        failed += 1;
        logger.error("[seat-watch] 선점 실패 — 이번 tick 미발송", {
          watchId: w.id,
          error: err instanceof Error ? err.message : "unknown",
        });
        continue;
      }
      if (!claimed) continue; // 다른 실행이 선점 — 이중발송 방지

      const kind: SeatNotifyKind = priceHit ? "watch_price_drop" : "watch_available";
      try {
        await createSeatNotification({
          kind,
          accountId: w.accountId,
          sessionId: w.sessionId,
          eventId: w.eventId,
          seatId: w.seatId,
          payload: { targetPrice: w.targetPrice, basePrice },
        });
        notified += 1;
        logger.info("[seat-watch] 알림 트리거", {
          watchId: w.id,
          kind,
          seatId: w.seatId,
          accountId: w.accountId,
          sessionId: w.sessionId,
          targetPrice: w.targetPrice,
        });
      } catch (err: unknown) {
        // 발송 실패 → 선점 해제해 다음 tick 재시도. 되돌리지 않으면 알림이 영구 유실된다.
        failed += 1;
        await releaseSeatWatch(w.id).catch(() => undefined);
        logger.error("[seat-watch] 알림 트리거 실패", {
          watchId: w.id,
          error: err instanceof Error ? err.message : "unknown",
        });
      }
    }
  }

  const result = {
    candidates: candidates.length,
    triggered,
    notified,
    failed,
    degradedEvents,
    timestamp: new Date().toISOString(),
  };

  if (degradedEvents > 0 || failed > 0) {
    return new Response(JSON.stringify({ success: false, data: result }), {
      status: 207,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  }
  return successResponse(result);
}
