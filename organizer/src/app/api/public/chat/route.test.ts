import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

// 공개 챗봇 라우트 회귀 — go 자체 LLM 챗봇 폐기 후 v2 `/api/v1/chat` 프록시 계약 검증.
const { checkRateLimit } = vi.hoisted(() => ({ checkRateLimit: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import { POST } from "@/app/api/public/chat/route";

function request(body: unknown, headers: Record<string, string> = {}) {
  // 라우트는 NextRequest 의 .headers/.json() 만 사용 — 표준 Request 로 충분(테스트용 캐스트).
  return new Request("http://localhost/api/public/chat", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

const OLD_ENV = process.env.V2_INTERNAL_BASE_URL;

describe("공개 챗봇 → v2 라우팅", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    checkRateLimit.mockResolvedValue({ success: true, remaining: 9, resetAt: Date.now() + 60_000, limit: 10 });
    process.env.V2_INTERNAL_BASE_URL = "https://v2.example.test";
  });

  afterEach(() => {
    process.env.V2_INTERNAL_BASE_URL = OLD_ENV;
    vi.restoreAllMocks();
  });

  it("IP 레이트리밋 초과 시 429 로 조기 종료(외부 호출 없음)", async () => {
    checkRateLimit.mockResolvedValueOnce({ success: false, resetAt: Date.now() + 10_000, remaining: 0, limit: 10 });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const res = await POST(request({ message: "안녕하세요" }));
    expect(res.status).toBe(429);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("V2_INTERNAL_BASE_URL 미설정 시 503", async () => {
    delete process.env.V2_INTERNAL_BASE_URL;
    const res = await POST(request({ message: "안녕하세요" }));
    expect(res.status).toBe(503);
  });

  it("message·sessionKey 를 v2 /api/v1/chat 로 전달하고 응답을 go 계약으로 매핑", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ response: "환불은 마이페이지에서 가능합니다.", tier: 0, conversation_id: "conv-123", escalated: true }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const res = await POST(request({ eventId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301", sessionKey: "sess-abcd1234", message: "환불 어떻게 하나요" }));
    expect(res.status).toBe(200);

    // v2 호출 URL·바디 검증
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(String(url)).toBe("https://v2.example.test/api/v1/chat");
    const sentBody = JSON.parse(String((init as RequestInit).body));
    expect(sentBody).toMatchObject({
      message: "환불 어떻게 하나요",
      conversation_id: "sess-abcd1234",
      // eventId → v2 event_id 로 전달(이벤트별 context 주입).
      event_id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    });

    // go 계약 매핑: reply / sessionKey(=conversation_id) / escalate
    const payload = (await res.json()) as { data: { reply: string; sessionKey: string; escalate: boolean } };
    expect(payload.data.reply).toBe("환불은 마이페이지에서 가능합니다.");
    expect(payload.data.sessionKey).toBe("conv-123");
    expect(payload.data.escalate).toBe(true);
  });

  it("sessionKey 없으면 conversation_id=null 로 전달(신규 대화)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ response: "안녕하세요!", tier: 0, conversation_id: "conv-new", escalated: false }), { status: 200 }),
    );
    await POST(request({ message: "안녕" }));
    const sentBody = JSON.parse(String((fetchSpy.mock.calls[0]![1] as RequestInit).body));
    expect(sentBody.conversation_id).toBeNull();
    // eventId 없으면 event_id=null(글로벌 CS 로 동작).
    expect(sentBody.event_id).toBeNull();
  });

  it("v2 429 를 사용자 429 로 패스스루", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("rate limited", { status: 429 }));
    const res = await POST(request({ message: "안녕" }));
    expect(res.status).toBe(429);
  });

  it("v2 5xx 는 502 로 매핑", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("boom", { status: 500 }));
    const res = await POST(request({ message: "안녕" }));
    expect(res.status).toBe(502);
  });

  it("빈 메시지는 400", async () => {
    const res = await POST(request({ message: "" }));
    expect(res.status).toBe(400);
  });

  it("공백만 있는 메시지도 400", async () => {
    const res = await POST(request({ message: "   \t\n" }));
    expect(res.status).toBe(400);
  });
});
