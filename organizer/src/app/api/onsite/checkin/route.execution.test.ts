import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 🔴 라우트를 **실제로 실행**한다 — 소스 검사가 아니다 (2026-08-10)
 *
 * `onsite-route.test.ts` 는 소스 관계를 본다. 그것으로는
 * *"거부 응답에 전화번호가 **없다**"* 를 **소스에 없다**로만 증명한다.
 * 실행 경로에서 다른 이유로 새면 못 잡는다.
 *
 * ⟹ 여기서는 핸들러를 부르고 **응답 본문을 파싱해** 확인한다. 로그도 소스가 아니라
 *    런타임에 실제로 넘어간 인자를 본다.
 *
 * 목킹 경계: 바깥(v2 클라이언트·go 풀·rate limit)만 목이고, **판정·응답 조립은 실코드**다.
 */

// env.server 는 server-only 가드 — dynamic-qr.test.ts 와 같은 스텁.
vi.mock("@/lib/env.server", () => ({
  getRuntimeSecret: (_key: string, fallback: string) => fallback,
}));

const h = vi.hoisted(() => ({
  checkInTicket: vi.fn(),
  resolveOwnedTicketByNumber: vi.fn(),
  resolvePublicEventById: vi.fn(),
  poolQuery: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  class_V2CommerceError: class V2CommerceError extends Error {
    constructor(message: string, readonly status: number, readonly body?: string) {
      super(message);
      this.name = "V2CommerceError";
    }
  },
  class_TicketAccessError: class TicketAccessError extends Error {},
}));

// 🔴 rate limit 은 통과시킨다 — 여기서 보려는 것은 본문이다.
vi.mock("@/lib/auth/withRateLimit", () => ({
  withRateLimit: () => <T extends (...a: never[]) => unknown>(handler: T) => handler,
}));
vi.mock("@/lib/v2/commerce-client", () => ({
  checkInTicket: (...a: unknown[]) => h.checkInTicket(...a),
  V2CommerceError: h.class_V2CommerceError,
}));
vi.mock("@/lib/v2/ticket-access", () => ({
  resolveOwnedTicketByNumber: (...a: unknown[]) => h.resolveOwnedTicketByNumber(...a),
  TicketAccessError: h.class_TicketAccessError,
}));
vi.mock("@/lib/v2/public-event", () => ({
  PUBLIC_ANY_STATUS: ["live"],
  resolvePublicEventById: (...a: unknown[]) => h.resolvePublicEventById(...a),
}));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.poolQuery }) }));
vi.mock("@/lib/logger", () => ({
  logger: { info: h.loggerInfo, warn: h.loggerWarn, error: h.loggerError },
}));

import { POST } from "@/app/api/onsite/checkin/route";
import { generateDynamicQRPayload } from "@/lib/ticket/dynamic-qr";

const KEY = "onsite-test-key-0123456789";
const EVENT = "11111111-1111-1111-1111-111111111111";
const ACCT = "baa84598-3db4-44c4-8eca-6f7d3cee171e";
const TICKET_NO = "TKT-AAEE04F7288F";
/** 로컬 go DB 실측값 그대로 — 픽스처가 현실과 같은 모양이어야 한다. */
const HOLDER = { name: "홍길동", phone: "01076307731" };

function post(body: unknown, key: string | null = KEY): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["x-onsite-key"] = key;
  return POST(
    new Request("https://go.pickket.kr/api/onsite/checkin", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }) as never,
  ) as Promise<Response>;
}

function goodBody(over: Record<string, unknown> = {}) {
  return {
    qr: generateDynamicQRPayload(TICKET_NO),
    scanned_at: "2026-08-20T09:10:00+09:00",
    device_id: "GATE-A-01",
    ...over,
  };
}

