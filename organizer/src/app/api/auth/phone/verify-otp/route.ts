/**
 * 휴대폰 OTP 검증 — 레벨2 2차 D4: go DB(phone_verifications) 직접읽기 → v2 프록시.
 *
 * SSOT: v2 /auth/verify-phone/confirm 이 OTP 검증·본인인증 레벨 상향을 수행(user 스코프).
 * go 는 요청 쿠키(v2 세션)를 전달해 프록시한다.
 *
 * 계약: 입력은 { verificationId, code } (send-otp 가 verificationId=phone 로 반환) 또는
 *   { phone, code }. v2 confirm 은 phone+code 를 받는다 → verificationId 를 phone 으로 사용.
 *   응답은 { verified, verificationLevel } (기존 verificationToken 은 v2 세션 기반이라 제거 —
 *   후속 API 는 v2 세션 verification_level 로 판정).
 */
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";

const schema = z
  .object({
    verificationId: z.string().min(1).optional(),
    phone: z.string().min(10).max(20).optional(),
    code: z.string().regex(/^\d{6}$/, "6자리 숫자를 입력해주세요"),
  })
  .refine((v) => v.verificationId || v.phone, {
    message: "전화번호 정보가 누락되었습니다",
  });

function normalizePhone(phone: string): string {
  return phone.replace(/[\s-]/g, "");
}

function getV2Base(): string {
  return process.env.V2_INTERNAL_BASE_URL ?? "https://api-staging.pickket.kr";
}

export async function POST(request: Request) {
  try {
    const body = schema.parse(await request.json());
    // send-otp 가 verificationId=phone 으로 반환하므로 우선 사용, 없으면 phone 필드.
    const phone = normalizePhone(body.verificationId ?? body.phone ?? "");

    const res = await fetch(`${getV2Base().replace(/\/$/, "")}/api/v1/auth/verify-phone/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: request.headers.get("cookie") ?? "",
        "User-Agent": request.headers.get("user-agent") ?? "pickket-go-bff/1.0",
      },
      body: JSON.stringify({ phone, code: body.code }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 401) {
      return errorResponse("로그인 후 본인인증을 진행해주세요", 401);
    }

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      let msg = "인증번호 검증에 실패했습니다";
      try {
        const parsed = JSON.parse(text);
        if (parsed?.detail && typeof parsed.detail === "string") msg = parsed.detail;
      } catch {
        /* raw 유지 */
      }
      // v2 검증 실패(불일치/만료)는 422 계열로 그대로 전달.
      return errorResponse(msg, res.status >= 400 && res.status < 500 ? res.status : 502);
    }

    const parsed = text ? JSON.parse(text) : {};
    return successResponse({
      verified: parsed.verified === true,
      verificationLevel: parsed.verification_level ?? null,
      phone,
    });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    logger.error("[verify-otp] v2 프록시 처리 중 에러", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(ERR.SERVER, 500);
  }
}
