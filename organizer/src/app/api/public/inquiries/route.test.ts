import { beforeEach, describe, expect, it, vi } from "vitest";

const { getPool, checkRateLimit, getEventBySlug, submitEventInquiry, MockV2CommerceError } =
  vi.hoisted(() => {
    class MockV2CommerceError extends Error {
      constructor(message: string, readonly status: number) {
        super(message);
        this.name = "V2CommerceError";
      }
    }
    return {
      getPool: vi.fn(),
      checkRateLimit: vi.fn(),
      getEventBySlug: vi.fn(),
      submitEventInquiry: vi.fn(),
      MockV2CommerceError,
    };
  });
vi.mock("@/lib/db/pool", () => ({ getPool }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit }));
// W2-PUB: 이벤트 조회가 go `events` SELECT → v2 by-slug live read 로 바뀌었다.
// W5-SUPPORT: 문의 저장도 go `INSERT INTO event_inquiries` → v2 `submitEventInquiry` 로 바뀌었다.
vi.mock("@/lib/v2/commerce-client", () => ({
  V2CommerceError: MockV2CommerceError,
  getEvent: vi.fn(),
  getEventBySlug,
  submitEventInquiry,
}));

import { POST } from "@/app/api/public/inquiries/route";

function request(body: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/public/inquiries", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("public inquiry abuse controls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimit.mockResolvedValue({ success: true, remaining: 4, resetAt: Date.now() + 60_000, limit: 5 });
    getEventBySlug.mockResolvedValue({
      event_id: "event-1",
      slug: "live",
      status: "live",
      go_account_id: "account-1",
    });
    submitEventInquiry.mockResolvedValue({ id: "inq-1" });
    getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [] }) });
  });

  it("does not write when the IP bucket is exhausted", async () => {
    checkRateLimit.mockResolvedValueOnce({ success: false, resetAt: Date.now() + 10_000, remaining: 0, limit: 5 });
    const response = await POST(request({ slug: "live", question: "hello there" }));
    expect(response.status).toBe(429);
    expect(submitEventInquiry).not.toHaveBeenCalled();
    expect(getEventBySlug).not.toHaveBeenCalled();
  });

  it("applies event and fingerprint buckets without putting PII in the key", async () => {
    const response = await POST(request({ slug: "live", question: "same question", contact: "person@example.test" }));
    expect(response.status).toBe(201);
    expect(checkRateLimit).toHaveBeenCalledTimes(3);
    for (const [key] of checkRateLimit.mock.calls) {
      expect(String(key)).not.toContain("person@example.test");
      expect(String(key)).not.toContain("same question");
    }
    expect(checkRateLimit.mock.calls[0]?.[1]).toMatchObject({ onRedisError: "closed" });
    // 저장은 v2 원장으로 간다(go DB 아님).
    expect(submitEventInquiry).toHaveBeenCalledWith("event-1", {
      question: "same question",
      contact: "person@example.test",
      source: "web",
    });
  });

  it("blocks a repeated fingerprint before the insert", async () => {
    checkRateLimit
      .mockResolvedValueOnce({ success: true, resetAt: Date.now() + 60_000 })
      .mockResolvedValueOnce({ success: true, resetAt: Date.now() + 60_000 })
      .mockResolvedValueOnce({ success: false, resetAt: Date.now() + 10_000 });
    const response = await POST(request({ slug: "live", question: "repeat me" }));
    expect(response.status).toBe(429);
    // 이벤트 조회는 v2 로 갔고, 지문 차단 시점에 원장 write 는 아직 없다.
    expect(getEventBySlug).toHaveBeenCalledTimes(1);
    expect(submitEventInquiry).not.toHaveBeenCalled();
  });

  it("supports a honeypot and rejects oversized bodies", async () => {
    const honeypot = await POST(request({ slug: "live", question: "hello bot", website: "https://spam.test" }));
    expect(honeypot.status).toBe(202);
    expect(submitEventInquiry).not.toHaveBeenCalled();

    const oversized = await POST(new Request("http://localhost/api/public/inquiries", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "20000" },
      body: JSON.stringify({ slug: "live", question: "x".repeat(1000) }),
    }));
    expect(oversized.status).toBe(413);
  });
});

