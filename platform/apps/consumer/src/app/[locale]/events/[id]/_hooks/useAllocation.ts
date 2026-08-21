"use client";

import { useEffect, useState, useCallback } from "react";
import { toast } from "sonner";
import { triggerAllocation, getMyResult } from "@pickket/lib/api";
import { useAuthStore } from "@pickket/store";

interface MyResultData {
  won: boolean;
  bid_price: number | null;
  fair_price: number | null;
  final_price: number | null;
  externality: number | null;
}

export function useAllocation(
  eventId: string,
  eventStatus: string | undefined,
  isRealEvent: boolean,
  loadData: () => Promise<void>,
) {
  const user = useAuthStore((s) => s.user);
  const [myResult, setMyResult] = useState<MyResultData | null>(null);
  const [allocating, setAllocating] = useState(false);

  useEffect(() => {
    if (!isRealEvent) return;
    if (!user || !eventStatus) return;
    if (!["allocated", "completed"].includes(eventStatus)) return;
    getMyResult(eventId)
      .then((res) => setMyResult(res.data))
      .catch(() => {});
  }, [eventId, user, eventStatus, isRealEvent]);

  const handleAllocate = useCallback(async () => {
    setAllocating(true);
    try {
      const res = await triggerAllocation(eventId);
      toast.success(res.data.message);
      await loadData();
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail || "배분에 실패했습니다";
      toast.error(msg);
    } finally {
      setAllocating(false);
    }
  }, [eventId, loadData]);

  return {
    myResult,
    allocating,
    handleAllocate,
  };
}

export type { MyResultData };
