/**
 * 이벤트 장소 검색 — 지도 API 연동(과업지시서 2-1). 주최사 로그인 필요.
 * 브라우저 → 이 라우트 → v2 `/internal/maps/search`(서비스 토큰) → 오픈스트리트맵.
 */
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { logger } from "@/lib/logger";
import type { MapSearchResult } from "@/lib/map/osm";
import { V2GwasupError, v2Get } from "@/lib/v2/gwasup-client";

export const GET = withRole("organizer", async (request) => {
  const q = (new URL(request.url).searchParams.get("q") ?? "").replace(/\s+/g, " ").trim();
  if (q.length < 2) return errorResponse("장소 이름이나 주소를 두 글자 이상 입력해 주세요", 400);
  if (q.length > 100) return errorResponse("검색어가 너무 깁니다 (100자 이내)", 400);
  try {
    const result = await v2Get<MapSearchResult>(`/internal/maps/search?q=${encodeURIComponent(q)}&limit=6`, 12_000);
    return successResponse(result);
  } catch (err: unknown) {
    if (err instanceof V2GwasupError) {
      const status = err.status === 429 ? 429 : err.status >= 400 && err.status < 500 ? err.status : 502;
      return errorResponse(err.message, status);
    }
    logger.error("장소 검색 실패", { err: err instanceof Error ? err.message : String(err) });
    return errorResponse("장소를 검색하지 못했어요. 잠시 후 다시 시도해 주세요.", 502);
  }
});