const OLD_ENV = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.ONSITE_CHECKIN_KEY = KEY;
  process.env.ONSITE_CHECKIN_EVENT_ID = EVENT;
  h.resolvePublicEventById.mockResolvedValue({ ok: true, event: { go_account_id: ACCT } });
  h.resolveOwnedTicketByNumber.mockResolvedValue({
    ticket_id: "22222222-2222-2222-2222-222222222222",
    ticket_number: TICKET_NO,
    status: "active",
    checked_in_at: null,
    raffle_number: 100123,
    product_name: "주중권 (목 1R ~ 금 2R)",
    order: { buyer: { name: "구매자김", email: null, phone: "010-9999-8888" } },
  });
  // 로컬 go DB 실측 행과 같은 모양
  h.poolQuery.mockResolvedValue({ rows: [{ name: HOLDER.name, phone: "010-7630-7731" }] });
  h.checkInTicket.mockResolvedValue({
    checked_in_at: "2026-08-20T00:10:00Z",
    status: "used",
    already: false,
    outcome: "admitted",
    attended_date: "2026-08-20",
  });
});
afterEach(() => {
  process.env = { ...OLD_ENV };
});

describe("🔴 실행 — 성공 응답 본문", () => {
  it("업체 명세 그대로의 **평평한** 본문이 나온다", async () => {
    const res = await post(goodBody());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      result: "admitted",
      ticket_no: TICKET_NO,
      holder_name: HOLDER.name,
      holder_phone: HOLDER.phone, // 🔴 하이픈이 벗겨져 나온다
      tier: "주중권 (목 1R ~ 금 2R)",
      raffle_no: 100123,
      attended_date: "2026-08-20",
    });
    // 🔴 {success, data} 봉투가 아니다
    expect(body).not.toHaveProperty("data");
  });

  it("🔴 참석자 이름이 나온다 — 구매자가 아니다", async () => {
    const body = await (await post(goodBody())).json();
    expect(body.holder_name).toBe("홍길동");
    expect(body.holder_name).not.toBe("구매자김");
  });

  it("재입장은 reentry_ok 로 나온다", async () => {
    h.checkInTicket.mockResolvedValue({
      checked_in_at: "2026-08-20T03:00:00Z", status: "used",
      already: true, outcome: "reentry_ok", attended_date: "2026-08-20",
    });
    const body = await (await post(goodBody())).json();
    expect(body.result).toBe("reentry_ok");
  });

  it("🔴 scanned_at 이 v2 에 그대로 간다 (오프라인 큐)", async () => {
    const at = "2026-08-20T23:50:00+09:00";
    await post(goodBody({ scanned_at: at }));
    expect(h.checkInTicket).toHaveBeenCalledWith(expect.any(String), { at });
  });
});

describe("🔴 실행 — 전화번호가 새지 않는가 (응답 본문으로 확인)", () => {
  it("🔴 키가 틀리면 401 이고 본문에 전화번호가 **없다**", async () => {
    const res = await post(goodBody(), "wrong-key-wrong-key-wrong");
    expect(res.status).toBe(401);
    const raw = await res.text();
    expect(raw).not.toMatch(/holder_phone|0107630|01076307731/);
  });

  it("🔴 v2 가 거부하면 403 이고 본문에 전화번호가 **없다**", async () => {
    h.checkInTicket.mockRejectedValue(
      new h.class_V2CommerceError("STATE_TRANSITION_FORBIDDEN: 지정된 입장일이 아닙니다", 422),
    );
    const res = await post(goodBody());
    expect(res.status).toBe(403);
    const raw = await res.text();
    expect(raw).not.toMatch(/holder_phone|0107630/);
    expect(JSON.parse(raw)).toEqual({
      result: "rejected",
      reason: "not_admission_day",
      message: "지정된 입장일이 아닙니다",
    });
  });

  it("🔴 위조 QR 은 403 · 본문에 전화번호가 **없다**", async () => {
    const good = generateDynamicQRPayload(TICKET_NO).split(":");
    good[3] = (good[3] ?? "").slice(0, -1) + "z";
    const res = await post(goodBody({ qr: good.join(":") }));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.reason).toBe("invalid");
    expect(body).not.toHaveProperty("holder_phone");
    // 🔴 위조는 v2 까지 가지 않는다
    expect(h.checkInTicket).not.toHaveBeenCalled();
  });

  it("🔴 우리 장애(503)에도 전화번호가 없다", async () => {
    h.resolveOwnedTicketByNumber.mockRejectedValue(new h.class_TicketAccessError("v2 장애"));
    const res = await post(goodBody());
    expect(res.status).toBe(503);
    expect(await res.text()).not.toMatch(/holder_phone|0107630/);
  });

  it("🔴 **로그**에 전화번호가 안 남는다 (런타임 인자로 확인)", async () => {
    await post(goodBody());
    const all = [...h.loggerInfo.mock.calls, ...h.loggerWarn.mock.calls, ...h.loggerError.mock.calls];
    expect(all.length, "로그가 하나는 남아야 검증이 의미 있다").toBeGreaterThan(0);
    for (const call of all) {
      const dump = JSON.stringify(call);
      expect(dump, `로그에 전화번호가 샌다: ${dump.slice(0, 120)}`).not.toMatch(/0107630|01076307731/);
      expect(dump).not.toMatch(/"phone"|holder_phone/);
    }
  });
});

