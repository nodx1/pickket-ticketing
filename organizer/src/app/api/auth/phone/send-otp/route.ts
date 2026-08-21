/**
 * 휴대폰 OTP 발송 — 레벨2 2차 D4: go DB(phone_verifications) 직접쓰기 → v2 프록시.
 *
 * SSOT: 본인인증 OTP 원장은 v2(Redis, user 스코프). go 는 v2 /auth/verify-phone/send 로
 * 프록시한다(로그인 사용자 컨텍스트 — 쿠키 포워딩). v2 가 Redis 에 OTP 를 저장·SMS 발송.
 *
 * 계약 유지: go 응답은 { verificationId, expiresInSeconds, provider }.
 *   v2 는 user 스코프라 별도 verificationId 를 두지 않음 → go 는 안정적 참조용으로 "phone" 을
 *   verificationId 로 되돌려준다(verify-otp 는 동일 세션·전화번호로 v2 confirm 호출).
 *
 * 인증: 요청 쿠키(v2 세션)를 그대로 v2 로 전달 — 비로그인 흐름(회원가입)은 D2 register 소관.
 */
import { z } from "zod";
import { errorResponse, successResponse } from "@/lib/apiResponse";
import { ERR } from "@/lib/errors";
import { logger } from "@/lib/logger";

const OTP_TTL_SECONDS = 300; // v2 _OTP_TTL 과 동일

const schema = z.object({
  phone: z
    .string()
    .min(10)
    .max(20)
    .regex(/^[+0-9\-\s]+$/, "올바른 전화번호 형식이 아닙니다"),
  purpose: z.enum(["signup", "login", "checkout", "refund", "phone_change"]).optional(),
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
    const phone = normalizePhone(body.phone);

    const res = await fetch(`${getV2Base().replace(/\/$/, "")}/api/v1/auth/verify-phone/send`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // v2 get_current_user 가 세션을 해석하도록 클라이언트 쿠키 포워딩.
        Cookie: request.headers.get("cookie") ?? "",
        "User-Agent": request.headers.get("user-agent") ?? "pickket-go-bff/1.0",
      },
      body: JSON.stringify({ phone }),
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 401) {
      return errorResponse("로그인 후 본인인증을 진행해주세요", 401);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      let msg = "SMS 발송에 실패했습니다. 잠시 후 다시 시도해주세요.";
      try {
        const parsed = JSON.parse(text);
        if (parsed?.detail && typeof parsed.detail === "string") msg = parsed.detail;
      } catch {
        /* raw 유지 */
      }
      // v2 rate-limit(1분 재발송 제한 등)은 400 계열 → 그대로 전달.
      return errorResponse(msg, res.status >= 400 && res.status < 500 ? res.status : 502);
    }

    return successResponse({
      // v2 는 user 스코프라 별도 id 미발급 — 전화번호를 참조자로 되돌림(verify-otp 가 재사용).
      verificationId: phone,
      expiresInSeconds: OTP_TTL_SECONDS,
      provider: "v2",
    });
  } catch (err: unknown) {
    if (err instanceof z.ZodError) {
      return errorResponse(err.issues[0]?.message ?? ERR.INVALID_INPUT, 400);
    }
    logger.error("[send-otp] v2 프록시 처리 중 에러", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse(ERR.SERVER, 500);
  }
}
