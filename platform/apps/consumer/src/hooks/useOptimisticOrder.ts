"use client";

import { useState, useCallback, useEffect, useRef } from "react";

export interface OptimisticEntry {
  id: string;
  price: number;
  quantity: number;
  side: "bid" | "ask";
  status: "pending" | "confirmed" | "failed";
  timestamp: number;
}

/**
 * 낙관적 주문 상태 관리 훅
 * 주문 제출 시 즉시 UI에 반영하고, 서버 응답 후 확정/실패 처리
 */
export function useOptimisticOrder() {
  const [optimisticEntries, setOptimisticEntries] = useState<OptimisticEntry[]>(
    [],
  );
  const timersRef = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());

  // Cleanup all pending timers on unmount
  useEffect(() => {
    const timers = timersRef.current; // ref 값을 effect 내부 변수에 복사 — cleanup 시점에 안전
    return () => {
      timers.forEach(clearTimeout);
      timers.clear();
    };
  }, []);

  const addOptimistic = useCallback(
    (entry: Omit<OptimisticEntry, "id" | "status" | "timestamp">) => {
      const newEntry: OptimisticEntry = {
        ...entry,
        id: `opt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        status: "pending",
        timestamp: Date.now(),
      };
      setOptimisticEntries((prev) => [...prev, newEntry]);
      return newEntry.id;
    },
    [],
  );

  const confirmOptimistic = useCallback((id: string) => {
    setOptimisticEntries((prev) => prev.filter((e) => e.id !== id));
  }, []);

  const failOptimistic = useCallback((id: string) => {
    setOptimisticEntries((prev) =>
      prev.map((e) => (e.id === id ? { ...e, status: "failed" as const } : e)),
    );
    // 실패한 항목은 3초 후 자동 제거
    const timer = setTimeout(() => {
      timersRef.current.delete(timer);
      setOptimisticEntries((prev) => prev.filter((e) => e.id !== id));
    }, 3000);
    timersRef.current.add(timer);
  }, []);

  const clearAll = useCallback(() => {
    setOptimisticEntries([]);
  }, []);

  return {
    optimisticEntries,
    addOptimistic,
    confirmOptimistic,
    failOptimistic,
    clearAll,
  };
}
