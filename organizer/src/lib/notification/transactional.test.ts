import { afterEach, describe, expect, it, vi } from "vitest";

// dispatchOne / logger 격리 (hoisted 홀더)
const h = vi.hoisted(() => ({ dispatchOne: vi.fn(), warn: vi.fn(), info: vi.fn() }));
vi.mock("./dispatch", () => ({ dispatchOne: (...a: unknown[]) => h.dispatchOne(...a) }));
vi.mock("@/lib/logger", () => ({ logger: { warn: (...a: unknown[]) => h.warn(...a), info: (...a: unknown[]) => h.info(...a), error: vi.fn() } }));

import { notifyPurchaseConfirm } from "./transactional";

afterEach(() => {
  h.dispatchOne.mockReset();
  h.warn.mockReset();
  h.info.mockReset();
});

/**
 * H-02 회귀: dispatchOne 은 실패해도 reject 하지 않고 {status:"failed"} 를 반환한다.
 * fanout 이 fulfilled 값의 status 를 검사하지 않으면 실제 실패가 조용히 소실된다.
 */
describe("transactional fanout (H-02 실패 전파)", () => {
  const base = {
    accountId: "acc-1",
    email: "buyer@example.com",
    phone: "01012345678",
    buyerName: "홍길동",
    eventTitle: "테스트 공연",
    orderNumber: "PK-1",
    ticketCount: 2,
    eventDate: "2026-08-20",
  };

  it("dispatchOne 이 {status:'failed'} 를 반환하면 실패로 로깅하고 FanoutResult 에 반영한다", async () => {
    h.dispatchOne.mockResolvedValue({ status: "failed", error: "NCP 500" });
    const res = await notifyPurchaseConfirm(base); // 이메일+알림톡 2채널
    const failWarns = h.warn.mock.calls.filter((c) => String(c[0]).includes("발송 실패"));
    expect(failWarns.length).toBeGreaterThanOrEqual(1);
    // 2.5-3: 전 채널 실패 → attempted===failed (리마인더 원장 롤백 판정 근거).
    expect(res.attempted).toBe(2);
    expect(res.failed).toBe(2);
  });

  it("성공 시 실패 로그를 남기지 않고 failed=0", async () => {
    h.dispatchOne.mockResolvedValue({ status: "sent", requestId: "r1" });
    const res = await notifyPurchaseConfirm(base);
    const failWarns = h.warn.mock.calls.filter((c) => String(c[0]).includes("발송 실패"));
    expect(failWarns.length).toBe(0);
    expect(res.failed).toBe(0);
    expect(res.attempted).toBe(2);
  });

  it("스킵(수신거부·미동의)은 실패로 세지 않는다 — 원장 유지 판정", async () => {
    h.dispatchOne.mockResolvedValue({ status: "skipped", reason: "suppressed" });
    const res = await notifyPurchaseConfirm(base);
    expect(res.failed).toBe(0); // 전부 스킵 → failed 0 → 원장 유지
    expect(res.attempted).toBe(2);
  });
});

/**
 * 🔴 구매완료 알림의 '모바일 티켓' 딥링크.
 *
 * 이게 없으면 카톡으로 티켓을 받은 구매자가 **아무도 못 연다** — 세션도 조회쿠키도
 * 없이 들어오므로 본인확인 화면으로 튕기고, 거기 매직링크 메일은 발신주소 미설정으로
 * 나가지 않는다(2026-07-28 실측). 즉 결제는 됐는데 티켓에 닿는 길이 없다.
 */
