/**
 * 레벨2 컷오버 W5-MSG — 공개 트래킹 픽셀/클릭 + 인바운드 이메일 웹훅의 v2 재배선 회귀.
 *
 * 고정하는 것:
 *   ① 트래킹: go DB SQL 0. 기록 실패해도 **픽셀/리다이렉트는 정상 반환**
 *      (지표 손실 < 메일 렌더 파손·수신자 링크 차단). 이건 의도적 fail-open 이며,
 *      원장이 아니라 관측 데이터라서 허용된다.
 *   ② 서명 검증 실패는 기록도 리다이렉트도 하지 않는다(오픈 리다이렉트 차단 유지).
 *   ③ 인바운드 웹훅: **안정 멱등키**(발신자+제목+본문 해시)로 적재. provider 재시도가
 *      같은 메일을 두 통으로 만들면 안 된다.
 *   ④ 인바운드 적재 실패는 5xx — 200 을 주면 provider 가 재시도하지 않아 메일이 유실된다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  recordEmailTracking: vi.fn(),
  ingestInboundEmail: vi.fn(),
  verifyTrackingToken: vi.fn(),
  verifyClickToken: vi.fn(),
  poolQuery: vi.fn(),
}));

vi.mock("@/lib/v2/messaging-ledger-client", () => ({
  recordEmailTracking: h.recordEmailTracking,
  ingestInboundEmail: h.ingestInboundEmail,
}));
vi.mock("@/lib/notification/tracking", () => ({
  verifyTrackingToken: h.verifyTrackingToken,
  verifyClickToken: h.verifyClickToken,
}));
vi.mock("@/lib/db/pool", () => ({ getPool: () => ({ query: h.poolQuery }) }));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
  maskPII: (v: string) => v,
}));

import { GET as openGET } from "@/app/api/track/open/route";
import { GET as clickGET } from "@/app/api/track/click/route";
import { POST as inboundPOST } from "@/app/api/webhooks/inbound-email/route";
import { NextRequest } from "next/server";

beforeEach(() => {
  vi.clearAllMocks();
  h.recordEmailTracking.mockResolvedValue({ delivery: true, campaign_recipient: false });
  h.ingestInboundEmail.mockResolvedValue({ id: "mail-1" });
  h.poolQuery.mockResolvedValue({ rows: [{ event_id: "evt-1", account_id: "acc-1" }], rowCount: 1 });
  process.env.INBOUND_EMAIL_SECRET = "hook-secret";
});

describe("오픈 트래킹 픽셀", () => {
  it("① 유효 토큰: v2 에 기록하고 픽셀 반환(go DB SQL 0)", async () => {
    h.verifyTrackingToken.mockReturnValue({ messageId: "m1", contact: "a@b.test" });
    const res = await openGET(new Request("https://go.test/api/track/open?t=tok"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/gif");
    expect(h.recordEmailTracking).toHaveBeenCalledWith("m1", "a@b.test", false);
  });

  it("① 기록 실패해도 픽셀은 반환(메일 렌더 보호)", async () => {
    h.verifyTrackingToken.mockReturnValue({ messageId: "m1", contact: "a@b.test" });
    h.recordEmailTracking.mockRejectedValue(new Error("ledger down"));
    const res = await openGET(new Request("https://go.test/api/track/open?t=tok"));
    expect(res.status).toBe(200);
  });

  it("② 서명 무효면 기록하지 않는다", async () => {
    h.verifyTrackingToken.mockReturnValue(null);
    const res = await openGET(new Request("https://go.test/api/track/open?t=bad"));
    expect(res.status).toBe(200);
    expect(h.recordEmailTracking).not.toHaveBeenCalled();
  });
});

describe("클릭 트래킹 리다이렉트", () => {
  const url = "https://go.test/api/track/click?t=tok&u=https%3A%2F%2Fexample.test%2Fa";

  it("① 유효 토큰: clicked=true 로 기록 후 302", async () => {
    h.verifyClickToken.mockReturnValue({ messageId: "m1", contact: "a@b.test" });
    const res = await clickGET(new Request(url));
    expect(res.status).toBe(302);
    expect(h.recordEmailTracking).toHaveBeenCalledWith("m1", "a@b.test", true);
  });

  it("① 기록 실패해도 리다이렉트는 막지 않는다", async () => {
    h.verifyClickToken.mockReturnValue({ messageId: "m1", contact: "a@b.test" });
    h.recordEmailTracking.mockRejectedValue(new Error("ledger down"));
    expect((await clickGET(new Request(url))).status).toBe(302);
  });

  it("② 서명 불일치는 400 — 리다이렉트도 기록도 없다(오픈 리다이렉트 차단)", async () => {
    h.verifyClickToken.mockReturnValue(null);
    const res = await clickGET(new Request(url));
    expect(res.status).toBe(400);
    expect(h.recordEmailTracking).not.toHaveBeenCalled();
  });

  it("② javascript: 스킴은 검증 이전에 400", async () => {
    const res = await clickGET(
      new Request("https://go.test/api/track/click?t=tok&u=javascript%3Aalert(1)"),
    );
    expect(res.status).toBe(400);
    expect(h.verifyClickToken).not.toHaveBeenCalled();
  });
});

describe("인바운드 이메일 웹훅", () => {
  const body = { from: "a@b.test", subject: "문의", text: "안녕하세요" };
  const hook = (payload: unknown, secret = "hook-secret") =>
    new NextRequest("https://go.test/api/webhooks/inbound-email", {
      method: "POST",
      headers: { "x-webhook-secret": secret, "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

  it("③ 같은 메일은 같은 멱등키 — 재시도가 두 통을 만들지 않는다", async () => {
    await inboundPOST(hook(body));
    await inboundPOST(hook(body));
    const [, key1] = h.ingestInboundEmail.mock.calls[0] as [unknown, string];
    const [, key2] = h.ingestInboundEmail.mock.calls[1] as [unknown, string];
    expect(key1).toMatch(/^[a-f0-9]{64}$/);
    expect(key1).toBe(key2);
  });

  it("③ 내용이 다르면 다른 멱등키(정상 신규 메일은 막지 않는다)", async () => {
    await inboundPOST(hook(body));
    await inboundPOST(hook({ ...body, text: "다른 내용" }));
    const [, key1] = h.ingestInboundEmail.mock.calls[0] as [unknown, string];
    const [, key2] = h.ingestInboundEmail.mock.calls[1] as [unknown, string];
    expect(key1).not.toBe(key2);
  });

  it("참석자 매칭으로 얻은 account_id/event_id 를 함께 넘긴다(테넌트 경계 강화)", async () => {
    await inboundPOST(hook(body));
    expect(h.ingestInboundEmail).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc-1", eventId: "evt-1", fromEmail: "a@b.test" }),
      expect.any(String),
    );
  });

  it("매칭 실패(go 조회 오류)여도 미분류로 적재는 계속한다", async () => {
    h.poolQuery.mockRejectedValue(new Error("attendees down"));
    const res = await inboundPOST(hook(body));
    expect(res.status).toBe(200);
    expect(h.ingestInboundEmail).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: null, eventId: null }),
      expect.any(String),
    );
  });

  it("④ 적재 실패는 502 — 200 을 주면 provider 가 재시도하지 않아 메일이 유실된다", async () => {
    h.ingestInboundEmail.mockRejectedValue(new Error("ledger down"));
    const res = await inboundPOST(hook(body));
    expect(res.status).toBe(502);
  });

  it("시크릿 불일치는 401(적재 없음)", async () => {
    const res = await inboundPOST(hook(body, "wrong"));
    expect(res.status).toBe(401);
    expect(h.ingestInboundEmail).not.toHaveBeenCalled();
  });

  it("발신자 없는 페이로드는 400", async () => {
    const res = await inboundPOST(hook({ subject: "x" }));
    expect(res.status).toBe(400);
    expect(h.ingestInboundEmail).not.toHaveBeenCalled();
  });
});
