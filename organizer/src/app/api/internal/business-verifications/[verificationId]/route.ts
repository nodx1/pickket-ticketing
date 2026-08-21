import { NextResponse } from "next/server";
import { z } from "zod";
import { createNotification } from "@/lib/notifications/create";
import { verifyServiceToken } from "@/lib/auth/service-token";
import {
  getBizVerificationDetail,
  reviewBizVerification,
  V2BizVerifError,
} from "@/lib/v2/business-verification-client";
import { logger } from "@/lib/logger";

/**
 * 사업자 인증 심사 — 내부 상세 조회 + 승인/반려(플랫폼 admin).
 * 승인 시 v2 원장 status='approved' → 유료 발행 게이트 해제(SSOT=v2).
 *
 * 레벨2 2차 D4: go DB 직접쿼리 → v2 프록시. 알림(go notifications)만 go 측에서 발송.
 */
type Params = { verificationId: string };

export async function GET(request: Request, { params }: { params: Promise<Params> }) {
  if (!verifyServiceToken(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { verificationId } = await params;
  try {
    const detail = await getBizVerificationDetail(verificationId);
    return NextResponse.json({ data: detail });
  } catch (err: unknown) {
    if (err instanceof V2BizVerifError && err.status === 404) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    logger.error("사업자 인증 상세 — v2 프록시 실패", {
      verificationId,
      error: err instanceof Error ? err.message : "unknown",
    });
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }
}

const patchSchema = z.object({
  action: z.enum(["approve", "reject"]),
  reason: z.string().optional(),
  reviewerId: z.string().uuid().optional(),
});

export async function PATCH(request: Request, { params }: { params: Promise<Params> }) {
  if (!verifyServiceToken(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { verificationId } = await params;
  let body: z.infer<typeof patchSchema>;
  try {
    body = patchSchema.parse(await request.json());
  } catch {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  if (body.action === "reject" && !body.reason?.trim()) {
    return NextResponse.json({ error: "반려 사유가 필요합니다" }, { status: 400 });
  }

  let result: { accountId: string; status: string };
  try {
    result = await reviewBizVerification(
      verificationId,
      body.action,
      body.reason ?? null,
      body.reviewerId ?? null,
    );
  } catch (err: unknown) {
    if (err instanceof V2BizVerifError) {
      // v2 검증 오류(404 없음 / 409 재심사 / 400 사유누락)는 그대로 전달.
      if (err.status === 400 || err.status === 404 || err.status === 409) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
    }
    logger.error("사업자 인증 심사 — v2 프록시 실패", {
      verificationId,
      error: err instanceof Error ? err.message : "unknown",
    });
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }

  // 알림(system 타입 — 토글 무관). v2 커밋 후 발송 — 실패해도 심사 결과는 유지.
  try {
    if (body.action === "approve") {
      await createNotification({
        accountId: result.accountId,
        type: "system",
        title: "사업자 인증 승인",
        message: "사업자 인증이 승인되었습니다. 이제 유료 이벤트를 발행할 수 있습니다.",
      });
    } else {
      await createNotification({
        accountId: result.accountId,
        type: "system",
        title: "사업자 인증 반려",
        message: `사업자 인증이 반려되었습니다. 사유: ${body.reason ?? "정보를 확인해주세요"}`,
      });
    }
  } catch {
    /* 알림 실패 무시 */
  }

  return NextResponse.json({
    data: { status: body.action === "approve" ? "approved" : "rejected" },
  });
}
