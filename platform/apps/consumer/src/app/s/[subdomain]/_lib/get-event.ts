import { cache } from "react";
import { API_URL } from "@pickket/lib";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isValidEvent(data: unknown): data is any {
  if (!data || typeof data !== "object") return false;
  const d = data as Record<string, unknown>;
  return typeof d.id === "string" && typeof d.title === "string";
}

export const getEvent = cache(async (subdomain: string) => {
  try {
    const res = await fetch(
      `${API_URL}/api/v1/events/by-subdomain/${subdomain}`,
      { next: { revalidate: 60 } },
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!isValidEvent(data)) return null;
    return data;
  } catch {
    return null;
  }
});
