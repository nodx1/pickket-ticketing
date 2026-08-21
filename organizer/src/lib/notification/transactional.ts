/**
 * 트랜잭션(정보성) 알림 — 구매자에게 즉시 발송. 수신동의 불요(정보통신망법 정보성 예외).
 * best-effort: 발송 실패가 주문/환불 흐름을 깨지 않도록 항상 catch. 이메일+알림톡 병행.
 * 알림톡 템플릿(PICKKET_*)은 카카오 승인 후 동작(미승인/미설정 시 dispatch 가 실패 기록).
 */
import { dispatchOne } from "./dispatch";
import { ALIMTALK_TEMPLATES, type AlimtalkButton } from "./alimtalk";
import { buildTicketLinkUrl, createTicketLinkToken } from "@/lib/ticket-link-token";
import { renderTransactionalEmail, type EmailAction, type EmailContent } from "./email-layout";

/** 딥링크 origin — invitations.ts 와 같은 규칙(환경변수 없으면 운영 도메인). */
const APP_ORIGIN = () =>
  (process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://go.pickket.kr").replace(/\/$/, "");
import { logger } from "@/lib/logger";

/**
 * 알림톡 버튼 → 이메일 버튼.
 *
 * 🔴 **이 변환이 배선의 핵심이다** (2026-08-01 실사고). 종전엔 `buttons` 를 **카카오에만**
 *    넘겼다. 그런데 본문은 알림톡 승인본을 그대로 재활용해 *"아래 '모바일 티켓'을 눌러"*
 *    라고 말한다 — **이메일에는 누를 것이 없었다.** 알림톡 받은 사람은 티켓에 도달하고,
 *    이메일만 받은 사람은 도달하지 못했다. 메일 발신이 열리면서 실제로 그런 메일이 나갔다.
 *
 * ⚠️ 반대 방향은 성립하지 않는다. 이메일 버튼을 카카오로 되돌려 보내면 **승인 템플릿에
 *    없는 버튼**이 붙어 전달이 거부된다(3027). 그래서 카카오→이메일 **한 방향**만 만든다.
 */
function buttonsToActions(buttons?: AlimtalkButton[]): EmailAction[] {
  return (buttons ?? [])
    .map((b) => ({ label: b.name, url: b.linkMobile || b.linkPc || "" }))
    .filter((a) => Boolean(a.url));
}

export interface FanoutResult {
  attempted: number; // 실제 시도한 채널 수(연락처 있는 채널)
  failed: number; // 발송 실패(예외 또는 status='failed'). skipped(수신거부·미동의)는 실패 아님.
}

/**
 * 채널 병행 발송.
 *
 * ⚠️ **본문이 채널마다 다르다.** `text` 는 카카오 승인본이라 한 글자도 못 바꾸고,
 *    이메일은 승인과 무관하므로 `email` 로 받은 구조를 전용 레이아웃으로 그린다.
 *    같은 문자열을 두 채널에 재활용하던 것이 `▶` 기호가 메일에 실리던 원인이다.
 */
async function fanout(
  accountId: string,
  contacts: { email?: string | null; phone?: string | null },
  emailSubject: string,
  text: string,
  templateCode: string,
  buttons?: AlimtalkButton[],
  email?: {
    content: EmailContent;
    /** 이메일 전용 버튼. 생략하면 알림톡 버튼을 그대로 옮긴다. */
    actions?: EmailAction[];
  },
): Promise<FanoutResult> {
  const jobs: Array<Promise<Awaited<ReturnType<typeof dispatchOne>>>> = [];
  if (contacts.email) {
    const actions = email?.actions ?? buttonsToActions(buttons);
    const body = email
      ? renderTransactionalEmail(email.content, actions)
      : // 구조를 안 넘긴 호출부가 생겨도 링크만은 잃지 않게 한다.
        renderTransactionalEmail({ heading: emailSubject, paragraphs: text.split("\n\n") }, actions);
    jobs.push(
      dispatchOne({ accountId, channel: "email", messageType: "informational", to: contacts.email, subject: emailSubject, body }),
    );
  }
  if (contacts.phone) {
    jobs.push(
      dispatchOne({ accountId, channel: "kakao", messageType: "informational", to: contacts.phone, body: text, templateCode, buttons }),
    );
  }
  const results = await Promise.allSettled(jobs);
  // H-02: dispatchOne 은 실패해도 reject 하지 않고 {status:"failed"} 를 반환한다 —
  // rejected 만 검사하면 실제 발송 실패가 조용히 소실된다. fulfilled 값의 status 도 집계.
  let failed = 0;
  results.forEach((r) => {
    if (r.status === "rejected") {
      failed += 1;
      logger.warn("트랜잭션 알림 발송 예외(무시)", { error: String(r.reason) });
    } else if (r.value.status === "failed") {
      failed += 1;
      logger.warn("트랜잭션 알림 발송 실패", { accountId, error: r.value.error });
    } else if (r.value.status === "skipped") {
      logger.info("트랜잭션 알림 발송 스킵", { accountId, reason: r.value.reason });
    }
  });
  return { attempted: results.length, failed };
}

/**
 * 구매완료 알림 — 티켓 딥링크 버튼을 함께 싣는다.
 *
 * 🔴 `ticketNumber` 가 없으면 버튼 없이 나간다. 그 경우 구매자는 링크를 눌러도
 *    본인확인 화면으로 튕긴다(세션·조회쿠키가 없으므로). 승인 템플릿에 버튼이
 *    있는 한 **버튼 없는 발송은 카카오가 전달을 거부**하기도 한다(실측 3027).
 *    호출측이 티켓번호를 넘기도록 하고, 없으면 로그로 드러낸다.
 */
export async function notifyPurchaseConfirm(p: {
  accountId: string;
  email?: string | null;
  phone?: string | null;
  buyerName: string;
  eventTitle: string;
  orderNumber: string;
  ticketCount: number;
  eventDate: string;
  ticketName?: string | null;
  venueName?: string | null;
  /** 대표 티켓번호 — 딥링크 버튼 대상(주문에 여러 장이면 첫 장). */
  ticketNumber?: string | null;
  /** 링크 만료(epoch ms). 행사 종료 + 1일을 넘기는 게 정석. */
  linkExpiresAt?: number;
}): Promise<FanoutResult> {
  const tpl = ALIMTALK_TEMPLATES.PURCHASE_CONFIRM;
  const text = tpl.body({
    eventTitle: p.eventTitle,
    eventDate: p.eventDate,
    ticketName: p.ticketName ?? "모바일 티켓",
    ticketCount: p.ticketCount,
    orderNumber: p.orderNumber,
    venueName: p.venueName ?? "-",
  });

  let buttons: AlimtalkButton[] | undefined;
  if (p.ticketNumber) {
    const url = buildTicketLinkUrl({
      origin: APP_ORIGIN(),
      ticketNumber: p.ticketNumber,
      token: createTicketLinkToken({
        ticketNumber: p.ticketNumber,
        expiresAt: p.linkExpiresAt,
      }),
    });
    buttons = [{ type: "WL", name: "모바일 티켓", linkMobile: url, linkPc: url }];
  } else {
    logger.warn("구매완료 알림에 티켓번호가 없어 딥링크 버튼을 넣지 못했습니다", {
      accountId: p.accountId,
      orderNumber: p.orderNumber,
    });
  }

  // 🔴 버튼 유무에 따라 안내 문구가 달라야 한다. 버튼이 없는데 "위 버튼을 눌러" 라고 쓰면
  //    2026-08-01 실사고와 **똑같은 메일**이 된다(누를 것이 없는데 누르라고 하는 메일).
  const hasTicketLink = Boolean(buttons?.length);
  const ticketLine = `${p.ticketName ?? "모바일 티켓"} ${p.ticketCount}매`;
  return fanout(p.accountId, p, `[피켓] 예매 완료 · ${p.eventTitle}`, text, tpl.code, buttons, {
    content: {
      // 제목이 이미 "예매 완료 · 행사명" 이라, 미리보기에는 **제목에 없는 것**을 준다.
      preview: [p.eventDate, p.venueName, ticketLine].filter(Boolean).join(" · "),
      heading: "예매가 완료되었습니다",
      subheading: p.eventTitle,
      rows: [
        // ⚠️ 라벨은 알림톡의 '대회일자·대회명' 을 따르지 않는다 — 승인본은 골프대회 기준이고,
        //    이 메일은 공연·전시에도 나간다. 이메일은 승인과 무관하므로 중립어를 쓴다.
        { label: "일시", value: p.eventDate },
        { label: "장소", value: p.venueName }, // 값이 없으면 줄 자체가 빠진다
        { label: "티켓", value: ticketLine },
        { label: "주문번호", value: p.orderNumber },
      ],
      // 환불·리마인더 메일은 이름을 부르는데 구매완료만 안 부르면 어색하다 — 맞춰 준다.
      intro: [`${p.buyerName}님, 결제가 확인되어 티켓이 발급되었습니다.`],
      paragraphs: [
        hasTicketLink
          ? "행사장 입구에서 위 버튼을 눌러 모바일 티켓(QR)을 보여주세요."
          : "행사장 입구에서 모바일 티켓(QR)을 보여주세요. 티켓은 피켓 '내 티켓'에서 확인할 수 있습니다.",
      ],
      notice: "화면을 캡쳐한 티켓은 입장이 제한됩니다. 반드시 모바일 티켓 화면을 열어 보여주세요.",
    },
  });
}

export async function notifyRefundConfirm(p: {
  accountId: string;
  /** 발송 멱등 표식의 대상. 호출부가 `orders.refund_notified_at` 로 선점한다(마이그 255). */
  orderId?: string;
  email?: string | null;
  phone?: string | null;
  buyerName: string;
  eventTitle: string;
  /** 알림톡 본문의 ▶주문번호. 승인 템플릿 변수라 **비우면 전달이 거부**된다(3027). */
  orderNumber: string;
  refundAmount: string;
}): Promise<FanoutResult> {
  const tpl = ALIMTALK_TEMPLATES.CANCEL_CONFIRM;
  // ⚠️ buyerName 은 알림톡 본문에 안 쓴다(승인 포맷이 "고객님" 호칭). 이메일 content 에만 쓴다.
  const text = tpl.body({ eventTitle: p.eventTitle, orderNumber: p.orderNumber, refundAmount: p.refundAmount });
  return fanout(p.accountId, p, `[피켓] 취소·환불 완료 · ${p.eventTitle}`, text, tpl.code, undefined, {
    content: {
      preview: `환불 금액 ${p.refundAmount} · 결제 수단에 따라 3~5영업일`,
      heading: "취소·환불이 완료되었습니다",
      subheading: p.eventTitle,
      rows: [
        { label: "주문번호", value: p.orderNumber },
        { label: "환불 금액", value: p.refundAmount },
      ],
      intro: [`${p.buyerName}님, 요청하신 취소가 처리되었습니다.`],
      paragraphs: ["환불은 결제 수단에 따라 3~5영업일이 걸릴 수 있습니다."],
    },
  });
}

export async function notifyCheckinQr(p: {
  accountId: string;
  email?: string | null;
  phone?: string | null;
  buyerName: string;
  eventTitle: string;
  ticketUrl: string;
}): Promise<FanoutResult> {
  const tpl = ALIMTALK_TEMPLATES.CHECKIN_QR;
  const text = tpl.body({ buyerName: p.buyerName, eventTitle: p.eventTitle, ticketUrl: p.ticketUrl });
  // ⚠️ `actions` 로만 준다 — `buttons` 로 주면 카카오 승인본에 없는 버튼이 붙어 전달이 거부된다(3027).
  return fanout(p.accountId, p, `[피켓] 입장 안내 · ${p.eventTitle}`, text, tpl.code, undefined, {
    content: {
      preview: "모바일 티켓(QR)을 여기서 열 수 있습니다",
      heading: "입장 안내",
      subheading: p.eventTitle,
      intro: [`${p.buyerName}님, 입장에 쓰실 모바일 티켓입니다.`],
      paragraphs: ["위 버튼을 눌러 QR 코드를 열고 입구에서 보여주세요."],
      notice: "화면을 캡쳐한 티켓은 입장이 제한됩니다.",
    },
    actions: [{ label: "모바일 티켓", url: p.ticketUrl }],
  });
}

export async function notifyReminder(p: {
  accountId: string;
  email?: string | null;
  phone?: string | null;
  buyerName: string;
  eventTitle: string;
  eventDate: string;
  venueName: string;
  type: "D7" | "D1";
}): Promise<FanoutResult> {
  const tpl = p.type === "D7" ? ALIMTALK_TEMPLATES.REMINDER_D7 : ALIMTALK_TEMPLATES.REMINDER_D1;
  const text = tpl.body({ buyerName: p.buyerName, eventTitle: p.eventTitle, eventDate: p.eventDate, venueName: p.venueName });
  // ⚠️ 말머리를 `[피켓]` 으로 통일한다 — 받은편지함에 `[피켓]`·`[PICKKET]` 이 섞여 있었다.
  //    D-7/내일 공연 도 사람 말로 바꾼다("D-7" 은 우리 말이지 구매자 말이 아니다).
  const subj = p.type === "D7" ? `[피켓] 일주일 남았습니다 · ${p.eventTitle}` : `[피켓] 내일입니다 · ${p.eventTitle}`;
  return fanout(p.accountId, p, subj, text, tpl.code, undefined, {
    content: {
      preview: `${p.eventDate} · ${p.venueName}`,
      heading: p.type === "D7" ? "행사가 일주일 남았습니다" : "내일 뵙겠습니다",
      subheading: p.eventTitle,
      rows: [
        { label: "일시", value: p.eventDate },
        { label: "장소", value: p.venueName },
      ],
      intro: [`${p.buyerName}님, 예매하신 행사가 다가왔습니다.`],
      paragraphs: ["미리 모바일 티켓을 확인해 두시면 입장이 빠릅니다."],
    },
    actions: [{ label: "내 티켓 보기", url: `${APP_ORIGIN()}/my-tickets` }],
  });
}
