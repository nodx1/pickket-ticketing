import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import {
  deleteEventHost,
  getEventHost,
  patchEventHost,
  V2CommerceError,
  type EventHost,
} from "@/lib/v2/commerce-client";

// slug 는 사용자 입력이 아님(내부 식별자). 수정 시엔 기존 slug 를 그대로 유지한다.
const organizerSchema = z.object({
  name: z.string().min(2, "주최자 이름은 2자 이상이어야 합니다"),
  description: z.string().optional(),
  email: z.email("올바른 이메일 형식을 입력해주세요").or(z.literal("")).optional(),
  phone: z.string().optional(),
  logoUrl: z.string().optional(),
  // 방향2 A: 연락처 소비자 공개 여부.
  contactPublic: z.boolean().optional(),
});

type Params = { organizerId: string };

/** v2 `event_hosts` 행 → 옛 go `organizers` 응답 shape. */
function toGoRow(host: EventHost) {
  return {
    id: host.host_id,
    name: host.name,
    slug: host.slug,
    description: host.description,
    email: host.email,
    phone: host.phone,
    logoUrl: host.logo_url,
    contactPublic: host.contact_public,
    isPublished: host.is_published,
    createdAt: host.created_at,
    updatedAt: host.updated_at,
  };
}

/**
 * v2 실패 → 상태코드.
 * 🔴 404(미존재/타 계정)만 404 다. 나머지 커머스 장애는 **503** — 404 로 뭉개면
 *    "주최자가 삭제됐다"는 거짓 신호가 되어 주최자가 재생성에 나선다.
 */
function commerceErrorResponse(err: V2CommerceError, action: string) {
  if (err.status === 404) return errorResponse(ERR.NOT_FOUND, 404);
  return errorResponse(
    `커머스 서버에 연결할 수 없어 ${action}하지 못했습니다. 잠시 후 다시 시도해주세요.`,
    503,
  );
}

export const GET = withRole<Params>("organizer", async (_request, { session, params }) => {
  try {
    return successResponse(toGoRow(await getEventHost(session.accountId, params.organizerId)));
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) return commerceErrorResponse(err, "주최자 정보를 불러오지");
    throw err;
  }
});

export const PATCH = withRole<Params>("organizer", async (request, { session, params }) => {
  let body: z.infer<typeof organizerSchema>;
  try {
    body = organizerSchema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  try {
    const host = await patchEventHost(session.accountId, params.organizerId, {
      name: body.name,
      description: body.description ?? null,
      email: body.email || null,
      phone: body.phone || null,
      logo_url: body.logoUrl || null,
      contact_public: body.contactPublic ?? false,
    });
    return successResponse(toGoRow(host));
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) return commerceErrorResponse(err, "주최자를 수정");
    throw err;
  }
});

/**
 * 주최자 삭제 (레벨2 컷오버 W2-EVT — go `organizers`/`event_organizers` 제거).
 *
 * 옛 go 는 (연결 이벤트 COUNT → 확인 응답 → 트랜잭션에서 events.organizer_id NULL + DELETE)
 * 였다. v2 `DELETE /internal/event-hosts/{id}?unlink=` 가 같은 흐름을 한 트랜잭션으로 수행하며,
 * `unlink` 미지정 + 연결 존재 시 `{deleted:false, needs_unlink:true}` 를 돌려준다.
 *
 * 🔴 fail-closed: v2 장애를 "이미 지워짐"으로 흡수하지 않는다(→ 503). 지우지 않은 것을
 *    지웠다고 응답하면 주최자가 표기가 사라진 줄 알고 재생성한다.
 */
export const DELETE = withRole<Params>("organizer", async (request, { session, params }) => {
  const unlink = new URL(request.url).searchParams.get("unlink") === "true";

  try {
    const result = await deleteEventHost(session.accountId, params.organizerId, unlink);
    if (!result.deleted && result.needs_unlink) {
      // 프론트가 "연결 해제 후 삭제" 확인 다이얼로그를 띄우도록 하는 신호(옛 계약 유지).
      return successResponse({
        deleted: false,
        needsUnlink: true,
        linkedEventCount: result.linked_event_count,
      });
    }
    return successResponse({
      deleted: true,
      unlinkedEventCount: result.unlinked_event_count,
    });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) return commerceErrorResponse(err, "주최자를 삭제");
    throw err;
  }
});
