/**
 * 🔴 티켓 링크 공유 미리보기 — **개인정보가 새면 안 된다.**
 *
 * ## 왜 생겼나
 * 2026-08-03 지적: 이 페이지에 `generateMetadata` 가 없어 **사이트 기본값**이 나갔다.
 * 카톡으로 초대권을 받으면 제목이 "PICKKET.GO — 이벤트를 여는 모든 사람을 위해",
 * 설명이 폐기된 "AI가 만들고…" 였다. 무슨 행사인지 알 수 없었다.
 *
 * ## 고정하는 계약
 * ```
 * 🔴 티켓번호·수신자 이름·QR 을 **절대** 싣지 않는다   ← 미리보기는 공개된다
 * 행사 제목과 대표 이미지까지만
 * 초대권이면 "초대권이 도착했습니다"
 * v2 가 흔들려도 **던지지 않는다**                      ← 던지면 페이지가 죽는다
 * 검색엔진 noindex                                      ← 링크 가진 사람만 보는 페이지
 * ```
 *
 * ⚠️ 미리보기는 카카오 서버에 **캐시된다.** 한 번 새면 회수가 어렵다.
 *    그래서 "안 넣었다" 를 문자열 존재가 아니라 **직렬화 전체 스캔**으로 확인한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TICKET_NUMBER = "TKT-223169F84420";
const RECIPIENT = "김동영";

const h = vi.hoisted(() => ({
  getTicketByNumber: vi.fn(),
  resolvePublicEventById: vi.fn(),
  getInvitationByTicketNumber: vi.fn(),
}));

vi.mock("@/lib/v2/commerce-client", () => ({
  getTicketByNumber: h.getTicketByNumber,
  getInvitationByTicketNumber: h.getInvitationByTicketNumber,
  V2CommerceError: class extends Error {
    status = 500;
  },
}));
vi.mock("@/lib/v2/public-event", () => ({
  resolvePublicEventById: h.resolvePublicEventById,
  PUBLIC_ANY_STATUS: [],
}));

/**
 * ⚠️ 페이지 모듈은 `server-only` 를 끌어온다(env.server 경유). vitest 에서는 그 모듈이
 *    "클라이언트에서 import 했다" 며 던진다 — 무력화해야 metadata 를 부를 수 있다.
 *    (`src/lib/env/runtime.ts:20` 에 같은 이유가 적혀 있다.)
 */
vi.mock("server-only", () => ({}));

// 페이지 본문이 끌어오는 무거운 의존은 여기서 필요 없다 — metadata 만 부른다.
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ verifySession: vi.fn() }));
vi.mock("@/lib/server/invitations", () => ({ markInvitationViewed: vi.fn() }));

import { generateMetadata } from "@/app/(public)/tickets/[ticketNumber]/page";

/** 메타데이터 전체를 문자열로 펼친다 — 어디에 숨어도 잡힌다. */
function flatten(meta: unknown): string {
  return JSON.stringify(meta);
}

function run(ticketNumber = TICKET_NUMBER) {
  return generateMetadata({ params: Promise.resolve({ ticketNumber }) });
}

beforeEach(() => {
  h.getTicketByNumber.mockReset();
  h.resolvePublicEventById.mockReset();
  h.getInvitationByTicketNumber.mockReset();

  h.getTicketByNumber.mockResolvedValue({
    ticket_number: TICKET_NUMBER,
    event_id: "ev-1",
    event: { title: "BC카드·한경 제48회 KLPGA 챔피언십" },
    order: { buyer: { name: RECIPIENT, phone: "010-1234-5678" } },
  });
  h.resolvePublicEventById.mockResolvedValue({
    ok: true,
    event: {
      title: "BC카드·한경 제48회 KLPGA 챔피언십",
      image_url: "https://cdn.pickket.kr/hero.webp",
    },
  });
  h.getInvitationByTicketNumber.mockResolvedValue({
    invitation: { recipient_name: RECIPIENT },
  });
});
afterEach(() => vi.clearAllMocks());

