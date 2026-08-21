"use client";

import { useState, useCallback } from "react";

export function useBookingState() {
  const [sidebarTierId, setSidebarTierId] = useState<string | null>(null);
  const [sidebarQty, setSidebarQty] = useState(1);
  const [showQueue, setShowQueue] = useState(false);

  const handleSidebarTierChange = useCallback((tierId: string) => {
    setSidebarTierId(tierId);
  }, []);

  const handleSidebarQtyChange = useCallback((qty: number) => {
    setSidebarQty(qty);
  }, []);

  return {
    sidebarTierId,
    setSidebarTierId,
    sidebarQty,
    setSidebarQty,
    showQueue,
    setShowQueue,
    handleSidebarTierChange,
    handleSidebarQtyChange,
  };
}
