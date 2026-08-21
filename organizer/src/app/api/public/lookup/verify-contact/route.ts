import { z } from "zod";
import { NextResponse } from "next/server";
import { withRateLimit } from "@/lib/auth/withRateLimit";
import { errorResponse } from "@/lib/apiResponse";
import { isProdRuntime } from "@/lib/env/runtime";
import { createPublicLookupToken, PUBLIC_LOOKUP_COOKIE } from "@/lib/public-access";
import { getTicketByNumber, V2CommerceError } from "@/lib/v2/commerce-client";
import { logger } from "@/lib/logger";

/**
 * 구매자 본인확인 — **지식증명**(주문의 이메일+전화 대조)으로 조회쿠키를 발급한다.
 *
 * ## 왜 필요한가 (2026-07-31)
 * 조회쿠키를 굽는 곳은 종전에 `my-tickets/verify`(매직링크) **한 곳뿐**이었다. 그런데
 * 매직링크는 메일 발송에 달려 있고, `MAILER_SENDER_ADDRESS` 미설정으로 메일이 한 통도
 * 나가지 않았다 ⟹ **쿠키가 생길 수 있는 경로가 물리적으로 없었다.**
 * 그 결과 구매자는 자기 티켓의 환불 화면에서 404 만 봤다(티켓은 실재하는데도).
 *
 * ## 무엇으로 대체하는가
 * 알림톡으로 티켓 링크를 받은 사람이 **자기 주문의 이메일과 전화를 알고 있다**는 것을
 * 증명하게 한다. 티켓번호(링크 보유) + 이메일 + 전화 **3요소 일치**를 요구한다.
 *
 * 🔴 이것은 매직링크보다 약한 증명이다. 링크를 전달받은 제3자가 구매자의 연락처까지
 *    알고 있으면 통과한다. 그럼에도 채택한 이유는 대안이 *"아무도 환불할 수 없음"*
 *    이기 때문이다. 메일이 살아나면 매직링크로 승격한다(그때 이 경로를 좁힌다).
 *
 * ## 지키는 것
 * - **열거 방지**: 실패 사유를 구분하지 않는다. 티켓 미존재·이메일 불일치·전화 불일치가
 *   전부 같은 응답이다. 구분하면 "이 티켓의 구매자 이메일은 무엇인가" 를 캐낼 수 있다.
 * - **무차별 대입 차단**: 분당 5회. 전화번호는 후보공간이 좁아(01X-XXXX-XXXX) 한도가
 *   느슨하면 링크만 가진 사람이 번호를 긁어낼 수 있다.
 * - **정보 미반환**: 성공해도 본문에 구매자 정보를 담지 않는다. 쿠키만 굽는다.
 * - **기존 계약 재사용**: 발급하는 쿠키는 매직링크와 **같은 토큰**이다. 그래서 하류
 *   (`refund/check`·`refund`·환불 페이지)가 한 줄도 바뀌지 않는다.
 */

const schema = z.object({
  ticketNumber: z.string().min(1).max(64),
  email: z.string().email().max(254),
  phone: z.string().min(1).max(32),
});

/** 숫자만 남긴다 — `public-access.normalizePhone` 과 같은 규칙이어야 대조가 성립한다. */
function digits(v: string) {
  return v.replace(/\D/g, "");
}

/**
 * 🔴 실패는 **항상 이 응답 하나**다. 사유를 나누면 열거 통로가 된다.
 *    상태코드도 404 가 아니라 401 이다 — 티켓 존재 여부를 알려주지 않기 위해서다.
 */
function deny() {
  return errorResponse("입력하신 정보가 주문 정보와 일치하지 않습니다", 401);
}

async function verifyContactHandler(request: Request) {
  let body: z.infer<typeof schema>;
  try {
    body = schema.parse(await request.json());
  } catch {
    return deny();
  }

  let ticket: Awaited<ReturnType<typeof getTicketByNumber>>;
  try {
    ticket = await getTicketByNumber(body.ticketNumber);
  } catch (err: unknown) {
    // 4xx(미존재 등)는 불일치와 **같은 응답**으로 접는다(열거 방지).
    if (err instanceof V2CommerceError && err.status >= 400 && err.status < 500) {
      return deny();
    }
    // 🔴 5xx·네트워크를 불일치로 위장하면 구매자는 맞는 정보를 넣고도 계속 튕긴다.
    //    장애는 장애라고 말한다.
    logger.error("[verify-contact] 티켓 조회 실패", {
      error: err instanceof Error ? err.message : String(err),
    });
    return errorResponse("일시적인 오류입니다. 잠시 후 다시 시도해주세요.", 503);
  }

  const buyerEmail = (ticket.order.buyer?.email ?? "").trim().toLowerCase();
  const buyerPhone = digits(ticket.order.buyer?.phone ?? "");
  if (!buyerEmail || !buyerPhone) return deny();

  const okEmail = buyerEmail === body.email.trim().toLowerCase();
  const okPhone = buyerPhone === digits(body.phone);
  if (!okEmail || !okPhone) return deny();

  // 쿠키 페이로드는 **주문 원장의 값**으로 만든다(사용자 입력이 아니라).
  // 하류 `matchesPublicLookup` 이 다시 주문과 대조하므로 형식 차이로 어긋나면 안 된다.
  const res = NextResponse.json({ success: true, data: { verified: true } });
  res.cookies.set(
    PUBLIC_LOOKUP_COOKIE,
    createPublicLookupToken({ email: buyerEmail, phone: buyerPhone }),
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

// 🔴 분당 5회. 전화번호 후보공간이 좁아 한도가 느슨하면 링크 보유자가 번호를 긁는다.
export const POST = withRateLimit({
  max: 5,
  windowMs: 60_000,
  keyPrefix: "public:verify-contact",
})(verifyContactHandler);
