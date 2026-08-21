"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import {
  getEvent,
  getEventTiers,
  getEventSessions,
  getVenue,
  getResults,
  getParticipantSlots,
  getParticipantAssignments,
  recordView,
  type EventDetail,
  type SeatTier,
  type SessionData,
  type SeatData,
  type VenueData,
  type ParticipantSlot,
  type ParticipantAssignment,
} from "@pickket/lib/api";
import { API_URL } from "@pickket/lib";

/**
 * axios 의 deduplicateGet 을 회피하기 위한 raw fetch. 같은 URL 을 여러 컴포넌트가
 * 동시에 호출해도 서로 취소하지 않음 (StrictMode 이중 마운트 안전).
 */
async function fetchEventSeatsRaw(
  eventId: string,
  signal: AbortSignal,
): Promise<SeatData[]> {
  const url = `${API_URL}/api/v1/events/${encodeURIComponent(eventId)}/seats`;
  const res = await fetch(url, {
    signal,
    credentials: "include",
  });
  if (!res.ok) throw new Error(`seats fetch failed: ${res.status}`);
  const data = (await res.json()) as unknown;
  return Array.isArray(data) ? (data as SeatData[]) : [];
}
import { useAuthStore } from "@pickket/store";
import { ensureFallbackData } from "@/lib/fallback-data";

