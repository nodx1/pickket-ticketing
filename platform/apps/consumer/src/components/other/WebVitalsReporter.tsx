"use client";

import { useReportWebVitals } from "next/web-vitals";
import { API_URL } from "@pickket/lib";

export function WebVitalsReporter() {
  useReportWebVitals((metric) => {
    // Skip in development to avoid 404 console noise
    if (process.env.NODE_ENV === "development") return;

    const { name, value, rating, id } = metric;

    // Send to backend for aggregation
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
