import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  query: vi.fn(),
  dispatchV2: vi.fn(),
  warn: vi.fn(),
}));

// 레벨2 T2-EVT — dispatcher 는 더 이상 go DB 를 건드리지 않는다. pool 목은 "쿼리 0회" 회귀검증용.
vi.mock("@/lib/db/pool", () => ({
  getPool: () => ({ query: h.query }),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: h.warn, error: vi.fn() },
}));
vi.mock("@/lib/v2/commerce-client", () => ({
  dispatchWebhookEvent: h.dispatchV2,
}));

import { dispatchWebhook } from "./dispatcher";

beforeEach(() => {
  h.query.mockReset();
  h.dispatchV2.mockReset();
  h.warn.mockReset();
});

describe("v2 outbound webhook dispatch flip", () => {
  it("go DB 조회 없이 event id 를 그대로 v2 canonical id 로 위임한다", async () => {
    h.dispatchV2.mockResolvedValue({
      delivery_ids: ["delivery-1"],
      queued: 1,
    });
    const payload = { eventId: "go-event-1", orderId: "order-1" };

    await expect(dispatchWebhook("order.completed", payload)).resolves.toEqual({
      deliveryIds: ["delivery-1"],
      queued: 1,
    });
    // id 승격(go events.id == v2 events.id) → 앵커 조회 없이 동일 id 로 dispatch.
    expect(h.dispatchV2).toHaveBeenCalledWith(
      "go-event-1",
      "order.completed",
      payload,
    );
    expect(h.query).not.toHaveBeenCalled();
  });

  it("eventId 없는 payload 는 발송을 생략한다", async () => {
    await expect(
      dispatchWebhook("order.completed", { orderId: "order-1" }),
    ).resolves.toEqual({ deliveryIds: [], queued: 0 });
    expect(h.dispatchV2).not.toHaveBeenCalled();
    expect(h.warn).toHaveBeenCalled();
  });

  it("v2 에 없는 이벤트는 조용히 삼키지 않고 에러를 전파한다", async () => {
    // 옛 "앵커 NULL → no-op" 이 사라진 자리 — 미존재는 v2 404 로 드러나야 한다(조용한 폴백 금지).
    h.dispatchV2.mockRejectedValue(new Error("v2 404"));
    await expect(
      dispatchWebhook("order.completed", { eventId: "go-event-1" }),
    ).rejects.toThrow("v2 404");
  });
});
