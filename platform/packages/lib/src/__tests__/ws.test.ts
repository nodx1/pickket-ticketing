import { describe, expect, it } from "vitest";

import { buildEventWebSocketUrl, resolveWebSocketBaseUrl } from "../ws";

describe("WebSocket URL helpers", () => {
  it("normalizes explicit URLs that already include /ws", () => {
    expect(buildEventWebSocketUrl("event-1", "wss://rt.pickket.kr/ws")).toBe(
      "wss://rt.pickket.kr/ws/event-1",
    );
    expect(buildEventWebSocketUrl("event-1", "wss://rt.pickket.kr/ws/")).toBe(
      "wss://rt.pickket.kr/ws/event-1",
    );
  });

  it("preserves explicit URLs without duplicating /ws", () => {
    expect(buildEventWebSocketUrl("event-2", "wss://rt.pickket.kr")).toBe(
      "wss://rt.pickket.kr/ws/event-2",
    );
  });

  it("falls back to current window origin when no explicit URL is provided", () => {
    const expectedBase = `${
      window.location.protocol === "https:" ? "wss:" : "ws:"
    }//${window.location.host}`;

    expect(resolveWebSocketBaseUrl()).toBe(expectedBase);
    expect(buildEventWebSocketUrl("event-3")).toBe(
      `${expectedBase}/ws/event-3`,
    );
  });
});