describe("🔴 개인정보 — 미리보기에 실리면 안 되는 것", () => {
  it("티켓번호가 어디에도 없다", async () => {
    const meta = await run();
    expect(flatten(meta), "티켓번호가 공개 미리보기에 실렸다").not.toContain(TICKET_NUMBER);
  });

  it("수신자 이름이 어디에도 없다", async () => {
    const meta = await run();
    expect(flatten(meta), "수신자 이름이 공개 미리보기에 실렸다").not.toContain(RECIPIENT);
  });

  it("전화번호가 어디에도 없다", async () => {
    const meta = await run();
    expect(flatten(meta)).not.toContain("010-1234-5678");
  });

  it("검색엔진에 남기지 않는다", async () => {
    const meta = await run();
    expect(meta.robots).toMatchObject({ index: false, follow: false });
  });
});

describe("무엇을 보여주는가", () => {
  it("행사 제목이 제목이 된다", async () => {
    const meta = await run();
    expect(meta.title).toBe("BC카드·한경 제48회 KLPGA 챔피언십");
  });

  /**
   * ⚠️ 루트 layout 의 `title.template` 이 브랜드를 붙인다.
   *    여기서 또 붙이면 "…챔피언십 | PICKKET.GO | PICKKET.GO" 가 된다.
   */
  it("브랜드를 직접 붙이지 않는다 — 루트 template 이 붙인다", async () => {
    const meta = await run();
    expect(String(meta.title)).not.toContain("PICKKET.GO");
  });

  it("대표 이미지를 싣는다", async () => {
    const meta = await run();
    expect(flatten(meta.openGraph)).toContain("https://cdn.pickket.kr/hero.webp");
  });

  it("🔴 초대권이면 「초대권이 도착했습니다」", async () => {
    const meta = await run();
    expect(String(meta.description)).toContain("초대권이 도착했습니다");
  });

  it("초대권이 아니면 그 문구를 쓰지 않는다 — 구매 티켓에 틀린 말이다", async () => {
    h.getInvitationByTicketNumber.mockResolvedValue({ invitation: null });
    const meta = await run();
    expect(String(meta.description)).not.toContain("초대권이 도착했습니다");
    expect(String(meta.description)).toContain("모바일 티켓");
  });

  it("대표 이미지가 없으면 이미지 없이 나간다 — 깨진 URL 금지", async () => {
    h.resolvePublicEventById.mockResolvedValue({ ok: true, event: { title: "행사", image_url: null } });
    const meta = await run();
    expect(flatten(meta)).not.toContain("null");
    expect(meta.twitter).toMatchObject({ card: "summary" });
  });
});

describe("🔴 실패해도 던지지 않는다 — 던지면 페이지가 죽는다", () => {
  it("티켓 조회 실패", async () => {
    h.getTicketByNumber.mockRejectedValue(new Error("v2 down"));
    const meta = await run();
    expect(meta.robots).toMatchObject({ index: false });
    expect(meta.title, "실패했는데 제목을 지어냈다").toBeUndefined();
  });

  it("이벤트 조회 실패", async () => {
    h.resolvePublicEventById.mockResolvedValue({ ok: false, status: 404 });
    await expect(run()).resolves.toBeTruthy();
  });

  it("초대권 판별만 실패하면 중립 문구로 계속 간다", async () => {
    h.getInvitationByTicketNumber.mockRejectedValue(new Error("v2 down"));
    const meta = await run();
    expect(meta.title).toBe("BC카드·한경 제48회 KLPGA 챔피언십");
    expect(String(meta.description)).toContain("모바일 티켓");
  });

  it("제목이 비면 기본값으로 물러난다", async () => {
    h.resolvePublicEventById.mockResolvedValue({ ok: true, event: { title: "   " } });
    const meta = await run();
    expect(meta.title).toBeUndefined();
  });
});
