import { errorResponse, successResponse } from "@/lib/apiResponse";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getPool } from "@/lib/db/pool";
import { finishCronRun, startCronRun } from "@/lib/ops/cron-run";
import { askV2AboutOrder, mayExpire } from "@/lib/orders/v2-authority";
import { reapInventory, V2CommerceError } from "@/lib/v2/commerce-client";

/**
 * 한 tick 에서 v2 에 물어볼 만료 후보 상한.
 *
 * 후보 1건당 v2 왕복 1회다. 상한이 없으면 적체가 생겼을 때 5분 크론이 수백 번 왕복하며
 * v2 를 밀어붙인다. 넘치면 잘라내되 **응답에 표시**한다 — 조용히 자르면 "다 처리했다"
 * 로 읽히고, 남은 주문은 다음 tick 이 만료 시각 순으로 이어받는다.
 */
const EXPIRE_CANDIDATE_LIMIT = 200;

/**
 * 만료 주문/홀드 정리 cron — 빅뱅 flip: 만료 원자성은 v2 SoT.
 *
 * 기존엔 go DB 를 직접 만료(orders.status / seats / products.stock / order_items 복원)했으나,
 * 이 컬럼/테이블들은 DROP 대상이라 깨진다. 이제 commerce-client.reapInventory() 로 위임 —
 * v2 가 만료 hold 회수 + 미결제주문 EXPIRED + 티켓 EXPIRED + 좌석 SOLD→AVAILABLE + sold_count 를
 * 단일 트랜잭션으로 처리한다. go 는 트리거만 담당(상태 SoT 미보유).
 *
 * ## 🔴 실행 기록(ops_cron_runs) — 2026-07-30 추가
 * 종전에는 이 라우트만 `startCronRun/finishCronRun` 을 호출하지 않았다. host crontab 에
 * 7개 크론이 등록돼 있는데 **이것만 `ops_cron_runs` 에 흔적이 없어**, 통합DB 감사에서
 * "7일간 실행 0건" 으로 나왔다.
 *
 * 문제는 그 상태가 **정상과 구분되지 않는다**는 것이다:
 *   · 잘 돌고 있다          → 기록 없음
 *   · 크론이 빠졌다          → 기록 없음
 *   · CRON_SECRET 이 틀려 401 → 기록 없음
 * crontab 이 `curl -fsS … >/dev/null 2>&1` 이라 실패 출력도 버려진다.
 * 미결제 주문·좌석 홀드를 정리하는 작업이 멈춰도 **아무도 모르는** 상태였다.
 *
 * ⚠️ 인증 실패(401)는 기록하지 않는다 — 기록은 pool 접근을 요구하고, 인증 전 단계에서
 *    외부 요청이 원장에 행을 만들 수 있게 하면 그 자체가 쓰기 표면이 된다.
 *    "크론이 도는데 401" 은 성공 기록의 **부재**로 드러난다(이제 성공 시엔 남으므로).
 */
