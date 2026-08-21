/**
 * 주최자 출연진 단건 수정/삭제 — 레벨2 W5-CONTENT.
 *
 * go `event_participants` → v2 `organizer_event_participants` 이관. go DB read/write 0.
 *
 * ## 동시성 (3차 재감사 P1 의 해소 방식이 바뀌었다)
 * 옛 구조는 "go 전체 스냅샷 재조회 → v2 섹션 전체교체 PUT" 이라 두 편집이 겹치면 오래된
 * 스냅샷이 최신을 덮어썼고, go 가 `pg_advisory_lock` 으로 임계구역을 직렬화해야 했다.
 * 이제 정본과 소비자 투영이 **둘 다 v2 안**에 있고, v2 가 `events` 행 `FOR UPDATE` 로 같은
 * 이벤트의 편집을 직렬화한 뒤 한 트랜잭션에서 커밋한다 — 락과 write 가 같은 트랜잭션이라
 * "락 잡은 채 외부 HTTP 대기" 문제도 함께 사라졌다.
 *
 * 🔴 DELETE 는 v2 장애를 "이미 없음 → 200 deleted" 로 흡수하지 않는다 — 503 으로 끊는다.
 */
import { withAuth } from "@/lib/auth/withAuth";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { requireFeature } from "@/lib/server/require-feature";
import {
  deleteOrganizerParticipant,
  patchOrganizerParticipant,
} from "@/lib/v2/commerce-client";
import { contentErrorResponse } from "@/lib/v2/content-errors";
import { toClientParticipant } from "@/lib/v2/organizer-content-view";

type Params = { eventId: string; participantId: string };

const VALID_ROLES = ["performer", "speaker", "mc", "dj", "guest"];
const NOT_FOUND = "출연진을 찾을 수 없습니다";

export const PATCH = withAuth<Params>(async (request, { session, params }) => {
  const { eventId, participantId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "participants");
  if (featureBlock) return featureBlock;

  const body = (await request.json()) as {
    name?: string;
    role?: string;
    bio?: string;
    imageUrl?: string;
    sortOrder?: number;
    isVisible?: boolean;
  };

  if (body.role != null && !VALID_ROLES.includes(body.role)) {
    return errorResponse(`유효하지 않은 역할입니다 (${VALID_ROLES.join(", ")})`, 400);
  }

  // 전달된 키만 patch — 미전달 필드는 v2 가 보존한다(옛 COALESCE 와 동일 결과).
  const patch: {
    name?: string; role?: string; bio?: string | null;
    image_url?: string | null; sort_order?: number; is_visible?: boolean;
  } = {};
  if (body.name !== undefined) patch.name = body.name;
  if (body.role !== undefined) patch.role = body.role;
  if (body.bio !== undefined) patch.bio = body.bio;
  if (body.imageUrl !== undefined) patch.image_url = body.imageUrl;
  if (body.sortOrder !== undefined) patch.sort_order = body.sortOrder;
  if (body.isVisible !== undefined) patch.is_visible = body.isVisible;

  try {
    const updated = await patchOrganizerParticipant(
      eventId, session.accountId, participantId, patch,
    );
    return successResponse(toClientParticipant(updated));
  } catch (err: unknown) {
    const mapped = contentErrorResponse(err, NOT_FOUND);
    if (mapped) return mapped;
    throw err;
  }
});

export const DELETE = withAuth<Params>(async (_request, { session, params }) => {
  const { eventId, participantId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "participants");
  if (featureBlock) return featureBlock;

  try {
    await deleteOrganizerParticipant(eventId, session.accountId, participantId);
    return successResponse({ deleted: true });
  } catch (err: unknown) {
    const mapped = contentErrorResponse(err, NOT_FOUND);
    if (mapped) return mapped;
    throw err;
  }
});
