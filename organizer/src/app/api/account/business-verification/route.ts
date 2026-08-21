import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { withRole } from "@/lib/auth/permissions";
import { ERR } from "@/lib/errors";
import {
  fetchBizVerification,
  submitBizVerification,
  V2BizVerifError,
} from "@/lib/v2/business-verification-client";
import { logger } from "@/lib/logger";

/**
 * 사업자 인증 심사 — organizer-facing 제출/조회 (P1).
 * 계정 소유자/관리자가 사업자 정보·서류·정산계좌를 제출한다. 승인은 v2 admin.
 *
 * 레벨2 2차 D4: go DB 직접쿼리 → v2 프록시(SSOT=v2). verification 게이트 정본은 v2 원장.
 * verification_status 는 v2 가 계산해 내려준다(유료 이벤트 발행 게이트 참조).
 */

const docSchema = z.object({
  docType: z.enum(["biz_cert", "bankbook", "permit"]),
  fileUrl: z.string().min(1),
});

const putSchema = z.object({
  action: z.enum(["save", "submit"]),
  bizNumber: z.string().optional(),
  companyName: z.string().optional(),
  repName: z.string().optional(),
  bizType: z.string().optional(),
  bizItem: z.string().optional(),
  address: z.string().optional(),
  openedOn: z.string().optional(), // YYYY-MM-DD
  bankName: z.string().optional(),
  bankAccount: z.string().optional(),
  bankHolder: z.string().optional(),
  authorizedConfirmed: z.boolean().optional(),
  maskingConfirmed: z.boolean().optional(),
  documents: z.array(docSchema).max(10).optional(),
});

export const GET = withRole("admin", async (_request, { session }) => {
  try {
    const result = await fetchBizVerification(session.accountId);
    return successResponse({
      verificationStatus: result.verificationStatus,
      verifiedAt: result.verifiedAt,
      rejectedReason: result.rejectedReason,
      current: result.current,
    });
  } catch (err: unknown) {
    if (err instanceof V2BizVerifError) {
      logger.error("사업자 인증 조회 — v2 프록시 실패", {
        accountId: session.accountId,
        status: err.status,
      });
      return errorResponse("사업자 인증 정보를 불러오지 못했습니다", 502);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});

export const PUT = withRole("admin", async (request, { session }) => {
  let body: z.infer<typeof putSchema>;
  try {
    body = putSchema.parse(await request.json());
  } catch (err: unknown) {
    if (err instanceof z.ZodError) return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    return errorResponse(ERR.INVALID_INPUT, 400);
  }

  try {
    const result = await submitBizVerification({
      accountId: session.accountId,
      action: body.action,
      bizNumber: body.bizNumber,
      companyName: body.companyName,
      repName: body.repName,
      bizType: body.bizType,
      bizItem: body.bizItem,
      address: body.address,
      openedOn: body.openedOn,
      bankName: body.bankName,
      bankAccount: body.bankAccount,
      bankHolder: body.bankHolder,
      authorizedConfirmed: body.authorizedConfirmed,
      maskingConfirmed: body.maskingConfirmed,
      documents: body.documents,
    });
    return successResponse({ status: result.status });
  } catch (err: unknown) {
    if (err instanceof V2BizVerifError) {
      // v2 검증 오류(400/409)는 사용자에게 그대로 전달(한국어 메시지).
      if (err.status === 400 || err.status === 409) {
        return errorResponse(err.message, err.status);
      }
      logger.error("사업자 인증 제출 — v2 프록시 실패", {
        accountId: session.accountId,
        status: err.status,
      });
      return errorResponse("사업자 인증 제출에 실패했습니다", 502);
    }
    return errorResponse(ERR.SERVER, 500);
  }
});
