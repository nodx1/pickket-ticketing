import { NextResponse } from "next/server";
import { verifyServiceToken } from "@/lib/auth/service-token";
import { listBizVerifications, V2BizVerifError } from "@/lib/v2/business-verification-client";
import { logger } from "@/lib/logger";

/**
 * 사업자 인증 심사 — 내부(플랫폼 admin) 대기열 조회.
 * 인증: X-Pickket-Service-Token (go↔v2 공유 시크릿).
 *
 * 레벨2 2차 D4: go DB 직접쿼리 → v2 프록시(SSOT=v2 원장).
 */
export async function GET(request: Request) {
  if (!verifyServiceToken(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "pending";
  try {
    const rows = await listBizVerifications(status);
    // 기존 응답 계약 유지(snake_case data) — v2 소비자 하위호환.
    const data = rows.map((r) => ({
      id: r.id,
      accountId: r.accountId,
      bizNumber: r.bizNumber,
      companyName: r.companyName,
      repName: r.repName,
      bankName: r.bankName,
      bankHolder: r.bankHolder,
      status: r.status,
      createdAt: r.createdAt,
    }));
    return NextResponse.json({ data });
  } catch (err: unknown) {
    if (err instanceof V2BizVerifError && err.status === 400) {
      return NextResponse.json({ error: "invalid_status" }, { status: 400 });
    }
    logger.error("사업자 인증 대기열 — v2 프록시 실패", {
      error: err instanceof Error ? err.message : "unknown",
    });
    return NextResponse.json({ error: "upstream_error" }, { status: 502 });
  }
}
