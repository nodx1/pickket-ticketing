import { errorResponse } from "@/lib/apiResponse";

/**
 * Phase 2 cutover 후 — go 자체 비번 재설정 deprecated.
 * v2 마켓에서 통합 처리. 410 Gone + 안내 메시지.
 */
export async function POST() {
  return errorResponse(
    "비밀번호 재설정은 통합된 계정 페이지에서 진행해주세요.",
    410,
  );
}
