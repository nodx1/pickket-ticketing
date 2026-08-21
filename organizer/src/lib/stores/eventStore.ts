"use client";

import { create } from "zustand";
import { fetchWithAuth } from "@/lib/fetchWithAuth";
import { showError } from "@/lib/hooks/useToast";
import type { EventStatus } from "@/lib/types";

export interface EventListItem {
  id: string;
  organizerId: string;
  organizerName: string;
  title: string;
  slug: string;
  summary: string | null;
  venueName: string | null;
  startsAt: string;
  endsAt: string;
  status: EventStatus;
  eventType: string;
  ageRating: string;
  maxAttendees: number | null;
  isOnline: boolean;
  attendeeCount: number;
  orderCount: number;
  revenue: number;
  heroImageUrl: string | null;
  organizers?: Array<{ organizerId: string; name: string; role: string; displayOrder: number }>;
}

interface EventDetailResponse {
  data: EventListItem & {
    description: string | null;
    venueAddress: string | null;
    timezone: string;
    homepageUrl: string | null;
  };
}

interface EventListMeta {
  total: number;
  page?: number;
  limit?: number;
}

interface EventListResponse {
  data: EventListItem[];
  meta?: EventListMeta;
}

interface EventStoreState {
  events: EventListItem[];
  meta: { total: number; page: number; limit: number } | null;
  currentEvent: EventDetailResponse["data"] | null;
  isLoading: boolean;
  fetchEvents: (query?: string) => Promise<void>;
  fetchEvent: (id: string) => Promise<void>;
}

export const useEventStore = create<EventStoreState>((set) => ({
  events: [],
  meta: null,
  currentEvent: null,
  isLoading: false,
  async fetchEvents(query = "") {
    set({ isLoading: true });
    try {
      const payload = await fetchWithAuth<EventListResponse>(`/api/events${query}`);
      const meta = payload.meta
        ? {
            total: payload.meta.total,
            page: payload.meta.page ?? 1,
            limit: payload.meta.limit ?? payload.data.length,
          }
        : null;
      set({ events: payload.data, meta, isLoading: false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "이벤트 목록을 불러오지 못했습니다";
      console.error("[eventStore]", message);
      showError(message);
      set({ isLoading: false });
    }
  },
  async fetchEvent(id: string) {
    set({ isLoading: true });
    try {
      const payload = await fetchWithAuth<EventDetailResponse>(`/api/events/${id}`);
      set({ currentEvent: payload.data, isLoading: false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "이벤트 정보를 불러오지 못했습니다";
      console.error("[eventStore]", message);
      showError(message);
      set({ isLoading: false });
    }
  },
}));
