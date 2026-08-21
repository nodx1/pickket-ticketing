/**
 * GET /api/public/live/summary?ticket=<ticketNumber>
 *
 * 입장한 갤러리의 티켓 페이지가 **20초마다** 부르는 유일한 라이브 엔드포인트.
 * 한 번 호출로 화면 하나가 채워진다 — 브라우저가 3~4개를 각각 부르면 갤러리 수만큼
 * 곱해진다.
 *
 * ## 🔴 실패해도 화면을 비우지 않는다
 *
 * 원천 장애·Redis 장애 어느 쪽이든 **직전 값**을 준다. 캐시가 아예 없으면 빈 목록이
 * 아니라 `state="before"`(대기 화면)를 준다 — 빈 목록은 고장으로 읽힌다.
 */
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRateLimit } from "@/lib/auth/withRateLimit";
import { getLiveSnapshot } from "@/lib/live/cache";
import { buildSummary, emptySummary } from "@/lib/live/summary";
import { logger } from "@/lib/logger";
import { V2CommerceError, getTicketByNumber } from "@/lib/v2/commerce-client";

async function liveSummaryHandler(request: Request) {
  const ticketNumber = new URL(request.url).searchParams.get("ticket")?.trim() ?? "";
  if (!ticketNumber) {
    return errorResponse("티켓 번호가 필요합니다", 400);
  }

  // 티켓 실재 확인 — 아무나 부르는 공개 프록시가 되지 않게 한다.
  // ⚠️ 여기서 접근 권한까지 보지는 않는다. 이 응답에 **개인정보가 없다**(대회 공개 정보뿐).
  //    권한 게이트를 넣으면 로그인 안 한 갤러리가 현장에서 못 본다.
  try {
    await getTicketByNumber(ticketNumber);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      if (err.status === 404) return errorResponse("티켓을 찾을 수 없습니다", 404);
      // 🔴 v2 가 흔들려도 라이브는 계속 보여준다 — 대회 중에 화면이 죽으면 안 된다.
      logger.warn("라이브 요약 — 티켓 확인 실패, 그대로 진행", { status: err.status });
    } else {
      logger.warn("라이브 요약 — 티켓 확인 오류, 그대로 진행", {
        error: err instanceof Error ? err.message : "unknown",
      });
    }
  }

  const snap = await getLiveSnapshot();
  return successResponse(snap ? buildSummary(snap) : emptySummary());
}

export const GET = withRateLimit({
  // 화면이 20초마다 부른다 = 분당 3회. 재시도·탭 복귀를 감안해 여유를 둔다.
  max: 30,
  windowMs: 60_000,
  keyPrefix: "public:live",
})(liveSummaryHandler);
