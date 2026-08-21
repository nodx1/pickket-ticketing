import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 🔴 QR 렌더가 **상태 게이트를 반드시 거치게** 고정한다 (2026-08-01 실사고).
 *
 * ## 무슨 일이 있었나
 * 환불을 마친 구매자에게 티켓 화면의 QR 이 그대로 보였다. 페이지가 `<RotatingTicketQR>`
 * 을 **조건 없이** 렌더했기 때문이다. 알림톡 딥링크는 이미 막혀 있었고
 * (`ticket-link-token.ts` 의 열람 허용 = active·used), 뚫려 있던 건 **이름·전화로 조회한
 * 경로** — 상태 검사가 없었다. 하필 환불 직후엔 그 쿠키가 살아 있어서,
 * **환불한 사람이 가장 확실하게 보는 화면**이 그 경로였다.
 *
 * ## 🔴 1차 수정이 반쪽이었다 (페이블 적대검수)
 * 처음엔 **유료 분기 안에만** 게이트를 붙였다. 그런데 초대권(comp)은 그 앞에서
 * `return <InvitationTicketView>` 로 빠진다. 취소된 초대권은 QR 자리만 빈 채
 * 히어로·공유·입장일까지 멀쩡한 화면을 그리고, 회전 QR 이 30초 뒤 갱신에 실패해
 * 「QR 갱신 중… 네트워크를 확인해주세요」를 띄웠다 —
 * **취소를 우리 시스템 고장으로 오독**시킨다. 원래 사고보다 나쁘다.
 *
 * ⟹ 분기마다 붙이는 방식을 버리고 **갈림길 앞 early return** 하나로 바꿨다.
 *    세 번째 티켓 유형이 생겨도 자동으로 덮인다.
 *
 * ## ⚠️ 이 가드의 한계 (정직하게 적어 둔다)
 * 소스를 문자열로 훑으므로 우회 가능하다. 페이블이 실증한 형태:
 *
 *     const usability = { ...resolveTicketUsability(ticket.status), usable: true };
 *
 * 이 한 줄이면 가드가 전부 통과한다. 그래서 **판정 위치**만이 아니라 **판정 값의 출처**도
 * 함께 본다(아래 `직접 대입` 검사). 그래도 완전하지 않다 —
 * 진짜 방어선은 `usability.test.ts` 의 상태별 판정과 서버측 `/qr` 라우트
 * (`artifact-context.ts` 가 cancelled/expired 를 404 로 던진다)다.
 */
const PAGE = path.join(process.cwd(), "src/app/(public)/tickets/[ticketNumber]/page.tsx");
const LIST = path.join(process.cwd(), "src/app/(public)/my-tickets/page.tsx");

function stripComments(src: string): string {
  return src
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, "") // JSX 주석
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("티켓 상세 — QR 상태 게이트", () => {
  const code = stripComments(readFileSync(PAGE, "utf8"));

  it("🔴 판정을 단일 출처에서 **직접** 받는다 — 스프레드로 덮어쓰지 않는다", () => {
    expect(code).toMatch(/const usability = resolveTicketUsability\(ticket\.status\);/);
    // `{ ...resolveTicketUsability(...), usable: true }` 형태 차단.
    expect(
      code,
      "판정 결과를 스프레드로 재구성하면 `usable` 을 덮어쓸 수 있다(tsc 도 못 잡는다)",
    ).not.toMatch(/\.\.\.resolveTicketUsability/);
    expect(code, "`usable` 을 직접 대입하지 말 것").not.toMatch(/usable:\s*(true|false)/);
  });

  it("🔴 초대권 분기 **앞**에서 차단한다 — 분기마다 붙이면 새 분기가 샌다", () => {
    const gateAt = code.indexOf("if (!usability.usable)");
    const invitationAt = code.indexOf("const isInvitation");
    const qrAt = code.indexOf("<RotatingTicketQR");
    expect(gateAt, "`if (!usability.usable)` early return 이 없다").toBeGreaterThan(0);
    expect(invitationAt, "초대권 분기를 못 찾았다 — 이 가드가 헛돈다").toBeGreaterThan(0);
    expect(
      gateAt,
      "게이트가 초대권 분기보다 뒤에 있다. 취소된 초대권이 QR 자리만 빈 채 " +
        "멀쩡한 화면으로 렌더되고, 회전 QR 갱신 실패가 '네트워크 오류' 로 표시된다.",
    ).toBeLessThan(invitationAt);
    expect(gateAt, "게이트가 QR 렌더보다 뒤에 있다").toBeLessThan(qrAt);
  });

  it("🔴 못 쓰는 티켓이면 QR 을 **생성조차** 하지 않는다 — 렌더에서만 가리면 응답에 실려 나간다", () => {
    // 서버 컴포넌트다. 가려도 페이로드에 QR data URL 이 들어가면 개발자도구로 꺼내 쓴다.
    expect(code).toMatch(/usability\.usable \? generateDynamicQRPayload\(ticketNumber\) : ""/);
    expect(code).toMatch(/usability\.usable \? await generateQRDataURL\(initialQrPayload\) : ""/);
  });

  it("차단 화면이 이유와 다음 행동을 준다 — 빈 자리는 '고장' 으로 읽힌다", () => {
    expect(code).toMatch(/data-testid="ticket-unusable-notice"/);
    expect(code).toMatch(/\{usability\.title\}/);
    expect(code).toMatch(/\{usability\.detail\}/);
    // 차단 화면에 QR 컴포넌트가 섞여 들어가지 않았는지.
    const gateAt = code.indexOf("if (!usability.usable)");
    const noticeEnd = code.indexOf("const isInvitation");
    expect(code.slice(gateAt, noticeEnd)).not.toMatch(/<RotatingTicketQR/);
  });

  it("차단 화면은 티켓을 식별할 수 있게 한다 — 문의할 때 필요하다", () => {
    const gateAt = code.indexOf("if (!usability.usable)");
    const block = code.slice(gateAt, code.indexOf("const isInvitation"));
    expect(block).toMatch(/ticket\.ticketNumber/);
    expect(block).toMatch(/ticket\.orderNumber/);
  });
});