describe("🔴 실행 — 인증·고정 경계", () => {
  it("키 미설정이면 503 (열린 채로 두지 않는다)", async () => {
    delete process.env.ONSITE_CHECKIN_KEY;
    const res = await post(goodBody());
    expect(res.status).toBe(503);
    expect(h.checkInTicket).not.toHaveBeenCalled();
  });

  it("이벤트 미설정이면 503", async () => {
    delete process.env.ONSITE_CHECKIN_EVENT_ID;
    expect((await post(goodBody())).status).toBe(503);
  });

  it("🔴 헤더가 없으면 401 — 인증 없이 통과하지 않는다", async () => {
    expect((await post(goodBody(), null)).status).toBe(401);
  });

  it("🔴 요청 본문의 event_id 로 행사를 바꿀 수 없다", async () => {
    await post(goodBody({ event_id: "99999999-9999-9999-9999-999999999999" }));
    // 고정 env 값으로만 조회한다
    expect(h.resolvePublicEventById).toHaveBeenCalledWith(EVENT, expect.anything());
  });

  it("잘못된 scanned_at 형식은 400", async () => {
    const res = await post(goodBody({ scanned_at: "어제 저녁" }));
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe("invalid");
    expect(h.checkInTicket).not.toHaveBeenCalled();
  });

  it("qr 이 비면 400", async () => {
    expect((await post(goodBody({ qr: "" }))).status).toBe(400);
  });
});

describe("🔴 실행 — 신원 폴백", () => {
  it("attendees 가 없으면 구매자 이름·번호로 떨어진다", async () => {
    h.poolQuery.mockResolvedValue({ rows: [] });
    const body = await (await post(goodBody())).json();
    expect(body.holder_name).toBe("구매자김");
    expect(body.holder_phone).toBe("01099998888");
  });

  it("🔴 go DB 장애여도 **입장은 성공**한다", async () => {
    h.poolQuery.mockRejectedValue(new Error("go DB 장애"));
    const res = await post(goodBody());
    expect(res.status, "부가 정보 때문에 게이트에서 사람을 세우면 안 된다").toBe(200);
    expect((await res.json()).holder_name).toBe("구매자김");
  });

  it("둘 다 없으면 빈 문자열 (null 아님)", async () => {
    h.poolQuery.mockResolvedValue({ rows: [] });
    h.resolveOwnedTicketByNumber.mockResolvedValue({
      ticket_id: "22222222-2222-2222-2222-222222222222",
      ticket_number: TICKET_NO, status: "active", checked_in_at: null,
      raffle_number: null, product_name: null,
      order: { buyer: null },
    });
    const body = await (await post(goodBody())).json();
    expect(body.holder_name).toBe("");
    expect(body.holder_phone).toBe("");
    expect(body.raffle_no).toBeNull();
  });
});