interface AllocationData {
  total_bids: number;
  total_allocated: number;
  competition_ratio: number;
  price_min: number | null;
  price_max: number | null;
  price_median: number | null;
  price_p25: number | null;
  price_p75: number | null;
  cutoff_price: number | null;
  computation_time_seconds: number | null;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function useEventData(
  eventId: string,
  initialEvent?: EventDetail | null,
  initialTiers?: SeatTier[] | null,
  initialVenue?: VenueData | null,
) {
  const user = useAuthStore((s) => s.user);
  // Stable ref for user so loadData does not need user in its deps array.
  // loadData reads user at call time via the ref; if user changes (OAuth login),
  // only participant-slot data is affected — we handle that via a separate effect
  // rather than re-running the entire event+tiers+sessions fetch (avoids flash).
  const userRef = useRef(user);
  userRef.current = user;
  const isRealEvent = UUID_RE.test(eventId);

  const ssrTiers = initialTiers ?? [];
  const ssrVenue = initialVenue ?? null;

  const [event, setEvent] = useState<EventDetail | null>(initialEvent ?? null);
  const eventRef = useRef(event);
  eventRef.current = event;

  const [tiers, setTiers] = useState<SeatTier[]>(ssrTiers);
  const [sessions, setSessions] = useState<SessionData[]>([]);
  const [venue, setVenue] = useState<VenueData | null>(ssrVenue);
  const [seats, setSeats] = useState<SeatData[]>([]);
  const [allocation, setAllocation] = useState<AllocationData | null>(null);
  const [participants, setParticipants] = useState<
    Array<{ position: string; name: string; session_id?: string }>
  >([]);
  const [rawSlots, setRawSlots] = useState<ParticipantSlot[]>([]);
  const [rawAssignments, setRawAssignments] = useState<ParticipantAssignment[]>(
    [],
  );
  const [loading, setLoading] = useState(!initialEvent);
  const [tiersReady, setTiersReady] = useState(ssrTiers.length > 0);

  const applyFallback = useCallback(
    (
      eventData: EventDetail | null,
      rawTiers: SeatTier[],
      rawVenue: VenueData | null,
      preserveVenue = false,
    ) => {
      const fb = ensureFallbackData(eventId, eventData, rawTiers, rawVenue);
      if (!eventData) setEvent(fb.event);
      setTiers(fb.tiers);
      if (!preserveVenue || fb.venue) setVenue(fb.venue);
      return fb;
    },
    [eventId],
  );

  const loadData = useCallback(
    async (signal?: AbortSignal) => {
      if (!eventId || !isRealEvent) {
        applyFallback(eventRef.current, [], null);
        if (!signal?.aborted) setLoading(false);
        return;
      }

      try {
        // ── Hop 1: event + tiers + sessions + slots + assignments 병렬 ──
        const [eventRes, tiersRes, sessionsRes, slotsRes, assignmentsRes] =
          await Promise.all([
            getEvent(eventId).catch(() => null),
            getEventTiers(eventId).catch(() => ({ data: [] as SeatTier[] })),
            getEventSessions(eventId).catch(() => ({
              data: [] as SessionData[],
            })),
            userRef.current
              ? getParticipantSlots(eventId).catch(
                  () => [] as ParticipantSlot[],
                )
              : ([] as ParticipantSlot[]),
            userRef.current
              ? getParticipantAssignments(eventId).catch(
                  () => [] as ParticipantAssignment[],
                )
              : ([] as ParticipantAssignment[]),
          ]);

        if (signal?.aborted) return;

        let eventData: EventDetail;
        if (eventRes) {
          eventData = eventRes.data;
          setEvent(eventData);
        } else {
          const existing = eventRef.current;
          if (!existing) {
            applyFallback(null, [], null);
            if (!signal?.aborted) setLoading(false);
            return;
          }
          eventData = existing;
        }

        const tierData = Array.isArray(tiersRes.data) ? tiersRes.data : [];
        const sessionData = Array.isArray(sessionsRes.data)
          ? sessionsRes.data
          : [];
        const slots = Array.isArray(slotsRes) ? slotsRes : [];
        const assignments = Array.isArray(assignmentsRes) ? assignmentsRes : [];

        setSessions(sessionData);
        if (slots.length > 0) {
          setRawSlots(slots);
          setRawAssignments(assignments);
          const combined = assignments.map((a: ParticipantAssignment) => {
            const slot = slots.find((s: ParticipantSlot) => s.id === a.slot_id);
            return {
              position: slot?.slot_name ?? "",
              name: a.participant_name,
              session_id: a.session_date,
            };
          });
          setParticipants(combined);
        }

        // ── tiers만 즉시 적용 (venue는 Hop 2에서 — fallback venue 깜빡임 방지) ──
        if (!signal?.aborted) {
          setTiers(tierData.length > 0 ? tierData : []);
          setTiersReady(true);
        }

        // ── Hop 2: venue + seats + results (event 데이터 의존) 병렬 ──
        let venueData: VenueData | null = null;
        const hop2: Promise<void>[] = [];

        if (eventData.venue_id) {
          hop2.push(
            getVenue(eventData.venue_id)
              .then((res) => {
                if (!signal?.aborted) venueData = res.data;
              })
              .catch((err) => {
                // venue 조회 실패 — 좌석 배치도 없이 fallback UI로 진행
                console.error("[useEventData] getVenue failed:", err);
              }),
          );
        }

        // 주최자가 피그마 빌더로 그린 개별 좌석 로드 — raw fetch 로 deduplicateGet 회피
        // (StrictMode 이중 마운트에서 axios 기반 호출이 서로 취소하면서 seats 가 빈 배열로
        //  고정되는 버그 있었음. 동일 URL 병렬 호출이 안전한 fetch 로 전환)
        if (signal) {
          hop2.push(
            fetchEventSeatsRaw(eventId, signal)
              .then((data) => {
                if (!signal.aborted) setSeats(data);
              })
              .catch((err: unknown) => {
                const name = (err as { name?: string } | null)?.name;
                if (name === "AbortError" || name === "CanceledError") return;
                if (!signal.aborted) setSeats([]);
              }),
          );
        }

        if (
          ["ALLOCATED", "COMPLETED", "allocated", "completed"].includes(
            eventData.status,
          )
        ) {
          hop2.push(
            getResults(eventId)
              .then((res) => {
                if (!signal?.aborted) setAllocation(res.data);
              })
              .catch((err) => {
                // 추첨 결과 조회 실패 — allocation 미표시로 진행 (UI에서 fallback)
                console.error("[useEventData] getResults failed:", err);
              }),
          );
        }

        // recordView는 fire-and-forget 분석 — 실패해도 무시
        recordView(eventId).catch(() => {});

        if (hop2.length > 0) await Promise.all(hop2);

        if (!signal?.aborted && venueData) {
          setVenue(venueData);
        }
      } catch {
        if (!signal?.aborted) {
          applyFallback(eventRef.current, [], null);
        }
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    // userRef is intentionally excluded from deps: user state changes should not
    // re-trigger a full event+tiers+sessions reload (causes loading flash on login).
    // userRef.current is read at call time, which is correct for conditional logic.
    [eventId, isRealEvent, applyFallback],
  );

  useEffect(() => {
    const ac = new AbortController();
    loadData(ac.signal);
    return () => ac.abort();
  }, [eventId, loadData]);

  const handleSessionChange = useCallback(
    async (sessionEventId: string) => {
      let tierData: SeatTier[] = [];
      try {
        const tiersRes = await getEventTiers(sessionEventId);
        tierData = Array.isArray(tiersRes.data) ? tiersRes.data : [];
      } catch {
        // API failed — tierData stays empty, applyFallback handles it
      }
      applyFallback(eventRef.current, tierData, null, true);
    },
    [applyFallback],
  );

  return {
    event,
    tiers,
    sessions,
    venue,
    seats,
    allocation,
    participants,
    rawSlots,
    rawAssignments,
    loading,
    tiersReady,
    loadData,
    handleSessionChange,
    isRealEvent,
  };
}

export type { AllocationData };
