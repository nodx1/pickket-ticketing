import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 🔴 현장업체 API — **응답을 실제로 만들어 본다** (2026-08-11)
 *
 * ## 왜 이 파일이 생겼나
 *
 * 옆 파일(`onsite-route.test.ts`) 16건은 전부 **소스 문자열 검사**였다.
 * `expect(s).toMatch(/result:\s*admitted\.outcome/)` — 코드에 그 줄이 있는지만 본다.
 * 라우트를 호출한 횟수는 **0** 이었다.
 *
 * 그래서 업체에 나갈 성공 응답(`admitted`·`reentry_ok`·이름·번호·경품번호)을
 * **아무도 한 번도 못 봤다.** 프로덕션에서도 못 본다 — 입장일 게이트(08-20~23) 때문에
 * 대회 전에는 `not_admission_day` 밖에 안 나온다.
 *
 * ## 무엇을 목킹하고 무엇을 실행하는가
 *
 * ```
 * 목킹   admit 모듈(판정) · rate limit · server-only
 *        ⟹ 판정 자체는 `admit.test.ts` 34건이 **실제 호출**로 따로 검증한다
 * 실행   🔴 라우트 핸들러 전체 — 인증·본문파싱·상태코드·**판정→JSON 매핑**
 *        그 매핑이 업체가 받는 계약이고, 지금까지 아무도 안 본 자리다
 * ```
 */

const KEY = "test-onsite-key-0123456789";
const EVENT = "11111111-2222-3333-4444-555555555555";
const TICKET = "TKT-0000AAAA1111";

vi.mock("server-only", () => ({}));

/** rate limit HOF 는 그대로 통과시킨다(한도는 별도 검증 대상). */
vi.mock("@/lib/auth/withRateLimit", () => ({
  withRateLimit: () => (h: (r: Request) => Promise<Response>) => h,
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/v2/public-event", () => ({
  PUBLIC_ANY_STATUS: "any",
  resolvePublicEventById: vi.fn(async () => ({ ok: true, event: { go_account_id: "acc-1" } })),
}));

const resolveScanPayload = vi.fn();
const admitTicketByNumber = vi.fn();
vi.mock("@/lib/checkin/admit", () => ({ resolveScanPayload, admitTicketByNumber }));

const OK_TICKET = {
  ticket_number: TICKET,
  product_name: "주중권 (목 1R ~ 금 2R)",
  raffle_number: 100123,
};

function admitOk(over: Record<string, unknown> = {}) {
  return {
    ok: true,
    outcome: "admitted",
    ticket: OK_TICKET,
    holder: { name: "참석자박", phone: "01012345678" },
    attendedDate: "2026-08-20",
    ...over,
  };
}