describe("티켓 목록 — 상태 라벨", () => {
  const code = stripComments(readFileSync(LIST, "utf8"));

  it("🔴 원시 상태값을 그대로 찍지 않는다 — 구매자에게 「cancelled」 가 보였다", () => {
    expect(
      code,
      "`{ticket.status}` 를 그대로 렌더하면 영문 원문이 노출된다. " +
        "`ticketStatusLabel()` 을 쓸 것.",
    ).not.toMatch(/:\s*ticket\.status\s*\}/);
  });

  it("라벨을 단일 출처에서 가져온다", () => {
    expect(code).toMatch(/ticketStatusLabel\(ticket\.status\)/);
  });

  it("못 쓰는 티켓은 배지 색으로도 구분된다", () => {
    expect(code).toMatch(/resolveTicketUsability\(ticket\.status\)\.usable/);
  });
});

/**
 * 🔴 **상태 고지 접근** — 취소된 티켓에 신원확인을 시키지 않는다 (2026-08-01 대표 제보).
 *
 * 종전엔 환불한 구매자가 알림톡 버튼을 누르면 이 여정으로 떠밀렸다:
 *
 *     알림톡 → "취소·양도되었거나 기간이 지난 티켓입니다"
 *            → 이메일·전화 입력 → 매직링크 메일 → 클릭 → 목록(15분 쿠키)
 *
 * **한 줄을 알려주려고 본인확인을 시킨 것**이다. 자기 알림톡으로 들어온 사람인데도.
 * 그 끝에 쿠키가 만료됐거나 기기가 다르면 아무것도 못 보고 끝난다(실사용에서 그렇게 됐다).
 *
 * ⚠️ 이 완화가 **QR 을 여는 쪽으로 새면 안 된다.** 아래 세 조건이 그걸 지킨다.
 */
describe("상태 고지 접근 — 취소 티켓에 본인확인을 시키지 않는다", () => {
  const code = stripComments(readFileSync(PAGE, "utf8"));

  it("토큰이 이 티켓 것이면 상태는 그 자리에서 알려준다", () => {
    expect(code).toMatch(/const statusOnlyAccess =/);
    expect(code).toMatch(/ticketLinkTokenMatches\(\{ token: inviteToken, ticketNumber \}\)/);
    expect(code).toMatch(/!statusOnlyAccess/); // 접근 게이트에 실제로 연결됐는지
  });

  it("🔴 못 쓰는 티켓일 때만 연다 — 없으면 pending 이 딥링크로 통째로 열린다", () => {
    // `VIEWABLE_STATUSES={active,used}` 와 `USABLE={pending,active,used}` 가 다르다.
    // 이 조건이 빠지면 무통장 미확정(pending)이 상태고지 경로로 들어와 QR 까지 받는다.
    expect(code).toMatch(/const statusOnlyAccess =[\s\S]{0,200}?!usability\.usable/);
  });

  it("🔴 초대권은 포함하지 않는다 — 회수는 의미가 다르다", () => {
    expect(code).toMatch(/const statusOnlyAccess =[\s\S]{0,200}?!invitation/);
  });

  it("usability 를 접근 판정보다 먼저 계산한다 — 아니면 statusOnlyAccess 가 못 쓴다", () => {
    const usabilityAt = code.indexOf("const usability = resolveTicketUsability");
    const gateAt = code.indexOf("const statusOnlyAccess");
    expect(usabilityAt).toBeGreaterThan(0);
    expect(usabilityAt).toBeLessThan(gateAt);
  });
});
