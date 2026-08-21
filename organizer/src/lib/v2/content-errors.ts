/**
 * 레벨2 W5-CONTENT — 콘텐츠 계열 라우트의 v2 에러 → HTTP 응답 매핑 (단일 정본).
 *
 * ## 이 파일이 존재하는 이유 (실제로 터졌던 결함들)
 *
 * 1. **v2 장애를 "빈 목록"·"0건"·"404"·"400 입력오류"로 위장 금지.**
 *    목록 라우트가 실패를 빈 배열로 삼키면 주최자는 "내 출연진이 다 사라졌다"고 읽는다.
 *    광범위 `catch` 가 전부 400 으로 뭉개면 주최자는 멀쩡한 입력값을 계속 고치며 헛수고한다.
 *
 * 2. **DELETE 멱등 흡수 금지.** "조회 실패 → 없음 → 이미 지워짐 → 200 deleted" 는
 *    v2 장애를 "지웠다"고 거짓말하는 것이다. 반드시 503 으로 끊는다.
 *
 * ## 매핑 규칙
 * | 원인 | 응답 | 근거 |
 * |---|---|---|
 * | `EventAccessError(not_found)` / v2 404 | **404** | 없거나 내 것이 아님(구분해 노출하지 않음) |
 * | v2 409 | **409** | 동시 편집·중복 충돌 — 새로고침 후 재시도 |
 * | v2 400/422 | **500** | go 가 이미 입력검증을 했으므로 v2 400 은 **계약 위반(코드 버그)** 이다. |
 * |            |         | 400 으로 돌려주면 주최자가 자기 입력을 의심하며 헛수고한다. 서버 문제라고 말한다. |
 * | 그 외(0/401/403/5xx/타임아웃) | **503** | 일시 장애 — 재시도 가능. 절대 404·빈값으로 뭉개지 않는다. |
 */
import { errorResponse } from "@/lib/apiResponse";
import { logger } from "@/lib/logger";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError, eventAccessStatus } from "@/lib/v2/event-access";

const UNAVAILABLE = "커머스 서버에 연결할 수 없습니다. 잠시 후 다시 시도해주세요.";
const CONFLICT = "다른 편집과 충돌했습니다. 새로고침 후 다시 시도해주세요.";
const CONTRACT_BUG = "요청을 처리하지 못했습니다. 잠시 후 다시 시도하거나 고객센터로 문의해주세요.";

/**
 * v2 호출 실패를 라우트 응답으로 변환한다.
 *
 * @param err       catch 로 잡은 값
 * @param notFound  404 일 때 보여줄 한국어 문구(예: "공지를 찾을 수 없습니다")
 * @returns 매핑된 Response. **인식하지 못한 오류면 `null`** — 호출부는 반드시 rethrow 한다
 *          (알 수 없는 예외를 200/400 으로 삼키지 않기 위해 의도적으로 null 을 돌려준다).
 */
export function contentErrorResponse(err: unknown, notFound: string): Response | null {
  if (err instanceof EventAccessError) {
    return eventAccessStatus(err) === 404
      ? errorResponse(notFound, 404)
      : errorResponse(UNAVAILABLE, 503);
  }
  if (err instanceof V2CommerceError) {
    if (err.status === 404) return errorResponse(notFound, 404);
    if (err.status === 409) return errorResponse(CONFLICT, 409);
    if (err.status === 400 || err.status === 422) {
      // 계약 위반은 조용히 넘기면 영영 안 고쳐진다 — 반드시 서버 로그에 남긴다.
      logger.error("v2 콘텐츠 API 계약 위반(400/422)", {
        status: err.status,
        message: err.message,
        body: err.body,
      });
      return errorResponse(CONTRACT_BUG, 500);
    }
    return errorResponse(UNAVAILABLE, 503);
  }
  return null;
}
