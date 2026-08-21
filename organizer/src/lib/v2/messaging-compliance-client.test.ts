import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  V2MessagingComplianceError,
  fetchConsents,
  fetchSuppressedContacts,
  grantConsent,
  revokeConsent,
  upsertSuppression,
} from "./messaging-compliance-client";

/**
 * W3-MSG 회귀 — 억제/동의 원장 v2 클라이언트의 **fail-closed** 계약.
 * 조회 실패를 빈 집합/false 로 바꾸면 수신거부자에게 발송된다. 모든 실패 경로를 못박는다.
 */

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const originalFetch = globalThis.fetch;

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const fn = vi.fn(impl as never);
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  process.env.V2_INTERNAL_BASE_URL = "http://v2.test";
  process.env.GO_WEBHOOK_SECRET = "test-secret";
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("fetchSuppressedContacts — fail-closed", () => {
  it("커머스 5xx 는 throw (빈 집합 폴백 금지)", async () => {
    mockFetch(() => json({ ok: false, error: { message: "boom" } }, 503));
    await expect(
      fetchSuppressedContacts(ACCOUNT, "email", ["a@x.com"]),
    ).rejects.toBeInstanceOf(V2MessagingComplianceError);
  });

  it("네트워크 오류는 throw", async () => {
    mockFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    await expect(fetchSuppressedContacts(ACCOUNT, "email", ["a@x.com"])).rejects.toThrow(
      /커머스 연결에 실패/,
    );
  });

  it("🔴 env 미설정도 실패다 — '설정이 없으니 억제 없음'으로 흘리지 않는다", async () => {
    delete process.env.V2_INTERNAL_BASE_URL;
    delete process.env.GO_WEBHOOK_SECRET;
    delete process.env.V2_EVENT_SYNC_SECRET;
    const fetchSpy = mockFetch(() => json({ ok: true, data: { suppressed: [] } }));
    await expect(fetchSuppressedContacts(ACCOUNT, "email", ["a@x.com"])).rejects.toBeInstanceOf(
      V2MessagingComplianceError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ok=false 봉투는 200 이어도 실패로 본다", async () => {
    mockFetch(() => json({ ok: false, error: { message: "거부됨" } }, 200));
    await expect(fetchSuppressedContacts(ACCOUNT, "email", ["a@x.com"])).rejects.toThrow(/거부됨/);
  });

  it("data 누락(형식 파손)도 실패 — 빈 집합으로 승격 금지", async () => {
    mockFetch(() => json({ ok: true }, 200));
    await expect(fetchSuppressedContacts(ACCOUNT, "email", ["a@x.com"])).rejects.toBeInstanceOf(
      V2MessagingComplianceError,
    );
  });

  it("정상 응답은 억제 연락처 집합을 돌려준다", async () => {
    mockFetch(() => json({ ok: true, data: { suppressed: ["drop@x.com"] } }));
    const out = await fetchSuppressedContacts(ACCOUNT, "email", ["keep@x.com", "drop@x.com"]);
    expect(out.has("drop@x.com")).toBe(true);
    expect(out.has("keep@x.com")).toBe(false);
  });

  it("HMAC 서명 헤더를 붙여 보낸다", async () => {
    const fetchSpy = mockFetch(() => json({ ok: true, data: { suppressed: [] } }));
    await fetchSuppressedContacts(ACCOUNT, "email", ["a@x.com"]);
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Pickket-Signature"]).toMatch(/^[0-9a-f]{64}$/);
    expect(headers["X-Pickket-Timestamp"]).toBeTruthy();
  });

  it("5000건 초과는 청크로 나눠 보내고 결과를 합친다", async () => {
    const contacts = Array.from({ length: 5001 }, (_, i) => `u${i}@x.com`);
    let call = 0;
    const fetchSpy = mockFetch(() => {
      call += 1;
      return json({ ok: true, data: { suppressed: [`u${call}@x.com`] } });
    });
    const out = await fetchSuppressedContacts(ACCOUNT, "email", contacts);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(out.size).toBe(2);
  });
});

describe("fetchConsents — 부재를 동의로 승격하지 않는다", () => {
  it("응답에 없는 연락처는 Map 에 없다(= 미동의)", async () => {
    mockFetch(() =>
      json({
        ok: true,
        data: { consents: [{ contact: "y@x.com", consented: true, night_consented: false }] },
      }),
    );
    const out = await fetchConsents(ACCOUNT, "email", ["y@x.com", "n@x.com"]);
    expect(out.get("y@x.com")).toEqual({ consented: true, nightConsented: false });
    expect(out.has("n@x.com")).toBe(false);
  });

  it("조회 실패는 throw (광고 게이트가 미동의로 오판하지 않도록 원인 전파)", async () => {
    mockFetch(() => json({ ok: false, error: { message: "down" } }, 500));
    await expect(fetchConsents(ACCOUNT, "email", ["a@x.com"])).rejects.toBeInstanceOf(
      V2MessagingComplianceError,
    );
  });
});

describe("write 경로", () => {
  it("upsertSuppression 은 전역(accountId=null)도 보낼 수 있다", async () => {
    const fetchSpy = mockFetch(() => json({ ok: true, data: { suppressed: true } }));
    await upsertSuppression(null, "all", "bounce@x.com", "bounce");
    const body = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({ go_account_id: null, channel: "all", reason: "bounce" });
  });

  it("upsertSuppression 실패는 throw (수신거부 처리를 성공으로 위장 금지)", async () => {
    mockFetch(() => json({ ok: false, error: { message: "nope" } }, 500));
    await expect(upsertSuppression(ACCOUNT, "email", "a@x.com", "unsubscribe")).rejects.toThrow();
  });

  it("grantConsent(consented=false) 는 withdraw 액션이 아니라 grant 로 현재상태를 남긴다", async () => {
    // 'withdraw' 는 UPDATE-only 라 행이 없으면 아무것도 남지 않는다 → go recordConsent 와 불일치.
    const fetchSpy = mockFetch(() => json({ ok: true, data: { action: "grant" } }));
    await grantConsent(ACCOUNT, "sms", "01011112222", { consented: false });
    const body = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
    expect(body.action).toBe("grant");
    expect(body.consented).toBe(false);
  });

  it("revokeConsent 는 withdraw 액션 + 사유를 보낸다", async () => {
    const fetchSpy = mockFetch(() => json({ ok: true, data: { action: "withdraw" } }));
    await revokeConsent(ACCOUNT, "email", "a@x.com", "unsubscribe");
    const body = JSON.parse(String((fetchSpy.mock.calls[0]?.[1] as RequestInit).body));
    expect(body).toMatchObject({ action: "withdraw", source: "unsubscribe" });
  });
});