describe("public inquiry — W2-PUB 이벤트 해석 (v2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimit.mockResolvedValue({ success: true, remaining: 4, resetAt: Date.now() + 60_000, limit: 5 });
    submitEventInquiry.mockResolvedValue({ id: "inq-1" });
    getPool.mockReturnValue({ query: vi.fn().mockResolvedValue({ rows: [] }) });
  });

  it("paused 이벤트도 문의를 받는다(옛 status IN ('live','paused') 게이트 유지)", async () => {
    getEventBySlug.mockResolvedValue({
      event_id: "event-1", slug: "paused-ev", status: "paused", go_account_id: "account-1",
    });
    const res = await POST(request({ slug: "paused-ev", question: "언제 재개하나요" }));
    expect(res.status).toBe(201);
  });

  it("🔴 draft 이벤트는 404 (비공개 이벤트로 문의 인입 금지)", async () => {
    getEventBySlug.mockResolvedValue({
      event_id: "event-1", slug: "draft-ev", status: "draft", go_account_id: "account-1",
    });
    const res = await POST(request({ slug: "draft-ev", question: "비공개 이벤트 문의" }));
    expect(res.status).toBe(404);
    expect(submitEventInquiry).not.toHaveBeenCalled();
  });

  it("미존재 slug 는 404", async () => {
    getEventBySlug.mockRejectedValue(new MockV2CommerceError("nope", 404));
    const res = await POST(request({ slug: "ghost", question: "없는 이벤트 문의" }));
    expect(res.status).toBe(404);
  });

  it("🔴 v2 장애는 404 가 아니라 503 (문의가 조용히 삼켜지면 안 된다)", async () => {
    getEventBySlug.mockRejectedValue(new MockV2CommerceError("down", 500));
    const res = await POST(request({ slug: "live", question: "커머스 장애 중 문의" }));
    expect(res.status).toBe(503);
    expect(submitEventInquiry).not.toHaveBeenCalled();
  });

  it("W5-SUPPORT: go account 미연동(v2 네이티브) 이벤트도 접수한다", async () => {
    // 옛 계약은 404 였다 — go `event_inquiries.account_id` 가 NOT NULL 이라 저장할 수 없었기
    // 때문이다. v2 원장은 account 축 없이 events FK 로만 매달리므로(경계=organizer_id) 그
    // 제약이 사라졌고, 유지하면 정상 이벤트의 문의를 이유 없이 거부하게 된다.
    getEventBySlug.mockResolvedValue({
      event_id: "event-1", slug: "v2native", status: "live", go_account_id: null,
    });
    const res = await POST(request({ slug: "v2native", question: "v2 네이티브 이벤트" }));
    expect(res.status).toBe(201);
    expect(submitEventInquiry).toHaveBeenCalledWith("event-1", {
      question: "v2 네이티브 이벤트",
      contact: null,
      source: "web",
    });
  });

  it("🔴 v2 저장 실패는 200 으로 흡수하지 않는다 (접수 안 됐는데 접수됐다고 하면 안 된다)", async () => {
    getEventBySlug.mockResolvedValue({
      event_id: "event-1", slug: "live", status: "live", go_account_id: "account-1",
    });
    submitEventInquiry.mockRejectedValue(new MockV2CommerceError("insert failed", 500));
    const res = await POST(request({ slug: "live", question: "저장 실패 시나리오" }));
    expect(res.status).toBe(503);
  });

  it("🔴 v2 4xx 도 5xx 로 되돌린다 (소비자 입력 잘못이 아니다)", async () => {
    getEventBySlug.mockResolvedValue({
      event_id: "event-1", slug: "live", status: "live", go_account_id: "account-1",
    });
    submitEventInquiry.mockRejectedValue(new MockV2CommerceError("event not found", 404));
    const res = await POST(request({ slug: "live", question: "이벤트 소실 시나리오" }));
    expect(res.status).toBe(503);
  });
});
