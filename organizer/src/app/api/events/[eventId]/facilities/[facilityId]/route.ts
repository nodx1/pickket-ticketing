/**
 * 주최자 시설 단건 수정/삭제 — 레벨2 W5-CONTENT.
 *
 * go `event_facilities` → v2 `organizer_event_facilities` 이관. go DB read/write 0.
 * 소비자 노출 투영 재작성은 v2 가 같은 트랜잭션에서 처리한다(옛 "섹션 전체 재PUT" 폐기).
 *
 * 🔴 DELETE 는 v2 장애를 "이미 없음 → 200 deleted" 로 흡수하지 않는다 — 503 으로 끊는다.
 */
import { withAuth } from "@/lib/auth/withAuth";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { requireFeature } from "@/lib/server/require-feature";
import { deleteOrganizerFacility, patchOrganizerFacility } from "@/lib/v2/commerce-client";
import { contentErrorResponse } from "@/lib/v2/content-errors";
import { toClientFacility } from "@/lib/v2/organizer-content-view";

type Params = { eventId: string; facilityId: string };

const VALID_CATEGORIES = ["stage", "sound", "lighting", "booth", "seating", "general"];
const VALID_STATUSES = ["planned", "confirmed", "setup", "active", "returned"];
const NOT_FOUND = "시설을 찾을 수 없습니다";

export const PATCH = withAuth<Params>(async (request, { session, params }) => {
  const { eventId, facilityId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "facilities");
  if (featureBlock) return featureBlock;

  const body = (await request.json()) as {
    name?: string;
    category?: string;
    quantity?: number;
    status?: string;
    vendor?: string;
    cost?: number;
    notes?: string;
  };

  if (body.category != null && !VALID_CATEGORIES.includes(body.category)) {
    return errorResponse(`유효하지 않은 카테고리입니다 (${VALID_CATEGORIES.join(", ")})`, 400);
  }
  if (body.status != null && !VALID_STATUSES.includes(body.status)) {
    return errorResponse(`유효하지 않은 상태입니다 (${VALID_STATUSES.join(", ")})`, 400);
  }

  // 전달된 키만 patch — 미전달 필드는 v2 가 보존한다(옛 COALESCE 와 동일 결과).
  const patch: {
    name?: string; category?: string; quantity?: number; status?: string;
    vendor?: string | null; cost?: number; notes?: string | null;
  } = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.category !== undefined) patch.category = body.category;
  if (body.quantity !== undefined) patch.quantity = body.quantity;
  if (body.status !== undefined) patch.status = body.status;
  if (body.vendor !== undefined) patch.vendor = body.vendor;
  if (body.cost !== undefined) patch.cost = body.cost;
  if (body.notes !== undefined) patch.notes = body.notes;

  try {
    const updated = await patchOrganizerFacility(eventId, session.accountId, facilityId, patch);
    return successResponse(toClientFacility(updated));
  } catch (err: unknown) {
    const mapped = contentErrorResponse(err, NOT_FOUND);
    if (mapped) return mapped;
    throw err;
  }
});

export const DELETE = withAuth<Params>(async (_request, { session, params }) => {
  const { eventId, facilityId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "facilities");
  if (featureBlock) return featureBlock;

  try {
    await deleteOrganizerFacility(eventId, session.accountId, facilityId);
    return successResponse({ deleted: true });
  } catch (err: unknown) {
    const mapped = contentErrorResponse(err, NOT_FOUND);
    if (mapped) return mapped;
    throw err;
  }
});
