/**
 * 주최자용 팬클럽 목록 프록시.
 *
 * v2 fanclubs SSOT → go 는 주최자 인증 후 v2 internal API 호출.
 * v2 엔드포인트: GET /api/v1/internal/fanclubs?organizer_id=<accountId>
 * 인증: X-Pickket-Service-Token
 */
import { successResponse, errorResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { logger } from "@/lib/logger";

export const GET = withRole("organizer", async (_request, { session }) => {
  const baseUrl = process.env.V2_INTERNAL_BASE_URL;
  const secret = process.env.V2_EVENT_SYNC_SECRET;
  if (!baseUrl || !secret) {
    return errorResponse("v2 연동 설정이 없습니다", 503);
  }

  const url = `${baseUrl.replace(/\/$/, "")}/api/v1/internal/fanclubs?organizer_id=${encodeURIComponent(session.accountId)}`;

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "X-Pickket-Service-Token": secret,
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      logger.warn("v2 fanclubs 조회 실패", {
        accountId: session.accountId,
        status: res.status,
      });
      return errorResponse("팬클럽 목록을 불러오지 못했습니다", res.status);
    }

    const data = await res.json();
    return successResponse(data);
  } catch (err) {
    logger.warn("v2 fanclubs 조회 에러", {
      accountId: session.accountId,
      error: err instanceof Error ? err.message : "unknown",
    });
    return errorResponse("팬클럽 목록을 불러오지 못했습니다", 502);
  }
});
