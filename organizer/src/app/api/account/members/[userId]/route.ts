/**
 * 팀 멤버 역할 변경·해제 — **v2 `organizer_team_members` 원장** (2026-07-31 복구).
 *
 * ## 종전 파손
 * go `users` 테이블을 UPDATE 했다. 레벨2 컷오버로 그 원장이 비면서:
 *   · `UPDATE ... WHERE id=$1` 이 **0행**을 고치고도 성공을 반환했다
 *   · 세션은 그 값을 **읽지도 않는다**(`resolve-session` 이 go DB 무조회) —
 *     `is_active` 는 하드코딩 `true` 였다
 * ⟹ **"해제했습니다" 를 표시하고 실제로는 아무 일도 일어나지 않았다.**
 *
 * ## 지금
 * v2 멤버십 행을 지운다. 세션 해석(`verify-token`)이 그 원장을 보므로
 * **다음 요청부터 조직이 안 보인다**(토큰 5분 + 매 요청 검증이라 전파는 즉시).
 *
 * 🔴 계정을 죽이지 않는다 — 그 사람은 다른 조직 멤버이거나 소비자로 티켓을 가질 수 있다.
 *    "조직에서 빼기" 와 "계정 정지" 는 다른 동작이다.
 */
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import {
  V2TeamError,
  logTeamFailure,
  removeTeamMember,
  updateTeamMemberRole,
} from "@/lib/v2/team-client";

type Params = { userId: string };

const schema = z.object({
  role: z.enum(["owner", "admin", "organizer", "staff", "check_in"]).optional(),
});

/** v2 오류를 화면 문구로 — 사유를 뭉개면 "왜 안 되는지" 를 아무도 모른다. */
function toResponse(err: unknown, fallback: string) {
  if (err instanceof V2TeamError) {
    if (err.status === 404) return errorResponse("대상 멤버를 찾을 수 없습니다", 404);
    if (err.status === 409) return errorResponse("조직 소유자는 변경·제외할 수 없습니다", 409);
    return errorResponse(`${fallback} 잠시 후 다시 시도해주세요.`, 503);
  }
  return errorResponse(fallback, 400);
}

export const PATCH = withRole<Params>("admin", async (request, { session, params }) => {
  try {
    // 역할 변경은 소유자만 — admin 이 자기와 같은 등급을 만들 수 있으면 권한이 새어나간다.
    if (session.role !== "owner") {
      return errorResponse(ERR.FORBIDDEN, 403);
    }
    const body = schema.parse(await request.json());
    if (!body.role) {
      return errorResponse("변경할 역할을 지정해주세요", 400);
    }
    const result = await updateTeamMemberRole(session.accountId, params.userId, body.role);
    return successResponse({ updated: true, role: result.role });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? "입력값을 확인해주세요", 400);
    }
    logTeamFailure("역할 변경", err);
    return toResponse(err, "멤버 역할을 변경하지 못했습니다.");
  }
});

export const DELETE = withRole<Params>("admin", async (_request, { session, params }) => {
  try {
    const result = await removeTeamMember(session.accountId, params.userId);
    if (!result.removed) {
      return errorResponse("대상 멤버를 찾을 수 없습니다", 404);
    }
    return successResponse({ removed: true });
  } catch (err: unknown) {
    logTeamFailure("해제", err);
    return toResponse(err, "멤버를 제외하지 못했습니다.");
  }
});
