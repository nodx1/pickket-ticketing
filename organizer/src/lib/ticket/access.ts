/**
 * 티켓 산출물(QR/Wallet/PDF) 접근 제어 공용 헬퍼
 *
 * 정책:
 * - 로그인된 세션이 "해당 이벤트를 소유한 account" 일 때만 접근 허용 (대시보드 운영자)
 *   → 임의 주최자가 타 이벤트의 티켓 산출물을 발급받는 IDOR 방지
 * - PUBLIC_LOOKUP_COOKIE가 buyer_email/buyer_phone과 일치하면 접근 허용 (구매자)
 * - 둘 다 없으면 접근 거부
 */
import { TICKET_ACCESS_COOKIE, ticketAccessCookieGrants } from "./access-cookie";
import { cookies } from "next/headers";
import { verifySession } from "@/lib/auth/session";
import {
  matchesPublicLookup,
  PUBLIC_LOOKUP_COOKIE,
  verifyPublicLookupToken,
} from "@/lib/public-access";

export async function canAccessTicketArtifact(
  buyerEmail: string | null,
  buyerPhone: string | null,
  eventAccountId?: string | null,
  /**
   * 🔴 딥링크로 연 손님을 위한 티켓 접근 쿠키 대조 대상.
   *
   * 지정하지 않으면 딥링크 경로가 인정되지 않는다 — 그 경우 초대권·구매 티켓 손님은
   * QR 갱신·PDF·지갑이 전부 403 이 되고, 결과적으로 **게이트에서 스캔이 거부**된다
   * (2026-07-29 실사고). 신규 호출부는 반드시 넘길 것.
   */
  ticketNumber?: string | null,
): Promise<boolean> {
  const cookieStore = await cookies();

  // 0. 티켓 전용 접근 쿠키 — 딥링크(초대권/유료)로 연 손님이 교환해 받은 것.
  //    **그 티켓에만** 유효하다(쿠키가 새도 다른 티켓은 열리지 않는다).
  if (ticketNumber && ticketAccessCookieGrants(cookieStore.get(TICKET_ACCESS_COOKIE)?.value, ticketNumber)) {
    return true;
  }

  // 1. 세션 확인 — 해당 티켓이 속한 이벤트를 소유한 account 의 세션일 때만 허용.
  //    BFF cutover 후 세션은 pickket_access(v2 JWT) 쿠키이므로 verifySession() 이
  //    내부적으로 그것을 읽는다. (구 pickket_session 쿠키는 더 이상 발급되지 않음)
  if (eventAccountId) {
    const session = await verifySession();
    if (session && session.accountId === eventAccountId) return true;
  }

  // 2. 공개 lookup 쿠키 확인 (구매자)
  const lookup = verifyPublicLookupToken(cookieStore.get(PUBLIC_LOOKUP_COOKIE)?.value);
  return matchesPublicLookup(lookup, { email: buyerEmail, phone: buyerPhone });
}
