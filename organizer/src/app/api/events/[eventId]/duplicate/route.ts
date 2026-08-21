import { randomUUID } from "node:crypto";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { logger } from "@/lib/logger";
import {
  duplicateEvent,
  goAccountRef,
  listEventHostLinks,
  putEventHostLinks,
  V2CommerceError,
} from "@/lib/v2/commerce-client";

type Params = { eventId: string };

/**
 * 이벤트 복제 (레벨2 컷오버 W2-EVT — go `INSERT … SELECT FROM events/products/event_questions` 제거).
 *
 * v2 `POST /internal/events/{id}/duplicate` 가 authoring 데이터 전체(이벤트 메타 + 상세 갭 필드 +
 * 예매설문 + 타임테이블 + seat_tiers)를 복제한다. 판매 실적(주문·티켓·좌석)은 복제하지 않는다.
 * 원본 소유 검증도 v2 가 organizer_ref 로 수행한다(불일치 → 404).
 *
 * 멱등: `new_event_id` 를 go 가 채번해 넘기므로 동시/재시도 실행에도 이벤트가 2개 생기지 않는다.
 * (v2 가 그 id 로 이미 만든 이벤트가 있으면 created=false 로 기존 것을 돌려준다.)
 */
export const POST = withRole<Params>("organizer", async (_request, { session, params }) => {
  const newEventId = randomUUID();

  let result: Awaited<ReturnType<typeof duplicateEvent>>;
  try {
    result = await duplicateEvent(
      params.eventId,
      {
        organizer_ref: goAccountRef(session.accountId),
        new_event_id: newEventId,
        copy_tiers: true,
      },
      { idempotencyKey: `event-duplicate:${params.eventId}:${newEventId}` },
    );
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse("이벤트를 찾을 수 없습니다", 404);
      if (err.status === 409) {
        return errorResponse("이미 사용 중인 주소(슬러그)입니다. 다시 시도해주세요.", 409);
      }
      logger.error("이벤트 복제 실패", {
        source: "duplicate-event",
        eventId: params.eventId,
        status: err.status,
      });
      return errorResponse(
        "이벤트 복제 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }

  // ── 주최자 연결 복제(옛 event_organizers INSERT … SELECT) ──
  // v2 duplicate 는 events 컬럼과 seat_tiers 만 복제하고 host 링크는 복제하지 않는다.
  // 🔴 실패를 삼키면 복제본이 "주최자 미지정"으로 남는다 → 명시 통지(이벤트는 이미 생성됨).
  try {
    const { hosts } = await listEventHostLinks(session.accountId, params.eventId);
    if (hosts.length > 0) {
      await putEventHostLinks(
        session.accountId,
        result.event_id,
        hosts.map((h) => ({
          host_id: h.host_id,
          role: h.role,
          display_order: h.display_order,
        })),
      );
    }
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      logger.warn("이벤트 복제 후 주최자 연결 실패", {
        eventId: params.eventId,
        newEventId: result.event_id,
        status: err.status,
      });
      return errorResponse(
        "이벤트는 복제됐지만 주최자 연결에 실패했습니다. 복제본의 설정에서 주최자를 다시 저장해주세요.",
        503,
      );
    }
    throw err;
  }

  return successResponse({ id: result.event_id }, 201);
});
