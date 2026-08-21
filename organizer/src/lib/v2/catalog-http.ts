/**
 * 카탈로그(상품·좌석등급) 라우트 공통 에러 매핑 — W2-PS.
 *
 * ## 왜 공통화하나
 * go DB 가 사라지면서 "조회 실패"의 의미가 갈라졌다. 라우트마다 제각각 처리하면
 * **v2 장애가 404(없음)·200 빈목록·400(입력오류)으로 위장**된다 — wave1 에서 실제로 터진 유형이다.
 * 여기 한 곳에서만 상태코드를 정한다.
 *
 * | 원인 | 상태 | 이유 |
 * |---|---|---|
 * | `EventAccessError(not_found)` | 404 | 없거나 내 계정 소유 아님(구분하지 않음) |
 * | `EventAccessError(unavailable)` | **503** | v2 응답불가. 404 로 뭉개면 "행사가 사라졌다"로 보인다 |
 * | `V2CommerceError` 5xx/네트워크 | **503** | 상품·재고 조회 실패. 빈 목록/0석으로 흡수 금지(매진처럼 보인다) |
 * | `V2CommerceError` 404 | 404 | 대상 없음 |
 * | `V2CommerceError` 409 | 409 | 판매분·좌석 있음 등 v2 불변식 위반 |
 */
import { errorResponse } from "@/lib/apiResponse";
import { logger } from "@/lib/logger";
import { V2CommerceError } from "@/lib/v2/commerce-client";
import { EventAccessError } from "@/lib/v2/event-access";

/** v2 일시 장애 사용자 문구(재시도 유도). */
export const CATALOG_UNAVAILABLE_MESSAGE =
  "상품 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.";

export interface CatalogErrorOptions {
  /** not_found 시 문구. 기본 "이벤트를 찾을 수 없습니다". */
  notFoundMessage?: string;
  /** 5xx 시 문구. 기본 CATALOG_UNAVAILABLE_MESSAGE. */
  unavailableMessage?: string;
  /** 409 시 문구. 기본은 v2 메시지 대신 일반 문구. */
  conflictMessage?: string;
  /** 로그 컨텍스트. */
  context?: Record<string, unknown>;
}

/**
 * 카탈로그 계열 예외 → 응답. 우리가 아는 예외가 아니면 `null` 을 돌려주고 호출부가 rethrow 한다
 * (정체불명 예외를 200/400 으로 삼키지 않기 위해).
 */
export function catalogErrorResponse(
  err: unknown,
  opts: CatalogErrorOptions = {},
): Response | null {
  const notFound = opts.notFoundMessage ?? "이벤트를 찾을 수 없습니다";
  const unavailable = opts.unavailableMessage ?? CATALOG_UNAVAILABLE_MESSAGE;

  if (err instanceof EventAccessError) {
    if (err.reason === "not_found") return errorResponse(notFound, 404);
    logger.warn("카탈로그 이벤트 조회 불가(v2 장애)", { ...opts.context, reason: err.reason });
    return errorResponse(unavailable, 503);
  }
  if (err instanceof V2CommerceError) {
    if (err.status === 404) return errorResponse(notFound, 404);
    if (err.status === 409) {
      return errorResponse(opts.conflictMessage ?? "이미 변경되었습니다. 새로고침 후 다시 시도해주세요", 409);
    }
    logger.warn("카탈로그 v2 요청 실패", { ...opts.context, status: err.status });
    return errorResponse(unavailable, 503);
  }
  return null;
}
