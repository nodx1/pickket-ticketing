import { errorResponse } from "@/lib/apiResponse";
import { withAuth } from "@/lib/auth/withAuth";

type Params = { eventId: string; sessionId: string };

/**
 * The RISE/go allocation runner is deliberately retired. v2 LotteryService
 * owns draw, winner orders/tickets and promotion as a single SoT.
 */
export const POST = withAuth<Params>(async () =>
  errorResponse(
    "go 추첨 실행 경로는 종료되었습니다. 이벤트 추첨 실행(v2)을 이용해주세요.",
    410,
  ),
);
