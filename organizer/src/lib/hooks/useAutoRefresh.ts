"use client";

import { useEffect, useRef, useState } from "react";

export function useAutoRefresh(fetchFn: () => Promise<void>, intervalMs: number) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const fetchRef = useRef(fetchFn);

  useEffect(() => {
    fetchRef.current = fetchFn;
  }, [fetchFn]);

  async function refresh() {
    setIsRefreshing(true);
    try {
      await fetchRef.current();
    } finally {
      setIsRefreshing(false);
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (!document.hidden) {
        void refresh();
      }
    }, intervalMs);

    return () => {
      window.clearInterval(timer);
    };
  }, [intervalMs]);

  return { refresh, isRefreshing };
}
