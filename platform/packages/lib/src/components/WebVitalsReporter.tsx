// @ts-nocheck — next/web-vitals resolves in app context via transpilePackages; not in packages/lib tsconfig scope
"use client";

import { useReportWebVitals } from "next/web-vitals";
import { API_URL } from "../env";

export function WebVitalsReporter() {
  useReportWebVitals((metric) => {
    if (process.env.NODE_ENV === "development") return;

    const { name, value, rating, id } = metric;

    if (typeof navigator !== "undefined" && navigator.sendBeacon) {
      navigator.sendBeacon(
        `${API_URL}/api/v1/metrics/web-vitals`,
        JSON.stringify({
          name,
          value,
          rating,
          id,
          url: window.location.pathname,
          ts: Date.now(),
        }),
      );
    }
  });

  return null;
}
