/**
 * 트랙 2.9 — 좌석맵 템플릿 라이브러리 (레벨2 영역A: go DB → v2 write-through 재배선)
 *
 * GET    /api/seat-map-templates — 시스템 시드 + 내 계정 템플릿 (v2 live read)
 * POST   /api/seat-map-templates — 내 좌석맵을 템플릿으로 저장 (v2 write-through)
 * DELETE /api/seat-map-templates?id=... — 내 템플릿 삭제 (v2 write-through, 시스템 시드 보호)
 *
 * 저장 정본은 v2 seat_map_templates. go DB 는 더 이상 쓰지 않는다(빌더 UI 무변경 — API 내부만 재배선).
 */
import { z } from "zod";
import { errorResponse, listResponse, successResponse } from "@/lib/apiResponse";
import { withAuth } from "@/lib/auth/withAuth";
import { withRole } from "@/lib/auth/permissions";
import {
  listSeatMapTemplates,
  createSeatMapTemplate,
  deleteSeatMapTemplate,
  V2CommerceError,
} from "@/lib/v2/commerce-client";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const createSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
  category: z.enum([
    "concert",
    "theater",
    "festival",
    "booth",
    "convention",
    "sports",
    "custom",
  ]),
  layout: z.record(z.string(), z.unknown()),
  thumbnailUrl: z.string().url().nullable().optional(),
});

/** v2 응답(snake_case) → go 클라이언트 계약(camelCase) 투영. */
function toGoShape(t: {
  id: string;
  name: string;
  description: string | null;
  category: string;
  thumbnail_url: string | null;
  layout: unknown;
  is_system: boolean;
  created_at: string | null;
}) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    category: t.category,
    thumbnailUrl: t.thumbnail_url,
    layout: t.layout,
    isSystem: t.is_system,
    createdAt: t.created_at,
  };
}

export const GET = withAuth(async (request, { session }) => {
  const url = new URL(request.url);
  const category = url.searchParams.get("category");
  try {
    const { templates } = await listSeatMapTemplates(session.accountId, category);
    const rows = templates.map(toGoShape);
    return listResponse(rows, rows.length);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      return errorResponse("템플릿을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.", 502);
    }
    throw err;
  }
});

export const POST = withRole("organizer", async (request, { session }) => {
  try {
    const body = createSchema.parse(await request.json());
    const created = await createSeatMapTemplate(
      session.accountId,
      {
        name: body.name,
        description: body.description ?? null,
        category: body.category,
        layout: body.layout,
        thumbnail_url: body.thumbnailUrl ?? null,
      },
      { idempotencyKey: `seatmpl-create:${session.accountId}:${body.name}` },
    );
    return successResponse(toGoShape(created));
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? "입력값 오류", 400);
    }
    if (err instanceof V2CommerceError) {
      const status = err.status >= 400 && err.status < 500 ? err.status : 502;
      return errorResponse(err.message || "템플릿 저장 실패", status);
    }
    return errorResponse("템플릿 저장 실패", 400);
  }
});

export const DELETE = withRole("organizer", async (request, { session }) => {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id || !UUID_RE.test(id)) {
    return errorResponse("id 파라미터 필요", 400);
  }
  try {
    const result = await deleteSeatMapTemplate(id, session.accountId);
    return successResponse({ deleted: result.deleted });
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      // 404 = 없거나 시스템 시드(보호). 그대로 상태 전파.
      const status = err.status >= 400 && err.status < 500 ? err.status : 502;
      return errorResponse(
        status === 404 ? "템플릿을 찾을 수 없습니다" : "템플릿 삭제 실패",
        status,
      );
    }
    throw err;
  }
});
