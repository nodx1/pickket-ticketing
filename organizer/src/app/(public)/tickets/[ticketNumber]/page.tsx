import { cache } from "react";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { resolveTicketLogoUrl } from "@/lib/ticket/logo";
import Link from "next/link";
import { CalendarPlus, MapPin, RefreshCcw, Trophy } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { TicketUnusableActions } from "./_components/ticket-unusable-actions";
import { Card, CardContent } from "@/components/ui/card";
import { verifySession } from "@/lib/auth/session";
import { formatDate, formatDateTimeKst } from "@/lib/format";
import {
  matchesPublicLookup,
  PUBLIC_LOOKUP_COOKIE,
  verifyPublicLookupToken,
} from "@/lib/public-access";
import { INVITE_TOKEN_PARAM, invitationTokenGrantsAccess } from "@/lib/invitation-token";
import { ticketLinkGrantsAccess, ticketLinkTokenMatches } from "@/lib/ticket-link-token";
import { buildOrderTicketItems } from "@/lib/tickets/order-siblings";
import { OrderTicketSwitcher } from "./_components/order-ticket-switcher";
import { resolveBlockedReason } from "./blocked-reason";
import { markInvitationViewed } from "@/lib/server/invitations";
import { generateQRDataURL } from "@/lib/qrCode";
import { generateDynamicQRPayload } from "@/lib/ticket/dynamic-qr";
import { resolveTicketUsability } from "@/lib/ticket/usability";
import { RotatingTicketQR } from "./_components/rotating-ticket-qr";
import { InvitationTicketView } from "./_components/invitation-ticket-view";
import { LiveView } from "./_components/live/live-view";
import { AdmittedTicketPanel } from "./_components/live/admitted-ticket-panel";
import { shouldShowLive } from "@/lib/live/gate";
import { parseV2Schedules } from "@/lib/v2/event-schedules";
import { deriveAdmissionWindow } from "./_components/admission-window";
import {
  V2CommerceError,
  getPublicTicketDesign,
  getInvitationByTicketNumber,
  getTicketByNumber,
} from "@/lib/v2/commerce-client";
import { PUBLIC_ANY_STATUS, resolvePublicEventById } from "@/lib/v2/public-event";

/**
 * 🔴 이 화면에만 있던 **로컬 포맷터를 지웠다** (2026-08-03).
 *
 * 같은 표 안에서 날짜가 세 형식으로 갈려 있었다:
 * ```
 * 발권일시       로컬 Intl (여기)          "2026년 8월 3일 오전 08:19"
 * 대회일정       lib/format.formatDate     "2026년 8월 20일 ~ 2026년 8월 23일"
 * 입장 가능 일자  admission-window (숫자)   "2026-08-20 ~ 08-23 중 1일"
 * ```
 *
 * ⚠️ **시간대 가드는 이걸 못 잡는다.** 그 가드는 `timeZone` 이 빠졌는지만 본다
 *    (`datetime.guard.test.ts`). 여기는 `Asia/Seoul` 을 제대로 넘기고 있었다 —
 *    틀린 건 시간대가 아니라 **형식이 갈린 것**이었다. 검사 축이 달랐다.
 *
 * ⟹ 표시 형식은 `lib/format.ts` 하나로 모은다. 화면마다 만들면 화면마다 갈린다.
 */
function formatDateTime(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const text = formatDateTimeKst(value, "");
  return text || null;
}

/**
 * 🔴 metadata 와 페이지 본문이 **같은 요청에서 v2 를 두 번 부르지 않게** 묶는다.
 *    React `cache()` 는 한 렌더 패스 안에서 같은 인자 호출을 합친다.
 *    (없으면 티켓을 열 때마다 v2 왕복이 2배가 된다 — 대회 중엔 그게 그대로 부하다.)
 */
const loadTicket = cache((ticketNumber: string) => getTicketByNumber(ticketNumber));
const loadEvent = cache((eventId: string) => resolvePublicEventById(eventId, PUBLIC_ANY_STATUS));
const loadInvitation = cache((ticketNumber: string) => getInvitationByTicketNumber(ticketNumber));

