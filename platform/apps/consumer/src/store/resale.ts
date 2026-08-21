import { create } from "zustand";

interface ResaleStore {
  orderSide: "buy" | "sell";
  orderPrice: number;
  orderQuantity: number;
  selectedEventId: string | null;
  selectedTierId: string | null;
  setOrderSide: (side: "buy" | "sell") => void;
  setOrderPrice: (price: number) => void;
  setOrderQuantity: (qty: number) => void;
  setMarket: (eventId: string, tierId: string) => void;
}

export const useResaleStore = create<ResaleStore>((set) => ({
  orderSide: "buy",
  orderPrice: 0,
  orderQuantity: 1,
  selectedEventId: null,
  selectedTierId: null,
  setOrderSide: (side) => set({ orderSide: side }),
  setOrderPrice: (price) => set({ orderPrice: price }),
  setOrderQuantity: (qty) => set({ orderQuantity: Math.max(1, qty) }),
  setMarket: (eventId, tierId) =>
    set({ selectedEventId: eventId, selectedTierId: tierId }),
}));
