import { NextRequest, NextResponse } from "next/server";
import { isProdRuntime } from "@/lib/env/runtime";
import { invitationTokenGrantsAccess } from "@/lib/invitation-token";
import { ticketLinkGrantsAccess } from "@/lib/ticket-link-token";
import { createTicketAccessCookie, TICKET_ACCESS_COOKIE, TICKET_ACCESS_TTL_MS } from "@/lib/ticket/access-cookie";
import { getInvitationByTicketNumber, V2CommerceError } from "@/lib/v2/commerce-client";
import { resolveTicketArtifactContext, TicketArtifactNotFoundError } from "@/lib/ticket/artifact-context";
import { logger } from "@/lib/logger";

/**
 * 딥링크 토큰 → **티켓 접근 쿠키** 교환 (POST).
 *
 * 🔴 왜 필요한가: 티켓 페이지는 딥링크 토큰을 인정하는데 아티팩트 API 4개
 * (`/qr` `/pdf` `/wallet/*`)는 세션·조회쿠키만 봤다. 초대권 손님은 둘 다 없어 403 이었고,
 * 그 결과 **30초 뒤 QR 갱신이 죽어 게이트에서 스캔이 거부**됐다(2026-07-29 실사고).
 *
 * 🔴 왜 POST 인가: 토큰이 쿼리스트링이 아니라 본문으로 간다(접근로그·Referer 에 안 남는다).
 * 🔴 왜 라우트 핸들러인가: 서버 컴포넌트는 쿠키를 설정할 수 없다(Next.js 제약).
 *
 * 실패해도 페이지는 열린다 — 이 교환은 아티팩트 접근을 **추가로** 여는 단계다.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ ticketNumber: string }> }) {
  const { ticketNumber } = await params;
  let token: string | null = null;
  try {
    const body = (await request.json()) as { token?: unknown };
    token = typeof body.token === "string" ? body.token : null;
  } catch {
    token = null;
  }
  if (!token) {
    return NextResponse.json({ error: "토큰이 필요합니다" }, { status: 400 });
  }

  try {
    // 티켓 실체·상태 확인. 취소/만료 티켓은 여기서 404 로 끊긴다(원장이 정본).
    const ticket = await resolveTicketArtifactContext(ticketNumber);

    // 초대권 경로 — 원장의 token_version(회수 nonce)과 대조해야 한다.
    let granted = false;
    try {
      const { invitation } = await getInvitationByTicketNumber(ticketNumber);
      if (invitation) {
        granted = invitationTokenGrantsAccess({
          token,
          ticketNumber,
          currentVersion: invitation.token_version,
        });
      } else {
        // 유료 티켓 경로 — 무효화는 **티켓 상태**가 한다(환불/양도/만료면 거부).
        granted = ticketLinkGrantsAccess({ token, ticketNumber, status: ticket.status });
      }
    } catch (err: unknown) {
      // 🔴 원장 조회 실패를 "초대권 아님" 으로 흘리지 않는다 — 정당한 초대객이 조용히
      //    거부되고 그 이유가 어디에도 안 남는다. 명시적으로 502 로 끊는다.
      if (err instanceof V2CommerceError) {
        logger.warn("티켓 접근 교환 — 초대 원장 조회 실패", { ticketNumber, status: err.status });
        return NextResponse.json({ error: "잠시 후 다시 시도해주세요" }, { status: 502 });
      }
      throw err;
    }

    if (!granted) {
      return NextResponse.json({ error: "링크가 만료되었거나 유효하지 않습니다" }, { status: 403 });
    }

    const res = NextResponse.json({ data: { ok: true } });
    res.cookies.set(TICKET_ACCESS_COOKIE, createTicketAccessCookie({ ticketNumber }), {
      httpOnly: true,
      sameSite: "lax",
      secure: isProdRuntime(),
      path: "/",
      expires: new Date(Date.now() + TICKET_ACCESS_TTL_MS),
    });
    return res;
  } catch (err: unknown) {
    if (err instanceof TicketArtifactNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    logger.error("티켓 접근 교환 실패", {
      ticketNumber,
      error: err instanceof Error ? err.message : "unknown",
    });
    return NextResponse.json({ error: "티켓 접근 처리에 실패했습니다" }, { status: 500 });
  }
}