/**
 * 공유 미리보기(카카오톡·문자 등).
 *
 * ## 🔴 왜 필요한가 (2026-08-03 지적)
 * 이 페이지에 `generateMetadata` 가 없어서 **사이트 기본값**이 그대로 나갔다:
 *
 * ```
 * 제목   PICKKET.GO — 이벤트를 여는 모든 사람을 위해
 * 설명   "…AI가 만들고, 당신은 행사에 집중하세요."   ← 폐기된 문구
 * ```
 *
 * 초대권을 받은 사람이 카톡으로 링크를 받으면 **무슨 행사인지 알 수 없었다.**
 *
 * ## 🔴 절대 넣지 않는 것 — 미리보기는 공개된다
 * 티켓번호 · 수신자 이름 · QR. 미리보기는 링크를 가진 누구에게나 보이고
 * 카카오 서버에 캐시된다. 행사 제목과 대표 이미지까지만 싣는다.
 *
 * ⚠️ 실패해도 **던지지 않는다.** `generateMetadata` 가 던지면 페이지 자체가 죽는다.
 *    v2 가 흔들릴 때 티켓을 못 여는 것이 미리보기가 밋밋한 것보다 나쁘다.
 */
export async function generateMetadata({
  params,
}: {
  params: Promise<{ ticketNumber: string }>;
}): Promise<Metadata> {
  // 링크를 가진 사람만 보는 페이지다 — 검색엔진에 남기지 않는다.
  //   ⚠️ noindex 는 OG 스크래핑을 막지 않는다(카톡 미리보기는 정상 동작).
  const base: Metadata = { robots: { index: false, follow: false } };

  try {
    const { ticketNumber } = await params;
    const ticket = await loadTicket(ticketNumber);
    const resolved = await loadEvent(ticket.event_id);
    if (!resolved.ok) return base;

    const event = resolved.event;
    const title = String(event.title ?? ticket.event?.title ?? "").trim();
    if (!title) return base;

    // 초대권이면 문구를 달리한다 — 구매한 티켓에 "초대권이 도착했습니다" 는 틀린 말이다.
    // 조회 실패는 삼킨다(여기서는 초대권 여부를 모른다는 것이 치명적이지 않다).
    let isInvitation = false;
    try {
      isInvitation = Boolean((await loadInvitation(ticketNumber)).invitation);
    } catch {
      /* 판별 실패 — 중립 문구로 간다 */
    }

    const description = isInvitation
      ? "초대권이 도착했습니다. 링크를 열어 입장 QR을 확인하세요."
      : "모바일 티켓입니다. 링크를 열어 입장 QR을 확인하세요.";

    const image = String(event.image_url ?? "").trim();

    return {
      ...base,
      // 🔴 브랜드를 붙이지 않는다 — 루트 layout 의 `template` 이 붙인다(두 번 붙는 것을 막는다).
      title,
      description,
      openGraph: {
        title,
        description,
        type: "website",
        locale: "ko_KR",
        siteName: "PICKKET.GO",
        ...(image ? { images: [{ url: image }] } : {}),
      },
      twitter: {
        card: image ? "summary_large_image" : "summary",
        title,
        description,
        ...(image ? { images: [image] } : {}),
      },
    };
  } catch {
    // 티켓 없음·v2 장애 — 기본값으로 조용히 물러난다.
    return base;
  }
}