describe("notifyPurchaseConfirm — 티켓 딥링크 버튼", () => {
  const BASE = {
    accountId: "acc-1",
    phone: "01011112222",
    buyerName: "홍길동",
    eventTitle: "테스트대회",
    orderNumber: "ORD-1",
    ticketCount: 2,
    eventDate: "2026년 8월 20일",
  };

  it("🔴 티켓번호가 있으면 '모바일 티켓' 웹링크 버튼을 싣는다", async () => {
    process.env.SESSION_SIGNING_KEY = "test-signing-key-0123456789abcdef";
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    const { notifyPurchaseConfirm } = await import("./transactional");

    await notifyPurchaseConfirm({ ...BASE, ticketNumber: "TKT-ABCDEF123456" });

    const kakao = h.dispatchOne.mock.calls
      .map(([a]) => a as { channel: string; buttons?: Array<{ name: string; linkMobile: string }> })
      .find((a) => a.channel === "kakao");
    expect(kakao?.buttons?.[0]?.name).toBe("모바일 티켓");
    // 승인 템플릿 링크 형식: /tickets/#{티켓번호}?t=#{토큰}
    expect(kakao?.buttons?.[0]?.linkMobile).toMatch(/\/tickets\/TKT-ABCDEF123456\?t=.+/);
  });

  it("🔴 PC 링크와 모바일 링크가 같다 — 어긋나면 카카오가 전달을 거부한다(3027)", async () => {
    process.env.SESSION_SIGNING_KEY = "test-signing-key-0123456789abcdef";
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    const { notifyPurchaseConfirm } = await import("./transactional");

    await notifyPurchaseConfirm({ ...BASE, ticketNumber: "TKT-ABCDEF123456" });

    const kakao = h.dispatchOne.mock.calls
      .map(([a]) => a as { channel: string; buttons?: Array<{ linkMobile: string; linkPc: string }> })
      .find((a) => a.channel === "kakao");
    expect(kakao?.buttons?.[0]?.linkPc).toBe(kakao?.buttons?.[0]?.linkMobile);
  });

  it("티켓번호가 없으면 버튼 없이 발송하고 경고를 남긴다(조용히 넘기지 않는다)", async () => {
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    const { notifyPurchaseConfirm } = await import("./transactional");

    await notifyPurchaseConfirm({ ...BASE });

    const kakao = h.dispatchOne.mock.calls
      .map(([a]) => a as { channel: string; buttons?: unknown })
      .find((a) => a.channel === "kakao");
    expect(kakao?.buttons).toBeUndefined();
    expect(h.warn).toHaveBeenCalled();
  });

  it("본문은 승인 템플릿 문안을 따른다(본문 인라인 URL 없음 — 검수 반려 사유)", async () => {
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    const { notifyPurchaseConfirm } = await import("./transactional");

    await notifyPurchaseConfirm({ ...BASE, ticketNumber: "TKT-ABCDEF123456" });

    const kakao = h.dispatchOne.mock.calls
      .map(([a]) => a as { channel: string; body: string })
      .find((a) => a.channel === "kakao");
    expect(kakao?.body).toContain("고객님께서 결제하신"); // 수신자 액션 명시(카카오 요구)
    expect(kakao?.body).not.toContain("http"); // 링크는 버튼으로만
  });
});

/**
 * 🔴 이메일에 티켓 링크가 실려야 한다 (2026-08-01 실사고).
 *
 * 종전엔 `buttons` 를 **카카오에만** 넘겼다. 그런데 본문은 알림톡 승인본을 그대로 써서
 * *"행사장 입구에서 아래 '모바일 티켓'을 눌러"* 라고 말한다 — **이메일에는 누를 것이 없었다.**
 * 알림톡 받은 사람은 티켓에 도달하고, 이메일만 받은 사람은 도달하지 못했다.
 * 메일 발신이 처음 열리면서 실제로 그런 메일이 나갔다.
 */
