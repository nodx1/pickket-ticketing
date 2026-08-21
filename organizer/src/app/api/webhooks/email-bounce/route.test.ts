import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ suppress: vi.fn() }));
vi.mock("@/lib/notification/compliance", () => ({ suppress: (...a: unknown[]) => h.suppress(...a) }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  maskPII: (s: string) => s,
}));

import { POST } from "./route";

const SECRET = "test-bounce-secret";

function req(body: unknown, auth = `Bearer ${SECRET}`) {
  return new Request("https://go.pickket.kr/api/webhooks/email-bounce", {
    method: "POST",
    headers: { authorization: auth, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv("EMAIL_BOUNCE_SECRET", SECRET);
  h.suppress.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

/**
 * H-10 회귀: 명시 allowlist(하드바운스·컴플레인)만 억제. 빈/미지/일시 이벤트는 quarantine(억제 안 함).
 */
describe("email-bounce webhook (H-10 전역 억제 방어)", () => {
  it("하드바운스·컴플레인은 억제한다", async () => {
    const res = await POST(
      req({ events: [{ email: "a@x.com", type: "hard_bounce" }, { email: "b@x.com", type: "complaint" }] }),
    );
    const json = await res.json();
    expect(json.data.suppressed).toBe(2);
    expect(json.data.quarantined).toBe(0);
    expect(h.suppress).toHaveBeenCalledTimes(2);
  });

  it("빈 type·미지 이벤트는 억제하지 않고 quarantine 한다", async () => {
    const res = await POST(
      req({
        events: [
          { email: "a@x.com", type: "" },
          { email: "b@x.com", type: "unknown_provider_event" },
          { email: "c@x.com" },
        ],
      }),
    );
    const json = await res.json();
    expect(json.data.suppressed).toBe(0);
    expect(json.data.quarantined).toBe(3);
    expect(h.suppress).not.toHaveBeenCalled();
  });

  it("일시 실패(soft/transient)는 억제하지 않는다", async () => {
    const res = await POST(
      req({ events: [{ email: "a@x.com", type: "soft_bounce" }, { email: "b@x.com", type: "transient" }] }),
    );
    const json = await res.json();
    expect(json.data.suppressed).toBe(0);
    expect(h.suppress).not.toHaveBeenCalled();
  });

  it("인증 없으면 401", async () => {
    const res = await POST(req({ events: [] }, "Bearer wrong"));
    expect(res.status).toBe(401);
  });
});
