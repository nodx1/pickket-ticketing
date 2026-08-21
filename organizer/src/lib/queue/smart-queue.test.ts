import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  join: vi.fn(),
  status: vi.fn(),
  leave: vi.fn(),
}));

vi.mock("@/lib/v2/commerce-client", () => ({
  joinQueueV2: h.join,
  getQueueStatusV2: h.status,
  leaveQueueV2: h.leave,
}));

import {
  createQueueSessionToken,
  getQueuePosition,
  isSessionActive,
  joinQueue,
  releaseSession,
  resolveQueueEventFromSessionToken,
} from "./smart-queue";

const sessionToken = "anonymous-session-0001";

beforeEach(() => {
  h.join.mockReset();
  h.status.mockReset();
  h.leave.mockReset();
  vi.stubEnv("GO_WEBHOOK_SECRET", "queue-test-secret");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("smart queue v2 compatibility facade", () => {
  it("delegates join with a stable anonymous session token", async () => {
    h.join.mockResolvedValue({
      position: 7,
      total_waiting: 10,
      is_active: false,
      estimated_wait_seconds: 18,
      token: null,
    });

    await expect(joinQueue("v2-event-1", 25, sessionToken)).resolves.toEqual({
      sessionToken,
      position: 7,
      status: "waiting",
      estimatedWait: 18,
      totalWaiting: 10,
      accessToken: null,
    });
    expect(h.join).toHaveBeenCalledWith(
      "v2-event-1",
      sessionToken,
      25,
      { idempotencyKey: `queue-join:v2-event-1:${sessionToken}` },
    );
  });

  it("maps status and release without go Redis or DB state", async () => {
    h.status.mockResolvedValue({
      position: 0,
      total_waiting: 2,
      is_active: true,
      estimated_wait_seconds: 0,
      token: "admission-token",
    });
    h.leave.mockResolvedValue({ success: true });

    await expect(
      getQueuePosition("v2-event-1", sessionToken),
    ).resolves.toMatchObject({
      status: "active",
      accessToken: "admission-token",
    });
    await expect(
      isSessionActive("v2-event-1", sessionToken),
    ).resolves.toBe(true);
    await expect(
      releaseSession("v2-event-1", sessionToken),
    ).resolves.toBeUndefined();

    expect(h.leave).toHaveBeenCalledWith(
      "v2-event-1",
      sessionToken,
      { idempotencyKey: `queue-leave:v2-event-1:${sessionToken}` },
    );
  });

  it("binds polling tokens to the go event and canonical v2 anchor", () => {
    const v2EventId = "41cb1069-0a2d-4a07-9496-9f2082f5852e";
    const token = createQueueSessionToken("go-event-a", v2EventId);

    expect(resolveQueueEventFromSessionToken(token, "go-event-a")).toBe(v2EventId);
    expect(resolveQueueEventFromSessionToken(token, "go-event-b")).toBeNull();
    expect(
      resolveQueueEventFromSessionToken(
        token.replace(v2EventId, "40b1973f-e521-40e8-9817-a17e127fd330"),
        "go-event-a",
      ),
    ).toBeNull();
  });
});
