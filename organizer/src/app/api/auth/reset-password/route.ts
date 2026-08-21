import { errorResponse } from "@/lib/apiResponse";

/**
 * Phase 2 cutover 후 — go 자체 비번 재설정 deprecated.
 * v2 가 처리. 410 Gone.
 */
export async function POST() {
  return errorResponse(
    "비밀번호 재설정은 통합된 계정 페이지에서 진행해주세요.",
    410,
  );
}
