import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withAuth } from "@/lib/auth/withAuth";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  fetchOrganizerAccount,
  patchOrganizerAccount,
  V2AccountError,
  type V2OrganizerAccount,
} from "@/lib/v2/organizer-account-client";

/**
 * ── 레벨2 컷오버 T1 — 계정 설정 v2 전환 ──
 * 정본은 v2 `organizer_profiles`(timezone/currency 는 mig `mainfix_0727` 가산 컬럼).
 * go `accounts` 조회는 컷오버 이후 항상 0행이라 이 화면이 404 로 파손돼 있었다.
 * 🔴 없음(404) 과 v2 장애(503) 를 구분한다 — 뭉개면 원인 추적이 불가능하다.
 */
const accountSettingsSchema = z.object({
  name: z.string().min(2, "계정명은 2자 이상이어야 합니다"),
  timezone: z.enum(["Asia/Seoul"]),
  currency: z.enum(["KRW"]),
});

/** v2 페이로드 → 기존 go 응답 계약(카멜케이스). 필드 구성은 종전과 동일하게 유지한다. */
function toSettings(a: V2OrganizerAccount) {
  return {
    id: a.id,
    name: a.company_name,
    slug: a.slug,
    timezone: a.timezone,
    currency: a.currency,
    businessNumber: a.business_number,
    contactEmail: a.contact_email,
    contactPhone: a.contact_phone,
    isActive: a.is_active,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

export const GET = withAuth(async (_request, { session }) => {
  try {
    const account = await fetchOrganizerAccount(session.accountId);
    if (!account) return errorResponse(ERR.NOT_FOUND, 404);
    return successResponse(toSettings(account));
  } catch (err: unknown) {
    if (err instanceof V2AccountError) {
      logger.error("계정 설정 조회 — v2 프록시 실패", { accountId: session.accountId, status: err.status });
      return errorResponse("계정 설정을 불러오지 못했습니다. 잠시 후 다시 시도해주세요", 503);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});

export const PATCH = withAuth(async (request, { session }) => {
  let body: z.infer<typeof accountSettingsSchema>;
  try {
    body = accountSettingsSchema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  try {
    const updated = await patchOrganizerAccount(session.accountId, {
      company_name: body.name,
      timezone: body.timezone,
      currency: body.currency,
    });
    if (!updated) return errorResponse(ERR.NOT_FOUND, 404);
    return successResponse(toSettings(updated));
  } catch (err: unknown) {
    if (err instanceof V2AccountError) {
      logger.error("계정 설정 저장 — v2 프록시 실패", { accountId: session.accountId, status: err.status });
      return errorResponse("계정 설정을 저장하지 못했습니다. 잠시 후 다시 시도해주세요", 503);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});
