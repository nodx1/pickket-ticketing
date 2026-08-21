import { withAuth } from "@/lib/auth/withAuth";
import { withRole } from "@/lib/auth/permissions";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { logAudit } from "@/lib/audit";
import { updateEvent, V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, getOwnedEvent } from "@/lib/v2/event-access";
import { auditClientIp } from "@/lib/request-ip";

const VALID_FEATURES = new Set([
  "sale_mode",
  "bot_detection",
  "group_booking",
  "participants",
  "facilities",
  "rehearsal",
  "compliance",
  "bridge_page",
  "packages",
  "final_call",
  "ticket_issuance",
]);

/**
 * 기능 토글 — 레벨2 컷오버 T2-EVT 로 정본이 v2 `events.enabled_features` 로 이관됐다.
 * go events 테이블은 더 이상 읽지도 쓰지도 않는다. 소유 검증은 v2 organizer_ref 가 강제.
 */

// GET /api/events/[eventId]/features — 활성화된 기능 목록 조회
export const GET = withAuth<{ eventId: string }>(async (_request, { session, params }) => {
  const { eventId } = await params;

  try {
    const event = await getOwnedEvent(eventId, session.accountId);
    if (!event) {
      return errorResponse("이벤트를 찾을 수 없습니다", 404);
    }
    return successResponse({
      enabledFeatures: event.enabled_features ?? [],
      availableFeatures: Array.from(VALID_FEATURES),
    });
  } catch (err: unknown) {
    if (err instanceof EventAccessError) {
      return errorResponse("기능 설정을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }
});

// PUT /api/events/[eventId]/features — 기능 토글 업데이트 (organizer 이상만 — 권한상승 하드닝)
export const PUT = withRole<{ eventId: string }>("organizer", async (request, { session, params }) => {
  const { eventId } = await params;
  const body = await request.json();
  const { enabledFeatures } = body as { enabledFeatures: string[] };

  if (!Array.isArray(enabledFeatures) || !enabledFeatures.every((f: unknown) => typeof f === "string")) {
    return errorResponse("enabledFeatures는 문자열 배열이어야 합니다", 400);
  }

  // 유효한 기능 키만 허용
  const validated = enabledFeatures.filter((f) => VALID_FEATURES.has(f));

  let oldFeatures: string[];
  try {
    // 소유권 확인 + 감사로그용 이전 값 확보(v2 가 경계를 강제한다).
    const event = await getOwnedEvent(eventId, session.accountId);
    if (!event) {
      return errorResponse("이벤트를 찾을 수 없습니다", 404);
    }
    oldFeatures = event.enabled_features ?? [];

    // v2 가 정본 — write-through. 멱등키는 값 기반으로 안정 파생(같은 토글 재시도 = 같은 키).
    await updateEvent(
      eventId,
      { enabled_features: validated },
      { idempotencyKey: `event-features:${eventId}:${validated.slice().sort().join(",")}` },
    );
  } catch (err: unknown) {
    if (err instanceof EventAccessError || err instanceof V2CommerceError) {
      return errorResponse("기능 설정을 저장하지 못했습니다. 잠시 후 다시 시도해주세요.", 503);
    }
    throw err;
  }

  // 감사로그는 **v2 write 성공 후**에만 남긴다(실패한 변경을 기록하지 않기 위해).
  await logAudit({
    userId: session.id,
    accountId: session.accountId,
    action: "update",
    tableName: "events",
    recordId: eventId,
    changes: { enabledFeatures: { from: oldFeatures, to: validated } },
    ipAddress: auditClientIp(request.headers),
  });

  return successResponse({ enabledFeatures: validated, availableFeatures: Array.from(VALID_FEATURES) });
});
