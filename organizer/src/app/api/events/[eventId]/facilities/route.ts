/**
 * 주최자 시설 목록/생성 — 레벨2 W5-CONTENT.
 *
 * go `event_facilities` → v2 `organizer_event_facilities` 이관. go DB read/write 0.
 * 소비자 노출 투영(`event_facilities` 미러, name/category/quantity/status 만)은 v2 가
 * **같은 트랜잭션에서** 재작성한다 — `vendor`/`cost`/`notes`(거래처·단가·내부메모)는
 * 절대 투영에 복사되지 않는다.
 *
 * 소유 검증 두 겹: `requireFeature`(플랜 게이트 + 소유·503) → v2 `organizer_ref`(불일치 404).
 */
import { randomUUID } from "node:crypto";
import { withAuth } from "@/lib/auth/withAuth";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { requireFeature } from "@/lib/server/require-feature";
import { createOrganizerFacility, listOrganizerFacilities } from "@/lib/v2/commerce-client";
import { contentErrorResponse } from "@/lib/v2/content-errors";
import { toClientFacility } from "@/lib/v2/organizer-content-view";

type Params = { eventId: string };

const VALID_CATEGORIES = ["stage", "sound", "lighting", "booth", "seating", "general"];
const NOT_FOUND = "이벤트를 찾을 수 없습니다";

export const GET = withAuth<Params>(async (_request, { session, params }) => {
  const { eventId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "facilities");
  if (featureBlock) return featureBlock;

  try {
    const { facilities } = await listOrganizerFacilities(eventId, session.accountId);
    return successResponse(facilities.map(toClientFacility));
  } catch (err: unknown) {
    // 🔴 목록 실패를 빈 배열로 폴백하지 않는다(= "시설 0건"으로 오독됨).
    const mapped = contentErrorResponse(err, NOT_FOUND);
    if (mapped) return mapped;
    throw err;
  }
});

export const POST = withAuth<Params>(async (request, { session, params }) => {
  const { eventId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "facilities");
  if (featureBlock) return featureBlock;

  const body = (await request.json()) as {
    name: string; category?: string; quantity?: number; vendor?: string; cost?: number; notes?: string;
  };

  if (!body.name) return errorResponse("시설명은 필수입니다", 400);
  // 카테고리는 v2 도 검증하지만, 사용자 입력 오류는 여기서 한국어로 즉시 알린다.
  if (body.category != null && !VALID_CATEGORIES.includes(body.category)) {
    return errorResponse(`유효하지 않은 카테고리입니다 (${VALID_CATEGORIES.join(", ")})`, 400);
  }

  // 행 id 를 호출측이 만든다 → 네트워크 재시도로 같은 요청이 두 번 도착해도 중복 시설이 생기지 않는다.
  const itemId = randomUUID();

  try {
    const created = await createOrganizerFacility(eventId, session.accountId, itemId, {
      name: body.name,
      category: body.category ?? "general",
      quantity: body.quantity ?? 1,
      vendor: body.vendor ?? null,
      cost: body.cost ?? 0,
      notes: body.notes ?? null,
    });
    return successResponse(toClientFacility(created));
  } catch (err: unknown) {
    const mapped = contentErrorResponse(err, NOT_FOUND);
    if (mapped) return mapped;
    throw err;
  }
});
