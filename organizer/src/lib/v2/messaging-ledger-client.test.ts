/**
 * W5-MSG 발송 원장 클라이언트 — **fail-closed 계약** 회귀.
 *
 * 이 프로젝트에서 "조회 실패 → 빈 목록" 결함이 두 번 났다(lotteryWon·productIds 세그먼트).
 * 발송 원장에서 같은 실수가 나면 더 나쁘다:
 *   · 발송 상세가 "0명에게 보냄"으로 보이고(실제로는 확인 불가),
 *   · 미확정(unknown) 큐가 비어 보여 **수동검토가 필요한 건이 통째로 사라진다**.
 *
 * 고정하는 것:
 *   ① env 미설정 = 실패(빈 결과 아님)
 *   ② 네트워크 오류 = 실패
 *   ③ 비-2xx / ok:false = 실패 + status 보존
 *   ④ 단건 조회의 404 만 null(정상 결과) — 그 외는 전부 throw
 *   ⑤ HMAC 서명 헤더 + Idempotency-Key 전달
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  claimUnknownDeliveries,
  getCampaign,
  getEventMessage,
  ingestInboundEmail,
  ledgerErrorStatus,
  listDeliveryQueue,
  listEventMessages,
  listMessageDeliveries,
  V2MessagingLedgerError,
} from "./messaging-ledger-client";

const fetchMock = vi.fn();

function envelope(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => ({ ok: status < 400, data }),
  } as unknown as Response;
}

function errorEnvelope(status: number, message = "boom") {
  return {
    ok: false,
    status,
    json: async () => ({ ok: false, error: { code: "X", message } }),
  } as unknown as Response;
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  process.env.V2_INTERNAL_BASE_URL = "https://api.test";
  process.env.GO_WEBHOOK_SECRET = "secret";
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.V2_INTERNAL_BASE_URL;
  delete process.env.GO_WEBHOOK_SECRET;
});

describe("① env 미설정 — 빈 결과가 아니라 실패", () => {
  it("base URL 이 없으면 목록 조회가 throw 한다", async () => {
    delete process.env.V2_INTERNAL_BASE_URL;
    await expect(listEventMessages("acc", "evt")).rejects.toBeInstanceOf(V2MessagingLedgerError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("secret 이 없으면 미확정 큐 조회가 throw 한다(빈 큐로 위장 금지)", async () => {
    delete process.env.GO_WEBHOOK_SECRET;
    await expect(listDeliveryQueue("acc", "unknown", 50)).rejects.toBeInstanceOf(
      V2MessagingLedgerError,
    );
  });
});

describe("② 네트워크 오류 — 실패", () => {
  it("fetch 가 던지면 throw 한다", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(claimUnknownDeliveries(10)).rejects.toBeInstanceOf(V2MessagingLedgerError);
  });
});

describe("③ 비정상 응답 — 실패 + status 보존", () => {
  it("503 은 V2MessagingLedgerError(status=503)", async () => {
    fetchMock.mockResolvedValue(errorEnvelope(503));
    await expect(listEventMessages("acc", "evt")).rejects.toMatchObject({ status: 503 });
  });

  it("200 이지만 ok:false 인 봉투도 실패로 취급", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ ok: false, error: { message: "denied" } }),
    } as unknown as Response);
    await expect(listEventMessages("acc", "evt")).rejects.toBeInstanceOf(V2MessagingLedgerError);
  });

  it("ledgerErrorStatus: 404 만 404, 나머지는 503(재시도 가능)", () => {
    expect(ledgerErrorStatus(new V2MessagingLedgerError("x", 404))).toBe(404);
    expect(ledgerErrorStatus(new V2MessagingLedgerError("x", 500))).toBe(503);
    expect(ledgerErrorStatus(new V2MessagingLedgerError("x"))).toBe(503);
  });
});

describe("④ 404 만 null — 그 외는 throw", () => {
  it("getEventMessage: 404 → null", async () => {
    fetchMock.mockResolvedValue(errorEnvelope(404));
    await expect(getEventMessage("acc", "evt", "msg")).resolves.toBeNull();
  });

  it("getEventMessage: 503 → throw(없음으로 강등 금지)", async () => {
    fetchMock.mockResolvedValue(errorEnvelope(503));
    await expect(getEventMessage("acc", "evt", "msg")).rejects.toBeInstanceOf(
      V2MessagingLedgerError,
    );
  });

  it("listMessageDeliveries: 404 → null, 502 → throw", async () => {
    fetchMock.mockResolvedValue(errorEnvelope(404));
    await expect(
      listMessageDeliveries("acc", "evt", "msg", { limit: 10, offset: 0 }),
    ).resolves.toBeNull();
    fetchMock.mockResolvedValue(errorEnvelope(502));
    await expect(
      listMessageDeliveries("acc", "evt", "msg", { limit: 10, offset: 0 }),
    ).rejects.toBeInstanceOf(V2MessagingLedgerError);
  });

  it("getCampaign: 404 → null", async () => {
    fetchMock.mockResolvedValue(errorEnvelope(404));
    await expect(getCampaign("acc", "evt", "cmp")).resolves.toBeNull();
  });
});

describe("⑤ 인증 헤더 · 멱등키", () => {
  it("HMAC 서명·타임스탬프·서비스 토큰을 함께 보낸다", async () => {
    fetchMock.mockResolvedValue(envelope({ messages: [] }));
    await listEventMessages("acc", "evt");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.test/api/v1/internal/messaging/messages/list");
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Pickket-Signature"]).toMatch(/^[a-f0-9]{64}$/);
    expect(headers["X-Pickket-Timestamp"]).toBeTruthy();
    expect(headers["X-Pickket-Service-Token"]).toBe("secret");
    // 멱등키가 필요 없는 조회에는 붙이지 않는다.
    expect(headers["Idempotency-Key"]).toBeUndefined();
  });

  it("인바운드 적재는 호출자가 준 **안정 멱등키**를 그대로 헤더로 전달한다", async () => {
    fetchMock.mockResolvedValue(envelope({ id: "mail-1" }));
    await ingestInboundEmail({ fromEmail: "a@b.test" }, "stable-key-123");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("stable-key-123");
  });

  it("정상 응답은 data 를 그대로 돌려준다(빈 배열 폴백 아님)", async () => {
    fetchMock.mockResolvedValue(envelope({ messages: [{ id: "m1" }] }));
    await expect(listEventMessages("acc", "evt")).resolves.toEqual([{ id: "m1" }]);
  });
});
