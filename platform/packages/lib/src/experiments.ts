"use client";

/**
 * A/B Testing experiment hook (P1-10).
 *
 * Usage:
 *   const { variant, isLoading, track } = useExperiment("homepage_cta");
 *   if (variant === "blue_button") { ... }
 *   track("conversion", 1.0);  // optional value
 */

import { useCallback, useEffect, useRef, useState } from "react";

import api from "./api";

interface VariantAssignment {
  test_name: string;
  test_id: string;
  variant_name: string;
}

interface UseExperimentResult {
  /** Current variant name, or null if not assigned / loading */
  variant: string | null;
  /** True while the initial variant fetch is in progress */
  isLoading: boolean;
  /** Track a conversion or custom event for this experiment */
  track: (eventType: string, value?: number) => Promise<void>;
}

const CACHE_PREFIX = "pickket_exp_";

function getCachedVariant(testName: string): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(`${CACHE_PREFIX}${testName}`);
    if (!raw) return null;
    const data = JSON.parse(raw) as { variant: string; ts: number };
    // Cache for 24 hours
    if (Date.now() - data.ts > 24 * 60 * 60 * 1000) {
      localStorage.removeItem(`${CACHE_PREFIX}${testName}`);
      return null;
    }
    return data.variant;
  } catch {
    return null;
  }
}

function setCachedVariant(testName: string, variant: string): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(
      `${CACHE_PREFIX}${testName}`,
      JSON.stringify({ variant, ts: Date.now() }),
    );
  } catch {
    // Storage full or unavailable — ignore
  }
}

export function useExperiment(testName: string): UseExperimentResult {
  const [variant, setVariant] = useState<string | null>(() =>
    getCachedVariant(testName),
  );
  const [isLoading, setIsLoading] = useState(!getCachedVariant(testName));
  const impressionTracked = useRef(false);

  // Fetch variant assignment
  useEffect(() => {
    let cancelled = false;

    const cached = getCachedVariant(testName);
    if (cached) {
      setVariant(cached);
      setIsLoading(false);
    }

    api
      .get<VariantAssignment | null>("/ab-tests/variant", {
        params: { test_name: testName },
      })
      .then((res) => {
        if (cancelled) return;
        const data = res.data;
        if (data?.variant_name) {
          setVariant(data.variant_name);
          setCachedVariant(testName, data.variant_name);
        } else {
          setVariant(null);
        }
      })
      .catch(() => {
        // Keep cached value if available; otherwise null
        if (!cancelled && !cached) setVariant(null);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [testName]);

  // Auto-track impression on mount when variant is resolved
  useEffect(() => {
    if (!variant || impressionTracked.current) return;
    impressionTracked.current = true;

    api
      .post("/ab-tests/track", {
        test_name: testName,
        event_type: "impression",
      })
      .catch(() => {
        // Best-effort tracking — don't block UX
      });
  }, [variant, testName]);

  const track = useCallback(
    async (eventType: string, value?: number) => {
      try {
        await api.post("/ab-tests/track", {
          test_name: testName,
          event_type: eventType,
          value: value ?? null,
        });
      } catch {
        // Best-effort — don't throw
      }
    },
    [testName],
  );

  return { variant, isLoading, track };
}
