/**
 * Phase E.3/E.4 — push-response 핸들러 단위 테스트
 */
const mockRouterPush = jest.fn();

jest.mock("expo-router", () => ({
  router: {
    push: (...args: unknown[]) => mockRouterPush(...args),
  },
}));

jest.mock("expo-notifications", () => ({
  addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
  getLastNotificationResponseAsync: jest.fn().mockResolvedValue(null),
}));

jest.mock("@/lib/crash-reporting", () => ({
  reportError: jest.fn(),
}));

import { handlePushResponse } from "@/lib/push-response";

beforeEach(() => {
  mockRouterPush.mockClear();
});

describe("handlePushResponse", () => {
  it("weekly_curation with event_ids → first event detail", () => {
    handlePushResponse({
      type: "weekly_curation",
      event_ids: ["evt-1", "evt-2"],
    });
    expect(mockRouterPush).toHaveBeenCalledWith("/event/evt-1");
  });

  it("weekly_curation without ids → home tab", () => {
    handlePushResponse({ type: "WEEKLY_CURATION" });
    expect(mockRouterPush).toHaveBeenCalledWith("/(tabs)/index");
  });

  it("friend_favorite → event detail", () => {
    handlePushResponse({ type: "friend_favorite", event_id: "evt-9" });
    expect(mockRouterPush).toHaveBeenCalledWith("/event/evt-9");
  });

  it("price_drop → event detail", () => {
    handlePushResponse({ type: "PRICE_DROP", event_id: "evt-3" });
    expect(mockRouterPush).toHaveBeenCalledWith("/event/evt-3");
  });

  it("location_nearby → event detail", () => {
    handlePushResponse({ type: "LOCATION_NEARBY", event_id: "evt-4" });
    expect(mockRouterPush).toHaveBeenCalledWith("/event/evt-4");
  });

  it("allocation_result with ticket_id → ticket detail", () => {
    handlePushResponse({ type: "allocation_result", ticket_id: "tkt-1" });
    expect(mockRouterPush).toHaveBeenCalledWith("/ticket/tkt-1");
  });

  it("payment_reminder with order_id → order detail", () => {
    handlePushResponse({ type: "payment_reminder", order_id: "ord-1" });
    expect(mockRouterPush).toHaveBeenCalledWith("/order/ord-1");
  });

  it("unknown type with event_id → fallback event detail", () => {
    handlePushResponse({ type: "random_type", event_id: "evt-5" });
    expect(mockRouterPush).toHaveBeenCalledWith("/event/evt-5");
  });

  it("empty data → no navigation", () => {
    handlePushResponse({});
    expect(mockRouterPush).not.toHaveBeenCalled();
  });
});
