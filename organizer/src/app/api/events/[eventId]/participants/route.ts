/**
 * 주최자 출연진 목록/생성 — 레벨2 W5-CONTENT.
 *
 * go `event_participants` → v2 `organizer_event_participants` 이관. go DB read/write 0.
 *
 * ## 숨김(is_visible=false) 처리
 * 주최자 목록(이 GET)은 **숨김 포함 전체**를 준다(편집 화면이므로).
 * 소비자 노출 투영(`event_participants` 미러)에는 v2 가 **is_visible=true 만** 복사한다
 * (감사 P0-8). 두 저장소가 v2 안에 있고 같은 트랜잭션에서 갱신되므로 필터 누락이 구조적으로
 * 한 곳(`_reproject_participants`)에만 존재한다.
 *
 * 옛 구조의 advisory lock(재조회→v2 PUT 임계구역 직렬화)은 사라졌다 — 이제 v2 가 events 행
 * `FOR UPDATE` 로 같은 이벤트의 동시 편집을 직렬화한다(락과 write 가 같은 트랜잭션).
 */
import { randomUUID } from "node:crypto";
import { withAuth } from "@/lib/auth/withAuth";
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { requireFeature } from "@/lib/server/require-feature";
import { createOrganizerParticipant, listOrganizerParticipants } from "@/lib/v2/commerce-client";
import { contentErrorResponse } from "@/lib/v2/content-errors";
import { toClientParticipant } from "@/lib/v2/organizer-content-view";

type Params = { eventId: string };

const VALID_ROLES = ["performer", "speaker", "mc", "dj", "guest"];
const NOT_FOUND = "이벤트를 찾을 수 없습니다";

export const GET = withAuth<Params>(async (_request, { session, params }) => {
  const { eventId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "participants");
  if (featureBlock) return featureBlock;

  try {
    const { participants } = await listOrganizerParticipants(eventId, session.accountId);
    return successResponse(participants.map(toClientParticipant));
  } catch (err: unknown) {
    // 🔴 목록 실패를 빈 배열로 폴백하지 않는다(= "출연진 0명"으로 오독됨).
    const mapped = contentErrorResponse(err, NOT_FOUND);
    if (mapped) return mapped;
    throw err;
  }
});

export const POST = withAuth<Params>(async (request, { session, params }) => {
  const { eventId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "participants");
  if (featureBlock) return featureBlock;

  const body = (await request.json()) as {
    name: string; role?: string; bio?: string; imageUrl?: string; sortOrder?: number;
  };

  if (!body.name) return errorResponse("이름은 필수입니다", 400);
  if (body.role != null && !VALID_ROLES.includes(body.role)) {
    return errorResponse(`유효하지 않은 역할입니다 (${VALID_ROLES.join(", ")})`, 400);
  }

  // 행 id 를 호출측이 만든다 → 네트워크 재시도로 같은 요청이 두 번 도착해도 중복 출연진이 생기지 않는다.
  const itemId = randomUUID();

  try {
    const created = await createOrganizerParticipant(eventId, session.accountId, itemId, {
      name: body.name,
      role: body.role ?? "performer",
      bio: body.bio ?? null,
      image_url: body.imageUrl ?? null,
      sort_order: body.sortOrder ?? 0,
    });
    return successResponse(toClientParticipant(created));
  } catch (err: unknown) {
    const mapped = contentErrorResponse(err, NOT_FOUND);
    if (mapped) return mapped;
    throw err;
  }
});
