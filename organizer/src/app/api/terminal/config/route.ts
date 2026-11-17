/**
 * 웹 단말(키오스크·POS 브라우저) 설정 — 실시간 게이트웨이 주소만 알려 준다(공개 정보).
 * 단말 인증은 단말 키로 v2 에 직접 한다(이 서버는 키를 보지 않는다).
 */
import { successResponse } from "@/lib/apiResponse";
import { realtimeBaseUrl } from "@/lib/v2/gwasup-client";

export function GET() {
  return successResponse({ url: realtimeBaseUrl(), path: "/ws/socket.io", rest: `${realtimeBaseUrl()}/api/v1/terminals` });
}
