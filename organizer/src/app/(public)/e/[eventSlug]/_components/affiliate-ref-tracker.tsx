"use client";

import { useEffect } from "react";

export function AffiliateRefTracker({ code }: { code: string | null }) {
  useEffect(() => {
    if (!code) {
      return;
    }
    document.cookie = `pickket_affiliate_ref=${encodeURIComponent(code)}; path=/; max-age=${60 * 60 * 24 * 30}; samesite=lax`;
  }, [code]);

  return null;
}