async function post(body: unknown, key: string = KEY) {
  const { POST } = await import("@/app/api/onsite/checkin/route");
  return POST(
    new Request("https://go.pickket.kr/api/onsite/checkin", {
      method: "POST",
      headers: { "content-type": "application/json", "x-onsite-key": key },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  process.env.ONSITE_CHECKIN_KEY = KEY;
  process.env.ONSITE_CHECKIN_EVENT_ID = EVENT;
  resolveScanPayload.mockReset().mockReturnValue({ ok: true, ticketNumber: TICKET });
  admitTicketByNumber.mockReset().mockResolvedValue(admitOk());
});

afterEach(() => {
  delete process.env.ONSITE_CHECKIN_KEY;
  delete process.env.ONSITE_CHECKIN_EVENT_ID;
});

describe("🔴 성공 응답 — 업체가 실제로 받는 JSON", () => {
  it("🔴 첫 입장 200 admitted · 7필드가 **명세서 그대로** 나온다", async () => {
    const res = await post({ qr: "PKT:x", device_id: "GATE-A-01" });
    expect(res.status).toBe(200);
    // 🔴 명세서 01_현장입장API_명세서_v2.md §2 와 한 글자도 어긋나면 안 된다.
    expect(await res.json()).toEqual({
      result: "admitted",
      ticket_no: TICKET,
      holder_name: "참석자박",
      holder_phone: "01012345678",
      tier: "주중권 (목 1R ~ 금 2R)",
      raffle_no: 100123,
      attended_date: "2026-08-20",
    });
  });

  it("🔴 재입장은 **200 reentry_ok** — 403 이 아니다", async () => {
    admitTicketByNumber.mockResolvedValue(admitOk({ outcome: "reentry_ok" }));
    const res = await post({ qr: "PKT:x" });
    expect(res.status, "재입장을 막으면 점심 먹고 온 손님이 게이트에 갇힌다").toBe(200);
    expect((await res.json()).result).toBe("reentry_ok");
  });

  it("🔴 두 결과가 **갈린다** — 화면에 admitted 를 박아두지 않았다", async () => {
    const first = await (await post({ qr: "PKT:x" })).json();
    admitTicketByNumber.mockResolvedValue(admitOk({ outcome: "reentry_ok" }));
    const second = await (await post({ qr: "PKT:x" })).json();
    // 기념품은 admitted 에만 나간다. 뭉치면 두 번 나간다.
    expect(first.result).not.toBe(second.result);
  });

  it("🔴 전화번호는 하이픈 없는 숫자열이다 — 명세서에 그렇게 못박았다", async () => {
    const j = await (await post({ qr: "PKT:x" })).json();
    expect(j.holder_phone).toBe("01012345678");
    expect(j.holder_phone).not.toMatch(/-/);
  });

  it("경품번호가 없으면 null 이다 — 0 이나 빈 문자열이 아니다", async () => {
    admitTicketByNumber.mockResolvedValue(
      admitOk({ ticket: { ...OK_TICKET, raffle_number: null } }),
    );
    expect((await (await post({ qr: "PKT:x" })).json()).raffle_no).toBeNull();
  });

  it("등급명이 없어도 빈 문자열로 채운다 — 필드를 빠뜨리지 않는다", async () => {
    admitTicketByNumber.mockResolvedValue(
      admitOk({ ticket: { ...OK_TICKET, product_name: null } }),
    );
    const j = await (await post({ qr: "PKT:x" })).json();
    expect(j.tier).toBe("");
    expect(Object.keys(j).sort()).toEqual(
      ["attended_date", "holder_name", "holder_phone", "raffle_no", "result", "ticket_no", "tier"],
    );
  });
});

describe("🔴 거부 응답에는 개인정보가 없다", () => {
  it("🔴 403 에 이름·번호가 실리지 않는다 — 스캐너 로그가 연락처 명단이 되면 안 된다", async () => {
    admitTicketByNumber.mockResolvedValue({
      ok: false,
      reason: "not_admission_day",
      message: "오늘은 입장 가능일이 아닙니다",
      status: 403,
    });
    const res = await post({ qr: "PKT:x" });
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body, "번호가 거부 응답에 샜다").not.toMatch(/010|holder/);
    expect(JSON.parse(body)).toEqual({
      result: "rejected",
      reason: "not_admission_day",
      message: "오늘은 입장 가능일이 아닙니다",
    });
  });

  it("🔴 없는 티켓(404)은 **403 으로 접어** 내보낸다 — 명세서에 404 는 없다", async () => {
    admitTicketByNumber.mockResolvedValue({
      ok: false, reason: "not_found", message: "등록되지 않은 티켓입니다", status: 404,
    });
    const res = await post({ qr: "PKT:x" });
    expect(res.status).toBe(403);
    expect((await res.json()).reason).toBe("not_found");
  });

  it("🔴 우리 장애는 result:\"error\" 5xx 다 — 업체가 통과시켜야 하는 유일한 실패", async () => {
    admitTicketByNumber.mockResolvedValue({
      ok: false, reason: "unavailable", message: "입장 처리 중 오류가 발생했습니다.", status: 502,
    });
    const res = await post({ qr: "PKT:x" });
    expect(res.status).toBe(502);
    const j = await res.json();
    expect(j.result, "rejected 로 나가면 업체가 손님을 돌려보낸다").toBe("error");
    expect(j.reason).toBeUndefined();
  });

  it("401 에도 아무것도 안 실린다", async () => {
    const res = await post({ qr: "PKT:x" }, "wrong-key");
    expect(res.status).toBe(401);
    expect(await res.text()).not.toMatch(/holder|010/);
  });

  it("🔴 키가 맞아도 **미설정이면 열리지 않는다**", async () => {
    delete process.env.ONSITE_CHECKIN_EVENT_ID;
    const res = await post({ qr: "PKT:x" });
    expect(res.status).toBe(503);
    expect(admitTicketByNumber).not.toHaveBeenCalled();
  });
});

describe("🔴 오프라인 큐 — 현장 시각으로 기록한다", () => {
  it("🔴 scanned_at 을 판정에 **넘긴다** — 안 넘기면 이틀치가 오늘로 뭉친다", async () => {
    await post({ qr: "PKT:x", scanned_at: "2026-08-20T09:12:33+09:00" });
    expect(admitTicketByNumber.mock.calls[0][0].at).toBe("2026-08-20T09:12:33+09:00");
  });

  it("scanned_at 이 없으면 null 을 넘긴다(현재 시각으로 기록)", async () => {
    await post({ qr: "PKT:x" });
    expect(admitTicketByNumber.mock.calls[0][0].at).toBeNull();
  });

  it("🔴 형식이 깨진 scanned_at 은 400 이고 판정까지 가지 않는다", async () => {
    const res = await post({ qr: "PKT:x", scanned_at: "어제" });
    expect(res.status).toBe(400);
    expect(admitTicketByNumber, "쓰레기 시각으로 원장에 쓰면 안 된다").not.toHaveBeenCalled();
  });

  it("device_id 는 64자로 자른다", async () => {
    const res = await post({ qr: "PKT:x", device_id: "G".repeat(200) });
    expect(res.status).toBe(200);
  });
});