describe("구매완료 이메일 — 티켓 링크", () => {
  const base = {
    accountId: "acc-1",
    email: "buyer@example.com",
    phone: "01011112222",
    buyerName: "구매자",
    eventTitle: "테스트 대회",
    eventDate: "2026. 8. 20.",
    ticketCount: 1,
    orderNumber: "ORD-260801-002",
    venueName: "포천힐스CC",
    ticketNumber: "TKT-ABCDEF",
    // ⚠️ epoch ms 다. `Date` 를 그대로 주면 tsc 가 잡고(TS2345), 토큰의 `e` 에 ISO 문자열이
    //    실려 만료 비교가 무의미해진다. 테스트만 틀렸던 자리 — 2026-08-01 교정.
    linkExpiresAt: new Date("2026-08-24T00:00:00Z").getTime(),
  };

  function emailCall() {
    return h.dispatchOne.mock.calls
      .map((c) => c[0] as { channel: string; body: string })
      .find((a) => a.channel === "email");
  }

  it("🔴 이메일 본문에 티켓 링크가 들어간다 — 없으면 구매자가 티켓에 도달 못 한다", async () => {
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    await notifyPurchaseConfirm(base);
    const email = emailCall();
    expect(email).toBeDefined();
    expect(email!.body).toContain("/tickets/TKT-ABCDEF");
  });

  it("🔴 누를 수 있는 <a> 여야 한다 (텍스트만 있으면 못 누른다)", async () => {
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    await notifyPurchaseConfirm(base);
    expect(emailCall()!.body).toMatch(/<a\s+href="[^"]*\/tickets\/TKT-ABCDEF/);
  });

  it("버튼이 안 눌리는 메일 클라이언트를 위해 URL 원문도 남긴다", async () => {
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    await notifyPurchaseConfirm(base);
    const body = emailCall()!.body;
    // <a href> 밖에도 URL 이 한 번 더 등장해야 한다
    const occurrences = body.split("/tickets/TKT-ABCDEF").length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("티켓번호가 없으면 링크 없이도 메일은 나간다(발송 자체를 막지 않는다)", async () => {
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    await notifyPurchaseConfirm({ ...base, ticketNumber: undefined });
    const email = emailCall();
    expect(email).toBeDefined();
    expect(email!.body).not.toContain("<a href");
  });

  it("🔴 본문 변수는 이스케이프된다 (행사명에 태그가 있어도 렌더되면 안 된다)", async () => {
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    await notifyPurchaseConfirm({ ...base, eventTitle: '<img src=x onerror="alert(1)">' });
    const body = emailCall()!.body;
    expect(body).not.toContain("<img src=x");
    expect(body).toContain("&lt;img");
  });
});

/**
 * 🔴 이메일 전용 본문 (2026-08-01, UI 세션).
 *
 * 종전 이메일은 **알림톡 승인본을 그대로** 실었다. 알림톡은 한 글자도 못 바꾸는 문안이라
 * `▶`·`※` 기호와 줄바꿈이 메일에 그대로 나갔고, `white-space:pre-line` 을 무시하는
 * 클라이언트에서는 한 문단으로 뭉쳤다. 여기서 고정하는 것은 **두 채널이 갈라졌다는 사실**이다.
 */
describe("거래 이메일 — 전용 레이아웃", () => {
  const base = {
    accountId: "acc-1",
    email: "buyer@example.com",
    phone: "01011112222",
    buyerName: "구매자",
    eventTitle: "테스트 대회",
    eventDate: "2026. 8. 20.",
    ticketCount: 2,
    orderNumber: "ORD-260801-002",
    venueName: "포천힐스CC",
    ticketNumber: "TKT-ABCDEF",
  };
  const pick = (ch: string) =>
    h.dispatchOne.mock.calls
      .map((c) => c[0] as { channel: string; body: string; buttons?: unknown })
      .find((a) => a.channel === ch);

  it("🔴 이메일에는 알림톡 기호(▶ ※)가 실리지 않는다 — 이 지시서의 목적", async () => {
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    await notifyPurchaseConfirm(base);
    const body = pick("email")!.body;
    expect(body).not.toContain("▶");
    expect(body).not.toContain("※");
    expect(body).not.toContain("white-space:pre-line"); // 줄바꿈을 스타일 하나에 기대지 않는다
  });

  it("🔴 알림톡 본문은 그대로다 — 카카오 승인본이라 한 글자도 못 바꾼다", async () => {
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    await notifyPurchaseConfirm(base);
    const kakao = pick("kakao")!.body;
    expect(kakao).toContain("▶ 대회일자 : 2026. 8. 20.");
    expect(kakao).toContain("고객님께서 결제하신");
  });

  it("주문 정보가 표로 들어간다", async () => {
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    await notifyPurchaseConfirm(base);
    const body = pick("email")!.body;
    for (const s of ["예매가 완료되었습니다", "테스트 대회", "2026. 8. 20.", "포천힐스CC", "모바일 티켓 2매", "ORD-260801-002"]) {
      expect(body, `누락: ${s}`).toContain(s);
    }
  });

  it("🔴 버튼이 없으면 '버튼을 눌러' 라고 말하지 않는다 — 그게 8/1 사고의 형태였다", async () => {
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    await notifyPurchaseConfirm({ ...base, ticketNumber: undefined });
    const body = pick("email")!.body;
    expect(body).not.toContain("<a href");
    expect(body, "누를 것이 없는데 누르라고 하는 메일").not.toContain("버튼을 눌러");
  });

  it("버튼이 있으면 누르라고 안내한다", async () => {
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    await notifyPurchaseConfirm(base);
    expect(pick("email")!.body).toContain("버튼을 눌러");
  });

  it("장소를 모르면 '장소' 줄이 통째로 빠진다 (알림톡은 '-' 로 채운다)", async () => {
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    await notifyPurchaseConfirm({ ...base, venueName: undefined });
    expect(pick("email")!.body).not.toContain("장소");
    expect(pick("kakao")!.body).toContain("※ 장소 : -"); // 승인본은 그대로
  });

  it("환불 완료 메일도 카드 레이아웃으로 나간다", async () => {
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    const { notifyRefundConfirm } = await import("./transactional");
    await notifyRefundConfirm({ ...base, refundAmount: "45,000원" });
    const body = pick("email")!.body;
    expect(body).toContain("취소·환불이 완료되었습니다");
    expect(body).toContain("45,000원");
    expect(body).toMatch(/<table\b/);
  });

  it("리마인더도 카드 레이아웃 + '내 티켓' 버튼이 붙는다", async () => {
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    const { notifyReminder } = await import("./transactional");
    await notifyReminder({ ...base, venueName: "포천힐스CC", type: "D7" });
    const body = pick("email")!.body;
    expect(body).toContain("행사가 일주일 남았습니다");
    expect(body).toMatch(/<a href="[^"]*\/my-tickets"/);
  });

  /**
   * 🔴 체크인 메일은 이메일에만 버튼을 붙인다.
   *
   * 같은 링크를 `buttons` 로 주면 **카카오 승인 템플릿(CHECKIN_QR)에 없는 버튼**이 붙어
   * 접수는 되고 전달이 거부된다(3027). 이메일↔카카오는 한 방향으로만 흐른다.
   */
  it("메일 제목 말머리가 4종 모두 [피켓] 으로 통일돼 있다", async () => {
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    const m = await import("./transactional");
    await m.notifyPurchaseConfirm(base);
    await m.notifyRefundConfirm({ ...base, refundAmount: "1원" });
    await m.notifyCheckinQr({ ...base, ticketUrl: "https://go.pickket.kr/t" });
    await m.notifyReminder({ ...base, venueName: "포천힐스CC", type: "D7" });
    await m.notifyReminder({ ...base, venueName: "포천힐스CC", type: "D1" });
    const subjects = h.dispatchOne.mock.calls
      .map((c) => (c[0] as { channel: string; subject?: string }))
      .filter((a) => a.channel === "email")
      .map((a) => a.subject ?? "");
    expect(subjects).toHaveLength(5);
    expect(subjects.filter((s) => s.startsWith("[피켓] "))).toHaveLength(5);
    expect(subjects.some((s) => s.includes("PICKKET")), "말머리가 섞여 있다").toBe(false);
  });

  it("🔴 체크인 메일: 이메일엔 버튼, 카카오엔 버튼 없음 (3027 방지)", async () => {
    h.dispatchOne.mockResolvedValue({ status: "sent" });
    const { notifyCheckinQr } = await import("./transactional");
    await notifyCheckinQr({ ...base, ticketUrl: "https://go.pickket.kr/tickets/TKT-ABCDEF?t=z" });
    expect(pick("email")!.body).toMatch(/<a href="https:\/\/go\.pickket\.kr\/tickets\/TKT-ABCDEF/);
    expect(pick("kakao")!.buttons).toBeUndefined();
  });
});
