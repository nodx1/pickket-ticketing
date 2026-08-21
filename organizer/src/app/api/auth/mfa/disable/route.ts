import { errorResponse } from "@/lib/apiResponse";

/**
 * Phase 2 cutover 후 — MFA 는 v2 가 처리.
 * go 자체 MFA endpoint 410.
 */
export async function POST() {
  return errorResponse("2단계 인증은 통합된 계정 설정에서 진행해주세요.", 410);
}

export async function GET() {
  return errorResponse("2단계 인증은 통합된 계정 설정에서 진행해주세요.", 410);
}
