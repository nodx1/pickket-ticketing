// @vitest-environment node
/**
 * 🔴 티켓 화면이 **언제 라이브로 바뀌는가** — 페이지 단위로 확인한다 (2026-08-06).
 *
 * ## 왜 순수함수 테스트로 부족한가
 * `shouldShowLive` 만 지키면 **판정**은 증명되지만 **배선**은 증명되지 않는다.
 * 실제 사고는 배선에서 난다:
 *   · 페이지가 `checked_in_at` 을 넘긴다      → 🔴 2일차에 QR 이 사라진다
 *   · 초대권 갈래에 라이브를 안 붙인다        → 🔴 초대권 손님이 라이브를 못 본다
 * 둘 다 순수함수는 통과한다. 그래서 **페이지를 실제로 렌더**해 무엇이 나오는지 본다.
 *
 * ⚠️ 서버 컴포넌트지만 그냥 `async` 함수다 — 호출해서 나온 엘리먼트 트리를 본다.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const getTicketByNumber = vi.fn();
const getInvitationByTicketNumber = vi.fn();
const resolvePublicEventById = vi.fn();
const getPublicTicketDesign = vi.fn();

// ⚠️ `server-only` 는 클라이언트 번들에서 즉시 던진다. 테스트 러너는 그 구분이 없으므로
//    빈 모듈로 세운다 — 서버 전용 코드를 **부르지 못하게** 막는 장치일 뿐 로직이 아니다.
vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined }),
}));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("notFound");
  },
  redirect: (to: string) => {
    throw new Error(`redirect:${to}`);
  },
}));
vi.mock("@/lib/auth/session", () => ({ verifySession: async () => null }));
/**
 * 접근 관문은 이 테스트의 대상이 아니다 — **구매자 본인**이 연 상태를 만든다.
 * (조회쿠키 통과. 관문 자체는 별도 테스트가 지킨다.)
 */
vi.mock("@/lib/public-access", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  verifyPublicLookupToken: () => ({ email: "g@example.com", phone: "010-1111-2222" }),
  matchesPublicLookup: () => true,
}));
vi.mock("@/lib/qrCode", () => ({ generateQRDataURL: async () => "data:image/png;base64,QR" }));
vi.mock("@/lib/ticket/dynamic-qr", () => ({
  generateDynamicQRPayload: async () => ({ payload: "p", expiresAt: 0 }),
}));
vi.mock("@/lib/server/invitations", () => ({ markInvitationViewed: async () => {} }));
vi.mock("@/lib/v2/commerce-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getTicketByNumber: (...a: unknown[]) => getTicketByNumber(...a),
  getInvitationByTicketNumber: (...a: unknown[]) => getInvitationByTicketNumber(...a),
  getPublicTicketDesign: (...a: unknown[]) => getPublicTicketDesign(...a),
}));
vi.mock("@/lib/v2/public-event", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolvePublicEventById: (...a: unknown[]) => resolvePublicEventById(...a),
}));

import TicketPage from "./page";

const TICKET = "PK-TEST-0001";

/** 하루 1일차 기준 시각들. */
const DAY1 = "2026-08-20T01:00:00Z"; // KST 10:00 (1일차)

interface TicketOver {
  admitted_today?: boolean;
  checked_in_at?: string | null;
}

function v2Ticket(over: TicketOver = {}) {
  return {
    ticket_id: "t-1",
    ticket_number: TICKET,
    status: "active",
    checked_in_at: null,
    seat_id: null,
    tier_id: null,
    product_name: "주중권",
    product_external_ref: null,
    raffle_number: 7,
    answers: null,
    issued_at: DAY1,
    event_id: "ev-1",
    event: { starts_at: DAY1, title: "BC카드·한경 제48회 KLPGA 챔피언십", organizer_id: null, external_ref: null },
    order: {
      id: "o-1",
      order_number: "ORD-1",
      buyer: { name: "김갤러리", email: "g@example.com", phone: "010-1111-2222" },
    },
    ...over,
  };
}

