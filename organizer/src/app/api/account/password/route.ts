import { errorResponse } from "@/lib/apiResponse";

/**
 * Phase 2 cutover 후 — 비밀번호 변경은 v2 가 처리.
 * go users.password_hash 는 NULL 상태라 검증 불가능.
 */
export async function PATCH() {
  return errorResponse(
    "비밀번호 변경은 통합된 계정 페이지에서 진행해주세요.",
    410,
  );
}
