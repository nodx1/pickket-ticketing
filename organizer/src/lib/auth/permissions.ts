import { errorResponse } from "@/lib/apiResponse";
import { ERR } from "@/lib/errors";
import { withAuth, type AuthContext } from "@/lib/auth/withAuth";
import type { UserRole } from "@/lib/types";
import type { NextRequest } from "next/server";

export const ROLE_HIERARCHY: Record<UserRole, number> = {
  owner: 5,
  admin: 4,
  organizer: 3,
  staff: 2,
  check_in: 1,
};

/**
 * 외부(v2)에서 온 역할 문자열을 `UserRole` 로 좁힌다.
 *
 * 🔴 **모르는 값은 가장 낮은 권한**(`check_in`)으로 떨어뜨린다.
 *    v2 에 새 팀 역할이 추가됐을 때 조용히 높은 권한을 주는 것보다,
 *    안 되는 편이 낫다(안 되면 문의가 오지만, 과다 권한은 아무도 모른다).
 *
 * ⚠️ `null`/`undefined` 는 **호출측이 정책을 정한다.** 여기서 기본값을 주지 않는다 —
 *    세션 해석은 하위호환으로 `owner` 폴백이 필요하고, 다른 곳은 그러면 안 된다.
 */
export function parseUserRole(value: string): UserRole | null {
  // 🔴 `in` 은 프로토타입 체인까지 본다 — `"toString" in ROLE_HIERARCHY` 가 true 다.
  //    그대로 두면 `toString` 같은 값이 역할로 통과하고, `ROLE_HIERARCHY[role]` 이
  //    함수를 반환해 `>=` 비교가 예측 불가가 된다. 자기 속성만 본다.
  return Object.hasOwn(ROLE_HIERARCHY, value) ? (value as UserRole) : null;
}

export function hasPermission(userRole: UserRole, requiredRole: UserRole) {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}

type RoleHandler<TParams> = (
  request: NextRequest,
  context: AuthContext<TParams>,
) => Promise<Response>;

export function withRole<TParams = unknown>(
  requiredRole: UserRole,
  handler: RoleHandler<TParams>,
) {
  return withAuth<TParams>(async (request, context) => {
    if (!hasPermission(context.session.role, requiredRole)) {
      return errorResponse(ERR.FORBIDDEN, 403);
    }

    return handler(request, context);
  });
}
