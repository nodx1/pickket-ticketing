/**
 * 카카오 알림톡 **승인 템플릿 본문** — 순수 모듈(서버 의존 0).
 *
 * 🔴 왜 발송 코드에서 분리했나
 * 초대권 화면의 미리보기(클라이언트 컴포넌트)가 이 문안을 그대로 렌더해야 한다.
 * 그런데 발송 모듈(`alimtalk.ts`)은 `ncp/client` → `node:crypto` 를 끌고 오므로,
 * 클라이언트에서 import 하면 **서버 전용 코드가 브라우저 번들 경로에 올라온다.**
 * 지금은 트리셰이킹이 걷어내지만(빌드 산출물 실측), 모듈 최상위에 부수효과가 하나만
 * 생겨도 무너진다 — **정확성을 트리셰이킹에 의존하지 않는다.**
 *
 * 🔴 그리고 미리보기와 실제 발송은 **같은 함수**를 써야 한다. 문안을 복붙하면 둘이
 *    갈라지고 미리보기가 거짓이 된다. 카카오 승인본은 한 글자만 달라도 전달이
 *    거부되므로(실측 3027) 화면에서 본 것이 곧 나갈 것이어야 한다.
 */

export const ALIMTALK_TEMPLATES = {
  PURCHASE_CONFIRM: {
    // 🔴 카카오 승인본과 **정확히** 일치해야 한다(띄어쓰기·줄바꿈 포함). 어긋나면
    //    접수는 A000 인데 전달이 거부된다(실측 3027). 승인 문구가 바뀌면 여기도 바꾼다.
    //    옛 본문은 본문에 URL 이 박혀 있어 검수 반려 형태였고, 코드도 언더바가 있어
    //    등록 코드(PICKKETPURCHASE001)와 달랐다 — 둘 다 교정.
    code: "PICKKETPURCHASE001",
    title: "티켓발급안내",
    body: (vars: {
      eventTitle: string;
      eventDate: string;
      ticketName: string;
      ticketCount: number;
      orderNumber: string;
      venueName: string;
    }) =>
      `[티켓] ${vars.eventTitle} 예매 완료\n\n` +
      `안녕하세요.\n` +
      `${vars.eventTitle} 티켓 서비스 '피켓'입니다.\n\n` +
      `고객님께서 결제하신 ${vars.eventTitle} 티켓이 발급되었습니다.\n\n` +
      `▶ 대회일자 : ${vars.eventDate}\n` +
      `▶ 대회명 : ${vars.eventTitle}\n` +
      `▶ 티켓명 : ${vars.ticketName}\n` +
      `▶ 매수 : ${vars.ticketCount}매\n` +
      `▶ 주문번호 : ${vars.orderNumber}\n\n` +
      `※ 장소 : ${vars.venueName}\n\n` +
      `※ 입장안내\n` +
      `행사장 입구에서 아래 '모바일 티켓'을 눌러\n` +
      `안내페이지에 모바일 티켓(QR)을 보여주시기 바랍니다.\n\n` +
      `※ 캡쳐된 모바일 티켓은 입장이 제한되오니 주의하여 주시기 바랍니다.`,
  },
  REMINDER_D7: {
    code: "PICKKET_REMIND_D7",
    title: "D-7 리마인더",
    body: (vars: { buyerName: string; eventTitle: string; eventDate: string; venueName: string }) =>
      `[PICKKET] ${vars.eventTitle}\n\n` +
      `${vars.buyerName}님, 공연까지 7일 남았습니다!\n` +
      `일시: ${vars.eventDate}\n` +
      `장소: ${vars.venueName}\n\n` +
      `내 티켓 확인: https://go.pickket.kr/my-tickets`,
  },
  REMINDER_D1: {
    code: "PICKKET_REMIND_D1",
    title: "D-1 리마인더",
    body: (vars: { buyerName: string; eventTitle: string; eventDate: string; venueName: string }) =>
      `[PICKKET] ${vars.eventTitle}\n\n` +
      `${vars.buyerName}님, 내일입니다!\n` +
      `일시: ${vars.eventDate}\n` +
      `장소: ${vars.venueName}\n` +
      `체크인: 모바일 티켓의 QR 코드를 준비해주세요.\n\n` +
      `내 티켓: https://go.pickket.kr/my-tickets`,
  },
  /**
   * 취소·환불 완료 안내 — **정보성**. 광고성 금지.
   *
   * 🔴 옛 문안은 등록 자체가 불가능했다. 코드에 언더바가 있었고(`PICKKET_CANCEL_001`),
   *    NCP 알림톡 템플릿 코드는 **영문+숫자만 허용**한다 — `PICKKETPURCHASE001` 이 같은
   *    이유로 이미 한 번 교정된 이력이 있다(위 PURCHASE_CONFIRM 주석). 즉 환불완료
   *    알림톡은 **한 번도 등록된 적이 없다.**
   *
   * 본문은 검수를 통과한 두 템플릿(PURCHASE·INVITE)과 같은 포맷으로 맞춘다 —
   * 발신주체 명시 + "고객님께서 요청하신" 수신맥락 + ▶구조화 정보 + ※안내.
   * 🔴 **본문에 URL 을 넣지 않는다** — 인라인 URL 이 과거 반려 형태였다.
   *
   * ⚠️ 카카오 승인본과 **한 글자도 달라선 안 된다.** 심사 중 문구가 수정되면
   *    그 결과를 여기 그대로 반영해야 한다(어긋나면 접수 A000·전달 거부 3027).
   */
  CANCEL_CONFIRM: {
    code: "PICKKETCANCEL001",
    // 콘솔 등록값과 일치. NCP 제목 필드는 **공백과 `/` 를 거부**한다
    //   (허용: 한글·영문·숫자·#!&?-_.() — 공백은 목록에 없다).
    title: "취소환불완료안내",
    body: (vars: { eventTitle: string; orderNumber: string; refundAmount: string }) =>
      `[취소] ${vars.eventTitle} 취소 완료\n\n` +
      `안녕하세요.\n` +
      `${vars.eventTitle} 티켓 서비스 '피켓'입니다.\n\n` +
      `고객님께서 요청하신 티켓 취소가 완료되었습니다.\n\n` +
      `▶ 대회명 : ${vars.eventTitle}\n` +
      `▶ 주문번호 : ${vars.orderNumber}\n` +
      `▶ 환불금액 : ${vars.refundAmount}\n\n` +
      `※ 환불은 결제하신 수단에 따라 3~5영업일이 소요될 수 있습니다.\n\n` +
      `※ 카드 결제는 카드사 정산 일정에 따라 취소 반영 시점이 다를 수 있습니다.`,
  },
  CHECKIN_QR: {
    code: "PICKKET_CHECKIN_001",
    title: "체크인 안내",
    body: (vars: { buyerName: string; eventTitle: string; ticketUrl: string }) =>
      `[PICKKET] ${vars.eventTitle}\n\n` +
      `${vars.buyerName}님, 아래 링크에서 QR 코드를 확인하세요.\n` +
      `${vars.ticketUrl}\n\n` +
      `입장 시 화면의 QR 코드를 제시해주세요.`,
  },
  /**
   * F2 초대권 발급 안내 — **정보성(발권 완료) 톤**. 광고성 금지.
   *
   * 2026-07 검수 반려 대응: 작년 실제 발송·승인된 초대권 문안(발신주체 명시 + "고객님께서 요청하신"
   * 수신맥락 + ▶구조화 정보 + ※안내/제한 고지) 포맷으로 재작성. 링크는 본문 인라인 URL 이 아니라
   * '모바일 티켓' 웹링크 **버튼**으로 전달한다(호출부에서 buttons 구성). templateCode 는 상수 —
   * 실제 카카오 콘솔 등록·재심사는 대표 몫이며, 승인 본문/변수가 이 문자열과 정확히 일치해야 발송된다.
   * 변수: eventTitle(대회명)·eventDate(대회일자)·venueName(장소). inviteUrl 은 버튼 링크로 분리.
   */
  INVITATION_ISSUED: {
    // NCP 알림톡 템플릿 코드는 영문+숫자만 허용(언더바 불가) → 콘솔 등록 코드와 정확히 일치해야 발송됨.
    code: "PICKKETINVITE001",
    title: "초대권 발급 안내",
    body: (vars: {
      eventTitle: string;
      eventDate: string;
      venueName: string;
    }) =>
      `[초대권] ${vars.eventTitle} 초대권\n\n` +
      `안녕하세요.\n` +
      `${vars.eventTitle} 초대권 서비스 '피켓'입니다.\n\n` +
      `고객님께서 요청하신 ${vars.eventTitle} 초대권이 도착했습니다.\n\n` +
      `▶ 대회일자 : ${vars.eventDate}\n` +
      `▶ 대회명 : ${vars.eventTitle}\n` +
      `▶ 티켓명 : 모바일 초대권\n\n` +
      `※ 대회장소 : ${vars.venueName}\n\n` +
      `※ 입장안내\n` +
      `대회장 매표소에서 아래 '모바일 티켓'을 눌러\n` +
      `안내페이지에 모바일 초대권(QR)을 보여주시기 바랍니다.\n\n` +
      `※ 본 초대권의 사용은 대회기간 중 1회에 한합니다.\n\n` +
      `※ 캡쳐된 모바일 초대권은 입장이 제한되오니 주의하여 주시기 바랍니다.`,
  },
} as const;

