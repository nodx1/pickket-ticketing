import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withAuth } from "@/lib/auth/withAuth";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  fetchOrganizerAccount,
  patchOrganizerAccount,
  V2AccountError,
} from "@/lib/v2/organizer-account-client";

// 사용자 노출 알림 카테고리(토글 단위). 각 카테고리 기본값 = true(전체 기본 on).
//
// ── 레벨2 컷오버 T1 ──
// 저장 정본이 go `accounts.notification_prefs` → **v2 `organizer_profiles.notification_prefs`**
// (mig `mainfix_0727` 가산 JSONB)로 옮겨졌다. go accounts 가 비워지며 이 화면도 404 로
// 파손돼 있었다. 응답 계약(완전한 6키 객체)은 종전 그대로 유지한다.
const NOTIFICATION_CATEGORIES = [
  "orders",
  "sold_out",
  "refunds",
  "payment_failed",
  "check_in",
  "ai",
] as const;

type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

type NotificationPrefs = Record<NotificationCategory, boolean>;

const DEFAULT_PREFS: NotificationPrefs = {
  orders: true,
  sold_out: true,
  refunds: true,
  payment_failed: true,
  check_in: true,
  ai: true,
};

const patchSchema = z.object({
  orders: z.boolean().optional(),
  sold_out: z.boolean().optional(),
  refunds: z.boolean().optional(),
  payment_failed: z.boolean().optional(),
  check_in: z.boolean().optional(),
  ai: z.boolean().optional(),
});

// 저장된 raw JSONB 를 기본값과 병합해 완전한 6키 객체로 정규화한다(알 수 없는 키는 무시).
function normalizePrefs(raw: unknown): NotificationPrefs {
  const source = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const merged = { ...DEFAULT_PREFS };
  for (const key of NOTIFICATION_CATEGORIES) {
    if (typeof source[key] === "boolean") {
      merged[key] = source[key] as boolean;
    }
  }
  return merged;
}

export const GET = withAuth(async (_request, { session }) => {
  try {
    const account = await fetchOrganizerAccount(session.accountId);
    if (!account) return errorResponse(ERR.NOT_FOUND, 404);
    return successResponse(normalizePrefs(account.notification_prefs));
  } catch (err: unknown) {
    if (err instanceof V2AccountError) {
      logger.error("알림 설정 조회 — v2 프록시 실패", { accountId: session.accountId, status: err.status });
      return errorResponse("알림 설정을 불러오지 못했습니다. 잠시 후 다시 시도해주세요", 503);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});

export const PATCH = withAuth(async (request, { session }) => {
  let body: z.infer<typeof patchSchema>;
  try {
    body = patchSchema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  try {
    // 부분 필드만 전달한다. 기존 값과의 병합은 v2 가 수행하고, 응답을 다시 정규화한다.
    const updated = await patchOrganizerAccount(session.accountId, { notification_prefs: body });
    if (!updated) return errorResponse(ERR.NOT_FOUND, 404);
    return successResponse(normalizePrefs(updated.notification_prefs));
  } catch (err: unknown) {
    if (err instanceof V2AccountError) {
      logger.error("알림 설정 저장 — v2 프록시 실패", { accountId: session.accountId, status: err.status });
      return errorResponse("알림 설정을 저장하지 못했습니다. 잠시 후 다시 시도해주세요", 503);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});
