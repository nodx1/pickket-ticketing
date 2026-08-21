import { NextResponse } from "next/server";
import { isProdRuntime } from "@/lib/env/runtime";
import {
  createPublicLookupToken,
  PUBLIC_LOOKUP_COOKIE,
  verifyMagicLinkToken,
} from "@/lib/public-access";

/**
 * 매직링크 검증 (감사 P1-7).
 *
 * 이메일로 받은 매직토큰을 검증(=이메일 수신함 소유증명)하고, 통과하면 PUBLIC_LOOKUP_COOKIE 를
 * 발급한 뒤 /my-tickets 로 리다이렉트한다. 실패(만료/위조)면 조회 폼으로 되돌린다.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const base = `${url.protocol}//${url.host}`;

  const lookup = verifyMagicLinkToken(token);
  if (!lookup) {
    return NextResponse.redirect(`${base}/my-tickets?error=invalid_or_expired`);
  }

  const res = NextResponse.redirect(`${base}/my-tickets?verified=1`);
  res.cookies.set(
    PUBLIC_LOOKUP_COOKIE,
    createPublicLookupToken({ email: lookup.email, phone: lookup.phone }),
    {
      httpOnly: true,
      sameSite: "lax",
      secure: isProdRuntime(),
      path: "/",
      expires: new Date(Date.now() + 15 * 60 * 1000),
    },
  );
  return res;
}
