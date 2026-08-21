import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withAuth } from "@/lib/auth/withAuth";
import { ERR } from "@/lib/errors";
import {
  listEventHostLinks,
  putEventHostLinks,
  V2CommerceError,
  type EventHostLink,
} from "@/lib/v2/commerce-client";

const putSchema = z.object({
  organizers: z
    .array(
      z.object({
        organizerId: z.string().uuid("올바른 주최자 ID가 아닙니다"),
        role: z.enum(["host", "coordinator", "sponsor"], {
          error: "역할은 host, coordinator, sponsor 중 하나여야 합니다",
        }),
        displayOrder: z.number().int().min(0).default(0),
      }),
    )
    .min(1, "최소 1개 이상의 주최자가 필요합니다")
    .refine(
      (arr) => arr.some((o) => o.role === "host"),
      "주최(host) 역할이 최소 1개 필요합니다",
    ),
});

/** 옛 go `event_organizers JOIN organizers` 행 shape 을 유지한다(프론트 계약 불변). */
function toGoRow(eventId: string, link: EventHostLink) {
  return {
    id: link.link_id,
    eventId,
    organizerId: link.host_id,
    role: link.role,
    displayOrder: link.display_order,
    organizerName: link.name,
    organizerLogoUrl: link.logo_url,
  };
}

/**
 * 이벤트 주최자 목록 (레벨2 컷오버 W2-EVT — go `event_organizers` 제거 → v2 `event_host_links`).
 *
 * 🔴 옛 코드는 `catch { return 500 }` 로 모든 실패를 뭉갰다. 이제 미소유/미존재는 404,
 *    v2 장애는 503 으로 구분한다(주최자가 원인을 알 수 있어야 한다).
 */
export const GET = withAuth(async (_request, { session, params }) => {
  const { eventId } = params as { eventId: string };

  try {
    const { hosts } = await listEventHostLinks(session.accountId, eventId);
    return successResponse(hosts.map((h) => toGoRow(eventId, h)));
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse("이벤트를 찾을 수 없습니다", 404);
      return errorResponse(
        "커머스 서버에 연결할 수 없어 주최자 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }
});

/**
 * 이벤트 주최자 전체 교체.
 *
 * 옛 go 는 (이벤트 소유 확인 → 주최자 소유 일괄 확인 → DELETE+INSERT 트랜잭션) 4단계였다.
 * v2 `PUT /internal/events/{id}/hosts` 가 **한 트랜잭션에서** 같은 검증을 수행한다:
 *   - 이벤트 미소유/미존재 → 404
 *   - 타 계정 host_id 포함 → 400 (부분 반영 없음 — 전부 롤백)
 *   - host 역할 0개 → 400
 */
export const PUT = withAuth(async (request, { session, params }) => {
  const { eventId } = params as { eventId: string };

  let body: z.infer<typeof putSchema>;
  try {
    body = putSchema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  try {
    const { hosts } = await putEventHostLinks(
      session.accountId,
      eventId,
      body.organizers.map((o) => ({
        host_id: o.organizerId,
        role: o.role,
        display_order: o.displayOrder,
      })),
    );
    return successResponse(hosts.map((h) => toGoRow(eventId, h)));
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse("이벤트를 찾을 수 없습니다", 404);
      if (err.status === 400) {
        return errorResponse("존재하지 않는 주최자가 포함되어 있습니다", 400);
      }
      if (err.status === 409) {
        return errorResponse("주최자 정보가 동시에 수정됐습니다. 다시 시도해주세요.", 409);
      }
      return errorResponse(
        "주최자 정보 저장 중 커머스 동기화에 실패했습니다. 잠시 후 다시 시도해주세요.",
        503,
      );
    }
    throw err;
  }
});
