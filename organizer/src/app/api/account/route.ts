import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withAuth } from "@/lib/auth/withAuth";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  fetchOrganizerAccount,
  patchOrganizerAccount,
  V2AccountError,
} from "@/lib/v2/organizer-account-client";

/**
 * ── 레벨2 컷오버 T1 — 계정 화면 v2 전환 ──
 * 예전엔 go `users INNER JOIN accounts` 를 읽었다. 컷오버로 go `accounts`/`users` 가
 * 비워지면서 이 라우트가 **항상 404** 가 됐고(주최자가 계정·사업자정보 화면을 못 엶),
 * `INSERT INTO accounts` 를 하는 코드가 하나도 없어 앱이 스스로 복구할 수도 없었다.
 *
 * 이제 정본은 v2 `organizer_profiles` 다. 세션은 이미 v2 SSOT 이며
 * `session.accountId` = verify-token 의 go_account_id 앵커라 그대로 organizer_ref 로 쓴다.
 *
 * 🔴 실패 의미를 구분한다 — 이 파손을 오래 못 찾은 이유가 정확히 그것이었다.
 *    · 프로필 없음  → 404 (진짜 없음)
 *    · v2 장애/타임아웃 → **503** (읽지 못함. 재시도 가능)
 */
const schema = z.object({
  name: z.string().min(2),
  phone: z.string().optional(),
  companyName: z.string().min(2),
  businessNumber: z.string().optional(),
  contactEmail: z.email().or(z.literal("")).optional(),
  contactPhone: z.string().optional(),
});

export const GET = withAuth(async (_request, { session }) => {
  try {
    const account = await fetchOrganizerAccount(session.accountId);
    if (!account) return errorResponse(ERR.NOT_FOUND, 404);
    return successResponse({
      name: account.name,
      email: account.email,
      phone: account.phone,
      companyName: account.company_name,
      businessNumber: account.business_number,
      contactEmail: account.contact_email,
      contactPhone: account.contact_phone,
    });
  } catch (err: unknown) {
    if (err instanceof V2AccountError) {
      logger.error("계정 조회 — v2 프록시 실패", { accountId: session.accountId, status: err.status });
      return errorResponse("계정 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요", 503);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});

// 계정 사업자 정보(business_number, contact_email 등) 수정은 admin 이상만 허용.
// staff/check_in 은 사업자 정보 변조 불가 (#8 수정).
export const PATCH = withRole("admin", async (request, { session }) => {
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) return errorResponse(ERR.INVALID_INPUT, 400);
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  try {
    const updated = await patchOrganizerAccount(session.accountId, {
      name: body.name,
      phone: body.phone ?? null,
      company_name: body.companyName,
      business_number: body.businessNumber ?? null,
      contact_email: body.contactEmail || undefined,
      contact_phone: body.contactPhone ?? null,
    });
    if (!updated) return errorResponse(ERR.NOT_FOUND, 404);
    return successResponse({ saved: true });
  } catch (err: unknown) {
    if (err instanceof V2AccountError) {
      logger.error("계정 수정 — v2 프록시 실패", { accountId: session.accountId, status: err.status });
      return errorResponse("계정 정보를 저장하지 못했습니다. 잠시 후 다시 시도해주세요", 503);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});