function v2Event() {
  return {
    ok: true as const,
    event: {
      id: "ev-1",
      title: "BC카드·한경 제48회 KLPGA 챔피언십",
      event_date: DAY1,
      event_date_end: "2026-08-23T01:00:00Z",
      venue: "포천힐스CC",
      venue_address: "경기 포천시",
      image_url: null,
      gallery_images: null,
      content: { event_schedules: [] },
    },
  };
}

/** 렌더 결과를 문자열로 훑는다 — 어떤 컴포넌트가 나왔는지 이름으로 확인한다. */
function componentNames(node: unknown, out: string[] = []): string[] {
  if (!node || typeof node !== "object") return out;
  const el = node as { type?: unknown; props?: { children?: unknown } };
  const t = el.type;
  if (typeof t === "function") out.push((t as { name?: string }).name ?? "anonymous");
  else if (typeof t === "string") out.push(t);
  const kids = el.props?.children;
  if (Array.isArray(kids)) kids.forEach((k) => componentNames(k, out));
  else if (kids) componentNames(kids, out);
  return out;
}

async function render(over: TicketOver, opts: { invitation?: boolean } = {}) {
  getTicketByNumber.mockResolvedValue(v2Ticket(over));
  resolvePublicEventById.mockResolvedValue(v2Event());
  getPublicTicketDesign.mockResolvedValue({ canvas_json: null, design: null });
  getInvitationByTicketNumber.mockResolvedValue(
    opts.invitation
      ? { invitation: { recipient_name: "박초대", admission_day: null, admission_mode: null, token_version: 1 } }
      : { invitation: null },
  );
  return TicketPage({
    params: Promise.resolve({ ticketNumber: TICKET }),
    searchParams: Promise.resolve({}),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("🔴 U1 — 다일권: 2일차에 QR 이 살아 있어야 한다", () => {
  it("🔴 1일차에 입장했어도 오늘(2일차) 미입장이면 QR 화면이다", async () => {
    // 주중권은 목·금 이틀이다. `checked_in_at` 은 1일차 값이 그대로 남는다.
    // 그 값으로 판정하면 2일차 아침 게이트 앞에서 QR 이 사라진다.
    const tree = await render({ checked_in_at: DAY1, admitted_today: false });
    const names = componentNames(tree);
    expect(names, "2일차인데 라이브가 떴다 — checked_in_at 으로 판정했다").not.toContain("LiveView");
  });

  it("오늘 입장했으면 라이브다", async () => {
    const tree = await render({ checked_in_at: DAY1, admitted_today: true });
    expect(componentNames(tree)).toContain("LiveView");
  });
});

describe("🔴 U2 — 모르면 안 바꾼다", () => {
  it("🔴 admitted_today 가 없으면(구버전 v2) QR 이다", async () => {
    const tree = await render({});
    expect(componentNames(tree), "undefined 를 truthy 로 흘렸다").not.toContain("LiveView");
  });

  it("입장 전(false)이면 QR 이다", async () => {
    const tree = await render({ admitted_today: false });
    expect(componentNames(tree)).not.toContain("LiveView");
  });
});

describe("🔴 U5 — 초대권 손님도 갤러리다", () => {
  it("🔴 초대권도 입장하면 라이브가 뜬다", async () => {
    const tree = await render({ admitted_today: true }, { invitation: true });
    const names = componentNames(tree);
    expect(names, "초대권 갈래에 라이브가 없다").toContain("LiveView");
    expect(names, "초대권인데 옛 화면이 떴다").not.toContain("InvitationTicketView");
  });

  it("초대권도 입장 전이면 초대권 화면 그대로다", async () => {
    const tree = await render({ admitted_today: false }, { invitation: true });
    const names = componentNames(tree);
    expect(names).toContain("InvitationTicketView");
    expect(names).not.toContain("LiveView");
  });

  it("유료 티켓도 입장하면 라이브가 뜬다", async () => {
    const tree = await render({ admitted_today: true }, { invitation: false });
    expect(componentNames(tree)).toContain("LiveView");
  });
});
