"use client";

import { useEffect, useState } from "react";

export function ContextBanner({ eventId }: { eventId: string }) {
  const [banner, setBanner] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/events/${eventId}/public/context-banner`);
        const data = (await res.json()) as { data?: { banner: string | null } };
        setBanner(data.data?.banner ?? null);
      } catch {
        // ignore
      }
    }
    void load();
  }, [eventId]);

  if (!banner) return null;

  return (
    <div className="rounded-xl bg-gradient-to-r from-primary/20 to-accent/20 px-4 py-2.5 text-center text-sm font-medium text-foreground backdrop-blur-sm">
      {banner}
    </div>
  );
}