/**
 * 🔴 NCP 알림톡 템플릿 코드는 **영문+숫자만** 받는다. 언더바가 든 코드는 콘솔에
 * 등록하는 것 자체가 불가능하다 — 즉 그 템플릿은 **존재한 적이 없다**.
 *
 * (2026-08-01 실측: `PICKKET_CANCEL_001` 이 등록 거부돼 `PICKKETCANCEL001` 로 다시
 *  등록됐다. `PICKKETPURCHASE001` 도 같은 이유로 한 번 교정된 이력이 있다.)
 */
const NCP_CODE_PATTERN = /^[A-Za-z0-9]+$/;

/** 이 코드가 NCP 콘솔에 등록될 수 있는 형식인가. */
export function isNcpRegistrableCode(code: string): boolean {
  return NCP_CODE_PATTERN.test(code);
}

/**
 * **주최자가 손으로 골라 보낼 수 있는** 템플릿.
 *
 * ## 🔴 왜 목록을 따로 두나
 * 레지스트리에 문안이 있다고 발송할 수 있는 게 아니다. 카카오 **승인**까지 받은 것만
 * 나간다. 승인 안 된 것을 화면에 두면 주최자는 고르고, 보내고, 실패한다 — 그 사이
 * 수신자는 아무것도 못 받고 주최자는 이유를 모른다.
 *
 * 2026-08-04 실측: 드롭다운 5개 중 **나갈 수 있는 것이 0개**였다(2개는 코드 오타,
 * 3개는 언더바라 애초에 등록 불가). 그래서 목록을 여기서 만든다 — 화면이 문자열을
 * 손으로 두 번 적지 않는다.
 *
 * ⚠️ 미등록 템플릿을 **레지스트리에서 지우지는 않는다.** 승인되면 되살릴 문안이다.
 *    여기 키만 추가하면 화면에 다시 뜬다.
 */
export const MANUAL_SEND_TEMPLATE_KEYS = [
  "PURCHASE_CONFIRM",
  "CANCEL_CONFIRM",
  "INVITATION_ISSUED",
] as const satisfies ReadonlyArray<keyof typeof ALIMTALK_TEMPLATES>;

export interface ManualSendTemplateOption {
  code: string;
  label: string;
}

/**
 * 수동 발송 드롭다운에 띄울 선택지.
 *
 * ⚠️ 등록 불가 형식(언더바)은 목록에 넣어도 **여기서 걸러진다**. 실수로 키를 추가해도
 *    막다른 선택지가 화면에 뜨지 않는 것이 이 필터의 목적이다.
 */
export function manualSendTemplateOptions(): ManualSendTemplateOption[] {
  return MANUAL_SEND_TEMPLATE_KEYS.map((key) => ALIMTALK_TEMPLATES[key])
    .filter((t) => isNcpRegistrableCode(t.code))
    .map((t) => ({ code: t.code, label: t.title }));
}
