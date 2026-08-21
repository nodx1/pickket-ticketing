/**
 * 브릿지 페이지(판매 전 대기 화면) 설정 — 레벨2 W5-CONTENT.
 *
 * go `bridge_pages` → v2 `organizer_bridge_pages` 이관. go DB read/write 0.
 * ⚠️ v2 에 이미 있는 `bridge_pages`(복수 이벤트 홍보 랜딩)와는 다른 개념이라 별도 테이블이다.
 *
 * 소유 검증은 두 겹이다: `requireFeature`(플랜 기능 게이트 + 소유·503) → v2 `organizer_ref`.
 * v2 장애를 404/기본값으로 뭉개지 않는다(fail-closed).
 */
import { withAuth } from "@/lib/auth/withAuth";
import { successResponse } from "@/lib/apiResponse";
import { requireFeature } from "@/lib/server/require-feature";
import {
  getOrganizerBridgePage,
  putOrganizerBridgePage,
  type OrganizerBridgePagePayload,
} from "@/lib/v2/commerce-client";
import { contentErrorResponse } from "@/lib/v2/content-errors";

type Params = { eventId: string };

const NOT_FOUND = "이벤트를 찾을 수 없습니다";

function toClient(page: OrganizerBridgePagePayload) {
  return {
    isActive: page.is_active,
    title: page.title,
    description: page.description,
    countdownTarget: page.countdown_target,
    backgroundColor: page.background_color,
    logoUrl: page.logo_url,
  };
}

export const GET = withAuth<Params>(async (_request, { session, params }) => {
  const { eventId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "bridge_page");
  if (featureBlock) return featureBlock;

  try {
    const page = await getOrganizerBridgePage(eventId, session.accountId);
    return successResponse(toClient(page));
  } catch (err: unknown) {
    const mapped = contentErrorResponse(err, NOT_FOUND);
    if (mapped) return mapped;
    throw err;
  }
});

export const PUT = withAuth<Params>(async (request, { session, params }) => {
  const { eventId } = await params;
  const featureBlock = await requireFeature(eventId, session.accountId, "bridge_page");
  if (featureBlock) return featureBlock;

  const body = (await request.json()) as {
    isActive?: boolean; title?: string; description?: string | null;
    countdownTarget?: string | null; backgroundColor?: string; logoUrl?: string | null;
  };

  try {
    const saved = await putOrganizerBridgePage(eventId, session.accountId, {
      is_active: body.isActive ?? false,
      title: body.title ?? "",
      description: body.description ?? null,
      // 빈 문자열은 "지움"으로 취급(datetime-local 입력을 비운 경우).
      countdown_target: body.countdownTarget ? body.countdownTarget : null,
      background_color: body.backgroundColor ?? "#6C5CE7",
      logo_url: body.logoUrl ?? null,
    });
    return successResponse(toClient(saved));
  } catch (err: unknown) {
    const mapped = contentErrorResponse(err, NOT_FOUND);
    if (mapped) return mapped;
    throw err;
  }
});