export default async function MobileTicketPage({
  params,
  searchParams,
}: {
  params: Promise<{ ticketNumber: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { ticketNumber } = await params;
  const sp = await searchParams;
  const rawInviteToken = sp[INVITE_TOKEN_PARAM];
  const inviteToken = Array.isArray(rawInviteToken) ? rawInviteToken[0] : rawInviteToken;
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get("pickket_session")?.value ?? null;
  const session = sessionToken ? await verifySession(sessionToken) : null;
  const lookup = verifyPublicLookupToken(cookieStore.get(PUBLIC_LOOKUP_COOKIE)?.value);
  // 🔴 `getPool()` 호출 제거(2026-07-28). W2-PUB 전환으로 이 페이지의 go 조회가 0 이 됐는데
  //    커넥션만 잡고 쓰지 않는 코드가 남아 있었다.

  // ── 레벨2 컷오버 W2-PUB (부분 전환) ──
  // ✅ go `attendees JOIN events JOIN orders` → v2 `tickets/by-number` + 이벤트 상세.
  // ✅ 레벨2 컷오버 — 이 페이지의 go DB 접근이 **0** 이 됐다.
  //    W5-CONTENT: `ticket_designs` → v2 `organizer_ticket_designs`
  //    W5-ATTENDEE: `event_invitations` → v2 정본
  //    (두 트랙이 같은 파일의 서로 다른 절반을 옮겼고, 병합 시 양쪽을 모두 채택했다.)
  let v2Ticket: Awaited<ReturnType<typeof getTicketByNumber>>;
  try {
    v2Ticket = await loadTicket(ticketNumber);
  } catch (err: unknown) {
    if (err instanceof V2CommerceError && err.status >= 400 && err.status < 500) {
      notFound();
    }
    // v2 5xx/네트워크 — "티켓 없음"으로 위장하지 않는다(error.tsx 가 재시도 안내).
    throw err;
  }

  const eventResolved = await loadEvent(v2Ticket.event_id);
  if (!eventResolved.ok) {
    if (eventResolved.status === 404) notFound();
    throw new Error("이벤트 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.");
  }
  const v2Event = eventResolved.event;

  // 티켓 디자인 = v2 정본(W5-CONTENT). 설정이 없으면 canvas_json 이 null 이다.
  // v2 장애는 전파한다 — 이 페이지는 이미 v2 티켓/이벤트 조회에 의존하므로 여기만 삼켜도
  // 얻는 가용성이 없고, 디자인 없는 티켓을 "원래 그런 것"으로 보이게만 만든다.
  const { canvas_json: ticketDesign } = await getPublicTicketDesign(v2Ticket.event_id);

  // W5-ATTENDEE: 초대권 원장 = v2 정본. 표기값(수신자·입장일)과 딥링크 nonce(token_version)를
  // **한 번에** 받는다(옛 go 2쿼리). 회수된 초대는 애초에 반환되지 않는다(fail-closed 형태).
  //
  // 🔴 조회 실패를 "초대권 아님"으로 흘리지 않는다. 그러면 정당한 초대객의 딥링크가 조용히
  //    거부되고(그 이유가 로그에도 안 남고) 유료 티켓처럼 로그인 화면으로 튕긴다 → 명시적 throw
  //    (error.tsx 가 재시도 안내). 접근 허용을 장애로 얻는 일도 없다(토큰 검증 입력이 없으니).
  let invitation: Awaited<ReturnType<typeof getInvitationByTicketNumber>>["invitation"];
  try {
    invitation = (await loadInvitation(ticketNumber)).invitation;
  } catch (err: unknown) {
    if (err instanceof V2CommerceError) {
      throw new Error("초대권 정보를 불러오지 못했습니다. 잠시 후 다시 시도해주세요.");
    }
    throw err;
  }

  const buyer = v2Ticket.order.buyer;
  const ticket = {
    ticketNumber: v2Ticket.ticket_number ?? ticketNumber,
    // ⚠️ go `attendees.name`(참석자명) → v2 주문 구매자명. v2 는 티켓별 참석자명을 갖지 않는다.
    name: buyer?.name ?? "",
    status: v2Ticket.status,
    issuedAt: v2Ticket.issued_at ?? null,
    raffleNumber: v2Ticket.raffle_number,
    ticketDesign: ticketDesign ?? null,
    orderNumber: v2Ticket.order.order_number ?? "",
    buyerEmail: buyer?.email ?? "",
    buyerPhone: buyer?.phone ?? null,
    eventTitle: v2Ticket.event.title ?? v2Event.title,
    startsAt: v2Ticket.event.starts_at ?? v2Event.event_date,
    endsAt: v2Event.event_date_end ?? v2Ticket.event.starts_at ?? v2Event.event_date,
    venueName: v2Event.venue ?? null,
    venueAddress: v2Event.venue_address ?? null,
    heroImageUrl: v2Event.image_url ?? null,
    galleryImages: v2Event.gallery_images ?? null,
    invitationRecipient: invitation?.recipient_name ?? null,
    invitationAdmissionDay: invitation?.admission_day ?? null,
    invitationAdmissionMode: invitation?.admission_mode ?? null,
  };

  // 상품명 SoT = v2 티켓(단건 read 에 이미 포함 — 별도 왕복 없음).
  const productName: string | null = v2Ticket.product_name;

  // 🔴 QR 을 띄워도 되는 상태인지 **접근 판정보다 먼저** 정한다 — 화면 세 곳(QR·환불버튼·
  //    목록 배지)이 같은 출처를 보고, 아래 `statusOnlyAccess` 도 이 값에 기댄다.
  //    화면마다 따로 적으면 갈라진다(오늘 아침 참석자 필터가 그래서 어긋나 있었다).
  const usability = resolveTicketUsability(ticket.status);

  // P0-2 딥링크 bearer: 유효한 초대권 토큰(?t=)이면 해당 comp 티켓만 무인증 열람 허용.
  //   토큰은 (a)서명·만료 유효 (b)티켓번호 일치 (c)원장 token_version(nonce) 일치 시에만 통과.
  //   comp/invitation 티켓 한정 — v2 초대 원장에 해당 ticket_number 가 있어야 매칭된다.
  //   유료/일반 티켓은 원장에 없으므로(invitation=null) 토큰이 있어도 통과되지 않고 기존 인증을 요구한다.
  let inviteAccess = false;
  if (inviteToken && invitation) {
    inviteAccess = invitationTokenGrantsAccess({
      token: inviteToken,
      ticketNumber,
      currentVersion: invitation.token_version,
    });
  }

  // 🔴 유료 티켓 딥링크 — 구매완료 알림톡의 '모바일 티켓' 버튼용.
  //
  // 이게 없으면 카톡으로 티켓을 받은 구매자가 **아무도 못 연다**. 세션도 조회쿠키도
  // 없이 들어오기 때문이다(초대권과 같은 상황이라 같은 방식으로 푼다).
  // 무효화는 별도 원장이 아니라 **티켓 상태**가 한다 — 환불/양도/만료면 안 열린다.
  // 초대권 원장에 없는 티켓(=유료)에만 적용해 두 경로가 겹치지 않게 한다.
  const ticketLinkAccess =
    !invitation &&
    ticketLinkGrantsAccess({ token: inviteToken, ticketNumber, status: ticket.status });

  // 🔴 **상태만 알려주는 접근** — 토큰이 이 티켓 것이면 "취소되었습니다" 는 그 자리에서 말한다.
  //
  //    종전엔 환불한 구매자가 알림톡 버튼을 누르면 신원확인 여정으로 떠밀렸다:
  //      알림톡 → "취소·양도되었거나…" → 이메일·전화 입력 → 매직링크 메일 → 클릭 → 목록
  //    **한 줄을 알려주려고 그 사람에게 본인확인을 시킨 것**이다. 자기 알림톡으로 들어온
  //    사람인데도. 그 끝에 쿠키가 만료됐거나 기기가 다르면 아무것도 못 보고 끝난다
  //    (대표 실사용에서 그렇게 됐다).
  //
  //    상태 고지는 티켓을 여는 것이 아니다 — QR·좌석·연락처는 아래 `usability` 차단 화면이
  //    여전히 안 준다. 초대권(회수 등)은 의미가 달라 여기 포함하지 않는다.
  //    ⚠️ **못 쓰는 티켓일 때만** 연다. 이 조건이 없으면 `pending`(무통장 미확정)처럼
  //       열람 허용 목록엔 없지만 사용 가능한 상태가 딥링크로 통째로 열린다 —
  //       상태 고지 하나 하려다 QR 을 내주는 셈이다.
  const statusOnlyAccess =
    !invitation &&
    !usability.usable &&
    ticketLinkTokenMatches({ token: inviteToken, ticketNumber });

  if (
    !session &&
    !inviteAccess &&
    !ticketLinkAccess &&
    !statusOnlyAccess &&
    !matchesPublicLookup(lookup, {
      email: String(ticket.buyerEmail ?? ""),
      phone: ticket.buyerPhone ? String(ticket.buyerPhone) : null,
    })
  ) {
    // 🔴 이유 없이 튕기지 않는다.
    //
    // 옛 코드는 `/my-tickets` 로 조용히 307 했다. 링크 만료·초대권 회수·토큰 누락·
    // 다른 기기 열람이 **전부 같은 화면**으로 떨어져서, 고객은 "티켓이 사라졌다"로
    // 읽고 문의를 넣는다. 조회 화면은 이메일 매직링크를 보내는데 그 메일마저
    // 지금은 나가지 않는다(발신주소 미설정) → 그 자리에서 막힌다.
    //
    // 최소한 **왜 못 열었는지**와 **무엇을 하면 되는지**는 넘긴다.
    const reason = resolveBlockedReason({
      hasToken: Boolean(inviteToken),
      status: ticket.status,
    });
    redirect(`/my-tickets?reason=${reason}&ticket=${encodeURIComponent(ticketNumber)}`);
  }

  // ── 🔴 같은 주문의 다른 티켓 (2026-08-19) ──
  //
  // 「4장 샀는데 QR 이 하나만 보인다」를 푼다. prod 실측: 유료 복수구매 54명 · 120장 중
  // **64장이 링크로 닿지 않았다**(알림톡 딥링크가 첫 장 하나뿐이고, 이 화면에도 나머지로
  // 가는 길이 없었다).
  //
  // 🔴 **여기까지 왔다는 것 자체가 접근 판정 통과다.** 위 `redirect` 를 지났으므로 방문자는
  //    딥링크 토큰(=이 주문 구매자)·세션·조회쿠키 중 하나를 갖고 있다. 같은 주문의 티켓을
  //    보여주는 것은 새 권한을 여는 게 아니라 같은 사람에게 자기 주문을 보여주는 것이다.
  //
  // 🔴 초대권 화면에는 띄우지 않는다 — 초대권은 **장마다 주인이 다르다**(1인 다장 상한 50,
  //    양도 기능 있음). v2 가 목록에서 이미 빼지만, 초대권으로 들어온 방문자에게는 애초에
  //    이 줄을 만들지 않는다(이중 방어 — 한쪽이 무너져도 남의 티켓이 안 열린다).
  //
  // ⚠️ 형제 링크에는 **각자의 토큰을 서버가 새로 발급**한다. 내 토큰을 그대로 붙이면
  //    `ticketLinkGrantsAccess` 의 티켓번호 대조에서 막힌다(토큰은 티켓번호에 묶여 있다).
  const orderTicketItems = buildOrderTicketItems({
    siblings: v2Ticket.order?.tickets,
    currentTicketNumber: ticketNumber,
    isInvitation: Boolean(invitation),
  });

  // 딥링크로 초대권을 연 경우 추적 원장을 viewed 로 전이(sent/issued → viewed).
  if (inviteAccess) {
    await markInvitationViewed(ticketNumber);
  }

  // 정적 평문 QR(스크린샷 영구재사용) 대신 회전 동적 QR — 초기 페이로드는 서버에서 발급(P2-C15).
  // ⚠️ 못 쓰는 티켓이면 **생성 자체를 건너뛴다.** 렌더에서만 가려도 서버 응답에 QR 이
  //    실려 나가면 개발자도구로 꺼내 쓸 수 있다.
  const initialQrPayload = usability.usable ? generateDynamicQRPayload(ticketNumber) : "";
  const qrImage = usability.usable ? await generateQRDataURL(initialQrPayload) : "";
  const design = (ticket.ticketDesign as {
    backgroundColor?: string;
    textColor?: string;
    accentColor?: string;
    logoUrl?: string;
    /** 레거시 키 — 옛 티켓 디자이너가 저장하던 쪽. 읽기 폴백용(`lib/ticket/logo.ts`). */
    logoImageUrl?: string;
    invitationHeaderText?: string;
    showEventName?: boolean;
    showDate?: boolean;
    showVenue?: boolean;
    showAttendeeName?: boolean;
    showProductName?: boolean;
    showRaffleNumber?: boolean;
    showGallery?: boolean;
  } | null) ?? null;

  // ── 🔴 사용 불가 티켓은 **갈림길 앞에서** 끝낸다 (2026-08-01) ─────────────
  //
  // 처음엔 유료 분기 안에만 게이트를 붙였다가 페이블 적대검수에서 반증됐다 —
  // **초대권 분기는 그 앞에서 return 한다.** 취소된 초대권은 QR 자리만 비운 채
  // 히어로·공유·입장일까지 멀쩡한 화면을 그리고, 회전 QR 이 30초 뒤 갱신에 실패해
  // 「QR 갱신 중… 네트워크를 확인해주세요」를 띄웠다.
  // ⟹ **취소를 우리 시스템 고장으로 오독**시킨다. 원래 사고보다 나쁘다.
  //
  // 분기마다 게이트를 붙이는 방식이 틀렸다. 갈림길 **앞**에 한 번 두면
  // 나중에 세 번째 티켓 유형이 생겨도 자동으로 덮인다.
  if (!usability.usable) {
    return (
      <div className="min-h-screen bg-background px-4 py-8">
        <div className="mx-auto max-w-md">
          <Card className="overflow-hidden rounded-[28px]">
            <CardContent className="space-y-6 p-6">
              <div>
                <p className="text-sm uppercase tracking-[0.22em] text-muted-foreground">mobile ticket</p>
                <h1 className="mt-3 text-2xl font-black tracking-[-0.04em]">{String(ticket.eventTitle)}</h1>
              </div>

              <div
                role="status"
                data-testid="ticket-unusable-notice"
                className="rounded-xl border border-destructive/30 bg-destructive/5 p-6 text-center"
              >
                <p className="text-base font-semibold text-foreground">{usability.title}</p>
                <p className="mt-2 text-sm text-muted-foreground">{usability.detail}</p>
              </div>

              <div className="space-y-2 rounded-lg border border-border bg-muted p-5 text-sm">
                <p className="text-foreground">{String(ticket.name)}</p>
                {productName ? <p className="text-muted-foreground">{productName}</p> : null}
                <p className="font-mono text-muted-foreground">{String(ticket.ticketNumber)}</p>
                <p className="text-xs text-muted-foreground">주문번호 {String(ticket.orderNumber)}</p>
              </div>

              <TicketUnusableActions eventSlug={v2Event.slug} />

              <p className="text-center text-xs text-muted-foreground">
                문의{" "}
                <a href="mailto:support@pickket.kr" className="text-primary hover:underline">
                  support@pickket.kr
                </a>
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    );
  }

  // ── F5 초대권 분기 ──────────────────────────────────────────────
  // comp/invitation 판정 근거 = invitations 원장 매칭(F2). 유료·일반 티켓은 원장에 없어 기존 UI 유지.
  const isInvitation = ticket.invitationRecipient != null;

  // ── 대회 라이브 ────────────────────────────────────────────────
  // 🔴 전환 판정은 **여기 한 곳**에서만 한다. 초대권/유료 두 분기가 같은 값을 쓴다 —
  //    각자 적으면 한쪽만 고쳐지고 **초대권 손님이 라이브를 못 본다**.
  // ⚠️ `admittedToday` 가 undefined(v2 구버전)면 `shouldShowLive` 가 false 를 준다 →
  //    지금 그대로 QR. 모르면 안 바꾼다.
  const showLive = shouldShowLive(v2Ticket);
  const liveSchedules = parseV2Schedules((v2Event.content ?? {}).event_schedules);
  const liveScheduleText =
    ticket.startsAt && ticket.endsAt
      ? `${formatDate(String(ticket.startsAt))} ~ ${formatDate(String(ticket.endsAt))}`
      : formatDate(String(ticket.startsAt ?? ""));
  const liveVenueText = ticket.venueName
    ? `${String(ticket.venueName)}${ticket.venueAddress ? ` · ${String(ticket.venueAddress)}` : ""}`
    : ticket.venueAddress
      ? String(ticket.venueAddress)
      : null;

  if (isInvitation) {
    const admission = deriveAdmissionWindow({
      mode: ticket.invitationAdmissionMode as string | null,
      admissionDay: ticket.invitationAdmissionDay as string | null,
      startsAt: ticket.startsAt as string | null,
      endsAt: ticket.endsAt as string | null,
    });

    const scheduleText =
      ticket.startsAt && ticket.endsAt
        ? `${formatDate(String(ticket.startsAt))} ~ ${formatDate(String(ticket.endsAt))}`
        : formatDate(String(ticket.startsAt ?? ""));

    const venueText = ticket.venueName
      ? `${String(ticket.venueName)}${ticket.venueAddress ? ` · ${String(ticket.venueAddress)}` : ""}`
      : ticket.venueAddress
        ? String(ticket.venueAddress)
        : null;

    // 하단 이미지 캐러셀 — 주최자 gallery_images(있으면). 없으면 히어로 1장 폴백.
    const rawGallery = (ticket.galleryImages as Array<{ url?: string } | string> | null) ?? [];
    const galleryImages = rawGallery
      .map((g) => (typeof g === "string" ? g : g?.url))
      .filter((u): u is string => typeof u === "string" && u.length > 0);

    const calendarUrl = `https://www.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(String(ticket.eventTitle))}&dates=${String(ticket.startsAt).replace(/[-:]/g, "").slice(0, 15)}Z/${String(ticket.endsAt).replace(/[-:]/g, "").slice(0, 15)}Z&location=${encodeURIComponent(String(ticket.venueName ?? ""))}&details=${encodeURIComponent(`PICKKET.GO 초대권: ${ticketNumber}`)}`;
    const mapUrl = ticket.venueAddress
      ? `https://map.naver.com/v5/search/${encodeURIComponent(String(ticket.venueAddress))}`
      : ticket.venueName
        ? `https://map.naver.com/v5/search/${encodeURIComponent(String(ticket.venueName))}`
        : null;

    // 🔴 초대권 손님도 갤러리다. 이 갈래를 빼면 초대권 18장이 라이브를 못 본다.
    if (showLive) {
      return (
        <LiveView
          ticketNumber={ticketNumber}
          eventTitle={String(ticket.eventTitle)}
          schedules={liveSchedules}
          ticketPanel={
            <AdmittedTicketPanel
              ticketNumber={ticketNumber}
              eventTitle={String(ticket.eventTitle)}
              attendeeName={String(ticket.invitationRecipient ?? ticket.name ?? "") || null}
              gradeLabel="초대권"
              scheduleText={scheduleText}
              venueText={venueText}
              raffleNumber={ticket.raffleNumber != null ? Number(ticket.raffleNumber) : null}
              // 🔴 초대권 갈래에도 QR 을 넘긴다 — 여기를 빠뜨려 실측에서 QR 이 안 떴다.
              qrImage={usability.usable ? qrImage : null}
              qrAccessToken={inviteAccess || ticketLinkAccess ? inviteToken ?? null : null}
              orderTickets={orderTicketItems}
            />
          }
        />
      );
    }

    return (
      <InvitationTicketView
        ticketNumber={ticketNumber}
        qrImage={qrImage}
        // 🔴 초대권도 딥링크로 들어온다 — 이걸 빼면 접근 교환이 안 돼 QR 갱신이 403 이 되고
        //    허용창을 넘기는 순간 게이트에서 스캔이 거부된다(유료 분기에만 붙였던 누락).
        accessToken={inviteAccess ? inviteToken ?? null : null}
        eventTitle={String(ticket.eventTitle)}
        recipientName={String(ticket.invitationRecipient ?? ticket.name ?? "")}
        gradeLabel="초대권"
        issuedAtText={formatDateTime(ticket.issuedAt as string | null)}
        scheduleText={scheduleText}
        admissionText={admission.label}
        admissionBadge={admission.badge}
        venueText={venueText}
        raffleNumber={ticket.raffleNumber != null ? Number(ticket.raffleNumber) : null}
        heroImageUrl={ticket.heroImageUrl ? String(ticket.heroImageUrl) : null}
        galleryImages={galleryImages}
        calendarUrl={calendarUrl}
        mapUrl={mapUrl}
        design={{
          backgroundColor: design?.backgroundColor,
          textColor: design?.textColor,
          accentColor: design?.accentColor,
          // 레거시 `logoImageUrl` 폴백 — 옛 티켓 디자이너로 저장한 로고도 뜬다.
          logoUrl: resolveTicketLogoUrl(design) ?? undefined,
          headerText: design?.invitationHeaderText,
          showEventName: design?.showEventName,
          showDate: design?.showDate,
          showVenue: design?.showVenue,
          showAttendeeName: design?.showAttendeeName,
          showRaffleNumber: design?.showRaffleNumber,
          showGallery: design?.showGallery,
        }}
      />
    );
  }

  if (showLive) {
    return (
      <LiveView
        ticketNumber={ticketNumber}
        eventTitle={String(ticket.eventTitle)}
        schedules={liveSchedules}
        ticketPanel={
          <AdmittedTicketPanel
            ticketNumber={ticketNumber}
            eventTitle={String(ticket.eventTitle)}
            attendeeName={String(ticket.name ?? "") || null}
            gradeLabel={productName}
            scheduleText={liveScheduleText}
            venueText={liveVenueText}
            raffleNumber={ticket.raffleNumber != null ? Number(ticket.raffleNumber) : null}
            // 🔴 입장 후에도 QR 을 남긴다 — 종일 입장·경품추첨 때 다시 필요하다.
            qrImage={usability.usable ? qrImage : null}
            qrAccessToken={inviteAccess || ticketLinkAccess ? inviteToken ?? null : null}
            orderTickets={orderTicketItems}
          />
        }
      />
    );
  }

  return (
    <div className="min-h-screen bg-background px-4 py-8">
      <div className="mx-auto max-w-md">
        <Card className="overflow-hidden border-border" style={{ backgroundColor: design?.backgroundColor ?? "#FFFFFF", color: design?.textColor ?? "#1A1D2E" }}>
          <div
            className="h-52"
            style={{
              background: ticket.heroImageUrl ? `url(${String(ticket.heroImageUrl)}) center/cover no-repeat` : "linear-gradient(135deg,rgba(108,92,231,0.15),rgba(139,92,246,0.10),rgba(5,150,105,0.08))",
            }}
          />
          <CardContent className="space-y-6 p-6">
            <div>
              <p className="text-sm uppercase tracking-[0.22em] text-primary">mobile ticket</p>
              {design?.showEventName !== false ? <h1 className="mt-3 text-2xl font-black tracking-[-0.04em]">{String(ticket.eventTitle)}</h1> : null}
              {design?.showDate !== false ? <p className="mt-2 text-sm text-muted-foreground">{formatDate(String(ticket.startsAt))} ~ {formatDate(String(ticket.endsAt))}</p> : null}
              {design?.showVenue !== false ? <p className="mt-1 text-sm text-muted-foreground">{String(ticket.venueName ?? "장소 미정")} {ticket.venueAddress ? `· ${String(ticket.venueAddress)}` : ""}</p> : null}
            </div>

            {/* 여기 도달했다면 `usability.usable` 이다 — 위 갈림길 앞 early return 이 보장한다. */}
            <div className="rounded-xl bg-card p-5">
              <RotatingTicketQR
                ticketNumber={ticketNumber}
                initialImage={qrImage}
                // 딥링크로 들어온 경우에만 교환한다(세션·조회쿠키 사용자는 이미 접근권이 있다).
                accessToken={inviteAccess || ticketLinkAccess ? inviteToken ?? null : null}
              />
            </div>

            {/*
              🔴 「N장 샀는데 QR 이 하나만 보인다」 (2026-08-19, 대회 D-1 실측 54명·64장).

              여기 도달했다는 것은 위 접근 판정을 통과했다는 뜻이다 — 딥링크 토큰
              (=구매자 본인)·세션·조회쿠키 중 하나. 그 사람에게 **같은 주문**의 티켓을
              보여주는 것은 새 권한을 여는 게 아니다.

              ⚠️ 초대권은 v2 가 목록에서 이미 뺀다(장마다 주인이 다르다). 여기서 또
                 거르지 않는 이유는, 경계를 두 곳에 두면 언젠가 한쪽만 고치기 때문이다.
            */}
            <OrderTicketSwitcher items={orderTicketItems} />

            <div className="border-t border-dashed border-border" />

            <div className="space-y-2 rounded-lg border border-border bg-muted p-5 text-sm">
              {design?.showAttendeeName !== false ? <p className="text-foreground">{String(ticket.name)}</p> : null}
              {design?.showProductName !== false && productName ? <p className="text-muted-foreground">{productName}</p> : null}
              <p className="font-mono text-muted-foreground">{String(ticket.ticketNumber)}</p>
              <p className="text-xs text-muted-foreground">주문번호 {String(ticket.orderNumber)}</p>
              {/*
                🔴 2026-07-31 — 경품번호가 **초대권 화면에만** 있었다.
                v2 는 `raffle_enabled` 이벤트의 모든 티켓에 번호를 부여하고 go 로도
                미러링되는데(실측: 유료 티켓 TKT-95A349DA8920 → 205108), **돈 낸 구매자만
                자기 번호를 볼 수 없었다.** 현장 추첨은 체크인한 사람 풀에서 뽑으므로
                번호를 모르면 당첨 발표를 봐도 본인인지 확인할 수 없다.
                초대권 화면(`invitation-ticket-view.tsx`)과 **같은 표시 조건**을 쓴다.
              */}
              {design?.showRaffleNumber !== false && ticket.raffleNumber != null ? (
                <div className="mt-3 flex items-center justify-between gap-3 border-t border-dashed border-border pt-3">
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <Trophy className="size-4 text-primary" />
                    경품번호
                  </span>
                  <span className="font-mono text-lg font-black tracking-wider text-primary">
                    {String(ticket.raffleNumber)}
                  </span>
                </div>
              ) : null}
            </div>

            {/*
              🔴 PDF 내려받기 제거 (대표 결정, 2026-07-29).
              PDF 템플릿에는 **QR 이 없다** — "QR 코드 영역" 문구와 티켓번호 텍스트뿐이라
              그 문서로는 입장할 수 없다. 그런데 이름이 "티켓 PDF" 라 손님이 받아서
              인쇄해 오거나 그것만 들고 게이트에 서면 **입장이 막힌다.**
              입장 수단으로 오인될 물건을 티켓 화면에 두지 않는다.
              (라우트 `/api/tickets/[n]/pdf` 는 남겨둔다 — 운영/문서 용도가 정리되면 그때 판단.)
            */}
            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" size="sm" asChild>
                <Link
                  href={`https://www.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(String(ticket.eventTitle))}&dates=${String(ticket.startsAt).replace(/[-:]/g, "").slice(0, 15)}Z/${String(ticket.endsAt).replace(/[-:]/g, "").slice(0, 15)}Z&location=${encodeURIComponent(String(ticket.venueName ?? ""))}&details=${encodeURIComponent(`PICKKET.GO 티켓: ${ticketNumber}`)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <CalendarPlus className="mr-1.5 size-3.5" />
                  캘린더
                </Link>
              </Button>
              <Button variant="outline" size="sm" asChild>
                <Link
                  href={ticket.venueAddress
                    ? `https://map.naver.com/v5/search/${encodeURIComponent(String(ticket.venueAddress))}`
                    : `https://map.naver.com/v5/search/${encodeURIComponent(String(ticket.venueName ?? ""))}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <MapPin className="mr-1.5 size-3.5" />
                  길찾기
                </Link>
              </Button>
            </div>

            {/* 이미 환불·만료·양도된 티켓엔 이 화면 자체가 안 뜬다(갈림길 앞 early return). */}
            <div className="flex gap-3">
              <Button asChild className="flex-1">
                <Link href={`/my-tickets/${ticketNumber}/refund`}>
                  <RefreshCcw className="mr-2 size-4" />
                  환불 신청
                </Link>
              </Button>
            </div>

            <div className="rounded-[24px] border border-border bg-muted p-4 text-sm text-muted-foreground">
              <p className="font-semibold text-foreground">입장 안내</p>
              <ul className="mt-2 space-y-1.5">
                <li>• QR 코드를 스태프에게 보여주세요</li>
                <li>• 체크인은 이벤트 시작 30분 전부터 가능합니다</li>
                <li>• 분실 시 이 페이지에서 다시 확인 가능합니다</li>
              </ul>
              <p className="mt-3 text-xs">
                도움이 필요하신가요?{" "}
                <a href="mailto:support@pickket.kr" className="text-primary hover:underline">support@pickket.kr</a>
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