export async function GET(request: Request) {
  const cronSecret = process.env.CRON_SECRET ?? "";
  const authHeader = request.headers.get("authorization") ?? "";
  const timestamp = request.headers.get("x-cron-timestamp") ?? "";

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return errorResponse("인증 정보가 올바르지 않습니다", 401);
  }

  if (timestamp) {
    const requestTime = new Date(timestamp).getTime();
    if (Number.isNaN(requestTime) || Math.abs(Date.now() - requestTime) > 300_000) {
      return errorResponse("요청 시간이 만료되었습니다", 401);
    }
  }

  // 🔴 계측 시작은 인증 통과 **후**. 인증 실패를 원장에 남기지 않는다(위 도크 참조).
  const pool = getPool();
  const cronRun = await startCronRun(pool, "expire-orders");

  try {
    // event_id 미지정 = 전체 스코프 만료 정리. v2 가 원자 처리하고 집계 반환.
    const reaped = await reapInventory();

    // 감사 P2: v2 는 만료주문을 EXPIRED 로 전이하지만 go orders 앵커는 'pending' 으로 잔류해
    // 표시/집계가 어긋날 수 있다. go-local 로도 만료 pending 주문을 'expired' 로 동기화한다(멱등).
    // (상태 SoT 는 v2 — 이 sweep 은 앵커 표시값 정합용. status='expired' 는 migration 071 로 허용됨.)
    let goExpired = 0;
    let attendeesCancelled = 0;
    let anchorSyncFailed = false;
    let paidSkipped = 0;
    let inFlight = 0;
    let undecidable = 0;
    let candidatesCapped = false;
    try {
      // 🔴 2026-07-31 — 종전엔 조건 없이 UPDATE 했다:
      //      WHERE status='pending' AND expires_at < NOW()
      //    v2→go 전파가 죽어 있던 동안 **결제 완료된 주문이 그대로 걸려** 만료됐고
      //    (ORD-260731-002: v2 confirmed·티켓 active), 이어서 아래 참석자 UPDATE 가
      //    그 구매자를 발송 세그먼트에서 제외시켰다.
      //
      //    Order status 는 **v2 SSOT** 다. go 의 expires_at 은 결제창 제한시간일 뿐
      //    "결제되지 않았다" 의 증거가 아니다. 그래서 후보를 v2 와 대조한 뒤에만 만료한다.
      //    ⚠️ fail-closed — 못 물어보면 **만료하지 않는다**. 안 죽인 주문은 다음 tick 이
      //       다시 보지만, 잘못 죽인 주문은 참석자 취소·보상환불까지 번진다.
      const candidates = await pool.query<{ id: string }>(
        `SELECT id FROM orders
          WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < NOW()
          ORDER BY expires_at
          LIMIT ${EXPIRE_CANDIDATE_LIMIT + 1}`,
      );
      const rows = candidates.rows.slice(0, EXPIRE_CANDIDATE_LIMIT);
      // 상한을 넘겼으면 **말한다**. 조용히 자르면 "다 처리했다" 로 읽힌다.
      candidatesCapped = candidates.rowCount != null && candidates.rowCount > EXPIRE_CANDIDATE_LIMIT;

      const expirable: string[] = [];
      for (const row of rows) {
        const verdict = await askV2AboutOrder(row.id);
        if (mayExpire(verdict)) {
          expirable.push(row.id);
          continue;
        }
        if (verdict.kind === "paid") {
          paidSkipped += 1;
          // 결제됐는데 go 가 pending 이면 전파가 유실된 것이다. 만료를 막는 것으로 끝내지
          // 않고 표면화한다 — 대사(reconcile-order-state)가 고칠 대상이다.
          logger.warn("🔴 결제 완료 주문의 만료를 차단했다(전파 유실 의심)", {
            source: "expire-orders",
            goOrderId: row.id,
            v2OrderId: verdict.v2OrderId,
            v2Status: verdict.v2Status,
          });
        } else if (verdict.kind === "in_flight") {
          // v2 가 아직 결제 전으로 본다 = **정상**. go 시계로 먼저 죽이지 않는다.
          // v2 reap 이 expired 로 만들면 그때 따라간다(SSOT 순서). 경보 대상이 아니다.
          inFlight += 1;
        } else if (verdict.kind === "unknown") {
          undecidable += 1;
          logger.warn("v2 판정 실패 — 만료를 보류한다", {
            source: "expire-orders",
            goOrderId: row.id,
            reason: verdict.reason,
          });
        }
      }

      const res = expirable.length
        ? await pool.query(
            // 재판정 조건(status/expires_at)을 UPDATE 에 그대로 유지한다 — 크론이 중복
            // 실행되거나(ops_cron_runs 에 동일 시각 2행 관측) 조회~UPDATE 사이에 상태가
            // 바뀌었을 때 낡은 판정으로 덮어쓰지 않는다.
            `UPDATE orders SET status = 'expired', updated_at = NOW()
              WHERE id = ANY($1::uuid[])
                AND status = 'pending' AND expires_at IS NOT NULL AND expires_at < NOW()`,
            [expirable],
          )
        : { rowCount: 0 };
      goExpired = res.rowCount ?? 0;

      // 만료 주문의 참석자가 confirmed 로 남으면 만료된 주문의 티켓으로 체크인이 가능해진다.
      //
      // 🔴 **명시적 직렬화**. repair 와 이 sweep 이 겹치면 "주문 completed · 참석자
      //    cancelled" 가 남고, 대사는 completed 를 안 보므로 **복구 경로가 없는 영구
      //    불일치**가 된다(원사고 재현). 그래서 주문행을 먼저 잠그고(FOR UPDATE) 같은
      //    트랜잭션에서 참석자를 갱신한다 — repair 도 주문행을 잠그므로
      //    (`repairOrderToPaid`) 둘은 반드시 직렬화된다.
      //
      //    ⚠️ 종전엔 `UPDATE attendees ... FROM orders` 조인이었다. 적대감사는 그것이
      //       PostgreSQL EPQ 특성(대상 행만 재검사·조인 관계는 옛 튜플 재사용) 때문에
      //       뚫린다고 지적했으나, **로컬 실 DB 2세션 실험에서 재현되지 않았다**
      //       (조인 버전도 참석자를 다시 죽이지 않았다 — `scripts/verify/sweep-repair-race-pg.sh`).
      //       즉 "조인이 확실히 깨진다" 는 **미확인**이다.
      //    ⟹ 그럼에도 명시적 잠금을 쓴다. 이 경로의 실패는 되돌릴 수 없고, EPQ 의
      //       세부 동작에 안전성을 의존하는 것보다 **직렬화가 읽는 사람에게 자명**하다.
      const sweepClient = await pool.connect();
      try {
        await sweepClient.query("BEGIN");
        const locked = await sweepClient.query<{ id: string }>(
          `SELECT id FROM orders
            WHERE status = 'expired' AND updated_at >= NOW() - INTERVAL '7 days'
            ORDER BY id
            FOR UPDATE`,
        );
        const ids = locked.rows.map((r) => r.id);
        if (ids.length > 0) {
          const att = await sweepClient.query(
            `UPDATE attendees SET status = 'cancelled', updated_at = NOW()
              WHERE order_id = ANY($1::uuid[])
                AND status NOT IN ('cancelled', 'checked_in')`,
            [ids],
          );
          attendeesCancelled = att.rowCount ?? 0;
        }
        await sweepClient.query("COMMIT");
      } catch (e) {
        await sweepClient.query("ROLLBACK").catch(() => {});
        throw e;
      } finally {
        sweepClient.release();
      }
    } catch (e) {
      // 앵커 표시 동기화 실패는 비파괴(다음 cron 이 재시도). 다만 **응답에서 지워버리면**
      // 만료 참석자가 confirmed 로 남아 체크인 가능한 상태를 200 성공으로 위장하게 된다
      // (레벨2 컷오버 W3-OPS: "성공 위장 금지"). 결과에 플래그로 표면화한다.
      anchorSyncFailed = true;
      logger.warn("만료주문 go 앵커 동기화 실패(후속 재시도)", {
        source: "expire-orders",
        error: e instanceof Error ? e.message : "unknown",
      });
    }

    const result = {
      expired: reaped.orders_expired,
      holdsReaped: reaped.holds_reaped,
      seatsReleased: reaped.seats_released,
      goAnchorsExpired: goExpired,
      attendeesCancelled,
      anchorSyncFailed,
      // 🔴 이 둘이 0 이 아니면 v2→go 전파가 새고 있다는 뜻이다. 만료를 막은 것으로
      //    끝이 아니라 대사가 고쳐야 하고, 계속 쌓이면 파이프 자체가 죽은 것이다.
      paidSkipped,
      inFlight,
      undecidable,
      candidatesCapped,
    };

    // v2 만료(정본)는 성공했으나 go 투영이 뒤쳐진 상태 = degraded. 다음 tick 이 수렴시킨다.
    if (anchorSyncFailed) {
      await finishCronRun(pool, cronRun, "degraded", result);
      return new Response(JSON.stringify({ success: false, data: result }), {
        status: 207,
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    }
    await finishCronRun(pool, cronRun, "succeeded", result);
    return successResponse(result);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      logger.error("주문 만료 처리 실패 (v2 reap)", {
        source: "expire-orders",
        status: err.status,
        error: err.message,
      });
      await finishCronRun(pool, cronRun, "failed", undefined, err);
      return errorResponse(err.message, err.status >= 500 || err.status === 0 ? 502 : err.status);
    }
    if (err instanceof Error) {
      logger.error("주문 만료 처리 실패", { source: "expire-orders", error: err.message });
    }
    await finishCronRun(pool, cronRun, "failed", undefined, err);
    return errorResponse(ERR.SERVER, 500);
  }
}
