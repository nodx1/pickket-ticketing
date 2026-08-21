import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 구매자 본인확인(지식증명) — 조회쿠키 발급 관문.
 *
 * 🔴 여기가 뚫리면 링크를 가진 사람이 **남의 티켓을 환불**한다. 그래서 축은 셋이다:
 *    ① 정확히 일치할 때만 통과   ② 실패 사유를 구분하지 않는다(열거 방지)
 *    ③ v2 장애를 불일치로 위장하지 않는다(맞는 정보를 넣고도 튕기면 안 된다)
 */
const h = vi.hoisted(() => {
  class MockV2CommerceError extends Error {
    constructor(message: string, readonly status: number) {
      super(message);
      this.name = "V2CommerceError";
    }
  }
  return {
    getTicketByNumber: vi.fn(),
    createPublicLookupToken: vi.fn(() => "lookup-token"),
    loggerError: vi.fn(),
    MockV2CommerceError,
  };
});

vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: h.MockV2CommerceError,
  getTicketByNumber: h.getTicketByNumber,
}));
vi.mock("@/lib/public-access", () => ({
  PUBLIC_LOOKUP_COOKIE: "pkt_lookup",
  createPublicLookupToken: h.createPublicLookupToken,
}));
vi.mock("@/lib/env/runtime", () => ({ isProdRuntime: () => false }));
vi.mock("@/lib/logger", () => ({ logger: { error: h.loggerError, warn: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/auth/withRateLimit", () => ({
  withRateLimit: () => (handler: unknown) => handler,
}));

import { POST as verifyContact } from "./route";

const TICKET = "TKT-04B24C0195C6";
const EMAIL = "buyer@example.com";
const PHONE = "01011112222";

function req(body: unknown) {
  return new Request("https://go.pickket.kr/api/public/lookup/verify-contact", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function ticketWith(email: string | null, phone: string | null) {
  return { ticket_number: TICKET, order: { buyer: { email, phone } } };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getTicketByNumber.mockResolvedValue(ticketWith(EMAIL, PHONE));
});

describe("본인확인 — 통과 조건", () => {
  it("이메일·전화가 모두 일치하면 조회쿠키를 굽는다", async () => {
    const res = await verifyContact(req({ ticketNumber: TICKET, email: EMAIL, phone: PHONE }));
    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")).toContain("pkt_lookup=");
    expect(h.createPublicLookupToken).toHaveBeenCalledWith({ email: EMAIL, phone: PHONE });
  });

  it("전화 하이픈·이메일 대소문자 차이는 허용한다(입력 관용)", async () => {
    const res = await verifyContact(
      req({ ticketNumber: TICKET, email: "BUYER@Example.COM", phone: "010-1111-2222" }),
    );
    expect(res.status).toBe(200);
  });

  it("🔴 쿠키 페이로드는 **주문 원장값**으로 만든다(사용자 입력 아님)", async () => {
    await verifyContact(
      req({ ticketNumber: TICKET, email: "BUYER@Example.COM", phone: "010-1111-2222" }),
    );
    // 정규화된 원장값이어야 하류 matchesPublicLookup 대조가 성립한다.
    expect(h.createPublicLookupToken).toHaveBeenCalledWith({ email: EMAIL, phone: PHONE });
  });
});

describe("본인확인 — 차단", () => {
  it("🔴 이메일이 틀리면 쿠키를 굽지 않는다", async () => {
    const res = await verifyContact(
      req({ ticketNumber: TICKET, email: "attacker@example.com", phone: PHONE }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(h.createPublicLookupToken).not.toHaveBeenCalled();
  });

  it("🔴 전화가 틀리면 쿠키를 굽지 않는다", async () => {
    const res = await verifyContact(
      req({ ticketNumber: TICKET, email: EMAIL, phone: "01099998888" }),
    );
    expect(res.status).toBe(401);
    expect(h.createPublicLookupToken).not.toHaveBeenCalled();
  });

  it("🔴 이메일만 맞아도 통과하지 않는다(두 요소 **모두** 필요)", async () => {
    const res = await verifyContact(req({ ticketNumber: TICKET, email: EMAIL, phone: "010" }));
    expect(res.status).toBe(401);
    expect(h.createPublicLookupToken).not.toHaveBeenCalled();
  });

  it("주문에 연락처가 없으면 통과시키지 않는다(빈값끼리 일치 금지)", async () => {
    h.getTicketByNumber.mockResolvedValue(ticketWith(null, null));
    const res = await verifyContact(req({ ticketNumber: TICKET, email: "", phone: "" }));
    expect(res.status).toBe(401);
    expect(h.createPublicLookupToken).not.toHaveBeenCalled();
  });

  /**
   * 🔴 실제 우회 경로다 — 뮤테이션이 살아남아 발견했다.
   *
   * 주문에 전화가 **없고**(게스트 주문·구형 데이터) 공격자가 이메일만 아는 상황에서,
   * 전화칸에 숫자가 하나도 없는 문자열("-", "없음" …)을 넣으면 `digits()` 결과가 빈
   * 문자열이 되어 **빈값끼리 일치**한다. 즉 전화를 모르고도 통과한다.
   * 두 요소 중 하나가 사실상 무력화되므로 반드시 막아야 한다.
   */
  it("🔴 주문 전화가 비어 있을 때 숫자없는 입력으로 통과할 수 없다", async () => {
    h.getTicketByNumber.mockResolvedValue(ticketWith(EMAIL, null));
    const res = await verifyContact(req({ ticketNumber: TICKET, email: EMAIL, phone: "-" }));
    expect(res.status).toBe(401);
    expect(h.createPublicLookupToken).not.toHaveBeenCalled();
  });

  it("🔴 주문 이메일이 비어 있을 때도 마찬가지다", async () => {
    h.getTicketByNumber.mockResolvedValue(ticketWith(null, PHONE));
    const res = await verifyContact(req({ ticketNumber: TICKET, email: "a@b.com", phone: PHONE }));
    expect(res.status).toBe(401);
    expect(h.createPublicLookupToken).not.toHaveBeenCalled();
  });
});

describe("열거 방지", () => {
  it("🔴 티켓 미존재와 정보 불일치가 **같은 응답**이다", async () => {
    const mismatch = await verifyContact(
      req({ ticketNumber: TICKET, email: "nope@example.com", phone: PHONE }),
    );
    h.getTicketByNumber.mockRejectedValue(new h.MockV2CommerceError("not found", 404));
    const missing = await verifyContact(
      req({ ticketNumber: "TKT-NOPE", email: EMAIL, phone: PHONE }),
    );

    expect(missing.status).toBe(mismatch.status);
    expect(await missing.clone().text()).toBe(await mismatch.clone().text());
  });

  it("성공 응답에 구매자 정보를 담지 않는다", async () => {
    const res = await verifyContact(req({ ticketNumber: TICKET, email: EMAIL, phone: PHONE }));
    const text = await res.text();
    expect(text).not.toContain(EMAIL);
    expect(text).not.toContain(PHONE);
  });
});

describe("장애를 불일치로 위장하지 않는다", () => {
  it("🔴 v2 5xx 는 503 — 401 로 접으면 맞는 정보를 넣고도 계속 튕긴다", async () => {
    h.getTicketByNumber.mockRejectedValue(new h.MockV2CommerceError("down", 503));
    const res = await verifyContact(req({ ticketNumber: TICKET, email: EMAIL, phone: PHONE }));
    expect(res.status).toBe(503);
    expect(h.loggerError).toHaveBeenCalled();
  });

  it("네트워크 예외도 503", async () => {
    h.getTicketByNumber.mockRejectedValue(new Error("ECONNRESET"));
    const res = await verifyContact(req({ ticketNumber: TICKET, email: EMAIL, phone: PHONE }));
    expect(res.status).toBe(503);
  });
});

/**
 * 🔴 아래 두 블록은 배포세션이 **적대 뮤테이션에서 살아남은 구멍**을 보고 추가했다
 * (2026-07-31). 원 테스트는 대조 로직·열거 방지는 지켰지만, **한도와 쿠키 속성**은
 * 아무것도 지키지 않았다 — 5→500 으로 풀어도, `httpOnly` 를 꺼도 전건 통과했다.
 *
 * 이 경로는 **공개 인증**이다. 전화번호 후보공간이 좁아(01X-XXXX-XXXX) 한도가 풀리면
 * 링크만 가진 사람이 번호를 긁을 수 있고, `httpOnly` 가 꺼지면 XSS 한 번에 조회쿠키가
 * 통째로 넘어간다. 로직이 옳아도 **그 두 개가 풀리면 경로가 뚫린다.**
 */
describe("공개 인증 경로가 지켜야 하는 속성", () => {
  const SRC = readFileSync(
    new URL("./route.ts", import.meta.url).pathname,
    "utf8",
  );

  it("🔴 무차별 대입 한도가 분당 5회 이하다 — 전화번호는 후보공간이 좁다", () => {
    const m = /withRateLimit\(\{[\s\S]{0,160}?max:\s*(\d+)[\s\S]{0,80}?windowMs:\s*([0-9_]+)/.exec(SRC);
    expect(m, "withRateLimit 이 없다").not.toBeNull();
    expect(Number(m![1]), "한도가 느슨해졌다").toBeLessThanOrEqual(5);
    expect(Number(m![2].replace(/_/g, "")), "창이 넓어졌다").toBeLessThanOrEqual(60_000);
  });

  it("🔴 조회쿠키가 httpOnly 다 — 꺼지면 XSS 한 번에 통째로 넘어간다", () => {
    expect(SRC).toMatch(/httpOnly:\s*true/);
  });

  it("쿠키가 sameSite·secure(prod)·만료를 갖는다", () => {
    expect(SRC).toMatch(/sameSite:/);
    expect(SRC).toMatch(/secure:\s*isProdRuntime\(\)/);
    expect(SRC).toMatch(/expires:/);
  });

  it("성공 응답이 구매자 정보를 담지 않는다 — 쿠키만 굽는다", () => {
    const body = /NextResponse\.json\(([\s\S]{0,120}?)\)/.exec(SRC)?.[1] ?? "";
    expect(body).not.toMatch(/email|phone|buyer/i);
  });
});
