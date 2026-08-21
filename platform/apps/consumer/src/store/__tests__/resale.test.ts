import { describe, it, expect, beforeEach } from "vitest";
import { useResaleStore } from "../resale";

describe("useResaleStore", () => {
  beforeEach(() => {
    // Reset to initial state
    useResaleStore.setState({
      orderSide: "buy",
      orderPrice: 0,
      orderQuantity: 1,
      selectedEventId: null,
      selectedTierId: null,
    });
  });

  describe("initial state", () => {
    it("starts with buy side", () => {
      expect(useResaleStore.getState().orderSide).toBe("buy");
    });

    it("starts with price 0", () => {
      expect(useResaleStore.getState().orderPrice).toBe(0);
    });

    it("starts with quantity 1", () => {
      expect(useResaleStore.getState().orderQuantity).toBe(1);
    });

    it("has null selectedEventId", () => {
      expect(useResaleStore.getState().selectedEventId).toBeNull();
    });

    it("has null selectedTierId", () => {
      expect(useResaleStore.getState().selectedTierId).toBeNull();
    });
  });

  describe("setOrderSide", () => {
    it("changes to sell", () => {
      useResaleStore.getState().setOrderSide("sell");
      expect(useResaleStore.getState().orderSide).toBe("sell");
    });

    it("changes back to buy", () => {
      useResaleStore.getState().setOrderSide("sell");
      useResaleStore.getState().setOrderSide("buy");
      expect(useResaleStore.getState().orderSide).toBe("buy");
    });
  });

  describe("setOrderPrice", () => {
    it("sets a valid price", () => {
      useResaleStore.getState().setOrderPrice(50000);
      expect(useResaleStore.getState().orderPrice).toBe(50000);
    });

    it("accepts zero price", () => {
      useResaleStore.getState().setOrderPrice(0);
      expect(useResaleStore.getState().orderPrice).toBe(0);
    });

    it("updates existing price", () => {
      useResaleStore.getState().setOrderPrice(10000);
      useResaleStore.getState().setOrderPrice(75000);
      expect(useResaleStore.getState().orderPrice).toBe(75000);
    });
  });

  describe("setOrderQuantity", () => {
    it("sets quantity", () => {
      useResaleStore.getState().setOrderQuantity(3);
      expect(useResaleStore.getState().orderQuantity).toBe(3);
    });

    it("enforces minimum quantity of 1", () => {
      useResaleStore.getState().setOrderQuantity(0);
      expect(useResaleStore.getState().orderQuantity).toBe(1);
    });

    it("enforces minimum for negative numbers", () => {
      useResaleStore.getState().setOrderQuantity(-5);
      expect(useResaleStore.getState().orderQuantity).toBe(1);
    });

    it("allows large quantity", () => {
      useResaleStore.getState().setOrderQuantity(100);
      expect(useResaleStore.getState().orderQuantity).toBe(100);
    });
  });

  describe("setMarket", () => {
    it("sets both eventId and tierId", () => {
      useResaleStore.getState().setMarket("event-123", "tier-456");
      const state = useResaleStore.getState();
      expect(state.selectedEventId).toBe("event-123");
      expect(state.selectedTierId).toBe("tier-456");
    });

    it("overwrites previous selection", () => {
      useResaleStore.getState().setMarket("event-1", "tier-1");
      useResaleStore.getState().setMarket("event-2", "tier-2");
      const state = useResaleStore.getState();
      expect(state.selectedEventId).toBe("event-2");
      expect(state.selectedTierId).toBe("tier-2");
    });
  });

  describe("combined workflow", () => {
    it("simulates a full buy order", () => {
      const store = useResaleStore.getState();

      store.setMarket("event-concert", "tier-vip");
      store.setOrderSide("buy");
      store.setOrderPrice(120000);
      store.setOrderQuantity(2);

      const state = useResaleStore.getState();
      expect(state.selectedEventId).toBe("event-concert");
      expect(state.selectedTierId).toBe("tier-vip");
      expect(state.orderSide).toBe("buy");
      expect(state.orderPrice).toBe(120000);
      expect(state.orderQuantity).toBe(2);
    });

    it("simulates switching from buy to sell", () => {
      useResaleStore.getState().setMarket("ev-1", "t-1");
      useResaleStore.getState().setOrderSide("buy");
      useResaleStore.getState().setOrderPrice(100000);

      useResaleStore.getState().setOrderSide("sell");
      useResaleStore.getState().setOrderPrice(110000);

      const state = useResaleStore.getState();
      expect(state.orderSide).toBe("sell");
      expect(state.orderPrice).toBe(110000);
    });
  });
});
