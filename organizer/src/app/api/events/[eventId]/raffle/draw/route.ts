import crypto from "node:crypto";

import { z } from "zod";

import { errorResponse, successResponse } from "@/lib/apiResponse";
import { logAudit } from "@/lib/audit";
import { withRole } from "@/lib/auth/permissions";
import { logger } from "@/lib/logger";
import { runRaffleDraw, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError } from "@/lib/v2/event-access";

import { loadOwnedRaffleEvent, toGoDraw } from "../_shared";

type Params = { eventId: string };

// #2 — 주최자 추첨 트리거 go 라우트.
// F4 추첨(당첨 raffle_number 산출)의 실행 정본은 v2 internal API(체크인자 풀·재현가능 seed).
// go 주최자는 v2 서비스토큰을 직접 못 쓰므로, 이 라우트가 **이벤트 소유검증** 후 서비스토큰으로
// v2 를 대신 호출한다(withRole + account_id 경계). seed 는 공개시드(감사가능·재현가능).
//
// 소유·앵커 해석: (id, account_id) 로 소유 게이트 + v2_event_id(canonical) + raffle_enabled(go-local)
// 를 한 쿼리로 확보한다. account_id 경계 필수(크로스테넌트 추첨 실행 차단).

const drawSchema = z.object({
  // 공개시드(재현 근거). 빈 문자열 금지. 주최자가 지정(예: 방송 추첨 seed).
  seed: z.string().trim().min(1, "추첨 시드를 입력해주세요").max(256),
  // 당첨 수. 1 이상. 풀보다 크면 v2 가 풀 크기로 clamp.
  count: z.coerce.number().int().min(1, "당첨 수는 1 이상이어야 합니다").max(100000),
  // 멱등 키(선택). 같은 (event, drawKey) 재실행 → 기존 결과 재생(이중 추첨 방지).
  drawKey: z.string().trim().min(1).max(128).optional(),
});

/**
 * POST /api/events/[eventId]/raffle/draw
 * 추첨 실행. 입력: seed(공개시드)·count(당첨 수)·drawKey(멱등, 선택).
 * 검증: count>0(zod), raffle_enabled(go-local 선차단), 추첨풀 0(v2 POOL_EMPTY→400).
 */
export const POST = withRole<Params>("organizer", async (request, { params, session }) => {
  let body: z.infer<typeof drawSchema>;
  try {
    body = drawSchema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? "입력값이 올바르지 않습니다", 400);
    }
    return errorResponse("요청 본문을 해석할 수 없습니다", 400);
  }

  // 🔴 레벨2 T2-EVT — 소유 검증이 v2 조회로 바뀌면서 v2 응답불가는 EventAccessError 로 온다.
  //    잡지 않으면 정체불명 500. **404 로 뭉개면 안 된다** — "이벤트 없음"은 주최자에게 재시도를
  //    포기시키지만, 실제로는 잠시 후 성공하는 일시 장애다(추첨은 방송 진행 중 눌리는 버튼).
  //    확인 불가 상태에서 추첨을 강행하지 않는다(fail-closed).
  let event: Awaited<ReturnType<typeof loadOwnedRaffleEvent>>;
  try {
    event = await loadOwnedRaffleEvent(params.eventId, session.accountId);
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse(
        "이벤트 정보를 확인하지 못해 추첨을 실행할 수 없습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }
  if (!event) return errorResponse("이벤트를 찾을 수 없습니다", 404);
  if (!event.raffleEnabled) {
    return errorResponse("이 이벤트는 경품 추첨이 활성화되지 않았습니다", 409);
  }
  if (!event.v2EventId) {
    // 앵커 미준비 = 커머스 write-through 미완(발권/추첨 대상 없음).
    return errorResponse("아직 추첨을 실행할 수 없습니다 (이벤트 동기화 미완)", 409);
  }

  try {
    const draw = await runRaffleDraw(
      event.v2EventId,
      {
        seed: body.seed,
        winner_count: body.count,
        executed_by: session.id,
        draw_key: body.drawKey ?? null,
      },
      // 멱등키: drawKey 있으면 그 키로 고정(재시도=같은 추첨), 없으면 event 스코프 고정키.
      // (drawKey 없이 반복 실행하면 매번 새 추첨이 되어야 하나, 단일 요청의 네트워크 재시도는
      //  같은 키로 묶어 이중 실행을 막는다 — 새 추첨을 원하면 새 요청이 새 랜덤 키를 받음.)
      { idempotencyKey: `raffle-draw:${event.v2EventId}:${body.drawKey ?? crypto.randomUUID()}` },
    );

    await logAudit({
      userId: session.id,
      accountId: session.accountId,
      action: "raffle_draw",
      tableName: "events",
      recordId: params.eventId,
      changes: {
        seed: draw.seed,
        winnerCount: draw.winner_count,
        poolSize: draw.pool_size,
        drawKey: draw.draw_key,
      },
    }).catch((err: unknown) => {
      logger.warn("추첨 실행 감사로그 실패", {
        eventId: params.eventId,
        error: err instanceof Error ? err.message : "unknown",
      });
    });

    return successResponse(toGoDraw(draw));
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // v2 봉투 에러코드로 사용자 문구 매핑. body 에 { code, message } 가 담김.
      const code = err.body ?? "";
      if (err.status === 409 && code.includes("POOL_EMPTY")) {
        return errorResponse("추첨 대상이 없습니다 (체크인 완료자가 없습니다)", 400);
      }
      if (err.status === 409 && code.includes("RAFFLE_DISABLED")) {
        return errorResponse("이 이벤트는 경품 추첨이 활성화되지 않았습니다", 409);
      }
      if (err.status >= 400 && err.status < 500) {
        return errorResponse("추첨 요청이 거부되었습니다", err.status);
      }
      logger.error("v2 추첨 실행 실패", {
        eventId: params.eventId,
        status: err.status,
        message: err.message,
      });
      return errorResponse("추첨 처리 중 오류가 발생했습니다", 502);
    }
    return errorResponse(err instanceof Error ? err.message : "추첨에 실패했습니다", 500);
  }
});
